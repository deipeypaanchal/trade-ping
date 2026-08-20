import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, PrivacyLevel } from '@prisma/client';
import { PrismaService } from '../config/prisma.service';
import { acquireGroupDeliveryLock, acquireUserSafetyLocks, DELIVERY_FENCE_TRANSACTION } from '../security/user-safety-lock';

@Injectable()
export class PrivacyService {
  constructor(private prisma: PrismaService) {}

  async setPrivacy(userId: string, groupId: string, levelRaw: string) {
    const level = levelRaw.toUpperCase() as PrivacyLevel;
    if (!Object.values(PrivacyLevel).includes(level)) throw new BadRequestException('Invalid privacy level');
    const enabled = level !== 'OFF';

    // Flip the database state closed before waiting for an in-flight delivery.
    // That prevents other queued senders from overtaking the safety command.
    if (!enabled) await this.failClosed(userId, groupId);

    await this.prisma.$transaction(async (tx) => {
      await acquireGroupDeliveryLock(tx, groupId);
      await acquireUserSafetyLocks(tx, userId, ['delivery']);
      if (enabled) {
        const lifecycle = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { deletionPendingAt: true } });
        if (lifecycle.deletionPendingAt) throw new BadRequestException('Account deletion is pending; sharing cannot be enabled.');
      }
      const existing = await tx.groupMember.findUnique({ where: { userId_groupId: { userId, groupId } } });
      const sharingEnabledAt = enabled
        ? existing?.alertsEnabled && existing.privacyLevel !== 'OFF' && existing.sharingEnabledAt
          ? existing.sharingEnabledAt
          : new Date()
        : null;
      await tx.groupMember.upsert({
        where: { userId_groupId: { userId, groupId } },
        update: { privacyLevel: level, alertsEnabled: enabled, sharingEnabledAt },
        create: { userId, groupId, privacyLevel: level, alertsEnabled: enabled, sharingEnabledAt },
      });

      if (!enabled) {
        await tx.tradeEvent.updateMany({
          where: { userId, groupId, alertStatus: { in: ['PENDING', 'SENDING'] } },
          data: { alertStatus: 'SKIPPED' },
        });
      }

      await tx.auditLog.create({
        data: {
          userId,
          action: 'privacy_updated',
          metadata: { groupId, level, sharingEnabledAt: sharingEnabledAt?.toISOString() ?? null },
        },
      });
    }, DELIVERY_FENCE_TRANSACTION);
  }

  async disableSharing(userId: string, groupId: string, reason: string): Promise<void> {
    await this.failClosed(userId, groupId);
    await this.prisma.$transaction(async (tx) => {
      await acquireGroupDeliveryLock(tx, groupId);
      await acquireUserSafetyLocks(tx, userId, ['delivery']);
      await tx.groupMember.updateMany({
        where: { userId, groupId },
        data: { privacyLevel: 'OFF', alertsEnabled: false, sharingEnabledAt: null },
      });
      await tx.tradeEvent.updateMany({
        where: { userId, groupId, alertStatus: { in: ['PENDING', 'SENDING'] } },
        data: { alertStatus: 'SKIPPED' },
      });
      await tx.auditLog.create({ data: { userId, action: 'group_sharing_disabled', metadata: { groupId, reason } } });
    }, DELIVERY_FENCE_TRANSACTION);
  }

  async disableGroupSharing(groupId: string, reason: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.groupMember.updateMany({
        where: { groupId },
        data: { privacyLevel: 'OFF', alertsEnabled: false, sharingEnabledAt: null },
      });
      await tx.tradeEvent.updateMany({
        where: { groupId, alertStatus: { in: ['PENDING', 'SENDING'] } },
        data: { alertStatus: 'SKIPPED' },
      });
    });

    await this.prisma.$transaction(async (tx) => {
      await acquireGroupDeliveryLock(tx, groupId);
      await tx.groupMember.updateMany({
        where: { groupId },
        data: { privacyLevel: 'OFF', alertsEnabled: false, sharingEnabledAt: null },
      });
      await tx.tradeEvent.updateMany({
        where: { groupId, alertStatus: { in: ['PENDING', 'SENDING'] } },
        data: { alertStatus: 'SKIPPED' },
      });
      await tx.auditLog.create({ data: { action: 'group_sharing_disabled', metadata: { groupId, reason } } });
    }, DELIVERY_FENCE_TRANSACTION);
  }

  async setInferredAlerts(groupId: string, enabled: boolean): Promise<void> {
    const cancelPending = async (tx: Prisma.TransactionClient | PrismaService) => {
      await tx.group.update({ where: { id: groupId }, data: { inferredAlertsEnabled: enabled } });
      if (!enabled) {
        await tx.tradeEvent.updateMany({
          where: {
            groupId,
            alertStatus: { in: ['PENDING', 'SENDING'] },
            OR: [{ rawType: 'position_delta' }, { rawStatus: 'INFERRED' }],
          },
          data: { alertStatus: 'SKIPPED' },
        });
      }
    };

    // Close the public state immediately, then wait for the group fence so the
    // admin command cannot return while a previously claimed provisional send
    // is still in flight.
    if (!enabled) await this.prisma.$transaction(cancelPending);
    await this.prisma.$transaction(async (tx) => {
      await acquireGroupDeliveryLock(tx, groupId);
      await cancelPending(tx);
      await tx.auditLog.create({
        data: {
          action: 'inferred_alerts_updated',
          metadata: { groupId, enabled },
        },
      });
    }, DELIVERY_FENCE_TRANSACTION);
  }

  private async failClosed(userId: string, groupId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.groupMember.updateMany({
        where: { userId, groupId },
        data: { privacyLevel: 'OFF', alertsEnabled: false, sharingEnabledAt: null },
      });
      await tx.tradeEvent.updateMany({
        where: { userId, groupId, alertStatus: { in: ['PENDING', 'SENDING'] } },
        data: { alertStatus: 'SKIPPED' },
      });
    });
  }
}
