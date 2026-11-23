import { Controller, Get, Module } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  get(): { status: 'ok' } {
    return { status: 'ok' };
  }
}

@Module({ controllers: [HealthController] })
export class AppModule {}
