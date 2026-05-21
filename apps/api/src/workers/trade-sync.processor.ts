import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { BrokerSyncService } from '../broker/broker-sync.service';

/**
 * Concurrency + rate limiter chosen conservatively for the SnapTrade free/standard
 * plan (~250 req/min) and 10-25 active users. Tune via env later if needed.
 *
 *   concurrency: 2 active user-syncs at a time (no thundering herd on SnapTrade)
 *   limiter:     30 jobs / minute across all workers in this process
 *
 * A `sync-all` job does no SnapTrade work itself: it fans out into one `sync-user`
 * job per user so each is rate-limited and isolated (one slow/failing user can't
 * block the rest). Per-user fan-out jobs are deduped within a 1-minute window so
 * overlapping triggers (auto-sync + webhook) don't double-enqueue.
 */
@Processor('trade-sync', { concurrency: 2, limiter: { max: 30, duration: 60_000 } })
export class TradeSyncProcessor extends WorkerHost {
  private readonly logger = new Logger(TradeSyncProcessor.name);
  constructor(private sync: BrokerSyncService, @InjectQueue('trade-sync') private queue: Queue) { super(); }

  async process(job: Job<{ userId?: string }>) {
    try {
      if (job.data.userId) return await this.sync.syncUser(job.data.userId);
      return await this.fanOut();
    } catch (err) {
      this.logger.error(`Job ${job.name} failed: ${(err as Error).message}`);
      throw err;
    }
  }

  private async fanOut(): Promise<{ enqueued: number }> {
    const ids = await this.sync.listSyncableUserIds();
    const windowKey = Math.floor(Date.now() / 60_000);
    await Promise.all(
      ids.map((userId) =>
        this.queue.add(
          'sync-user',
          { userId },
          { jobId: `sync-user:${userId}:${windowKey}`, removeOnComplete: 100, removeOnFail: 500, attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
        ),
      ),
    );
    return { enqueued: ids.length };
  }
}
