import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { json, Request } from 'express';
import { AppModule } from './app.module';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.use(json({
    limit: '1mb',
    verify: (req: Request & { rawBody?: string }, _res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  }));
  // enableShutdownHooks triggers NestJS OnModuleDestroy / OnApplicationShutdown
  // for all providers (Prisma disconnect, BullMQ worker close, auto-sync timer
  // cleanup). Combined with SIGTERM handling below this gives us a clean drain
  // on container restarts.
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3000);
  const server = await app.listen(port);
  let shuttingDown = false;
  const httpDrainTimeoutMs = 30_000;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.log(`${signal} received; closing HTTP server and shutting down`);
    try {
      await new Promise<void>((resolve, reject) => {
        const forceClose = setTimeout(() => {
          logger.warn(`HTTP drain exceeded ${httpDrainTimeoutMs}ms; closing remaining connections`);
          server.closeAllConnections?.();
        }, httpDrainTimeoutMs);
        forceClose.unref?.();
        server.close((err?: Error) => {
          clearTimeout(forceClose);
          if (err) reject(err);
          else resolve();
        });
        // Keep active requests draining, but do not let idle keep-alive sockets
        // delay a deploy shutdown.
        server.closeIdleConnections?.();
      });
      await app.close();
      logger.log('graceful shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error(`shutdown error: ${(err as Error).message}`);
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error(`unhandledRejection: ${reason instanceof Error ? reason.stack : String(reason)}`);
    void shutdown('unhandledRejection');
  });
  process.on('uncaughtException', (err) => {
    logger.error(`uncaughtException: ${err.stack ?? err.message}`);
    void shutdown('uncaughtException');
  });
}
void bootstrap();
