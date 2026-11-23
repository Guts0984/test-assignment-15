import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { env } from './config/env';

const bootstrap = async (): Promise<void> => {
  const app = await NestFactory.create(AppModule);
  await app.listen(env.API_PORT, '0.0.0.0');
};

void bootstrap();
