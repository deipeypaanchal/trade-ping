import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { BrokerSyncService } from '../broker/broker-sync.service';

/**
 * Concurrency + rate limiter chosen conservatively for the SnapTrade free/standard
 * plan (~250 req/min) and 10-25 active users. Tune via env later if needed.
 *
 *   concurrency: 2 active user-syncs at a time (no thundering herd on SnapTrade)
 *   limiter:     30 jobs / minute across all workers in this process
 */
@Processor('trade-sync', { concurrency: 2, limiter: { max: 30, duration: 60_000 } })
export class TradeSyncProcessor extends WorkerHost {
  private readonly logger = new Logger(TradeSyncProcessor.name);
  constructor(private sync: BrokerSyncService) { super(); }

  async process(job: Job<{ userId?: string }>) {
    try {
      if (job.data.userId) return await this.sync.syncUser(job.data.userId);
      return await this.sync.syncAll();
    } catch (err) {
      this.logger.error(`Job ${job.name} failed: ${(err as Error).message}`);
      throw err;
    }
  }
}
