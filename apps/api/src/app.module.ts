import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { validateEnv } from './config/env';
import { PrismaService } from './config/prisma.service';
import { HealthController } from './health/health.controller';
import { TelegramModule } from './telegram/telegram.module';
import { SnaptradeModule } from './snaptrade/snaptrade.module';
import { BrokerModule } from './broker/broker.module';
import { AlertsModule } from './alerts/alerts.module';
import { PrivacyModule } from './privacy/privacy.module';
import { WorkersModule } from './workers/workers.module';
import { LegalModule } from './legal/legal.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    BullModule.forRootAsync({ imports: [ConfigModule], inject: [ConfigService], useFactory: (config: ConfigService) => { const u = new URL(config.getOrThrow<string>('REDIS_URL')); return { connection: { host: u.hostname, port: Number(u.port || 6379), username: u.username || undefined, password: u.password || undefined, tls: u.protocol === 'rediss:' ? {} : undefined } }; } }),
    TelegramModule,
    SnaptradeModule,
    BrokerModule,
    AlertsModule,
    PrivacyModule,
    WorkersModule,
    LegalModule,
  ],
  controllers: [HealthController],
  providers: [PrismaService],
})
export class AppModule {}
