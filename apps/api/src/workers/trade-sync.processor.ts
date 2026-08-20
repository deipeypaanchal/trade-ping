import { Processor, WorkerHost, InjectQueue, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { BrokerSyncService } from '../broker/broker-sync.service';
import { PrismaService } from '../config/prisma.service';
import { JOB_DEFAULTS, SYNC } from '../config/constants';
import { AlertService } from '../alerts/alert.service';
import { acquireUserSafetyLocks, SYNC_FENCE_TRANSACTION } from '../security/user-safety-lock';

type TradeJobData = { userId?: string; tradeEventId?: string; lifecycleScrubbed?: boolean };

/**
 * Concurrency + rate limiter chosen conservatively for the SnapTrade free/standard
 * plan (~250 req/min) and 10-25 active users. Tune via constants.ts if needed.
 *
 *   concurrency: 1 active user-sync at a time (keeps DB headroom for safety fences)
 *   limiter:     30 jobs / minute across all workers in this process
 *
 * A `sync-all` job does no SnapTrade work itself: it fans out into one `sync-user`
 * job per user so each is rate-limited and isolated (one slow/failing user can't
 * block the rest). Per-user fan-out jobs are deduped within a 1-minute window so
 * overlapping triggers (auto-sync + webhook) don't double-enqueue.
 */
@Processor('trade-sync', { concurrency: SYNC.CONCURRENCY, limiter: { max: SYNC.RATE_LIMIT_MAX, duration: SYNC.RATE_LIMIT_DURATION_MS } })
export class TradeSyncProcessor extends WorkerHost {
  private readonly logger = new Logger(TradeSyncProcessor.name);
  constructor(private sync: BrokerSyncService, private alerts: AlertService, private prisma: PrismaService, @InjectQueue('trade-sync') private queue: Queue) { super(); }

  async process(job: Job<TradeJobData>) {
    try {
      if (await this.scrubBlockedLifecycleJob(job)) return { skipped: 'account-deletion' };
      if (job.name === 'send-alert' && job.data.tradeEventId) {
        return { sent: await this.alerts.sendTradeAlert(job.data.tradeEventId) };
      }
      if (job.data.userId) return await this.sync.syncUser(job.data.userId);
      return await this.fanOut();
    } catch (err) {
      this.logger.error(`Job ${job.name} failed: ${(err as Error).message}`);
      throw err;
    } finally {
      // Account deletion may have begun while this job held the sync/delivery
      // fence. Scrub identifiers before BullMQ retains completion/failure data.
      await this.scrubBlockedLifecycleJob(job).catch(() => {
        this.logger.warn('lifecycle job data could not be scrubbed immediately');
      });
    }
  }

  /** Persisted record of every terminal job failure so operators can debug retries in audit_log. */
  @OnWorkerEvent('failed')
  async onFailed(job: Job, err: Error) {
    try {
      const auditUserId = await this.auditUserIdFor(job);
      if (auditUserId === null) return;
      if (auditUserId === undefined) {
        await this.prisma.auditLog.create({
          data: { action: 'job_failed', metadata: this.failureMetadata(job, err) },
        });
        return;
      }
      await this.prisma.$transaction(async (tx) => {
        await acquireUserSafetyLocks(tx, auditUserId, ['sync']);
        const user = await tx.user.findUnique({
          where: { id: auditUserId },
          select: { deletionPendingAt: true },
        });
        if (!user || user.deletionPendingAt) return;
        const deletion = await tx.providerDeletion.findFirst({
          where: { localUserId: auditUserId, purpose: 'ACCOUNT_DELETION', status: { not: 'CONFIRMED' } },
          select: { providerUserId: true },
        });
        if (deletion) return;
        await tx.auditLog.create({
          data: { userId: auditUserId, action: 'job_failed', metadata: this.failureMetadata(job, err) },
        });
      }, SYNC_FENCE_TRANSACTION);
    } catch (e) {
      this.logger.warn(`failed to record job_failed audit: ${(e as Error).message}`);
    }
  }

  private async scrubBlockedLifecycleJob(job: Job<TradeJobData>): Promise<boolean> {
    const data = job.data;
    if (data.lifecycleScrubbed) return true;
    let userId = data.userId;
    if (!userId && data.tradeEventId) {
      const event = await this.prisma.tradeEvent.findUnique({
        where: { id: data.tradeEventId },
        select: { userId: true },
      });
      if (!event) {
        await job.updateData({ lifecycleScrubbed: true }).catch(() => undefined);
        return true;
      }
      userId = event.userId;
    }
    if (!userId) return false;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { deletionPendingAt: true },
    });
    if (!user) {
      await job.updateData({ lifecycleScrubbed: true }).catch(() => undefined);
      return true;
    }
    const pendingDeletion = user.deletionPendingAt || await this.prisma.providerDeletion.findFirst({
      where: { localUserId: userId, purpose: 'ACCOUNT_DELETION', status: { not: 'CONFIRMED' } },
      select: { providerUserId: true },
    });
    if (!pendingDeletion) return false;
    await job.updateData({ lifecycleScrubbed: true }).catch(() => undefined);
    return true;
  }

  /** null means the job belongs to deleted/pending-deletion data and must not
   * create an orphan or post-deletion audit record. undefined is a global job. */
  private async auditUserIdFor(job: Job): Promise<string | undefined | null> {
    const data = job.data as TradeJobData;
    if (data.lifecycleScrubbed) return null;
    let userId = data.userId;
    if (!userId && data.tradeEventId) {
      userId = (await this.prisma.tradeEvent.findUnique({
        where: { id: data.tradeEventId },
        select: { userId: true },
      }))?.userId;
      if (!userId) return null;
    }
    if (!userId) return undefined;
    return userId;
  }

  private failureMetadata(job: Job, err: Error) {
    return {
      jobId: job.id,
      jobName: job.name,
      attemptsMade: job.attemptsMade,
      error: err.message,
    };
  }

  private async fanOut(): Promise<{ enqueued: number }> {
    const ids = await this.sync.listSyncableUserIds();
    const windowKey = Math.floor(Date.now() / SYNC.FANOUT_DEDUPE_WINDOW_MS);
    await Promise.all(
      ids.map((userId) =>
        this.queue.add(
          'sync-user',
          { userId },
          { jobId: `sync-user:${userId}:${windowKey}`, ...JOB_DEFAULTS },
        ),
      ),
    );
    return { enqueued: ids.length };
  }
}
