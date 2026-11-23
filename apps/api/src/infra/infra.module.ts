import {
  Global,
  Inject,
  Injectable,
  Module,
  type DynamicModule,
  type OnApplicationShutdown,
} from '@nestjs/common';
import {
  createDb,
  createDbClock,
  createEmitterPublisher,
  createUserAccessRevoker,
  type Db,
  type DbClock,
  type RealtimePublisher,
} from '@helpdesk/core';
import { Redis } from 'ioredis';
import { systemClock, type Clock } from '@helpdesk/shared';
import { env as appEnv, type Env } from '../config/env';
import { ACCESS_REVOKER, CLOCK, DB, DB_CLOCK, ENV, PUBLISHER, REDIS } from './tokens';

@Injectable()
class InfraShutdown implements OnApplicationShutdown {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(DB_CLOCK) private readonly dbClock: DbClock | null,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.dbClock?.stop();
    await this.db.$disconnect();
    await this.redis.quit().catch(() => undefined);
  }
}

/** Database, environment and clock, shared by every module. */
@Global()
@Module({})
export class InfraModule {
  static register(env: Env = appEnv): DynamicModule {
    return {
      module: InfraModule,
      global: true,
      providers: [
        { provide: ENV, useValue: env },
        { provide: DB, useFactory: (): Db => createDb(env.DATABASE_URL) },
        {
          provide: DB_CLOCK,
          inject: [DB],
          useFactory: (db: Db): Promise<DbClock | null> =>
            env.TEST_CLOCK_ENABLED
              ? createDbClock({ base: systemClock, db, listenUrl: env.DATABASE_URL })
              : Promise.resolve(null),
        },
        {
          provide: CLOCK,
          inject: [DB_CLOCK],
          useFactory: (dbClock: DbClock | null): Clock => dbClock ?? systemClock,
        },
        {
          provide: REDIS,
          useFactory: (): Redis => {
            const r = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: true });
            r.on('error', () => undefined);
            return r;
          },
        },
        {
          provide: PUBLISHER,
          inject: [REDIS],
          useFactory: (r: Redis): RealtimePublisher => createEmitterPublisher(r),
        },
        {
          provide: ACCESS_REVOKER,
          inject: [REDIS],
          useFactory: (r: Redis) => createUserAccessRevoker(r),
        },
        InfraShutdown,
      ],
      exports: [ENV, DB, DB_CLOCK, CLOCK, REDIS, PUBLISHER, ACCESS_REVOKER],
    };
  }
}
