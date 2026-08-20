import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../config/prisma.service';

/**
 * Background sweeper that deletes expired webhook idempotency rows and old,
 * HMAC-scoped Telegram ordering cursors. Without it replay state grows forever.
 *
 * Runs every IDEMPOTENCY_SWEEP_INTERVAL_MS, opportunistically; a missed sweep
 * does no harm \u2014 completed rows and finite processing leases enforce
 * idempotency; expiry only bounds how long replay state is retained.
 */
const IDEMPOTENCY_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
// Telegram may reset update_id after a week without updates. Expire ordering
// state with a margin so the first post-idle safety command is never compared
// against an unrelated ID from the prior sequence.
const TELEGRAM_CURSOR_RETENTION_MS = 6 * 24 * 60 * 60_000;

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
      const now = new Date();
      const [{ count: idempotencyCount }, { count: cursorCount }, { count: suppressionCount }] = await Promise.all([
        this.prisma.idempotencyKey.deleteMany({ where: { expiresAt: { lt: now } } }),
        this.prisma.telegramUpdateCursor.deleteMany({
          where: { updatedAt: { lt: new Date(now.getTime() - TELEGRAM_CURSOR_RETENTION_MS) } },
        }),
        this.prisma.telegramIdentitySuppression.deleteMany({ where: { expiresAt: { lt: now } } }),
      ]);
      const count = idempotencyCount + cursorCount + suppressionCount;
      if (count > 0) this.logger.log(`swept ${count} expired replay-state row(s)`);
      return count;
    } catch (err) {
      this.logger.warn(`idempotency sweep failed: ${(err as Error).message}`);
      return 0;
    }
  }
}
