import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TelegramController } from './telegram.controller';
import { TelegramService } from './telegram.service';
import { PrismaService } from '../config/prisma.service';
import { BrokerModule } from '../broker/broker.module';
import { PrivacyModule } from '../privacy/privacy.module';

@Module({ imports: [ConfigModule, forwardRef(() => BrokerModule), PrivacyModule], controllers: [TelegramController], providers: [TelegramService, PrismaService], exports: [TelegramService] })
export class TelegramModule {}
