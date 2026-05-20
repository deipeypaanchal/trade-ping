import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { PrismaService } from '../config/prisma.service';
import { CryptoService } from '../security/crypto.service';
import { SnaptradeService } from './snaptrade.service';
import { SnaptradeWebhookController } from './snaptrade-webhook.controller';

@Module({ imports: [ConfigModule, BullModule.registerQueue({ name: 'trade-sync' })], providers: [SnaptradeService, CryptoService, PrismaService], controllers: [SnaptradeWebhookController], exports: [SnaptradeService] })
export class SnaptradeModule {}
