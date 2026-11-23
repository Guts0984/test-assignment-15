import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import './config/env';

const bootstrap = async (): Promise<void> => {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  // Stop explicitly and exit: the signal Nest's own hook re-sends is ignored by a Node process running as PID 1.
  const stop = (): void => {
    void app.close().finally(() => process.exit(0));
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
};

void bootstrap();
