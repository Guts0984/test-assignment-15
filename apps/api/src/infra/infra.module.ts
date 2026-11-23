import {
  Global,
  Inject,
  Injectable,
  Module,
  type DynamicModule,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { createDb, createDbClock, type Db, type DbClock } from '@helpdesk/core';
import { systemClock, type Clock } from '@helpdesk/shared';
import { env as appEnv, type Env } from '../config/env';
import { CLOCK, DB, DB_CLOCK, ENV } from './tokens';

@Injectable()
class InfraShutdown implements OnApplicationShutdown {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(DB_CLOCK) private readonly dbClock: DbClock | null,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.dbClock?.stop();
    await this.db.$disconnect();
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
        InfraShutdown,
      ],
      exports: [ENV, DB, DB_CLOCK, CLOCK],
    };
  }
}
