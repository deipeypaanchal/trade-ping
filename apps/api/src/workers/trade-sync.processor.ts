import { Processor, WorkerHost, InjectQueue, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { BrokerSyncService } from '../broker/broker-sync.service';
import { PrismaService } from '../config/prisma.service';
import { JOB_DEFAULTS, SYNC } from '../config/constants';

/**
 * Concurrency + rate limiter chosen conservatively for the SnapTrade free/standard
 * plan (~250 req/min) and 10-25 active users. Tune via constants.ts if needed.
 *
 *   concurrency: 2 active user-syncs at a time (no thundering herd on SnapTrade)
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
  constructor(private sync: BrokerSyncService, private prisma: PrismaService, @InjectQueue('trade-sync') private queue: Queue) { super(); }

  async process(job: Job<{ userId?: string }>) {
    try {
      if (job.data.userId) return await this.sync.syncUser(job.data.userId);
      return await this.fanOut();
    } catch (err) {
      this.logger.error(`Job ${job.name} failed: ${(err as Error).message}`);
      throw err;
    }
  }

  /** Persisted record of every terminal job failure so operators can debug retries in audit_log. */
  @OnWorkerEvent('failed')
  async onFailed(job: Job, err: Error) {
    try {
      await this.prisma.auditLog.create({
        data: {
          userId: (job.data as { userId?: string })?.userId,
          action: 'job_failed',
          metadata: {
            jobId: job.id,
            jobName: job.name,
            attemptsMade: job.attemptsMade,
            error: err.message,
          },
        },
      });
    } catch (e) {
      this.logger.warn(`failed to record job_failed audit: ${(e as Error).message}`);
    }
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
