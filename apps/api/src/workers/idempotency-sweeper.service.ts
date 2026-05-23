import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../config/prisma.service';

/**
 * Background sweeper that deletes expired IdempotencyKey rows. Without this the
 * table grows unbounded and disk usage tracks total webhook volume forever,
 * even though every row's purpose ends at `expiresAt` (10 min by default).
 *
 * Runs every IDEMPOTENCY_SWEEP_INTERVAL_MS, opportunistically; a missed sweep
 * does no harm \u2014 the unique-key on `key` is what actually enforces
 * idempotency, the table only acts as a TTL cache.
 */
const IDEMPOTENCY_SWEEP_INTERVAL_MS = 10 * 60 * 1000;

@Injectable()
export class IdempotencySweeperService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IdempotencySweeperService.name);
  private timer?: NodeJS.Timeout;

  constructor(private prisma: PrismaService) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.sweep(), IDEMPOTENCY_SWEEP_INTERVAL_MS);
    // Run once a minute after boot so we don't pile work on the cold-start path.
    setTimeout(() => void this.sweep(), 60_000).unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(): Promise<number> {
    try {
      const { count } = await this.prisma.idempotencyKey.deleteMany({ where: { expiresAt: { lt: new Date() } } });
      if (count > 0) this.logger.log(`swept ${count} expired idempotency key(s)`);
      return count;
    } catch (err) {
      this.logger.warn(`idempotency sweep failed: ${(err as Error).message}`);
      return 0;
    }
  }
}
