import { Controller, Get, HttpCode, HttpStatus, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../config/prisma.service';

@Controller()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Liveness + readiness in one endpoint. Returns 200 only if Postgres is
   * reachable; otherwise 503 so Railway/Kubernetes restart the container.
   * Kept lightweight (single SELECT 1) so probes don't hit rate limits.
   */
  @Get('healthz')
  async health() {
    const checks: Record<string, string> = {};
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.database = 'up';
    } catch (err) {
      checks.database = `down: ${(err as Error).message}`;
      throw new ServiceUnavailableException({ ok: false, service: 'tradeping-api', time: new Date().toISOString(), checks });
    }
    return { ok: true, service: 'tradeping-api', time: new Date().toISOString(), checks };
  }

  /** Cheap liveness probe — doesn't touch the DB; for orchestrators that need both. */
  @Get('livez')
  @HttpCode(HttpStatus.OK)
  livez() {
    return { ok: true, time: new Date().toISOString() };
  }
}
