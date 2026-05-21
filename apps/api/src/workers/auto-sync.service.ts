import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { JOB_DEFAULTS } from '../config/constants';

@Injectable()
export class AutoSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AutoSyncService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    @InjectQueue('trade-sync') private queue: Queue,
    private config: ConfigService,
  ) {}

  onModuleInit() {
    const minutes = this.config.getOrThrow<number>('SYNC_INTERVAL_MINUTES');
    const intervalMs = minutes * 60_000;
    this.logger.log(`automatic trade sync enabled every ${minutes} minute(s)`);
    this.timer = setInterval(() => void this.enqueue(), intervalMs);
    void this.enqueue();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async enqueue() {
    const minutes = this.config.getOrThrow<number>('SYNC_INTERVAL_MINUTES');
    const windowId = Math.floor(Date.now() / (minutes * 60_000));
    await this.queue.add('sync-all', {}, { jobId: `auto-sync-all-${windowId}`, ...JOB_DEFAULTS });
  }
}
