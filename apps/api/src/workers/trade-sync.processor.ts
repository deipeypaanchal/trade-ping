import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { BrokerSyncService } from '../broker/broker-sync.service';

@Processor('trade-sync')
export class TradeSyncProcessor extends WorkerHost {
  constructor(private sync: BrokerSyncService) { super(); }
  async process(job: Job<{ userId?: string }>) {
    if (job.data.userId) return this.sync.syncUser(job.data.userId);
    return this.sync.syncAll();
  }
}
