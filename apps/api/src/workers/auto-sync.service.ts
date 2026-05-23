import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { AUTO_SYNC, JOB_DEFAULTS } from '../config/constants';
import { PrismaService } from '../config/prisma.service';

@Injectable()
export class AutoSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AutoSyncService.name);
  private timer?: NodeJS.Timeout;
  private bootTimer?: NodeJS.Timeout;

  constructor(
    @InjectQueue('trade-sync') private queue: Queue,
    private prisma: PrismaService,
    private config: ConfigService,
  ) {}

  onModuleInit() {
    const minutes = this.config.getOrThrow<number>('SYNC_INTERVAL_MINUTES');
    const intervalMs = minutes * 60_000;
    this.logger.log(`automatic trade sync enabled every ${minutes} minute(s)`);
    this.timer = setInterval(() => void this.enqueue('interval'), intervalMs);
    // Boot enqueue is delayed AND gated on "was there a recent sync?". This
    // is the single biggest defence against redeploy spam: a restart should
    // not retrigger sync work that another worker already finished moments ago.
    this.bootTimer = setTimeout(() => void this.enqueueIfStale(), AUTO_SYNC.BOOT_INITIAL_DELAY_MS);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    if (this.bootTimer) clearTimeout(this.bootTimer);
  }

  private async enqueueIfStale() {
    const lastAt = await this.lastAutoSyncAt();
    if (lastAt && Date.now() - lastAt.getTime() < AUTO_SYNC.BOOT_SKIP_IF_RECENT_MS) {
      this.logger.log(`skipping boot sync; previous auto-sync at ${lastAt.toISOString()}`);
      return;
    }
    await this.enqueue('boot');
  }

  private async enqueue(reason: 'boot' | 'interval') {
    const minutes = this.config.getOrThrow<number>('SYNC_INTERVAL_MINUTES');
    const windowId = Math.floor(Date.now() / (minutes * 60_000));
    await this.queue.add('sync-all', { reason }, { jobId: `auto-sync-all-${windowId}`, ...JOB_DEFAULTS });
    await this.stampLastAutoSync();
  }

  private async lastAutoSyncAt(): Promise<Date | null> {
    // The auto-sync marker is account-less and user-less: a process-wide
    // singleton row keyed by ('auto-sync', null, null) in SyncState is
    // forbidden by the unique constraint, so we use an AuditLog scan instead.
    const row = await this.prisma.auditLog.findFirst({
      where: { action: 'auto_sync_enqueued' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    return row?.createdAt ?? null;
  }

  private async stampLastAutoSync() {
    await this.prisma.auditLog.create({ data: { action: 'auto_sync_enqueued', metadata: {} } });
  }
}
