import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get(ConfigService);

  const origins = String(config.get<string>('CORS_ORIGINS') || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

  app.set('trust proxy', 1);
  app.enableCors({
    origin: origins.length ? origins : false,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Internal-Secret',
      'X-Request-Id',
      'X-Forwarded-For',
    ],
  });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  const port = Number(config.get('PORT')) || 3010;
  await app.listen(port);
  const mode = config.get<string>('META_MODE') || 'disabled';

  console.log(
    `[lavilet-meta-capi] mode=${mode} http://localhost:${port}/api/health`,
  );
}

void bootstrap();
