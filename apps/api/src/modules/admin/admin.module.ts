import { Module } from '@nestjs/common';
import type { Db, RealtimePublisher } from '@helpdesk/core';
import type { Clock } from '@helpdesk/shared';
import { ACCESS_REVOKER, ADMIN, CLOCK, DB, ENV, PUBLISHER } from '../../infra/tokens';
import { AdminController } from './admin.controller';
import { createAdmin } from './admin.usecases';

@Module({
  controllers: [AdminController],
  providers: [
    {
      provide: ADMIN,
      inject: [DB, CLOCK, ENV, PUBLISHER, ACCESS_REVOKER],
      useFactory: (
        db: Db,
        clock: Clock,
        env: { ARGON2_MEMORY_KIB: number; ARGON2_TIME_COST: number },
        publisher: RealtimePublisher,
        revoker: { leaveTeam: (u: string, t: string) => void; disconnectUser: (u: string) => void },
      ) =>
        createAdmin({
          db,
          clock,
          cost: { memoryKiB: env.ARGON2_MEMORY_KIB, timeCost: env.ARGON2_TIME_COST },
          publisher,
          revoker,
        }),
    },
  ],
})
export class AdminModule {}
