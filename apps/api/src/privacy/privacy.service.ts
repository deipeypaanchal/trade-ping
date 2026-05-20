import { BadRequestException, Injectable } from '@nestjs/common';
import { PrivacyLevel } from '@prisma/client';
import { PrismaService } from '../config/prisma.service';

@Injectable()
export class PrivacyService {
  constructor(private prisma: PrismaService) {}

  async setPrivacy(userId: string, groupId: string, levelRaw: string) {
    const level = levelRaw.toUpperCase() as PrivacyLevel;
    if (!Object.values(PrivacyLevel).includes(level)) throw new BadRequestException('Invalid privacy level');
    await this.prisma.groupMember.update({ where: { userId_groupId: { userId, groupId } }, data: { privacyLevel: level, alertsEnabled: level !== 'OFF' } });
    await this.prisma.auditLog.create({ data: { userId, action: 'privacy_updated', metadata: { groupId, level } } });
  }
}
