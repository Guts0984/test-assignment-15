import { Module } from '@nestjs/common';
import type { Db } from '@helpdesk/core';
import type { Clock } from '@helpdesk/shared';
import { hashPassword } from '../../infra/password';
import { AUTH, CLOCK, DB, ENV } from '../../infra/tokens';
import { AuthController } from './auth.controller';
import { createAuth } from './auth.usecases';

type AuthEnv = {
  readonly JWT_ACCESS_SECRET: string;
  readonly JWT_ACCESS_TTL_SECONDS: number;
  readonly REFRESH_TOKEN_TTL_DAYS: number;
  readonly ARGON2_MEMORY_KIB: number;
  readonly ARGON2_TIME_COST: number;
};

@Module({
  controllers: [AuthController],
  providers: [
    {
      provide: AUTH,
      inject: [DB, CLOCK, ENV],
      useFactory: async (db: Db, clock: Clock, env: AuthEnv) =>
        createAuth({
          db,
          clock,
          jwtSecret: env.JWT_ACCESS_SECRET,
          accessTtlSeconds: env.JWT_ACCESS_TTL_SECONDS,
          refreshTtlDays: env.REFRESH_TOKEN_TTL_DAYS,
          dummyHash: await hashPassword('not-a-real-password', {
            memoryKiB: env.ARGON2_MEMORY_KIB,
            timeCost: env.ARGON2_TIME_COST,
          }),
        }),
    },
  ],
})
export class AuthModule {}
