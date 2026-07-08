import { Controller, Get, HttpCode, HttpStatus, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../config/prisma.service';

@Controller()
export class HealthController {
  private readonly logger = new Logger(HealthController.name);
  private readonly startedAt = new Date();
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('trade-sync') private readonly queue: Queue,
    private readonly config: ConfigService,
  ) {}

  /**
   * Liveness + readiness in one endpoint. Returns 200 only if Postgres is
   * reachable; otherwise 503 so Railway/Kubernetes restart the container.
   * Kept lightweight (single SELECT 1) so probes don't hit rate limits.
   */
  @Get('healthz')
  async health() {
    const checks: Record<string, string> = {};
    let healthy = true;
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.database = 'up';
    } catch (err) {
      healthy = false;
      this.logger.warn(`database health check failed: ${(err as Error).message}`);
      checks.database = 'down';
    }

    try {
      const redis = await this.queue.client;
      await redis.ping();
      checks.redis = 'up';
    } catch (err) {
      healthy = false;
      this.logger.warn(`redis health check failed: ${(err as Error).message}`);
      checks.redis = 'down';
    }

    if (!healthy) throw new ServiceUnavailableException({ ok: false, ...this.meta(), checks });
    return { ok: true, ...this.meta(), checks };
  }

  /** Cheap liveness probe — doesn't touch the DB; for orchestrators that need both. */
  @Get('livez')
  @HttpCode(HttpStatus.OK)
  livez() {
    return { ok: true, ...this.meta() };
  }

  private meta() {
    return {
      service: 'tradeping-api',
      time: new Date().toISOString(),
      startedAt: this.startedAt.toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      release: this.config.get<string>('RELEASE_SHA') || null,
    };
  }
}
