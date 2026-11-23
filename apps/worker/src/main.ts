import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import './config/env';

const bootstrap = async (): Promise<void> => {
  const app = await NestFactory.createApplicationContext(AppModule);
  app.enableShutdownHooks();
};

void bootstrap();
