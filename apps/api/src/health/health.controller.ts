import { Controller, Get } from '@nestjs/common';
@Controller()
export class HealthController {
  @Get('healthz') health() { return { ok: true, service: 'tradeping-api', time: new Date().toISOString() }; }
}
