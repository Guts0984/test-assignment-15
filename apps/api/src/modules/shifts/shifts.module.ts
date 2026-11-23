import { Module } from '@nestjs/common';
import type { Db, RealtimePublisher } from '@helpdesk/core';
import type { Clock } from '@helpdesk/shared';
import { CLOCK, DB, ENV, PUBLISHER, SHIFTS } from '../../infra/tokens';
import { createShifts } from './shifts.usecases';
import { ShiftsController } from './shifts.controller';

@Module({
  controllers: [ShiftsController],
  providers: [
    {
      provide: SHIFTS,
      inject: [DB, CLOCK, ENV, PUBLISHER],
      useFactory: (
        db: Db,
        clock: Clock,
        env: { SHIFT_OFF_REPLY_WINDOW_MINUTES: number },
        publisher: RealtimePublisher,
      ) =>
        createShifts({
          db,
          clock,
          replyWindowMinutes: env.SHIFT_OFF_REPLY_WINDOW_MINUTES,
          publisher,
        }),
    },
  ],
})
export class ShiftsModule {}
