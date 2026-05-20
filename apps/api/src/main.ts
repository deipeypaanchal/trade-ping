import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { json, Request } from 'express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.use(json({
    limit: '1mb',
    verify: (req: Request & { rawBody?: string }, _res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  }));
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
}
bootstrap();
