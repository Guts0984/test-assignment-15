import { Module } from '@nestjs/common';
import type { Db } from '@helpdesk/core';
import type { Clock } from '@helpdesk/shared';
import { ADMIN, CLOCK, DB, ENV } from '../../infra/tokens';
import { AdminController } from './admin.controller';
import { createAdmin } from './admin.usecases';

@Module({
  controllers: [AdminController],
  providers: [
    {
      provide: ADMIN,
      inject: [DB, CLOCK, ENV],
      useFactory: (
        db: Db,
        clock: Clock,
        env: { ARGON2_MEMORY_KIB: number; ARGON2_TIME_COST: number },
      ) =>
        createAdmin({
          db,
          clock,
          cost: { memoryKiB: env.ARGON2_MEMORY_KIB, timeCost: env.ARGON2_TIME_COST },
        }),
    },
  ],
})
export class AdminModule {}
