import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { Queue } from 'bullmq';
import { createHash, randomUUID } from 'crypto';
import { Request } from 'express';
import { JOB_DEFAULTS, WEBHOOK } from '../config/constants';
import { PrismaService } from '../config/prisma.service';
import { CryptoService } from '../security/crypto.service';
import { stableStringify } from '../security/stable-json';
import { acquireUserSafetyLocks, WEBHOOK_FENCE_TRANSACTION } from '../security/user-safety-lock';
import { SnaptradeService } from './snaptrade.service';

type SnapWebhook = {
  eventTimestamp?: string;
  userId?: string;
  eventType?: string;
  brokerageAuthorizationId?: string;
  accountId?: string;
  [key: string]: unknown;
};

type WebhookClaim = {
  nonce: string;
  token: string;
  expiresAt: Date;
};

type RouteResult = { completed: true } | { completed: false; rerouteUserId: string };

const SYNC_TRIGGER_EVENTS = new Set([
  'ACCOUNT_HOLDINGS_UPDATED',
  'ACCOUNT_TRANSACTIONS_INITIAL_UPDATE',
  'ACCOUNT_TRANSACTIONS_UPDATED',
  'TRADE_DETECTION',
  'TRADE_UPDATE',
  'NEW_ACCOUNT_AVAILABLE',
  'CONNECTION_ADDED',
  'CONNECTION_FIXED',
  'CONNECTION_UPDATED',
]);

const MAX_ROUTE_ATTEMPTS = 3;

@Controller('snaptrade')
export class SnaptradeWebhookController {
  constructor(
    private crypto: CryptoService,
    private config: ConfigService,
    private prisma: PrismaService,
    @InjectQueue('trade-sync') private queue: Queue,
    private snap: SnaptradeService,
  ) {}

  @Get('callback')
  @Header('content-type', 'text/html; charset=utf-8')
  callback(@Query('mock') mock?: string) {
    const suffix = mock === 'true' ? ' Mock mode completed.' : '';
    return `<main style="font-family: system-ui, sans-serif; max-width: 560px; margin: 64px auto; line-height: 1.5"><h1>Connection accepted</h1><p>${suffix} TradePing is finishing its read-only sync.</p><p>Return to Telegram, run <strong>/status</strong> privately, then choose <strong>/privacy public</strong>, <strong>normal</strong>, or <strong>private</strong> in the intended group. Sharing stays off until you choose, and earlier trades will not be posted.</p></main>`;
  }

  @Post('webhook')
  async webhook(
    @Body() body: SnapWebhook,
    @Headers('signature') signature: string | undefined,
    @Req() req: Request & { rawBody?: string },
  ) {
    const canonical = req.rawBody ?? stableStringify(body);
    const canonicalHash = createHash('sha256').update(canonical).digest('hex');
    const eventJobKey = canonicalHash.slice(0, 16);
    const expected = this.crypto.hmacBase64(
      this.config.getOrThrow<string>('SNAPTRADE_CONSUMER_KEY'),
      canonical,
    );
    if (!this.crypto.safeEqual(signature, expected)) {
      throw new UnauthorizedException('Invalid SnapTrade signature');
    }
    const age = body.eventTimestamp ? Date.now() - new Date(body.eventTimestamp).getTime() : NaN;
    if (!Number.isFinite(age) || age > WEBHOOK.REPLAY_WINDOW_MS || age < -WEBHOOK.FUTURE_TOLERANCE_MS) {
      throw new UnauthorizedException('Stale SnapTrade webhook');
    }

    const claim = await this.claimWebhook(`snaptrade:${canonicalHash}`);
    if (!claim) return { ok: true, replay: true };

    try {
      let affectedUserId = await this.resolveAffectedUserId(body);
      for (let attempt = 0; attempt < MAX_ROUTE_ATTEMPTS; attempt += 1) {
        const result = affectedUserId
          ? await this.processMappedWebhook(body, eventJobKey, claim, affectedUserId)
          : await this.processUnmappedWebhook(body, eventJobKey, claim);
        if (result.completed) return { ok: true };
        affectedUserId = result.rerouteUserId;
      }
      throw new ServiceUnavailableException('SnapTrade webhook mapping changed too often; retry required');
    } catch (err) {
      // A handled failure deliberately expires only this token's lease. A hard
      // process crash leaves the lease in place briefly, then the same signed
      // event is reclaimable without mistaking the crash for completion.
      await this.releaseClaim(claim).catch(() => undefined);
      throw err;
    }
  }

  private async claimWebhook(nonce: string): Promise<WebhookClaim | null> {
    const now = new Date();
    const claim: WebhookClaim = {
      nonce,
      token: randomUUID(),
      expiresAt: new Date(now.getTime() + WEBHOOK.IDEMPOTENCY_TTL_MS),
    };
    const leaseUntil = new Date(now.getTime() + WEBHOOK.PROCESSING_LEASE_MS);
    try {
      await this.prisma.idempotencyKey.create({
        data: {
          key: nonce,
          status: 'PROCESSING',
          leaseUntil,
          processingToken: claim.token,
          completedAt: null,
          expiresAt: claim.expiresAt,
        },
      });
      return claim;
    } catch (err) {
      if ((err as { code?: string }).code !== 'P2002') throw err;
    }

    const reclaimed = await this.prisma.idempotencyKey.updateMany({
      where: { key: nonce, status: 'PROCESSING', leaseUntil: { lte: now } },
      data: {
        leaseUntil,
        processingToken: claim.token,
        completedAt: null,
        expiresAt: claim.expiresAt,
      },
    });
    if (reclaimed.count === 1) return claim;

    const existing = await this.prisma.idempotencyKey.findUnique({
      where: { key: nonce },
      select: { status: true },
    });
    if (existing?.status === 'COMPLETED') return null;
    // Do not acknowledge concurrent in-flight work as completed. A retry after
    // the finite lease is the recovery path if that other process dies.
    throw new ServiceUnavailableException('SnapTrade webhook is already being processed; retry required');
  }

  private async renewClaim(tx: Prisma.TransactionClient, claim: WebhookClaim): Promise<void> {
    const renewed = await tx.idempotencyKey.updateMany({
      where: { key: claim.nonce, status: 'PROCESSING', processingToken: claim.token },
      data: { leaseUntil: new Date(Date.now() + WEBHOOK.PROCESSING_LEASE_MS) },
    });
    if (renewed.count !== 1) throw new ServiceUnavailableException('SnapTrade webhook lease was lost');
  }

  private async completeClaim(tx: Prisma.TransactionClient, claim: WebhookClaim): Promise<void> {
    const completed = await tx.idempotencyKey.updateMany({
      where: { key: claim.nonce, status: 'PROCESSING', processingToken: claim.token },
      data: {
        status: 'COMPLETED',
        leaseUntil: null,
        processingToken: null,
        completedAt: new Date(),
        expiresAt: claim.expiresAt,
      },
    });
    if (completed.count !== 1) throw new ServiceUnavailableException('SnapTrade webhook lease was lost');
  }

  private async releaseClaim(claim: WebhookClaim): Promise<void> {
    await this.prisma.idempotencyKey.updateMany({
      where: { key: claim.nonce, status: 'PROCESSING', processingToken: claim.token },
      // Retain a structurally valid PROCESSING row but make it immediately
      // reclaimable. The next worker replaces this token atomically.
      data: { leaseUntil: new Date(0) },
    });
  }

  private async resolveAffectedUserId(body: SnapWebhook): Promise<string | undefined> {
    const snapUserId = body.userId ? String(body.userId) : undefined;
    if (body.eventType === 'USER_DELETED' && snapUserId) {
      const deletion = await this.prisma.providerDeletion.findUnique({
        where: { provider_providerUserId: { provider: 'snaptrade', providerUserId: snapUserId } },
        select: { localUserId: true },
      });
      if (deletion?.localUserId) return deletion.localUserId;
    }
    if (snapUserId) {
      const user = await this.prisma.user.findUnique({
        where: { snaptradeUserId: snapUserId },
        select: { id: true },
      });
      if (user) return user.id;
    }
    if (body.brokerageAuthorizationId) {
      const connection = await this.prisma.brokerConnection.findUnique({
        where: { authorizationId: String(body.brokerageAuthorizationId) },
        select: { userId: true },
      });
      return connection?.userId;
    }
    return undefined;
  }

  private async processMappedWebhook(
    body: SnapWebhook,
    eventJobKey: string,
    claim: WebhookClaim,
    lockedUserId: string,
  ): Promise<RouteResult> {
    return this.prisma.$transaction(async (tx) => {
      await acquireUserSafetyLocks(tx, lockedUserId, ['sync', 'delivery']);
      await this.renewClaim(tx, claim);

      const snapUserId = body.userId ? String(body.userId) : undefined;
      const authorizationId = body.brokerageAuthorizationId
        ? String(body.brokerageAuthorizationId)
        : undefined;
      const deletion = snapUserId
        ? await tx.providerDeletion.findUnique({
            where: { provider_providerUserId: { provider: 'snaptrade', providerUserId: snapUserId } },
            select: { localUserId: true, purpose: true, status: true },
          })
        : null;
      const mappedUser = snapUserId
        ? await tx.user.findUnique({
            where: { snaptradeUserId: snapUserId },
            select: {
              id: true,
              snaptradeUserId: true,
              encryptedUserSecret: true,
              brokerSyncEnabled: true,
              deletionPendingAt: true,
            },
          })
        : null;
      const connection = authorizationId
        ? await tx.brokerConnection.findUnique({
            where: { authorizationId },
            select: { userId: true },
          })
        : null;
      const lockedUser = await tx.user.findUnique({
        where: { id: lockedUserId },
        select: {
          id: true,
          snaptradeUserId: true,
          encryptedUserSecret: true,
          brokerSyncEnabled: true,
          deletionPendingAt: true,
        },
      });

      const freshAffectedUserId = body.eventType === 'USER_DELETED'
        ? deletion?.localUserId ?? mappedUser?.id
        : mappedUser?.id ?? connection?.userId;
      if (freshAffectedUserId && freshAffectedUserId !== lockedUserId) {
        return { completed: false, rerouteUserId: freshAffectedUserId };
      }

      if (body.eventType === 'USER_DELETED' && deletion) {
        await tx.providerDeletion.updateMany({
          where: { provider: 'snaptrade', providerUserId: snapUserId!, status: { not: 'CONFIRMED' } },
          data: { status: 'CONFIRMED', confirmedAt: new Date(), lastError: null },
        });
        if (deletion.purpose === 'ACCOUNT_DELETION' && deletion.localUserId) {
          await tx.user.deleteMany({ where: { id: deletion.localUserId } });
          await tx.telegramIdentitySuppression.updateMany({
            where: { localUserId: deletion.localUserId, deletionCompletedAt: null },
            data: { deletionCompletedAt: new Date(), localUserId: null },
          });
        }
        await tx.providerDeletion.deleteMany({
          where: { provider: 'snaptrade', providerUserId: snapUserId! },
        });
        await this.completeClaim(tx, claim);
        return { completed: true };
      }

      const currentMapping = !!lockedUser
        && (!snapUserId || lockedUser.snaptradeUserId === snapUserId)
        && (!mappedUser || mappedUser.id === lockedUserId);
      if (!currentMapping) {
        // A delayed event for an old provider generation must not mutate the
        // replacement user, enqueue work, or create a user-scoped audit row.
        await this.completeClaim(tx, claim);
        return { completed: true };
      }

      if (body.eventType === 'USER_DELETED') {
        await this.closeProviderDeletedUser(tx, lockedUserId, snapUserId!);
        await this.completeClaim(tx, claim);
        return { completed: true };
      }

      const accountDeletion = await tx.providerDeletion.findFirst({
        where: {
          localUserId: lockedUserId,
          purpose: 'ACCOUNT_DELETION',
          status: { not: 'CONFIRMED' },
        },
        select: { providerUserId: true },
      });
      const deletionPending = !!lockedUser.deletionPendingAt || !!accountDeletion;

      if (body.eventType === 'CONNECTION_DELETED' && authorizationId) {
        await this.closeProviderDeletedConnection(tx, lockedUserId, authorizationId);
      } else if (body.eventType === 'CONNECTION_BROKEN' && authorizationId && !deletionPending) {
        await tx.brokerConnection.updateMany({
          where: { authorizationId, userId: lockedUserId },
          data: { status: 'ERROR', disabledReason: 'SnapTrade reported CONNECTION_BROKEN' },
        });
      } else if (body.eventType === 'CONNECTION_ADDED'
        && (!lockedUser.brokerSyncEnabled || deletionPending)) {
        await this.revokeUnexpectedAuthorization(tx, lockedUser, authorizationId);
      } else if (body.eventType && SYNC_TRIGGER_EVENTS.has(body.eventType)
        && lockedUser.brokerSyncEnabled && !deletionPending) {
        // BullMQ's stable job id makes a crash after queueing but before the DB
        // commit harmless: a reclaimed event cannot create a second job.
        await this.queue.add(
          'sync-user',
          { userId: lockedUserId },
          { jobId: `sync-user:${lockedUserId}:${eventJobKey}`, ...JOB_DEFAULTS },
        );
      }

      // Pending account deletion must not acquire new retained audit data. The
      // deletion callbacks themselves also avoid an audit after removing or
      // invalidating the provider identity.
      if (!deletionPending && body.eventType !== 'CONNECTION_DELETED') {
        await tx.auditLog.create({
          data: {
            userId: lockedUserId,
            action: 'snaptrade_webhook_received',
            metadata: {
              eventType: body.eventType,
              eventTimestamp: body.eventTimestamp,
              matchedUser: true,
            },
          },
        });
      }
      await this.completeClaim(tx, claim);
      return { completed: true };
    }, WEBHOOK_FENCE_TRANSACTION);
  }

  private async processUnmappedWebhook(
    body: SnapWebhook,
    eventJobKey: string,
    claim: WebhookClaim,
  ): Promise<RouteResult> {
    return this.prisma.$transaction(async (tx) => {
      await this.renewClaim(tx, claim);
      const snapUserId = body.userId ? String(body.userId) : undefined;
      const authorizationId = body.brokerageAuthorizationId
        ? String(body.brokerageAuthorizationId)
        : undefined;
      const deletion = snapUserId
        ? await tx.providerDeletion.findUnique({
            where: { provider_providerUserId: { provider: 'snaptrade', providerUserId: snapUserId } },
            select: { localUserId: true, purpose: true, status: true },
          })
        : null;
      const mappedUser = snapUserId
        ? await tx.user.findUnique({
            where: { snaptradeUserId: snapUserId },
            select: { id: true },
          })
        : null;
      const connection = authorizationId
        ? await tx.brokerConnection.findUnique({
            where: { authorizationId },
            select: { userId: true },
          })
        : null;
      const freshAffectedUserId = body.eventType === 'USER_DELETED'
        ? deletion?.localUserId ?? mappedUser?.id
        : mappedUser?.id ?? connection?.userId;
      if (freshAffectedUserId) {
        return { completed: false, rerouteUserId: freshAffectedUserId };
      }

      if (body.eventType === 'USER_DELETED' && deletion) {
        // A null localUserId means the owning User was already removed. The
        // signed confirmation still retires the provider tombstone.
        await tx.providerDeletion.updateMany({
          where: { provider: 'snaptrade', providerUserId: snapUserId!, status: { not: 'CONFIRMED' } },
          data: { status: 'CONFIRMED', confirmedAt: new Date(), lastError: null },
        });
        await tx.providerDeletion.deleteMany({
          where: { provider: 'snaptrade', providerUserId: snapUserId! },
        });
      } else {
        if (body.eventType && SYNC_TRIGGER_EVENTS.has(body.eventType) && !snapUserId) {
          await this.queue.add('sync-all', {}, { jobId: `sync-all:${eventJobKey}`, ...JOB_DEFAULTS });
        }
        if (body.eventType !== 'USER_DELETED') {
          await tx.auditLog.create({
            data: {
              action: 'snaptrade_webhook_received',
              metadata: {
                eventType: body.eventType,
                eventTimestamp: body.eventTimestamp,
                matchedUser: false,
              },
            },
          });
        }
      }
      await this.completeClaim(tx, claim);
      return { completed: true };
    }, WEBHOOK_FENCE_TRANSACTION);
  }

  private async revokeUnexpectedAuthorization(
    tx: Prisma.TransactionClient,
    user: {
      id: string;
      snaptradeUserId: string | null;
      encryptedUserSecret: string | null;
    },
    authorizationId?: string,
  ): Promise<void> {
    if (!authorizationId || !user.snaptradeUserId || !user.encryptedUserSecret) {
      throw new ServiceUnavailableException('Disabled user received an authorization that cannot yet be revoked');
    }
    const secret = this.crypto.decrypt(user.encryptedUserSecret);
    try {
      await this.snap.deleteConnection(user.snaptradeUserId, secret, authorizationId);
    } catch (err) {
      const status = (err as { status?: unknown; response?: { status?: unknown } }).status
        ?? (err as { response?: { status?: unknown } }).response?.status;
      // A previous attempt may have completed the remote revoke immediately
      // before its transaction/response failed. Provider 404 is terminal-safe.
      if (status !== 404) throw err;
    }
    await tx.brokerConnection.updateMany({
      where: { authorizationId, userId: user.id },
      data: {
        status: 'DISCONNECTED',
        disabledReason: 'Authorization revoked because broker sync was disabled',
        disconnectedAt: new Date(),
      },
    });
  }

  private async closeProviderDeletedUser(
    tx: Prisma.TransactionClient,
    userId: string,
    providerUserId: string,
  ): Promise<void> {
    const disconnectedAt = new Date();
    await tx.user.updateMany({
      where: { id: userId, snaptradeUserId: providerUserId },
      data: { snaptradeUserId: null, encryptedUserSecret: null, brokerSyncEnabled: false },
    });
    await tx.groupMember.updateMany({
      where: { userId },
      data: { privacyLevel: 'OFF', alertsEnabled: false, sharingEnabledAt: null },
    });
    await tx.tradeEvent.updateMany({
      where: { userId, alertStatus: { in: ['PENDING', 'SENDING'] } },
      data: { alertStatus: 'SKIPPED' },
    });
    await tx.brokerConnection.updateMany({
      where: { userId },
      data: { status: 'DISCONNECTED', disconnectedAt },
    });
  }

  private async closeProviderDeletedConnection(
    tx: Prisma.TransactionClient,
    userId: string,
    authorizationId: string,
  ): Promise<void> {
    const disconnectedAt = new Date();
    const reason = 'SnapTrade confirmed connection deletion';
    await tx.user.updateMany({ where: { id: userId }, data: { brokerSyncEnabled: false } });
    await tx.groupMember.updateMany({
      where: { userId },
      data: { privacyLevel: 'OFF', alertsEnabled: false, sharingEnabledAt: null },
    });
    await tx.tradeEvent.updateMany({
      where: { userId, alertStatus: { in: ['PENDING', 'SENDING'] } },
      data: { alertStatus: 'SKIPPED' },
    });
    await tx.brokerConnection.updateMany({
      where: { authorizationId, userId },
      data: { status: 'DISCONNECTED', disabledReason: reason, disconnectedAt },
    });
  }
}
