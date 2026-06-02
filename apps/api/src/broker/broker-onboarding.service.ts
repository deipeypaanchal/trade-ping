import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../config/prisma.service';
import { SnaptradeService } from '../snaptrade/snaptrade.service';
import { CryptoService } from '../security/crypto.service';
import { EncryptedSecretError } from '../security/errors';

@Injectable()
export class BrokerOnboardingService {
  private readonly logger = new Logger(BrokerOnboardingService.name);
  constructor(private prisma: PrismaService, private snap: SnaptradeService, private crypto: CryptoService) {}

  async createConnectUrl(userId: string, groupId: string): Promise<string> {
    const user = await this.registeredUser(userId);
    const url = await this.snap.connectionPortal(user.snaptradeUserId!, this.crypto.decrypt(user.encryptedUserSecret!), groupId);
    await this.audit(user.id, 'connection_portal_created', { groupId, sessionId: url.sessionId });
    if (!url.redirectURI) throw new Error('SnapTrade did not return redirectURI');
    return url.redirectURI;
  }

  async createReconnectUrl(userId: string, groupId: string, brokerRaw?: string): Promise<string> {
    const user = await this.registeredUser(userId);
    const broken = await this.prisma.brokerConnection.findMany({
      where: { userId, status: { in: ['DISABLED', 'ERROR'] } },
      orderBy: { updatedAt: 'desc' },
    });
    const broker = brokerRaw?.trim().toLowerCase();
    const matches = broker
      ? broken.filter((conn) => [conn.brokerageName, conn.brokerageSlug].some((name) => name?.toLowerCase().includes(broker)))
      : broken;
    if (!matches.length) throw new BadRequestException('No disabled brokerage connection matched. Run /status to check your connections.');
    if (matches.length > 1) throw new BadRequestException('More than one connection needs repair. Run /reconnect followed by the brokerage name, for example /reconnect Robinhood.');
    const connection = matches[0];
    const url = await this.snap.connectionPortal(user.snaptradeUserId!, this.crypto.decrypt(user.encryptedUserSecret!), groupId, connection.authorizationId);
    await this.audit(user.id, 'reconnect_portal_created', { groupId, authorizationId: connection.authorizationId, sessionId: url.sessionId });
    if (!url.redirectURI) throw new Error('SnapTrade did not return reconnect redirectURI');
    return url.redirectURI;
  }

  private async registeredUser(userId: string) {
    let user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.snaptradeUserId || !user.encryptedUserSecret) {
      const snapUser = await this.snap.registerUser(user.id);
      user = await this.prisma.user.update({ where: { id: user.id }, data: {
        snaptradeUserId: snapUser.userId,
        encryptedUserSecret: this.crypto.encrypt(snapUser.userSecret),
      }});
      await this.audit(user.id, 'snaptrade_user_registered', {});
    }
    return user;
  }

  async refreshConnections(userId: string): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.snaptradeUserId || !user.encryptedUserSecret) return;
    const secret = this.crypto.decrypt(user.encryptedUserSecret);
    const conns = await this.snap.listConnections(user.snaptradeUserId, secret);
    for (const c of conns) {
      const connection = await this.prisma.brokerConnection.upsert({
        where: { authorizationId: c.id },
        update: {
          brokerageName: c.brokerage?.display_name ?? c.brokerage?.name,
          brokerageSlug: c.brokerage?.slug,
          connectionType: c.type ?? 'read',
          status: c.disabled ? 'DISABLED' : 'ACTIVE',
          disabledReason: c.disabled ? 'SnapTrade reports connection disabled' : null,
        },
        create: {
          userId,
          authorizationId: c.id,
          brokerageName: c.brokerage?.display_name ?? c.brokerage?.name,
          brokerageSlug: c.brokerage?.slug,
          connectionType: c.type ?? 'read',
          status: c.disabled ? 'DISABLED' : 'ACTIVE',
        },
      });
      if (!c.disabled) {
        const accounts = await this.snap.listAccounts(user.snaptradeUserId, secret, c.id);
        for (const acct of accounts) {
          await this.prisma.brokerAccount.upsert({
            where: { connectionId_providerAccountId: { connectionId: connection.id, providerAccountId: acct.id } },
            update: {
              accountNameHash: acct.name ? this.crypto.hash(acct.name) : undefined,
              accountType: this.accountTypeFrom(acct),
              status: 'ACTIVE',
            },
            create: {
              connectionId: connection.id,
              providerAccountId: acct.id,
              accountNameHash: acct.name ? this.crypto.hash(acct.name) : undefined,
              accountType: this.accountTypeFrom(acct),
              status: 'ACTIVE',
            },
          });
        }
      }
    }
    await this.audit(user.id, 'connections_refreshed', { count: conns.length });
  }

  async disconnectAll(userId: string): Promise<number> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    let count = 0;
    let remoteFailures = 0;
    if (user.snaptradeUserId && user.encryptedUserSecret) {
      let secret: string;
      try {
        secret = this.crypto.decrypt(user.encryptedUserSecret);
      } catch (err) {
        // The user's secret is unreadable (key rotation, corrupted ciphertext).
        // Flip local state, audit, and surface the failure to the caller so the
        // Telegram handler can show "contact support" instead of the misleading
        // "you had no active brokerage connections".
        if (!(err instanceof EncryptedSecretError)) throw err;
        this.logger.warn(`disconnectAll(${userId}): decrypt failed; flipping local state only`);
        await this.prisma.brokerConnection.updateMany({ where: { userId }, data: { status: 'DISCONNECTED', disconnectedAt: new Date() } });
        await this.audit(userId, 'brokerages_disconnected', { count: 0, decryptFailed: true });
        throw new EncryptedSecretError('Your encrypted brokerage secret could not be read. Reconnect via /connect, or contact support.', err);
      }
      const conns = await this.snap.listConnections(user.snaptradeUserId, secret);
      for (const c of conns) {
        try {
          await this.snap.deleteConnection(user.snaptradeUserId, secret, c.id);
          count += 1;
        } catch (err) {
          remoteFailures += 1;
          this.logger.warn(`disconnectAll(${userId}) failed to delete authorization ${c.id}: ${(err as Error).message}`);
        }
      }
    }
    await this.prisma.brokerConnection.updateMany({ where: { userId }, data: { status: 'DISCONNECTED', disconnectedAt: new Date() } });
    await this.audit(userId, 'brokerages_disconnected', { count, remoteFailures });
    return count;
  }

  private async audit(userId: string, action: string, metadata: object) {
    await this.prisma.auditLog.create({ data: { userId, action, metadata } });
  }

  private accountTypeFrom(acct: { raw_type?: string; meta?: Record<string, unknown> }): string | undefined {
    const metaType = acct.meta?.brokerage_account_type ?? acct.meta?.type;
    const type = acct.raw_type ?? (typeof metaType === 'string' ? metaType : undefined);
    return type?.trim() || undefined;
  }
}
