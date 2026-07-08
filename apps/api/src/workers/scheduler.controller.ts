import { Body, Controller, Headers, Post, UnauthorizedException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { BrokerSyncService } from '../broker/broker-sync.service';
import { JOB_DEFAULTS } from '../config/constants';
import { safeBearerEqual } from '../security/constant-time';

@Controller('jobs')
export class SchedulerController {
  constructor(@InjectQueue('trade-sync') private queue: Queue, private config: ConfigService, private sync: BrokerSyncService) {}

  @Post('sync-all')
  async syncAll(@Headers('authorization') auth?: string) {
    this.requireInternal(auth);
    await this.queue.add('sync-all', { reason: 'manual' }, { jobId: this.windowedJobId('manual-sync-all'), ...JOB_DEFAULTS });
    return { ok: true };
  }

  @Post('sync-user')
  async syncUser(@Body() body: { userId: string }, @Headers('authorization') auth?: string) {
    this.requireInternal(auth);
    await this.queue.add('sync-user', { userId: body.userId }, { jobId: this.windowedJobId(`manual-sync-user-${body.userId}`), ...JOB_DEFAULTS });
    return { ok: true };
  }

  @Post('sync-all-now')
  async syncAllNow(@Headers('authorization') auth?: string) {
    this.requireInternal(auth);
    await this.sync.syncAll();
    return { ok: true };
  }

  private requireInternal(auth?: string) {
    const secret = this.config.getOrThrow<string>('INTERNAL_JOB_SECRET');
    if (!safeBearerEqual(auth, secret)) throw new UnauthorizedException();
  }

  private windowedJobId(prefix: string) {
    return `${prefix}-${Math.floor(Date.now() / 60_000)}`;
  }
}
