import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../config/prisma.service';
import { CryptoService } from '../security/crypto.service';
import { SnaptradeService } from '../snaptrade/snaptrade.service';
import { TradeDetectorService } from './trade-detector.service';
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
    const userSecret = this.crypto.decrypt(user.encryptedUserSecret);
    const connections = await this.snap.listConnections(user.snaptradeUserId, userSecret);
    let created = 0, alerted = 0;
    for (const conn of connections) {
      const dbConn = await this.prisma.brokerConnection.upsert({
        where: { authorizationId: conn.id },
        update: { brokerageName: conn.brokerage?.display_name ?? conn.brokerage?.name, brokerageSlug: conn.brokerage?.slug, connectionType: conn.type ?? 'read', status: conn.disabled ? 'DISABLED' : 'ACTIVE' },
        create: { userId, authorizationId: conn.id, brokerageName: conn.brokerage?.display_name ?? conn.brokerage?.name, brokerageSlug: conn.brokerage?.slug, connectionType: conn.type ?? 'read', status: conn.disabled ? 'DISABLED' : 'ACTIVE' },
      });
      if (conn.disabled) continue;
      const accounts = await this.snap.listAccounts(user.snaptradeUserId, userSecret, conn.id);
      for (const acct of accounts) {
        const acctNameHash = acct.name ? this.crypto.hash(acct.name) : undefined;
        const dbAcct = await this.prisma.brokerAccount.upsert({
          where: { connectionId_providerAccountId: { connectionId: dbConn.id, providerAccountId: acct.id } },
          update: { accountNameHash: acctNameHash, status: 'ACTIVE' },
          create: { connectionId: dbConn.id, providerAccountId: acct.id, accountNameHash: acctNameHash, status: 'ACTIVE' },
        });
        const orders = await this.snap.listAccountOrders(user.snaptradeUserId, userSecret, acct.id, this.config.getOrThrow<number>('TRADE_ORDER_LOOKBACK_DAYS'));
        for (const order of orders) {
          const norm = this.detector.normalizeOrder(userId, acct.id, order);
          if (!norm) continue;
          const suppress = opts.suppressBackfill || await this.shouldSuppressAsBackfill(userId, dbAcct.id, norm.tradeTime);
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
              const sent = await this.alerts.sendTradeAlert(trade.id);
              if (sent) alerted += 1;
            }
          }
        }
        await this.markSynced(userId, dbAcct.id);
      }
    }
    await this.prisma.auditLog.create({ data: { userId, action: 'broker_sync_completed', metadata: { created, alerted } } });
    if (created || alerted) this.logger.log(`sync completed for ${userId}: created=${created} alerted=${alerted}`);
    return { created, alerted };
  }

  async syncAll(): Promise<void> {
    const users = await this.prisma.user.findMany({ where: { snaptradeUserId: { not: null }, encryptedUserSecret: { not: null } }, select: { id: true } });
    for (const u of users) {
      try { await this.syncUser(u.id); } catch (e) { this.logger.error(`sync failed for ${u.id}: ${(e as Error).message}`); }
    }
  }

  private async shouldSuppressAsBackfill(userId: string, accountId: string, tradeTime: Date): Promise<boolean> {
    const state = await this.prisma.syncState.findUnique({ where: { userId_accountId_key: { userId, accountId, key: 'last_successful_order_sync' } } });
    if (!state) {
      const cutoff = Date.now() - this.config.getOrThrow<number>('BACKFILL_SUPPRESS_HOURS') * 3600_000;
      return tradeTime.getTime() < cutoff;
    }
    return false;
  }

  private async markSynced(userId: string, accountId: string) {
    await this.prisma.syncState.upsert({
      where: { userId_accountId_key: { userId, accountId, key: 'last_successful_order_sync' } },
      update: { value: { at: new Date().toISOString() } },
      create: { userId, accountId, key: 'last_successful_order_sync', value: { at: new Date().toISOString() } },
    });
  }
}
