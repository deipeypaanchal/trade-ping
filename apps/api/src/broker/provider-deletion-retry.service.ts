import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { BrokerOnboardingService } from './broker-onboarding.service';

const RETRY_INTERVAL_MS = 60 * 60_000;

@Injectable()
export class ProviderDeletionRetryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProviderDeletionRetryService.name);
  private timer?: NodeJS.Timeout;

  constructor(private readonly onboarding: BrokerOnboardingService) {}

  onModuleInit(): void {
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), RETRY_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(): Promise<void> {
    try {
      const result = await this.onboarding.retryProviderDeletions();
      if (result.attempted) {
        this.logger.log(`provider deletion retry attempted=${result.attempted} accepted=${result.accepted}`);
      }
    } catch (err) {
      this.logger.warn(`provider deletion retry failed: ${(err as Error).message}`);
    }
  }
}
