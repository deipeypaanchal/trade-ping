import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../config/prisma.service';
import { SnaptradeService } from '../snaptrade/snaptrade.service';
import { CryptoService } from '../security/crypto.service';
import { EncryptedSecretError } from '../security/errors';

@Injectable()
export class BrokerOnboardingService {
  private readonly logger = new Logger(BrokerOnboardingService.name);
  constructor(private prisma: PrismaService, private snap: SnaptradeService, private crypto: CryptoService) {}

  async createConnectUrl(userId: string, groupId: string): Promise<string> {
    let user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.snaptradeUserId || !user.encryptedUserSecret) {
      const snapUser = await this.snap.registerUser(user.id);
      user = await this.prisma.user.update({ where: { id: user.id }, data: {
        snaptradeUserId: snapUser.userId,
        encryptedUserSecret: this.crypto.encrypt(snapUser.userSecret),
      }});
      await this.audit(user.id, 'snaptrade_user_registered', {});
    }
    const url = await this.snap.connectionPortal(user.snaptradeUserId!, this.crypto.decrypt(user.encryptedUserSecret!), groupId);
    await this.audit(user.id, 'connection_portal_created', { groupId, sessionId: url.sessionId });
    if (!url.redirectURI) throw new Error('SnapTrade did not return redirectURI');
    return url.redirectURI;
  }

  async refreshConnections(userId: string): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.snaptradeUserId || !user.encryptedUserSecret) return;
    const secret = this.crypto.decrypt(user.encryptedUserSecret);
    const conns = await this.snap.listConnections(user.snaptradeUserId, secret);
    for (const c of conns) {
      await this.prisma.brokerConnection.upsert({
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
        // Can't talk to SnapTrade without the secret; still flip local state so
        // the user is freed from broken connections. Surface in audit log.
        if (!(err instanceof EncryptedSecretError)) throw err;
        this.logger.warn(`disconnectAll(${userId}): decrypt failed; flipping local state only`);
        await this.prisma.brokerConnection.updateMany({ where: { userId }, data: { status: 'DISCONNECTED', disconnectedAt: new Date() } });
        await this.audit(userId, 'brokerages_disconnected', { count: 0, decryptFailed: true });
        return 0;
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
}
