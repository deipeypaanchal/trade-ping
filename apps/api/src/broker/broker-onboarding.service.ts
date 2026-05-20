import { Injectable } from '@nestjs/common';
import { PrismaService } from '../config/prisma.service';
import { SnaptradeService } from '../snaptrade/snaptrade.service';
import { CryptoService } from '../security/crypto.service';

@Injectable()
export class BrokerOnboardingService {
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
    if (user.snaptradeUserId && user.encryptedUserSecret) {
      const secret = this.crypto.decrypt(user.encryptedUserSecret);
      const conns = await this.snap.listConnections(user.snaptradeUserId, secret);
      for (const c of conns) {
        try { await this.snap.deleteConnection(user.snaptradeUserId, secret, c.id); count += 1; } catch {}
      }
    }
    await this.prisma.brokerConnection.updateMany({ where: { userId }, data: { status: 'DISCONNECTED', disconnectedAt: new Date() } });
    await this.audit(userId, 'brokerages_disconnected', { count });
    return count;
  }

  private async audit(userId: string, action: string, metadata: object) {
    await this.prisma.auditLog.create({ data: { userId, action, metadata } });
  }
}
