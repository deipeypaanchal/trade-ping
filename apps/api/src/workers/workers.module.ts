import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { BrokerModule } from '../broker/broker.module';
import { PrismaService } from '../config/prisma.service';
import { TradeSyncProcessor } from './trade-sync.processor';
import { SchedulerController } from './scheduler.controller';
import { AutoSyncService } from './auto-sync.service';
import { IdempotencySweeperService } from './idempotency-sweeper.service';

@Module({
  imports: [ConfigModule, BrokerModule, BullModule.registerQueue({ name: 'trade-sync' })],
  providers: [TradeSyncProcessor, AutoSyncService, IdempotencySweeperService, PrismaService],
  controllers: [SchedulerController],
})
export class WorkersModule {}
