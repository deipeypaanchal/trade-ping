import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { PrismaService } from '../config/prisma.service';
import { CryptoService } from '../security/crypto.service';
import { SnaptradeModule } from '../snaptrade/snaptrade.module';
import { AlertsModule } from '../alerts/alerts.module';
import { BrokerOnboardingService } from './broker-onboarding.service';
import { BrokerSyncService } from './broker-sync.service';
import { TradeDetectorService } from './trade-detector.service';

@Module({ imports: [ConfigModule, SnaptradeModule, forwardRef(() => AlertsModule), BullModule.registerQueue({ name: 'trade-sync' })], providers: [PrismaService, CryptoService, BrokerOnboardingService, BrokerSyncService, TradeDetectorService], exports: [BrokerOnboardingService, BrokerSyncService, TradeDetectorService] })
export class BrokerModule {}
