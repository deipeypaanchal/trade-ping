import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../config/prisma.service';
import { CryptoService } from '../security/crypto.service';
import { EncryptedSecretError } from '../security/errors';
import { SnapTradeOrder, SnapTradePosition } from '../snaptrade/snaptrade.types';
import { SnaptradeService } from '../snaptrade/snaptrade.service';
import { PositionSnapshotEntry, TradeDetectorService } from './trade-detector.service';
import { AlertService } from '../alerts/alert.service';
import { contractMultiplier } from './asset-type';
import { shouldSuppressAlert } from './suppress-policy';
import { scopeKeyToGroup } from './order-key';
import { supportsProvisionalPositionAlerts } from './broker-freshness';
import { ALERT, JOB_DEFAULTS, SYNC } from '../config/constants';
import { isExcludedBotSymbol } from './excluded-symbols';
import {
  acquireGroupDeliveryLock,
  acquireUserSafetyLocks,
  SYNC_FENCE_TRANSACTION,
} from '../security/user-safety-lock';

export class SyncDeadlineExceededError extends Error {
  constructor(phase: string) {
    super(`broker sync deadline exceeded during ${phase}`);
    this.name = 'SyncDeadlineExceededError';
  }
}

type SyncDatabase = Prisma.TransactionClient | PrismaService;
type SyncPostCommitWork = {
  tradeAlertIds: Set<string>;
  provisionalAlertIds: Set<string>;
};

@Injectable()
export class BrokerSyncService {
  private readonly logger = new Logger(BrokerSyncService.name);
  constructor(
    private prisma: PrismaService,
    private crypto: CryptoService,
    private snap: SnaptradeService,
    private detector: TradeDetectorService,
    private alerts: AlertService,
    private config: ConfigService,
    @InjectQueue('trade-sync') private queue?: Queue,
  ) {}

  async syncUser(userId: string, opts: { suppressBackfill?: boolean } = {}): Promise<{ created: number; alerted: number }> {
    // Measure from before the transaction opens. Advisory-lock contention is
    // therefore part of the budget instead of silently consuming the entire
    // 15-minute transaction lifetime before provider work begins.
    const deadlineAt = Date.now() + SYNC.MAX_RUN_MS;
    const postCommit: SyncPostCommitWork = {
      tradeAlertIds: new Set<string>(),
      provisionalAlertIds: new Set<string>(),
    };
    const result = await this.prisma.$transaction(async (tx) => {
      await acquireUserSafetyLocks(tx, userId, ['sync']);
      this.assertSyncDeadline(deadlineAt, 'sync lock acquisition');
      return this.syncUserWithFence(tx, userId, opts, deadlineAt, postCommit);
    }, SYNC_FENCE_TRANSACTION);

    // External delivery and Redis queue work each have their own safety bounds
    // and must start only after the database transaction has committed. This
    // keeps the lock-owning transaction as the sole writer during sync while
    // avoiding uncommitted TradeEvents that a separate AlertService transaction
    // cannot see.
    for (const tradeEventId of postCommit.provisionalAlertIds) {
      await this.scheduleProvisionalAlert(tradeEventId);
    }
    let alerted = 0;
    for (const tradeEventId of postCommit.tradeAlertIds) {
      try {
        if (await this.alerts.sendTradeAlert(tradeEventId)) alerted += 1;
      } catch (err) {
        this.logger.warn(`alert send threw for trade ${tradeEventId}: ${(err as Error).message}`);
      }
    }
    if (result.created || alerted) this.logger.log(`sync completed for ${userId}: created=${result.created} alerted=${alerted}`);
    return { created: result.created, alerted };
  }

  private async syncUserWithFence(
    db: Prisma.TransactionClient,
    userId: string,
    opts: { suppressBackfill?: boolean } = {},
    deadlineAt = Date.now() + SYNC.MAX_RUN_MS,
    postCommit: SyncPostCommitWork = { tradeAlertIds: new Set(), provisionalAlertIds: new Set() },
  ): Promise<{ created: number; alerted: number }> {
    this.assertSyncDeadline(deadlineAt, 'user lookup');
    const user = await db.user.findUniqueOrThrow({
      where: { id: userId },
      include: {
        memberships: {
          where: {
            alertsEnabled: true,
            privacyLevel: { not: 'OFF' },
            sharingEnabledAt: { not: null },
            group: { telegramChatId: { startsWith: '-' } },
          },
          include: { group: { select: { inferredAlertsEnabled: true } } },
        },
      },
    });
    this.assertSyncDeadline(deadlineAt, 'user lookup');
    if (!user.brokerSyncEnabled || !user.snaptradeUserId || !user.encryptedUserSecret) return { created: 0, alerted: 0 };

    // Decrypt up front. If the encryption key rotated or the payload is corrupted,
    // mark the user's connections as disconnected so they're prompted to /connect
    // again instead of cycling through worker retries forever.
    let userSecret: string;
    try {
      userSecret = this.crypto.decrypt(user.encryptedUserSecret);
    } catch (err) {
      if (err instanceof EncryptedSecretError) {
        this.assertSyncDeadline(deadlineAt, 'decrypt failure cleanup');
        this.logger.error(`decrypt failed for user ${userId}: ${err.message}; marking connections DISCONNECTED`);
        await db.brokerConnection.updateMany({
          where: { userId, status: { not: 'DISCONNECTED' } },
          data: { status: 'DISCONNECTED', disabledReason: 'Encryption key mismatch — please /connect again', disconnectedAt: new Date() },
        });
        await db.auditLog.create({ data: { userId, action: 'broker_sync_failed', metadata: { reason: 'decrypt_failed' } } });
        return { created: 0, alerted: 0 };
      }
      throw err;
    }

    let created = 0, alerted = 0;
    let connections;
    this.assertSyncDeadline(deadlineAt, 'list connections');
    try {
      connections = await this.snap.listConnections(user.snaptradeUserId, userSecret);
    } catch (err) {
      this.assertSyncDeadline(deadlineAt, 'list connections');
      this.logger.warn(`syncUser(${userId}) listConnections failed: ${(err as Error).message}; skipping this run`);
      await db.auditLog.create({ data: { userId, action: 'broker_sync_failed', metadata: { reason: 'list_connections_failed', message: (err as Error).message } } });
      return { created, alerted };
    }
    this.assertSyncDeadline(deadlineAt, 'list connections');
    if (!await this.syncStillEnabled(db, userId, deadlineAt)) return { created, alerted };
    await this.disconnectMissingConnections(db, userId, connections.map((conn) => conn.id));
    this.assertSyncDeadline(deadlineAt, 'connection reconciliation');

    for (const conn of connections) {
      this.assertSyncDeadline(deadlineAt, 'connection loop');
      if (!await this.syncStillEnabled(db, userId, deadlineAt)) return { created, alerted };
      try {
        const dbConn = await db.brokerConnection.upsert({
          where: { authorizationId: conn.id },
          update: { brokerageName: conn.brokerage?.display_name ?? conn.brokerage?.name, brokerageSlug: conn.brokerage?.slug, connectionType: conn.type ?? 'read', status: conn.disabled ? 'DISABLED' : 'ACTIVE' },
          create: { userId, authorizationId: conn.id, brokerageName: conn.brokerage?.display_name ?? conn.brokerage?.name, brokerageSlug: conn.brokerage?.slug, connectionType: conn.type ?? 'read', status: conn.disabled ? 'DISABLED' : 'ACTIVE' },
        });
        this.assertSyncDeadline(deadlineAt, 'connection upsert');
        if (conn.disabled) continue;
        this.assertSyncDeadline(deadlineAt, 'list accounts');
        const accounts = await this.snap.listAccounts(user.snaptradeUserId, userSecret, conn.id);
        this.assertSyncDeadline(deadlineAt, 'list accounts');
        if (!await this.syncStillEnabled(db, userId, deadlineAt)) return { created, alerted };
        await this.disconnectMissingAccounts(db, dbConn.id, accounts.map((account) => account.id));
        this.assertSyncDeadline(deadlineAt, 'account reconciliation');
        for (const acct of accounts) {
          this.assertSyncDeadline(deadlineAt, 'account loop');
          if (!await this.syncStillEnabled(db, userId, deadlineAt)) return { created, alerted };
          const acctNameHash = acct.name ? this.crypto.hash(acct.name) : undefined;
          const accountType = this.accountTypeFrom(acct);
          const dbAcct = await db.brokerAccount.upsert({
            where: { connectionId_providerAccountId: { connectionId: dbConn.id, providerAccountId: acct.id } },
            update: { accountNameHash: acctNameHash, accountType, status: 'ACTIVE' },
            create: { connectionId: dbConn.id, providerAccountId: acct.id, accountNameHash: acctNameHash, accountType, status: 'ACTIVE' },
          });
          this.assertSyncDeadline(deadlineAt, 'account upsert');
          const previousSnapshot = await this.positionSnapshot(db, userId, dbAcct.id);
          this.assertSyncDeadline(deadlineAt, 'position baseline lookup');
          const orderFetch = await this.fetchOrders(db, user.snaptradeUserId, userSecret, acct.id, deadlineAt);
          if (!await this.syncStillEnabled(db, userId, deadlineAt)) return { created, alerted };
          const orders = orderFetch.orders;
          const seenOrderHashes = new Set<string>();
          // First sync for an account establishes a baseline: every order returned is
          // pre-existing history, so suppress it all rather than flooding the group.
          // After the baseline, suppression is delegated to the pure shouldSuppressAlert
          // policy which also folds in the last successful sync time so an outage
          // longer than the static window doesn't re-alert old fills.
          const lastSuccessfulSyncAt = await this.lastSuccessfulSyncAt(db, userId, dbAcct.id);
          const isFirstSync = lastSuccessfulSyncAt === null;
          const backfillSuppressHours = this.config.getOrThrow<number>('BACKFILL_SUPPRESS_HOURS');
          const suppressBefore = this.recoverySuppressBefore();
          for (const order of orders) {
            this.assertSyncDeadline(deadlineAt, 'order loop');
            const norm = this.detector.normalizeOrder(userId, acct.id, order);
            if (!norm) continue;
            if (seenOrderHashes.has(norm.dedupeHash)) continue;
            seenOrderHashes.add(norm.dedupeHash);
            const profit = this.estimateProfit(norm, previousSnapshot);
            const decision = shouldSuppressAlert({
              tradeTime: norm.tradeTime,
              isFirstSync,
              suppressBackfill: opts.suppressBackfill === true,
              backfillSuppressHours,
              suppressBefore,
            });
            const suppress = decision.suppress;
            for (const member of user.memberships) {
              this.assertSyncDeadline(deadlineAt, 'group event loop');
              // Consent is prospective. A newly enabled group must not receive
              // recent orders that executed before the user's explicit choice.
              if (!member.sharingEnabledAt || norm.tradeTime <= member.sharingEnabledAt) continue;
              const dedupe = scopeKeyToGroup(norm.dedupeHash, member.groupId);
              const trade = await db.tradeEvent.upsert({
                where: { dedupeHash: dedupe },
                update: {},
                create: {
                  userId,
                  groupId: member.groupId,
                  accountId: dbAcct.id,
                  symbol: norm.symbol,
                  side: norm.side,
                  quantity: norm.quantity,
                  price: norm.price,
                  priceSource: norm.priceSource,
                  averageFillPrice: norm.averageFillPrice,
                  executionPrice: norm.executionPrice,
                  limitPrice: norm.limitPrice,
                  fees: norm.fees,
                  assetType: norm.assetType,
                  underlying: norm.underlying,
                  optionExpiration: norm.optionExpiration ? new Date(norm.optionExpiration) : undefined,
                  optionStrike: norm.optionStrike,
                  optionType: norm.optionType,
                  profitLoss: profit?.amount,
                  profitLossPct: profit?.percent,
                  currency: norm.currency,
                  tradeTime: norm.tradeTime,
                  rawType: norm.rawType,
                  rawStatus: norm.rawStatus,
                  rawId: norm.rawId,
                  dedupeHash: dedupe,
                  backfillStatus: suppress ? 'BACKFILL' : 'NEW',
                  alertStatus: suppress ? 'SKIPPED' : 'PENDING',
                },
              });
              this.assertSyncDeadline(deadlineAt, 'trade event upsert');
              if (trade.createdAt.getTime() > Date.now() - 10_000) created += 1;
              if (!suppress && trade.alertStatus === 'PENDING') {
                postCommit.tradeAlertIds.add(trade.id);
              }
            }
          }
          try {
            this.assertSyncDeadline(deadlineAt, 'position fetch');
            if (!await this.syncStillEnabled(db, userId, deadlineAt)) return { created, alerted };
            const positions = await this.snap.listAccountPositions(user.snaptradeUserId, userSecret, acct.id);
            this.assertSyncDeadline(deadlineAt, 'position fetch');
            if (!await this.syncStillEnabled(db, userId, deadlineAt)) return { created, alerted };
            const positionCounts = await this.syncPositionDeltas(userId, dbAcct.id, acct.id, user.memberships, positions, opts.suppressBackfill === true, dbConn, orderFetch.historicalComplete, deadlineAt, db, postCommit);
            created += positionCounts.created;
            alerted += positionCounts.alerted;
          } catch (err) {
            if (err instanceof SyncDeadlineExceededError) throw err;
            this.logger.warn(`syncUser(${userId}) account ${acct.id} positions failed: ${(err as Error).message}`);
            await db.auditLog.create({ data: { userId, action: 'broker_sync_positions_failed', metadata: { accountId: acct.id, message: (err as Error).message } } });
          }
          // recentOrders is a realtime add-on that is not enabled for every
          // SnapTrade customer. The standard historical endpoint is sufficient
          // to establish the normal-order baseline and to allow clearly labeled
          // provisional holdings alerts when recentOrders is temporarily flaky.
          this.assertSyncDeadline(deadlineAt, 'order watermark');
          if (orderFetch.historicalComplete) await this.markOrderSynced(db, userId, dbAcct.id);
          this.assertSyncDeadline(deadlineAt, 'order watermark');
        }
      } catch (err) {
        if (err instanceof SyncDeadlineExceededError) throw err;
        // Per-connection isolation: a single failing brokerage must not abort the
        // whole user's sync. Other connections (and a future retry of this one)
        // can still make progress.
        this.logger.warn(`syncUser(${userId}) connection ${conn.id} failed: ${(err as Error).message}`);
        await db.auditLog.create({ data: { userId, action: 'broker_sync_connection_failed', metadata: { authorizationId: conn.id, message: (err as Error).message } } });
      }
    }
    this.assertSyncDeadline(deadlineAt, 'completion audit');
    await db.auditLog.create({ data: { userId, action: 'broker_sync_completed', metadata: { created, alertsQueued: postCommit.tradeAlertIds.size } } });
    return { created, alerted };
  }

  private assertSyncDeadline(deadlineAt: number, phase: string): void {
    if (Date.now() >= deadlineAt) throw new SyncDeadlineExceededError(phase);
  }

  private async syncStillEnabled(db: SyncDatabase, userId: string, deadlineAt: number): Promise<boolean> {
    this.assertSyncDeadline(deadlineAt, 'sync-enabled check');
    const enabled = (await db.user.findUnique({ where: { id: userId }, select: { brokerSyncEnabled: true } }))?.brokerSyncEnabled === true;
    this.assertSyncDeadline(deadlineAt, 'sync-enabled check');
    return enabled;
  }

  /** IDs of every user that has completed SnapTrade registration and can be synced. */
  async listSyncableUserIds(): Promise<string[]> {
    const users = await this.prisma.user.findMany({
      where: {
        brokerSyncEnabled: true,
        snaptradeUserId: { not: null },
        encryptedUserSecret: { not: null },
        brokerConnections: { some: { status: { not: 'DISCONNECTED' } } },
      },
      select: { id: true },
    });
    return users.map((u) => u.id);
  }

  /** Inline sync of every user. Used by the admin `sync-all-now` endpoint; the queue path fans out instead. */
  async syncAll(): Promise<void> {
    for (const id of await this.listSyncableUserIds()) {
      try { await this.syncUser(id); } catch (e) { this.logger.error(`sync failed for ${id}: ${(e as Error).message}`); }
    }
  }

  private async fetchOrders(
    db: SyncDatabase,
    userId: string,
    userSecret: string,
    accountId: string,
    deadlineAt = Date.now() + SYNC.MAX_RUN_MS,
  ): Promise<{ complete: boolean; historicalComplete: boolean; orders: SnapTradeOrder[] }> {
    this.assertSyncDeadline(deadlineAt, 'order fetch');
    const [recent, historical] = await Promise.allSettled([
      this.snap.listRecentAccountOrders(userId, userSecret, accountId),
      this.snap.listAccountOrders(userId, userSecret, accountId, this.config.getOrThrow<number>('TRADE_ORDER_LOOKBACK_DAYS')),
    ]);
    this.assertSyncDeadline(deadlineAt, 'order fetch');
    const failures = [
      ...(recent.status === 'rejected' ? [{ source: 'recent', message: (recent.reason as Error).message }] : []),
      ...(historical.status === 'rejected' ? [{ source: 'historical', message: (historical.reason as Error).message }] : []),
    ];
    if (failures.length) {
      this.logger.warn(`sync account ${accountId} order fetch incomplete: ${failures.map((failure) => `${failure.source}: ${failure.message}`).join('; ')}; processing available orders and preserving last successful order watermark`);
      await db.auditLog.create({
        data: { userId, action: 'broker_sync_orders_failed', metadata: { accountId, failures } },
      });
      this.assertSyncDeadline(deadlineAt, 'order failure audit');
    }
    return {
      complete: failures.length === 0,
      historicalComplete: historical.status === 'fulfilled',
      orders: [
        ...(recent.status === 'fulfilled' && Array.isArray(recent.value) ? recent.value : []),
        ...(historical.status === 'fulfilled' && Array.isArray(historical.value) ? historical.value : []),
      ],
    };
  }

  private async disconnectMissingConnections(db: SyncDatabase, userId: string, remoteAuthorizationIds: string[]) {
    await db.brokerConnection.updateMany({
      where: { userId, status: { not: 'DISCONNECTED' }, authorizationId: { notIn: remoteAuthorizationIds } },
      data: { status: 'DISCONNECTED', disabledReason: 'No longer returned by SnapTrade', disconnectedAt: new Date() },
    });
  }

  private async disconnectMissingAccounts(db: SyncDatabase, connectionId: string, remoteAccountIds: string[]) {
    await db.brokerAccount.updateMany({
      where: { connectionId, status: { not: 'DISCONNECTED' }, providerAccountId: { notIn: remoteAccountIds } },
      data: { status: 'DISCONNECTED' },
    });
  }

  private async lastSuccessfulSyncAt(db: SyncDatabase, userId: string, accountId: string): Promise<Date | null> {
    const state = await db.syncState.findUnique({ where: { userId_accountId_key: { userId, accountId, key: 'last_successful_order_sync' } } });
    if (!state?.value || typeof state.value !== 'object' || Array.isArray(state.value)) return null;
    const at = (state.value as { at?: unknown }).at;
    if (typeof at !== 'string') return null;
    const d = new Date(at);
    return Number.isFinite(d.getTime()) ? d : null;
  }

  private recoverySuppressBefore(): Date | null {
    const getter = (this.config as ConfigService & { get?: <T>(key: string) => T | undefined }).get;
    const raw = typeof getter === 'function' ? getter.call(this.config, 'RECOVERY_SUPPRESS_BEFORE') : undefined;
    if (typeof raw !== 'string') return null;
    if (!raw) return null;
    const date = new Date(raw);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  private async positionSnapshot(db: SyncDatabase, userId: string, accountId: string): Promise<PositionSnapshotEntry[]> {
    const state = await db.syncState.findUnique({ where: { userId_accountId_key: { userId, accountId, key: 'position_snapshot' } } });
    return this.readPositionSnapshot(state?.value);
  }

  private estimateProfit(
    trade: { symbol: string; side: 'BUY' | 'SELL'; quantity?: number; price?: number; assetType?: string },
    previous: PositionSnapshotEntry[],
  ): { amount: number; percent: number } | null {
    if (trade.side !== 'SELL' || trade.quantity === undefined || trade.price === undefined) return null;
    const prior = previous.find((entry) => entry.symbol === trade.symbol);
    if (!prior?.price) return null;
    // Both sides must use the SAME contract multiplier. Earlier code applied
    // 100× to proceeds only, producing absurd PnL for options (e.g. a $300
    // realised gain rendered as $498 / +24,900%). Cost basis is also stored
    // per-share/per-contract; multiply it identically.
    const multiplier = contractMultiplier(trade.assetType as 'OPTION' | 'EQUITY' | 'CRYPTO' | 'FOREX' | 'UNKNOWN' | undefined, trade.symbol);
    const proceeds = trade.price * multiplier * trade.quantity;
    const cost = prior.price * multiplier * trade.quantity;
    if (!Number.isFinite(proceeds) || !Number.isFinite(cost) || cost <= 0) return null;
    const amount = proceeds - cost;
    return { amount, percent: (amount / cost) * 100 };
  }

  private async syncPositionDeltas(
    userId: string,
    dbAccountId: string,
    providerAccountId: string,
    memberships: { groupId: string; sharingEnabledAt: Date | null; group?: { inferredAlertsEnabled: boolean } }[],
    positions: SnapTradePosition[],
    suppressBackfill: boolean,
    broker: { brokerageName?: string | null; brokerageSlug?: string | null } = {},
    orderHistoryComplete = false,
    deadlineAt = Date.now() + SYNC.MAX_RUN_MS,
    db: SyncDatabase = this.prisma,
    postCommit?: SyncPostCommitWork,
  ): Promise<{ created: number; alerted: number }> {
    this.assertSyncDeadline(deadlineAt, 'position delta setup');
    const current = positions
      .map((position) => this.detector.normalizePosition(position))
      .filter((position): position is PositionSnapshotEntry => position !== null);
    const currentByKey = this.positionMap(current);
    const state = await db.syncState.findUnique({ where: { userId_accountId_key: { userId, accountId: dbAccountId, key: 'position_snapshot' } } });
    this.assertSyncDeadline(deadlineAt, 'position snapshot lookup');
    const previous = this.readPositionSnapshot(state?.value);
    const previousByKey = this.positionMap(previous);
    const positionChangeHealth = this.positionChangeHealth(previousByKey, currentByKey);

    let created = 0;
    const alerted = 0;
    const startedAt = Date.now();
    if (state && !suppressBackfill) {
      if (positionChangeHealth === 'PARTIAL_DROP') {
        await this.auditSuspiciousPositionDelta(db, userId, dbAccountId, previous, current, 'partial_drop');
        this.assertSyncDeadline(deadlineAt, 'position anomaly audit');
        return { created, alerted };
      }
      if (positionChangeHealth === 'REHYDRATION') {
        await this.auditSuspiciousPositionDelta(db, userId, dbAccountId, previous, current, 'rehydration');
        this.assertSyncDeadline(deadlineAt, 'position rehydration audit');
        await this.writePositionSnapshot(db, userId, dbAccountId, current);
        this.assertSyncDeadline(deadlineAt, 'position rehydration snapshot');
        return { created, alerted };
      }
      const keys = new Set([...previousByKey.keys(), ...currentByKey.keys()]);
      for (const key of keys) {
        this.assertSyncDeadline(deadlineAt, 'position delta loop');
        const norm = this.detector.normalizePositionDelta(userId, providerAccountId, previousByKey.get(key), currentByKey.get(key));
        if (!norm) continue;
        for (const member of [...memberships].sort((a, b) => a.groupId.localeCompare(b.groupId))) {
          this.assertSyncDeadline(deadlineAt, 'position consent fence');
          const tx = db as Prisma.TransactionClient;
          await acquireGroupDeliveryLock(tx, member.groupId);
          this.assertSyncDeadline(deadlineAt, 'position group delivery lock');
          await acquireUserSafetyLocks(tx, userId, ['delivery']);
          this.assertSyncDeadline(deadlineAt, 'position user delivery lock');

          // Memberships and the first baseline read both predate this consent
          // fence. Refresh both now: OFF -> enabled must establish a baseline
          // strictly after its new epoch, and a baseline that aged out while we
          // waited can never become a provisional alert.
          const currentMember = await db.groupMember.findUnique({
            where: { userId_groupId: { userId, groupId: member.groupId } },
            select: { alertsEnabled: true, privacyLevel: true, sharingEnabledAt: true },
          });
          this.assertSyncDeadline(deadlineAt, 'position consent refresh');
          const fencedBaseline = await db.syncState.findUnique({
            where: { userId_accountId_key: { userId, accountId: dbAccountId, key: 'position_snapshot' } },
            select: { value: true },
          });
          this.assertSyncDeadline(deadlineAt, 'position consent refresh');
          const fencedBaselineAt = this.positionSnapshotAt(fencedBaseline?.value);
          if (
            !currentMember?.alertsEnabled
            || currentMember.privacyLevel === 'OFF'
            || !currentMember.sharingEnabledAt
            || !fencedBaselineAt
            || fencedBaselineAt <= currentMember.sharingEnabledAt
          ) continue;

          const currentGroup = await db.group.findUnique({
            where: { id: member.groupId },
            select: { inferredAlertsEnabled: true },
          });
          this.assertSyncDeadline(deadlineAt, 'position group refresh');
          const provisional = currentGroup?.inferredAlertsEnabled === true
            && supportsProvisionalPositionAlerts(broker)
            && orderHistoryComplete
            && this.positionSnapshotIsFresh(fencedBaseline?.value)
            && !(await this.hasMatchingConfirmedExecution(dbAccountId, member.groupId, norm, db));
          this.assertSyncDeadline(deadlineAt, 'position execution match');
          const dedupe = scopeKeyToGroup(norm.dedupeHash, member.groupId);
          const trade = await db.tradeEvent.upsert({
            where: { dedupeHash: dedupe },
            update: {},
            create: {
              userId,
              groupId: member.groupId,
              accountId: dbAccountId,
              symbol: norm.symbol,
              side: norm.side,
              quantity: norm.quantity,
              price: norm.price,
              priceSource: norm.priceSource,
              assetType: norm.assetType,
              underlying: norm.underlying,
              currency: norm.currency,
              tradeTime: norm.tradeTime,
              rawType: norm.rawType,
              rawStatus: norm.rawStatus,
              rawId: norm.rawId,
              dedupeHash: dedupe,
              backfillStatus: 'NEW',
              // A position snapshot is not proof of a fill. Only an explicitly
              // opted-in, near-real-time broker may post it as a provisional
              // holdings change; delayed brokers remain diagnostic-only.
              alertStatus: provisional ? 'PENDING' : 'SKIPPED',
            },
          });
          this.assertSyncDeadline(deadlineAt, 'position consent fence');
          if (trade.createdAt.getTime() >= startedAt) created += 1;
          if (provisional && trade.alertStatus === 'PENDING') {
            this.assertSyncDeadline(deadlineAt, 'provisional alert scheduling');
            if (postCommit) postCommit.provisionalAlertIds.add(trade.id);
            else await this.scheduleProvisionalAlert(trade.id);
            this.assertSyncDeadline(deadlineAt, 'provisional alert scheduling');
          }
        }
      }
    }

    this.assertSyncDeadline(deadlineAt, 'position snapshot write');
    await this.writePositionSnapshot(db, userId, dbAccountId, current);
    this.assertSyncDeadline(deadlineAt, 'position snapshot write');
    return { created, alerted };
  }

  private async scheduleProvisionalAlert(tradeEventId: string): Promise<void> {
    if (!this.queue) {
      this.logger.warn(`trade-sync queue unavailable; provisional alert ${tradeEventId} left pending for retry`);
      return;
    }
    try {
      await this.queue.add(
        'send-alert',
        { tradeEventId },
        {
          ...JOB_DEFAULTS,
          jobId: `send-alert:${tradeEventId}`,
          delay: ALERT.PROVISIONAL_SEND_GRACE_MS,
        },
      );
    } catch (err) {
      this.logger.warn(`could not schedule provisional alert ${tradeEventId}: ${(err as Error).message}; left pending for retry`);
    }
  }

  private async hasMatchingConfirmedExecution(
    accountId: string,
    groupId: string,
    trade: { symbol: string; side: 'BUY' | 'SELL'; quantity?: number; tradeTime: Date },
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<boolean> {
    const windowMs = ALERT.PROVISIONAL_EXECUTION_MATCH_WINDOW_MS;
    return (await db.tradeEvent.count({
      where: {
        accountId,
        groupId,
        symbol: trade.symbol,
        side: trade.side,
        ...(trade.quantity === undefined ? {} : { quantity: trade.quantity }),
        rawType: { not: 'position_delta' },
        rawStatus: { not: 'INFERRED' },
        tradeTime: {
          gte: new Date(trade.tradeTime.getTime() - windowMs),
          lte: new Date(trade.tradeTime.getTime() + windowMs),
        },
      },
    })) > 0;
  }

  private positionSnapshotIsFresh(value: unknown): boolean {
    const at = this.positionSnapshotAt(value);
    return !!at && Date.now() - at.getTime() <= ALERT.PROVISIONAL_BASELINE_MAX_AGE_MS;
  }

  private positionSnapshotAt(value: unknown): Date | null {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !('at' in value) || typeof value.at !== 'string') return null;
    const at = new Date(value.at);
    return Number.isFinite(at.getTime()) ? at : null;
  }

  private positionChangeHealth(previousByKey: Map<string, PositionSnapshotEntry>, currentByKey: Map<string, PositionSnapshotEntry>): 'OK' | 'PARTIAL_DROP' | 'REHYDRATION' {
    const previousCount = previousByKey.size;
    const currentCount = currentByKey.size;
    if (!previousCount) return 'OK';
    const removedCount = [...previousByKey.keys()].filter((key) => !currentByKey.has(key)).length;
    const addedCount = [...currentByKey.keys()].filter((key) => !previousByKey.has(key)).length;

    if (previousCount >= 3 && removedCount >= Math.ceil(previousCount / 2)) return 'PARTIAL_DROP';
    if (previousCount <= 1 && currentCount >= 3 && addedCount >= 3) return 'REHYDRATION';
    return 'OK';
  }

  private async auditSuspiciousPositionDelta(
    db: SyncDatabase,
    userId: string,
    accountId: string,
    previous: PositionSnapshotEntry[],
    current: PositionSnapshotEntry[],
    reason: string,
  ) {
    await db.auditLog.create({
      data: {
        userId,
        action: 'broker_sync_position_delta_suppressed',
        metadata: {
          reason,
          accountId,
          previousCount: previous.length,
          currentCount: current.length,
          previousSymbols: previous.map((entry) => entry.symbol).sort(),
          currentSymbols: current.map((entry) => entry.symbol).sort(),
        },
      },
    });
  }

  private positionMap(entries: PositionSnapshotEntry[]): Map<string, PositionSnapshotEntry> {
    return new Map(entries.map((entry) => [entry.symbolId ?? entry.symbol, entry]));
  }

  private readPositionSnapshot(value: unknown): PositionSnapshotEntry[] {
    if (!value || typeof value !== 'object') return [];
    const rawPositions = Array.isArray(value) ? value : 'positions' in value && Array.isArray(value.positions) ? value.positions : [];
    return rawPositions.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const symbol = 'symbol' in entry && typeof entry.symbol === 'string' ? entry.symbol : null;
      const quantity = 'quantity' in entry && typeof entry.quantity === 'number' ? entry.quantity : null;
      if (!symbol || quantity === null || isExcludedBotSymbol(symbol)) return [];
      return [{
        symbol,
        symbolId: 'symbolId' in entry && typeof entry.symbolId === 'string' ? entry.symbolId : undefined,
        quantity,
        price: 'price' in entry && typeof entry.price === 'number' ? entry.price : undefined,
        marketPrice: 'marketPrice' in entry && typeof entry.marketPrice === 'number' ? entry.marketPrice : undefined,
        openPnl: 'openPnl' in entry && typeof entry.openPnl === 'number' ? entry.openPnl : undefined,
        currency: 'currency' in entry && typeof entry.currency === 'string' ? entry.currency : undefined,
      }];
    });
  }

  private async writePositionSnapshot(db: SyncDatabase, userId: string, accountId: string, positions: PositionSnapshotEntry[]) {
    await db.syncState.upsert({
      where: { userId_accountId_key: { userId, accountId, key: 'position_snapshot' } },
      update: { value: { at: new Date().toISOString(), positions } },
      create: { userId, accountId, key: 'position_snapshot', value: { at: new Date().toISOString(), positions } },
    });
  }

  private async markOrderSynced(db: SyncDatabase, userId: string, accountId: string) {
    await db.syncState.upsert({
      where: { userId_accountId_key: { userId, accountId, key: 'last_successful_order_sync' } },
      update: { value: { at: new Date().toISOString() } },
      create: { userId, accountId, key: 'last_successful_order_sync', value: { at: new Date().toISOString() } },
    });
  }

  private accountTypeFrom(acct: { raw_type?: string; meta?: Record<string, unknown> }): string | undefined {
    const metaType = acct.meta?.brokerage_account_type ?? acct.meta?.type;
    const type = acct.raw_type ?? (typeof metaType === 'string' ? metaType : undefined);
    return type?.trim() || undefined;
  }
}
