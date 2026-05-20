import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { BrokerModule } from '../broker/broker.module';
import { TradeSyncProcessor } from './trade-sync.processor';
import { SchedulerController } from './scheduler.controller';

@Module({ imports: [ConfigModule, BrokerModule, BullModule.registerQueue({ name: 'trade-sync' })], providers: [TradeSyncProcessor], controllers: [SchedulerController] })
export class WorkersModule {}
