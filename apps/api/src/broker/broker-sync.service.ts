import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../config/prisma.service';
import { CryptoService } from '../security/crypto.service';
import { EncryptedSecretError } from '../security/errors';
import { SnapTradePosition } from '../snaptrade/snaptrade.types';
import { SnaptradeService } from '../snaptrade/snaptrade.service';
import { PositionSnapshotEntry, TradeDetectorService } from './trade-detector.service';
import { AlertService } from '../alerts/alert.service';

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
  ) {}

  async syncUser(userId: string, opts: { suppressBackfill?: boolean } = {}): Promise<{ created: number; alerted: number }> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: {
        memberships: {
          where: { group: { telegramChatId: { startsWith: '-' } } },
        },
      },
    });
    if (!user.snaptradeUserId || !user.encryptedUserSecret) return { created: 0, alerted: 0 };

    // Decrypt up front. If the encryption key rotated or the payload is corrupted,
    // mark the user's connections as disconnected so they're prompted to /connect
    // again instead of cycling through worker retries forever.
    let userSecret: string;
    try {
      userSecret = this.crypto.decrypt(user.encryptedUserSecret);
    } catch (err) {
      if (err instanceof EncryptedSecretError) {
        this.logger.error(`decrypt failed for user ${userId}: ${err.message}; marking connections DISCONNECTED`);
        await this.prisma.brokerConnection.updateMany({
          where: { userId, status: { not: 'DISCONNECTED' } },
          data: { status: 'DISCONNECTED', disabledReason: 'Encryption key mismatch — please /connect again', disconnectedAt: new Date() },
        });
        await this.prisma.auditLog.create({ data: { userId, action: 'broker_sync_failed', metadata: { reason: 'decrypt_failed' } } });
        return { created: 0, alerted: 0 };
      }
      throw err;
    }

    let created = 0, alerted = 0;
    let connections;
    try {
      connections = await this.snap.listConnections(user.snaptradeUserId, userSecret);
    } catch (err) {
      this.logger.warn(`syncUser(${userId}) listConnections failed: ${(err as Error).message}; skipping this run`);
      await this.prisma.auditLog.create({ data: { userId, action: 'broker_sync_failed', metadata: { reason: 'list_connections_failed', message: (err as Error).message } } });
      return { created, alerted };
    }

    for (const conn of connections) {
      try {
        const dbConn = await this.prisma.brokerConnection.upsert({
          where: { authorizationId: conn.id },
          update: { brokerageName: conn.brokerage?.display_name ?? conn.brokerage?.name, brokerageSlug: conn.brokerage?.slug, connectionType: conn.type ?? 'read', status: conn.disabled ? 'DISABLED' : 'ACTIVE' },
          create: { userId, authorizationId: conn.id, brokerageName: conn.brokerage?.display_name ?? conn.brokerage?.name, brokerageSlug: conn.brokerage?.slug, connectionType: conn.type ?? 'read', status: conn.disabled ? 'DISABLED' : 'ACTIVE' },
        });
        if (conn.disabled) continue;
        const accounts = await this.snap.listAccounts(user.snaptradeUserId, userSecret, conn.id);
        for (const acct of accounts) {
          const acctNameHash = acct.name ? this.crypto.hash(acct.name) : undefined;
          const accountType = this.accountTypeFrom(acct);
          const dbAcct = await this.prisma.brokerAccount.upsert({
            where: { connectionId_providerAccountId: { connectionId: dbConn.id, providerAccountId: acct.id } },
            update: { accountNameHash: acctNameHash, accountType, status: 'ACTIVE' },
            create: { connectionId: dbConn.id, providerAccountId: acct.id, accountNameHash: acctNameHash, accountType, status: 'ACTIVE' },
          });
          const orders = [
            ...(await this.snap.listRecentAccountOrders(user.snaptradeUserId, userSecret, acct.id)),
            ...(await this.snap.listAccountOrders(user.snaptradeUserId, userSecret, acct.id, this.config.getOrThrow<number>('TRADE_ORDER_LOOKBACK_DAYS'))),
          ];
          const seenOrderHashes = new Set<string>();
          // First sync for an account establishes a baseline: every order returned is
          // pre-existing history, so suppress it all rather than flooding the group.
          // After the baseline, only genuinely stale orders (older than the suppress
          // window, e.g. a broker surfacing a backdated fill) are suppressed.
          const isFirstSync = !(await this.hasSyncState(userId, dbAcct.id));
          const staleCutoff = Date.now() - this.config.getOrThrow<number>('BACKFILL_SUPPRESS_HOURS') * 3600_000;
          for (const order of orders) {
            const norm = this.detector.normalizeOrder(userId, acct.id, order);
            if (!norm) continue;
            if (seenOrderHashes.has(norm.dedupeHash)) continue;
            seenOrderHashes.add(norm.dedupeHash);
            const suppress = opts.suppressBackfill || isFirstSync || norm.tradeTime.getTime() < staleCutoff;
            for (const member of user.memberships) {
              const trade = await this.prisma.tradeEvent.upsert({
                where: { dedupeHash: `${norm.dedupeHash}:${member.groupId}` },
                update: {},
                create: {
                  userId,
                  groupId: member.groupId,
                  accountId: dbAcct.id,
                  symbol: norm.symbol,
                  side: norm.side,
                  quantity: norm.quantity,
                  price: norm.price,
                  currency: norm.currency,
                  tradeTime: norm.tradeTime,
                  rawType: norm.rawType,
                  rawStatus: norm.rawStatus,
                  rawId: norm.rawId,
                  dedupeHash: `${norm.dedupeHash}:${member.groupId}`,
                  backfillStatus: suppress ? 'BACKFILL' : 'NEW',
                  alertStatus: suppress ? 'SKIPPED' : 'PENDING',
                },
              });
              if (trade.createdAt.getTime() > Date.now() - 10_000) created += 1;
              if (!suppress && trade.alertStatus === 'PENDING') {
                try {
                  if (await this.alerts.sendTradeAlert(trade.id)) alerted += 1;
                } catch (e) {
                  this.logger.warn(`alert send threw for trade ${trade.id}: ${(e as Error).message}`);
                }
              }
            }
          }
          try {
            const positions = await this.snap.listAccountPositions(user.snaptradeUserId, userSecret, acct.id);
            const positionCounts = await this.syncPositionDeltas(userId, dbAcct.id, acct.id, user.memberships, positions, opts.suppressBackfill === true);
            created += positionCounts.created;
            alerted += positionCounts.alerted;
          } catch (err) {
            this.logger.warn(`syncUser(${userId}) account ${acct.id} positions failed: ${(err as Error).message}`);
            await this.prisma.auditLog.create({ data: { userId, action: 'broker_sync_positions_failed', metadata: { accountId: acct.id, message: (err as Error).message } } });
          }
          await this.markSynced(userId, dbAcct.id);
        }
      } catch (err) {
        // Per-connection isolation: a single failing brokerage must not abort the
        // whole user's sync. Other connections (and a future retry of this one)
        // can still make progress.
        this.logger.warn(`syncUser(${userId}) connection ${conn.id} failed: ${(err as Error).message}`);
        await this.prisma.auditLog.create({ data: { userId, action: 'broker_sync_connection_failed', metadata: { authorizationId: conn.id, message: (err as Error).message } } });
      }
    }
    await this.prisma.auditLog.create({ data: { userId, action: 'broker_sync_completed', metadata: { created, alerted } } });
    if (created || alerted) this.logger.log(`sync completed for ${userId}: created=${created} alerted=${alerted}`);
    return { created, alerted };
  }

  /** IDs of every user that has completed SnapTrade registration and can be synced. */
  async listSyncableUserIds(): Promise<string[]> {
    const users = await this.prisma.user.findMany({ where: { snaptradeUserId: { not: null }, encryptedUserSecret: { not: null } }, select: { id: true } });
    return users.map((u) => u.id);
  }

  /** Inline sync of every user. Used by the admin `sync-all-now` endpoint; the queue path fans out instead. */
  async syncAll(): Promise<void> {
    for (const id of await this.listSyncableUserIds()) {
      try { await this.syncUser(id); } catch (e) { this.logger.error(`sync failed for ${id}: ${(e as Error).message}`); }
    }
  }

  private async hasSyncState(userId: string, accountId: string): Promise<boolean> {
    const state = await this.prisma.syncState.findUnique({ where: { userId_accountId_key: { userId, accountId, key: 'last_successful_order_sync' } } });
    return state !== null;
  }

  private async syncPositionDeltas(
    userId: string,
    dbAccountId: string,
    providerAccountId: string,
    memberships: { groupId: string }[],
    positions: SnapTradePosition[],
    suppressBackfill: boolean,
  ): Promise<{ created: number; alerted: number }> {
    const current = positions
      .map((position) => this.detector.normalizePosition(position))
      .filter((position): position is PositionSnapshotEntry => position !== null);
    const currentByKey = this.positionMap(current);
    const state = await this.prisma.syncState.findUnique({ where: { userId_accountId_key: { userId, accountId: dbAccountId, key: 'position_snapshot' } } });
    const previous = this.readPositionSnapshot(state?.value);
    const previousByKey = this.positionMap(previous);

    let created = 0, alerted = 0;
    const startedAt = Date.now();
    if (state && !suppressBackfill) {
      const keys = new Set([...previousByKey.keys(), ...currentByKey.keys()]);
      for (const key of keys) {
        const norm = this.detector.normalizePositionDelta(userId, providerAccountId, previousByKey.get(key), currentByKey.get(key));
        if (!norm) continue;
        for (const member of memberships) {
          const trade = await this.prisma.tradeEvent.upsert({
            where: { dedupeHash: `${norm.dedupeHash}:${member.groupId}` },
            update: {},
            create: {
              userId,
              groupId: member.groupId,
              accountId: dbAccountId,
              symbol: norm.symbol,
              side: norm.side,
              quantity: norm.quantity,
              price: norm.price,
              currency: norm.currency,
              tradeTime: norm.tradeTime,
              rawType: norm.rawType,
              rawStatus: norm.rawStatus,
              rawId: norm.rawId,
              dedupeHash: `${norm.dedupeHash}:${member.groupId}`,
              backfillStatus: 'NEW',
              alertStatus: 'PENDING',
            },
          });
          if (trade.createdAt.getTime() >= startedAt) created += 1;
          if (trade.alertStatus === 'PENDING') {
            try {
              if (await this.alerts.sendTradeAlert(trade.id)) alerted += 1;
            } catch (e) {
              this.logger.warn(`alert send threw for position delta ${trade.id}: ${(e as Error).message}`);
            }
          }
        }
      }
    }

    await this.writePositionSnapshot(userId, dbAccountId, current);
    return { created, alerted };
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
      if (!symbol || quantity === null) return [];
      return [{
        symbol,
        symbolId: 'symbolId' in entry && typeof entry.symbolId === 'string' ? entry.symbolId : undefined,
        quantity,
        price: 'price' in entry && typeof entry.price === 'number' ? entry.price : undefined,
        currency: 'currency' in entry && typeof entry.currency === 'string' ? entry.currency : undefined,
      }];
    });
  }

  private async writePositionSnapshot(userId: string, accountId: string, positions: PositionSnapshotEntry[]) {
    await this.prisma.syncState.upsert({
      where: { userId_accountId_key: { userId, accountId, key: 'position_snapshot' } },
      update: { value: { at: new Date().toISOString(), positions } },
      create: { userId, accountId, key: 'position_snapshot', value: { at: new Date().toISOString(), positions } },
    });
  }

  private async markSynced(userId: string, accountId: string) {
    await this.prisma.syncState.upsert({
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
