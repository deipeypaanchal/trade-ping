import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { TelegramController } from './telegram.controller';
import { TelegramService } from './telegram.service';
import { PrismaService } from '../config/prisma.service';
import { BrokerModule } from '../broker/broker.module';
import { PrivacyModule } from '../privacy/privacy.module';
import { CryptoService } from '../security/crypto.service';

@Module({ imports: [ConfigModule, forwardRef(() => BrokerModule), PrivacyModule, BullModule.registerQueue({ name: 'trade-sync' })], controllers: [TelegramController], providers: [TelegramService, PrismaService, CryptoService], exports: [TelegramService] })
export class TelegramModule {}
