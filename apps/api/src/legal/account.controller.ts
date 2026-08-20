import { BadRequestException, Body, Controller, Delete, Headers, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../config/prisma.service';
import { BrokerOnboardingService } from '../broker/broker-onboarding.service';
import { safeBearerEqual } from '../security/constant-time';

@Controller('account')
export class AccountController {
  constructor(private prisma: PrismaService, private broker: BrokerOnboardingService, private config: ConfigService) {}

  @Delete('delete')
  async deleteAccount(@Body() body: { telegramUserId?: string; userId?: string }, @Headers('authorization') auth?: string) {
    const secret = this.config.getOrThrow<string>('INTERNAL_JOB_SECRET');
    if (!safeBearerEqual(auth, secret)) throw new UnauthorizedException();
    // XOR validation: caller must specify exactly one identifier. Accepting
    // both has historically been a confused-deputy footgun — a stale userId
    // alongside the intended telegramUserId silently deleted the wrong account.
    const hasId = !!body.userId;
    const hasTelegram = !!body.telegramUserId;
    if (hasId === hasTelegram) {
      throw new BadRequestException('Provide exactly one of userId or telegramUserId');
    }
    const user = hasId
      ? await this.prisma.user.findUnique({ where: { id: body.userId! } })
      : await this.prisma.user.findUnique({ where: { telegramUserId: body.telegramUserId! } });
    if (!user) return { ok: true, deleted: false, pending: false, notFound: true };
    // SnapTrade accepts user deletion asynchronously. The service scrubs local
    // content immediately but retains an opaque local record plus provider
    // tombstone until signed USER_DELETED confirms it or an exact-generation
    // deletion retry receives the provider's authoritative 404 absence signal.
    const deletion = await this.broker.deleteRemoteUser(user.id);
    if (deletion.state === 'COMPLETE') {
      await this.prisma.user.deleteMany({ where: { id: user.id } });
      return {
        ok: true,
        deleted: true,
        pending: false,
        providerDeletionRequired: false,
        providerCredentialState: deletion.providerCredentialState,
        purgedJobs: deletion.purgedJobs,
      };
    }
    return {
      ok: true,
      deleted: false,
      pending: true,
      deletionRequestId: user.id,
      remoteDeletionAccepted: deletion.state === 'PENDING',
      retryRequired: deletion.state === 'RETRY_REQUIRED',
      manualReviewRequired: deletion.state === 'MANUAL_REVIEW_REQUIRED',
      providerDeletionRequired: true,
      providerCredentialState: deletion.providerCredentialState,
      purgedJobs: deletion.purgedJobs,
    };
  }
}
