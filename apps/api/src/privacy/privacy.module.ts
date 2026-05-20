import { Module } from '@nestjs/common';
import { PrismaService } from '../config/prisma.service';
import { PrivacyService } from './privacy.service';
@Module({ providers: [PrivacyService, PrismaService], exports: [PrivacyService] })
export class PrivacyModule {}
