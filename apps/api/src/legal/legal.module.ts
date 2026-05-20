import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from '../config/prisma.service';
import { BrokerModule } from '../broker/broker.module';
import { AccountController } from './account.controller';
@Module({ imports: [ConfigModule, BrokerModule], controllers: [AccountController], providers: [PrismaService] })
export class LegalModule {}
