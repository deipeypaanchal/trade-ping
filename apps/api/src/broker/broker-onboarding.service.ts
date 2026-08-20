import { BadRequestException, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../config/prisma.service';
import { SnaptradeService } from '../snaptrade/snaptrade.service';
import { CryptoService } from '../security/crypto.service';
import { EncryptedSecretError } from '../security/errors';
import { acquireTelegramUpdateLock, acquireUserSafetyLocks, SYNC_FENCE_TRANSACTION } from '../security/user-safety-lock';
import { randomBytes } from 'crypto';
import { SYNC } from '../config/constants';

export type DisconnectResult = {
  revoked: number;
  failed: number;
  remoteRevocationComplete: boolean;
};

export type RemoteUserDeletionResult = {
  state: 'COMPLETE' | 'PENDING' | 'RETRY_REQUIRED' | 'MANUAL_REVIEW_REQUIRED';
  providerDeletionRequired: boolean;
  providerCredentialState: 'COMPLETE' | 'PROVIDER_ID_ONLY' | 'SECRET_ONLY' | 'NONE';
  purgedJobs: number;
};

type SnapIdentity = {
  userId: string;
  userSecret: string;
  replaced: boolean;
  replacedProviderUserId?: string;
};

type ProviderDeletionRequestState = 'PENDING' | 'CONFIRMED' | 'RETRY';
const TELEGRAM_DELETION_SUPPRESSION_MS = 90 * 24 * 60 * 60_000;

@Injectable()
export class BrokerOnboardingService {
  private readonly logger = new Logger(BrokerOnboardingService.name);
  constructor(
    private prisma: PrismaService,
    private snap: SnaptradeService,
    private crypto: CryptoService,
    @Optional() @InjectQueue('trade-sync') private queue?: Queue,
  ) {}

  async createConnectUrl(userId: string, groupId: string): Promise<string> {
    const requestedAt = new Date();
    const deadlineAt = Date.now() + SYNC.MAX_RUN_MS;
    const result = await this.prisma.$transaction(async (tx) => {
      await acquireUserSafetyLocks(tx, userId, ['sync']);
      await this.assertPortalLifecycleUnchanged(tx, userId, requestedAt);
      return this.createConnectUrlUnlocked(tx, userId, groupId, deadlineAt);
    }, SYNC_FENCE_TRANSACTION);
    if (result.replacedProviderUserId) await this.requestProviderDeletion(result.replacedProviderUserId);
    await this.retryReadyProviderDeletions(userId);
    return result.url;
  }

  private async createConnectUrlUnlocked(
    db: Prisma.TransactionClient,
    userId: string,
    groupId: string,
    deadlineAt: number,
  ): Promise<{ url: string; replacedProviderUserId?: string }> {
    this.assertPortalDeadline(deadlineAt, 'connect start');
    await this.ensurePendingMembership(db, userId, groupId);
    const user = await this.registeredUser(db, userId, deadlineAt);
    const snapUser = await this.readOrResetSecret(
      db,
      user.id,
      user.snaptradeUserId!,
      user.encryptedUserSecret,
      user.snaptradeGeneration,
      deadlineAt,
    );
    this.assertPortalDeadline(deadlineAt, 'connection portal');
    const url = await this.snap.connectionPortal(snapUser.userId, snapUser.userSecret, groupId);
    this.assertPortalDeadline(deadlineAt, 'connection portal response');
    if (!url.redirectURI) throw new Error('SnapTrade did not return redirectURI');
    await db.user.update({ where: { id: user.id }, data: { brokerSyncEnabled: true } });
    await this.audit(user.id, 'connection_portal_created', { groupId, sessionId: url.sessionId }, db);
    return { url: url.redirectURI, replacedProviderUserId: snapUser.replacedProviderUserId };
  }

  async createReconnectUrl(userId: string, groupId: string, brokerRaw?: string): Promise<string> {
    const requestedAt = new Date();
    const deadlineAt = Date.now() + SYNC.MAX_RUN_MS;
    const result = await this.prisma.$transaction(async (tx) => {
      await acquireUserSafetyLocks(tx, userId, ['sync']);
      await this.assertPortalLifecycleUnchanged(tx, userId, requestedAt);
      return this.createReconnectUrlUnlocked(tx, userId, groupId, brokerRaw, deadlineAt);
    }, SYNC_FENCE_TRANSACTION);
    if (result.replacedProviderUserId) await this.requestProviderDeletion(result.replacedProviderUserId);
    await this.retryReadyProviderDeletions(userId);
    return result.url;
  }

  private async createReconnectUrlUnlocked(
    db: Prisma.TransactionClient,
    userId: string,
    groupId: string,
    brokerRaw: string | undefined,
    deadlineAt: number,
  ): Promise<{ url: string; replacedProviderUserId?: string }> {
    this.assertPortalDeadline(deadlineAt, 'reconnect start');
    await this.ensurePendingMembership(db, userId, groupId);
    const user = await this.registeredUser(db, userId, deadlineAt);
    const broken = await db.brokerConnection.findMany({
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
    const snapUser = await this.readOrResetSecret(
      db,
      user.id,
      user.snaptradeUserId!,
      user.encryptedUserSecret,
      user.snaptradeGeneration,
      deadlineAt,
    );
    this.assertPortalDeadline(deadlineAt, 'reconnect portal');
    const url = await this.snap.connectionPortal(
      snapUser.userId,
      snapUser.userSecret,
      groupId,
      snapUser.replaced ? undefined : connection.authorizationId,
    );
    this.assertPortalDeadline(deadlineAt, 'reconnect portal response');
    if (!url.redirectURI) throw new Error('SnapTrade did not return reconnect redirectURI');
    await db.user.update({ where: { id: user.id }, data: { brokerSyncEnabled: true } });
    await this.audit(user.id, 'reconnect_portal_created', { groupId, authorizationId: connection.authorizationId, sessionId: url.sessionId }, db);
    return { url: url.redirectURI, replacedProviderUserId: snapUser.replacedProviderUserId };
  }

  private async registeredUser(db: Prisma.TransactionClient, userId: string, deadlineAt: number) {
    let user = await db.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.snaptradeUserId) {
      const hadOrphanedSecret = !!user.encryptedUserSecret;
      const nextGeneration = user.snaptradeGeneration + (hadOrphanedSecret ? 1 : 0);
      const registrationId = `${user.id}-g-${nextGeneration}-${randomBytes(8).toString('hex')}`;
      await this.planProviderRegistration(user.id, registrationId, nextGeneration);
      this.assertPortalDeadline(deadlineAt, 'provider registration');
      const snapUser = await this.snap.registerUser(registrationId);
      this.assertPortalDeadline(deadlineAt, 'provider registration response');
      if (snapUser.userId !== registrationId) {
        await this.cleanupConfirmedUnmappedProviderUser(snapUser.userId, nextGeneration, user.id);
        throw new Error('SnapTrade returned a provider identity different from the durable registration intent');
      }
      try {
        const encryptedUserSecret = this.crypto.encrypt(snapUser.userSecret);
        await db.user.update({ where: { id: user.id }, data: {
            snaptradeUserId: snapUser.userId,
            encryptedUserSecret,
            snaptradeGeneration: nextGeneration,
            brokerSyncEnabled: true,
          }});
        await db.providerDeletion.deleteMany({
          where: { provider: 'snaptrade', providerUserId: registrationId, status: 'REGISTRATION' },
        });
        user = {
          ...user,
          snaptradeUserId: snapUser.userId,
          encryptedUserSecret,
          snaptradeGeneration: nextGeneration,
          brokerSyncEnabled: true,
        };
      } catch (err) {
        await this.cleanupConfirmedUnmappedProviderUser(
          snapUser.userId,
          user.snaptradeGeneration + (hadOrphanedSecret ? 1 : 0),
          user.id,
        );
        throw err;
      }
      await this.audit(user.id, 'snaptrade_user_registered', { orphanedSecretCleared: hadOrphanedSecret }, db);
    }
    return user;
  }

  private async readOrResetSecret(
    db: Prisma.TransactionClient,
    userId: string,
    snaptradeUserId: string,
    encryptedUserSecret: string | null,
    generation: number,
    deadlineAt: number,
  ): Promise<SnapIdentity> {
    try {
      if (!encryptedUserSecret) throw new EncryptedSecretError('SnapTrade user secret is missing');
      return { userId: snaptradeUserId, userSecret: this.crypto.decrypt(encryptedUserSecret), replaced: false };
    } catch (err) {
      if (!(err instanceof EncryptedSecretError)) throw err;
      this.logger.warn(`createConnectUrl(${userId}): encrypted secret unreadable; resetting SnapTrade registration`);
      const replacementId = `${userId}-g-${generation + 1}-${randomBytes(8).toString('hex')}`;
      await this.planProviderRegistration(userId, replacementId, generation + 1);
      this.assertPortalDeadline(deadlineAt, 'replacement registration');
      const snapUser = await this.snap.registerUser(replacementId);
      this.assertPortalDeadline(deadlineAt, 'replacement registration response');
      if (snapUser.userId !== replacementId || snapUser.userId === snaptradeUserId) {
        await this.cleanupConfirmedUnmappedProviderUser(snapUser.userId, generation + 1, userId);
        throw new Error('SnapTrade returned an identity outside the durable replacement intent', { cause: err });
      }

      // Map the unique replacement and persist the old identity's retry handle
      // atomically. Only then is it safe to request asynchronous deletion.
      try {
        await db.user.update({
            where: { id: userId },
            data: {
              snaptradeUserId: snapUser.userId,
              encryptedUserSecret: this.crypto.encrypt(snapUser.userSecret),
              snaptradeGeneration: generation + 1,
              brokerSyncEnabled: true,
            },
          });
        await db.providerDeletion.deleteMany({
          where: { provider: 'snaptrade', providerUserId: replacementId, status: 'REGISTRATION' },
        });
        await db.providerDeletion.upsert({
            where: { provider_providerUserId: { provider: 'snaptrade', providerUserId: snaptradeUserId } },
            update: {
              localUserId: userId,
              purpose: 'SECRET_REPLACEMENT',
              generation,
              status: 'READY',
              requestedAt: null,
              confirmedAt: null,
            },
            create: {
              provider: 'snaptrade',
              providerUserId: snaptradeUserId,
              localUserId: userId,
              purpose: 'SECRET_REPLACEMENT',
              generation,
              status: 'READY',
            },
          });
        await db.brokerConnection.updateMany({
            where: { userId },
            data: { status: 'DISCONNECTED', disabledReason: 'Secret reset during production recovery — reconnect required', disconnectedAt: new Date() },
          });
      } catch (err) {
        await this.cleanupConfirmedUnmappedProviderUser(snapUser.userId, generation + 1, userId);
        throw err;
      }

      await this.audit(userId, 'snaptrade_user_reset_after_secret_loss', {
        oldDeletionQueued: true,
        generation: generation + 1,
      }, db);
      return { ...snapUser, replaced: true, replacedProviderUserId: snaptradeUserId };
    }
  }

  async refreshConnections(userId: string): Promise<void> {
    const deadlineAt = Date.now() + SYNC.MAX_RUN_MS;
    return this.prisma.$transaction(async (tx) => {
      await acquireUserSafetyLocks(tx, userId, ['sync']);
      await this.refreshConnectionsUnlocked(tx, userId, deadlineAt);
    }, SYNC_FENCE_TRANSACTION);
  }

  private async refreshConnectionsUnlocked(
    db: Prisma.TransactionClient,
    userId: string,
    deadlineAt: number,
  ): Promise<void> {
    const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.brokerSyncEnabled || !user.snaptradeUserId || !user.encryptedUserSecret) return;
    const secret = this.crypto.decrypt(user.encryptedUserSecret);
    this.assertPortalDeadline(deadlineAt, 'connection refresh');
    const conns = await this.snap.listConnections(user.snaptradeUserId, secret);
    this.assertPortalDeadline(deadlineAt, 'connection refresh response');
    for (const c of conns) {
      this.assertPortalDeadline(deadlineAt, 'connection refresh loop');
      const connection = await db.brokerConnection.upsert({
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
        this.assertPortalDeadline(deadlineAt, 'account refresh');
        const accounts = await this.snap.listAccounts(user.snaptradeUserId, secret, c.id);
        this.assertPortalDeadline(deadlineAt, 'account refresh response');
        for (const acct of accounts) {
          this.assertPortalDeadline(deadlineAt, 'account refresh loop');
          await db.brokerAccount.upsert({
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
    await this.audit(user.id, 'connections_refreshed', { count: conns.length }, db);
  }

  async disconnectAll(userId: string): Promise<DisconnectResult> {
    await this.disableSyncAndSharing(userId, 'disconnect_requested');
    // A connect/reconnect already inside the sync fence may have replaced the
    // provider generation after the initial lookup. Revoke only from the
    // post-fence identity so the command cannot report success for stale data.
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    await this.purgeUserJobs(userId);

    let revoked = 0;
    let failed = 0;
    let remoteRevocationComplete = true;
    if (!!user.snaptradeUserId !== !!user.encryptedUserSecret) {
      remoteRevocationComplete = false;
      await this.audit(userId, 'brokerages_disconnected', {
        revoked,
        failed,
        partialProviderCredentials: true,
        remoteRevocationComplete,
      });
      return { revoked, failed, remoteRevocationComplete };
    }
    if (user.snaptradeUserId && user.encryptedUserSecret) {
      let secret: string;
      try {
        secret = this.crypto.decrypt(user.encryptedUserSecret);
      } catch (err) {
        if (!(err instanceof EncryptedSecretError)) throw err;
        this.logger.warn(`disconnectAll(${userId}): decrypt failed; local sync remains disabled`);
        remoteRevocationComplete = false;
        await this.audit(userId, 'brokerages_disconnected', { revoked, failed, decryptFailed: true, remoteRevocationComplete });
        return { revoked, failed, remoteRevocationComplete };
      }
      let conns: Awaited<ReturnType<SnaptradeService['listConnections']>>;
      try {
        conns = await this.snap.listConnections(user.snaptradeUserId, secret);
      } catch (err) {
        this.logger.warn(`disconnectAll(${userId}) could not list remote authorizations: ${(err as Error).message}`);
        remoteRevocationComplete = false;
        await this.audit(userId, 'brokerages_disconnected', { revoked, failed, listFailed: true, remoteRevocationComplete });
        return { revoked, failed, remoteRevocationComplete };
      }
      for (const c of conns) {
        try {
          await this.snap.deleteConnection(user.snaptradeUserId, secret, c.id);
          revoked += 1;
        } catch (err) {
          failed += 1;
          remoteRevocationComplete = false;
          this.logger.warn(`disconnectAll(${userId}) failed to delete authorization ${c.id}: ${(err as Error).message}`);
        }
      }
    }
    await this.audit(userId, 'brokerages_disconnected', { revoked, failed, remoteRevocationComplete });
    return { revoked, failed, remoteRevocationComplete };
  }

  async deleteRemoteUser(userId: string): Promise<RemoteUserDeletionResult> {
    let user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.deletionPendingAt && user.deletionBlockReason) {
      await this.establishTelegramDeletionBoundary(user.id, user.telegramUserId);
      return {
        state: 'MANUAL_REVIEW_REQUIRED',
        providerDeletionRequired: true,
        providerCredentialState: this.providerCredentialState(user.snaptradeUserId, user.encryptedUserSecret),
        purgedJobs: await this.purgeUserJobs(userId),
      };
    }
    const existing = await this.prisma.providerDeletion.findFirst({
      where: { localUserId: userId, purpose: 'ACCOUNT_DELETION', status: { not: 'CONFIRMED' } },
      orderBy: { generation: 'desc' },
    });
    if (existing) {
      await this.establishTelegramDeletionBoundary(user.id, user.telegramUserId);
      const purgedJobs = await this.purgeUserJobs(userId);
      const deletionState: ProviderDeletionRequestState = existing.status === 'PENDING'
        ? 'PENDING'
        : await this.requestProviderDeletion(existing.providerUserId);
      return {
        state: deletionState === 'CONFIRMED' ? 'COMPLETE' : deletionState === 'PENDING' ? 'PENDING' : 'RETRY_REQUIRED',
        providerDeletionRequired: deletionState !== 'CONFIRMED',
        providerCredentialState: this.providerCredentialState(user.snaptradeUserId, user.encryptedUserSecret),
        purgedJobs,
      };
    }

    await this.disableSyncAndSharing(userId, 'account_deletion_requested', true);
    // A connect/reconnect request that was already inside the sync fence may
    // have replaced the provider identity after our initial lookup. Re-read
    // only after the deletion fence has drained so the durable tombstone can
    // never target a stale generation and orphan the newly mapped identity.
    user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    await this.establishTelegramDeletionBoundary(user.id, user.telegramUserId);
    // A concurrent deletion request may have completed the scrub while this
    // request waited for the sync/delivery fence. The tombstone and scrub are
    // atomic, so re-check it before interpreting the now-null provider mapping
    // as a completed remote deletion.
    const concurrentDeletion = await this.prisma.providerDeletion.findFirst({
      where: { localUserId: userId, purpose: 'ACCOUNT_DELETION', status: { not: 'CONFIRMED' } },
      orderBy: { generation: 'desc' },
    });
    if (concurrentDeletion) {
      const purgedJobs = await this.purgeUserJobs(userId);
      const deletionState: ProviderDeletionRequestState = concurrentDeletion.status === 'PENDING'
        ? 'PENDING'
        : await this.requestProviderDeletion(concurrentDeletion.providerUserId);
      return {
        state: deletionState === 'CONFIRMED' ? 'COMPLETE' : deletionState === 'PENDING' ? 'PENDING' : 'RETRY_REQUIRED',
        providerDeletionRequired: deletionState !== 'CONFIRMED',
        providerCredentialState: this.providerCredentialState(user.snaptradeUserId, user.encryptedUserSecret),
        purgedJobs,
      };
    }
    const tradeEvents = await this.prisma.tradeEvent.findMany({ where: { userId }, select: { id: true } });
    const purgedJobs = await this.purgeUserJobs(userId, tradeEvents.map((event) => event.id));
    const providerCredentialState = this.providerCredentialState(user.snaptradeUserId, user.encryptedUserSecret);

    if (!user.snaptradeUserId && user.encryptedUserSecret) {
      await this.prisma.$transaction(async (tx) => {
        await tx.groupMember.deleteMany({ where: { userId } });
        await tx.tradeEvent.deleteMany({ where: { userId } });
        await tx.syncState.deleteMany({ where: { userId } });
        await tx.brokerConnection.deleteMany({ where: { userId } });
        await tx.auditLog.deleteMany({ where: { userId } });
        await tx.user.update({
          where: { id: userId },
          data: {
            telegramUserId: null,
            displayName: '[deletion blocked: missing provider id]',
            timeZone: null,
            encryptedUserSecret: null,
            brokerSyncEnabled: false,
            deletionBlockReason: 'MISSING_PROVIDER_ID',
          },
        });
      });
      return {
        state: 'MANUAL_REVIEW_REQUIRED',
        providerDeletionRequired: true,
        providerCredentialState,
        purgedJobs,
      };
    }

    if (!user.snaptradeUserId) {
      await this.prisma.$transaction(async (tx) => {
        await tx.user.deleteMany({ where: { id: userId } });
        await tx.telegramIdentitySuppression.updateMany({
          where: { localUserId: userId, deletionCompletedAt: null },
          data: { deletionCompletedAt: new Date(), localUserId: null },
        });
      });
      return {
        state: 'COMPLETE',
        providerDeletionRequired: false,
        providerCredentialState,
        purgedJobs,
      };
    }

    const providerUserId = user.snaptradeUserId;
    await this.prisma.$transaction(async (tx) => {
      await tx.providerDeletion.upsert({
        where: { provider_providerUserId: { provider: 'snaptrade', providerUserId } },
        update: {
          localUserId: userId,
          purpose: 'ACCOUNT_DELETION',
          generation: user.snaptradeGeneration,
          status: 'READY',
          requestedAt: null,
          confirmedAt: null,
        },
        create: {
          provider: 'snaptrade',
          providerUserId,
          localUserId: userId,
          purpose: 'ACCOUNT_DELETION',
          generation: user.snaptradeGeneration,
          status: 'READY',
        },
      });
      // Retain only the opaque local id and provider deletion handle while the
      // asynchronous request is pending. All user content and identifiers go.
      await tx.groupMember.deleteMany({ where: { userId } });
      await tx.tradeEvent.deleteMany({ where: { userId } });
      await tx.syncState.deleteMany({ where: { userId } });
      await tx.brokerConnection.deleteMany({ where: { userId } });
      await tx.auditLog.deleteMany({ where: { userId } });
      await tx.user.update({
        where: { id: userId },
        data: {
          telegramUserId: null,
          displayName: '[deletion pending]',
          timeZone: null,
          snaptradeUserId: null,
          encryptedUserSecret: null,
          brokerSyncEnabled: false,
          deletionBlockReason: null,
        },
      });
    });

    const deletionState = await this.requestProviderDeletion(providerUserId);
    return {
      state: deletionState === 'CONFIRMED' ? 'COMPLETE' : deletionState === 'PENDING' ? 'PENDING' : 'RETRY_REQUIRED',
      providerDeletionRequired: deletionState !== 'CONFIRMED',
      providerCredentialState,
      purgedJobs,
    };
  }

  private async ensurePendingMembership(
    db: Prisma.TransactionClient,
    userId: string,
    groupId: string,
  ): Promise<void> {
    await db.groupMember.upsert({
      where: { userId_groupId: { userId, groupId } },
      update: {},
      create: { userId, groupId, privacyLevel: 'OFF', alertsEnabled: false, sharingEnabledAt: null },
    });
  }

  private async establishTelegramDeletionBoundary(userId: string, telegramUserId: string | null): Promise<void> {
    if (!telegramUserId) return;
    const identityHash = this.crypto.hash(telegramUserId);
    const identityScope = `telegram-identity:${identityHash}`;
    await this.prisma.$transaction(async (tx) => {
      // Telegram command handling takes the same lock for its entire operation.
      // Once this boundary commits, an old in-flight command has finished and
      // every later delivery observes the suppression before any User upsert.
      await acquireTelegramUpdateLock(tx, identityScope);
      const deletedAt = new Date();
      const expiresAt = new Date(deletedAt.getTime() + TELEGRAM_DELETION_SUPPRESSION_MS);
      await tx.telegramIdentitySuppression.upsert({
        where: { identityHash },
        update: {
          localUserId: userId,
          deletedAt,
          deletionCompletedAt: null,
          reactivatedAt: null,
          reactivatedUpdateId: null,
          expiresAt,
        },
        create: { identityHash, localUserId: userId, deletedAt, expiresAt },
      });
    }, SYNC_FENCE_TRANSACTION);
  }

  private async assertPortalLifecycleUnchanged(
    tx: Prisma.TransactionClient,
    userId: string,
    requestedAt: Date,
  ): Promise<void> {
    const lifecycle = await tx.user.findUniqueOrThrow({
      where: { id: userId },
      select: { brokerSyncEnabled: true, deletionPendingAt: true, updatedAt: true },
    });
    if (lifecycle.deletionPendingAt) {
      throw new BadRequestException('Account deletion is pending; a new brokerage portal cannot be opened.');
    }
    if (!lifecycle.brokerSyncEnabled && lifecycle.updatedAt >= requestedAt) {
      throw new BadRequestException('Account state changed while opening the brokerage portal. Run /connect again if you still want to reconnect.');
    }
  }

  private async disableSyncAndSharing(userId: string, reason: string, deletionPending = false): Promise<void> {
    const disconnectedAt = new Date();
    const deletionPendingAt = deletionPending ? disconnectedAt : undefined;
    // Flip the durable gate before waiting for an in-flight sync/delivery fence.
    await this.prisma.user.update({
      where: { id: userId },
      data: { brokerSyncEnabled: false, deletionPendingAt },
    });
    const immediate = await Promise.allSettled([
      this.prisma.groupMember.updateMany({
        where: { userId },
        data: { privacyLevel: 'OFF', alertsEnabled: false, sharingEnabledAt: null },
      }),
      this.prisma.tradeEvent.updateMany({
        where: { userId, alertStatus: { in: ['PENDING', 'SENDING'] } },
        data: { alertStatus: 'SKIPPED' },
      }),
      this.prisma.brokerConnection.updateMany({
        where: { userId },
        data: { status: 'DISCONNECTED', disconnectedAt },
      }),
    ]);
    for (const result of immediate) {
      if (result.status === 'rejected') {
        this.logger.warn(`Immediate lifecycle close partially failed for ${userId}: ${(result.reason as Error).message}`);
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await acquireUserSafetyLocks(tx, userId, ['sync', 'delivery']);
      await tx.user.update({
        where: { id: userId },
        data: { brokerSyncEnabled: false, deletionPendingAt },
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
      await tx.auditLog.create({ data: { userId, action: 'broker_sync_disabled', metadata: { reason } } });
    }, SYNC_FENCE_TRANSACTION);
  }

  private async requestProviderDeletion(providerUserId: string): Promise<ProviderDeletionRequestState> {
    const now = new Date();
    await this.prisma.providerDeletion.updateMany({
      where: { provider: 'snaptrade', providerUserId, status: { not: 'CONFIRMED' } },
      data: { status: 'READY', lastAttemptAt: now, lastError: null },
    });
    try {
      await this.snap.deleteUser(providerUserId);
    } catch (err) {
      if ((err as { status?: unknown }).status === 404) {
        // SnapTrade deletion is asynchronous and its confirmation webhook can
        // be exhausted or lost. A later authoritative 404 means the exact,
        // generation-scoped provider identity is already absent; finalize the
        // matching tombstone instead of retaining identifiers forever.
        await this.confirmProviderAbsence(providerUserId);
        return 'CONFIRMED';
      }
      const message = String((err as Error).message ?? err)
        .replaceAll(providerUserId, '[provider-user]')
        .slice(0, 500);
      await this.prisma.providerDeletion.updateMany({
        where: { provider: 'snaptrade', providerUserId, status: { not: 'CONFIRMED' } },
        data: { status: 'READY', lastAttemptAt: now, lastError: message },
      });
      this.logger.warn(`SnapTrade user deletion remains retryable: ${message}`);
      return 'RETRY';
    }
    await this.prisma.providerDeletion.updateMany({
      where: { provider: 'snaptrade', providerUserId, status: { not: 'CONFIRMED' } },
      data: { status: 'PENDING', requestedAt: now, lastAttemptAt: now, lastError: null },
    });
    return 'PENDING';
  }

  async retryProviderDeletions(limit = 25): Promise<{ attempted: number; accepted: number }> {
    const staleBefore = new Date(Date.now() - 24 * 60 * 60_000);
    const staleRegistrationBefore = new Date(Date.now() - 10 * 60_000);
    const deletions = await this.prisma.providerDeletion.findMany({
      where: {
        OR: [
          { status: 'READY' },
          { status: 'PENDING', requestedAt: { lt: staleBefore } },
          { status: 'PENDING', requestedAt: null },
          { status: 'REGISTRATION', createdAt: { lt: staleRegistrationBefore } },
        ],
      },
      orderBy: [{ lastAttemptAt: 'asc' }, { createdAt: 'asc' }],
      take: Math.max(1, Math.min(limit, 100)),
    });
    let accepted = 0;
    for (const deletion of deletions) {
      if (await this.requestProviderDeletion(deletion.providerUserId) !== 'RETRY') accepted += 1;
    }
    return { attempted: deletions.length, accepted };
  }

  private async confirmProviderAbsence(providerUserId: string): Promise<void> {
    const deletion = await this.prisma.providerDeletion.findUnique({
      where: { provider_providerUserId: { provider: 'snaptrade', providerUserId } },
      select: { localUserId: true, purpose: true },
    });
    if (!deletion) return;
    await this.prisma.$transaction(async (tx) => {
      if (deletion.purpose === 'ACCOUNT_DELETION' && deletion.localUserId) {
        await tx.user.deleteMany({ where: { id: deletion.localUserId } });
        await tx.telegramIdentitySuppression.updateMany({
          where: { localUserId: deletion.localUserId, deletionCompletedAt: null },
          data: { deletionCompletedAt: new Date(), localUserId: null },
        });
      }
      await tx.providerDeletion.deleteMany({
        where: { provider: 'snaptrade', providerUserId },
      });
    });
  }

  private async planProviderRegistration(userId: string, providerUserId: string, generation: number): Promise<void> {
    try {
      await this.prisma.providerDeletion.create({
        data: {
          provider: 'snaptrade',
          providerUserId,
          localUserId: userId,
          purpose: 'SECRET_REPLACEMENT',
          generation,
          status: 'REGISTRATION',
        },
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        throw new BadRequestException('A prior provider registration is still being reconciled. Try again shortly.');
      }
      throw err;
    }
  }

  private async cleanupConfirmedUnmappedProviderUser(
    providerUserId: string,
    generation: number,
    userId: string,
  ): Promise<void> {
    let mapping: { snaptradeUserId: string | null } | null;
    try {
      mapping = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { snaptradeUserId: true },
      });
    } catch (err) {
      this.logger.warn(`Could not verify failed SnapTrade mapping; cleanup deferred: ${(err as Error).message}`);
      return;
    }
    if (mapping?.snaptradeUserId === providerUserId) return;

    try {
      await this.prisma.providerDeletion.upsert({
        where: { provider_providerUserId: { provider: 'snaptrade', providerUserId } },
        update: { localUserId: null, purpose: 'SECRET_REPLACEMENT', generation, status: 'READY' },
        create: {
          provider: 'snaptrade',
          providerUserId,
          localUserId: null,
          purpose: 'SECRET_REPLACEMENT',
          generation,
          status: 'READY',
        },
      });
      await this.requestProviderDeletion(providerUserId);
    } catch (err) {
      this.logger.warn(`Could not persist orphan cleanup handle; attempting direct provider deletion: ${(err as Error).message}`);
      await this.snap.deleteUser(providerUserId).catch((deleteErr) => {
        this.logger.error(`Unmapped SnapTrade user cleanup failed: ${(deleteErr as Error).message}`);
      });
    }
  }

  private async retryReadyProviderDeletions(userId: string): Promise<void> {
    const pending = await this.prisma.providerDeletion.findMany({
      where: { localUserId: userId, purpose: 'SECRET_REPLACEMENT', status: 'READY' },
      orderBy: { generation: 'asc' },
    });
    for (const deletion of pending) {
      await this.requestProviderDeletion(deletion.providerUserId);
    }
  }

  private async purgeUserJobs(userId: string, tradeEventIds: string[] = []): Promise<number> {
    if (!this.queue) return 0;
    let jobs: Awaited<ReturnType<Queue['getJobs']>>;
    try {
      jobs = await this.queue.getJobs(
        ['wait', 'waiting', 'active', 'delayed', 'prioritized', 'paused', 'waiting-children', 'failed', 'completed'],
        0,
        -1,
        true,
      );
    } catch (err) {
      // Redis cleanup is defense in depth. The durable deletion gate and the
      // worker's lifecycle scrub must keep deletion progressing during a queue
      // outage; a later retry can remove retained jobs.
      this.logger.warn(`Could not enumerate lifecycle jobs; deletion will continue: ${(err as Error).message}`);
      return 0;
    }
    const eventIds = new Set(tradeEventIds);
    const matching = jobs.filter((job) => {
      const data = job.data as { userId?: string; tradeEventId?: string };
      return data.userId === userId || (!!data.tradeEventId && eventIds.has(data.tradeEventId));
    });
    let removed = 0;
    for (const job of matching) {
      try {
        await job.remove();
        removed += 1;
      } catch {
        this.logger.warn('A lifecycle job could not be removed immediately; the active worker will scrub it.');
      }
    }
    return removed;
  }

  private providerCredentialState(
    providerUserId: string | null,
    encryptedUserSecret: string | null,
  ): RemoteUserDeletionResult['providerCredentialState'] {
    if (providerUserId && encryptedUserSecret) return 'COMPLETE';
    if (providerUserId) return 'PROVIDER_ID_ONLY';
    if (encryptedUserSecret) return 'SECRET_ONLY';
    return 'NONE';
  }

  private async audit(
    userId: string,
    action: string,
    metadata: object,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ) {
    if (db !== this.prisma) {
      await db.auditLog.create({ data: { userId, action, metadata } });
      return;
    }
    await this.prisma.$transaction(async (tx) => {
      await acquireUserSafetyLocks(tx, userId, ['sync']);
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { deletionPendingAt: true },
      });
      if (!user || user.deletionPendingAt) return;
      const deletion = await tx.providerDeletion.findFirst({
        where: { localUserId: userId, purpose: 'ACCOUNT_DELETION', status: { not: 'CONFIRMED' } },
        select: { providerUserId: true },
      });
      if (deletion) return;
      await tx.auditLog.create({ data: { userId, action, metadata } });
    }, SYNC_FENCE_TRANSACTION);
  }

  private assertPortalDeadline(deadlineAt: number, phase: string): void {
    if (Date.now() >= deadlineAt) {
      throw new Error(`Broker lifecycle deadline exceeded during ${phase}`);
    }
  }

  private accountTypeFrom(acct: { raw_type?: string; meta?: Record<string, unknown> }): string | undefined {
    const metaType = acct.meta?.brokerage_account_type ?? acct.meta?.type;
    const type = acct.raw_type ?? (typeof metaType === 'string' ? metaType : undefined);
    return type?.trim() || undefined;
  }
}
