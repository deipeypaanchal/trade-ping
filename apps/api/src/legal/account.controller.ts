import { Body, Controller, Delete, Headers, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../config/prisma.service';
import { BrokerOnboardingService } from '../broker/broker-onboarding.service';

@Controller('account')
export class AccountController {
  constructor(private prisma: PrismaService, private broker: BrokerOnboardingService, private config: ConfigService) {}

  @Delete('delete')
  async deleteAccount(@Body() body: { telegramUserId?: string; userId?: string }, @Headers('authorization') auth?: string) {
    const secret = this.config.getOrThrow<string>('INTERNAL_JOB_SECRET');
    if (auth !== `Bearer ${secret}`) throw new UnauthorizedException();
    const user = body.userId ? await this.prisma.user.findUnique({ where: { id: body.userId } }) : body.telegramUserId ? await this.prisma.user.findUnique({ where: { telegramUserId: body.telegramUserId } }) : null;
    if (!user) return { ok: true, deleted: false };
    await this.broker.disconnectAll(user.id);
    await this.prisma.user.delete({ where: { id: user.id } });
    return { ok: true, deleted: true };
  }
}
