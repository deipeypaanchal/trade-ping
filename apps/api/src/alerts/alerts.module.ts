import { Module, forwardRef } from '@nestjs/common';
import { PrismaService } from '../config/prisma.service';
import { TelegramModule } from '../telegram/telegram.module';
import { AlertService } from './alert.service';
@Module({ imports: [forwardRef(() => TelegramModule)], providers: [AlertService, PrismaService], exports: [AlertService] })
export class AlertsModule {}
