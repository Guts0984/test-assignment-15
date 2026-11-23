import { Inject } from '@nestjs/common';
import { WebSocketGateway, WebSocketServer, type OnGatewayInit } from '@nestjs/websockets';
import type { Db } from '@helpdesk/core';
import type { Clock } from '@helpdesk/shared';
import type { Redis } from 'ioredis';
import type { Server } from 'socket.io';
import { env } from '../../config/env';
import { CLOCK, DB, ENV, REDIS } from '../../infra/tokens';
import { setupRealtime } from './realtime.setup';

type RealtimeEnv = {
  readonly JWT_ACCESS_SECRET: string;
  readonly PRESENCE_TTL_SECONDS: number;
  readonly SOCKET_EVENT_BUDGET_PER_SECOND: number;
};

const allowed = new Set(env.CORS_ALLOWED_ORIGINS.split(',').map((s) => s.trim()));

/** Socket.IO endpoint (WebSocket only, so no sticky sessions are needed behind nginx). */
@WebSocketGateway({
  path: '/socket.io',
  transports: ['websocket'],
  pingInterval: env.SOCKET_PING_INTERVAL_MS,
  pingTimeout: env.SOCKET_PING_TIMEOUT_MS,
  maxHttpBufferSize: 100_000,
  cors: {
    origin: (origin: string | undefined, cb: (e: Error | null, ok?: boolean) => void) =>
      cb(null, origin === undefined || allowed.has(origin)),
  },
})
export class RealtimeGateway implements OnGatewayInit {
  @WebSocketServer() server!: Server;
  private stop: (() => void) | null = null;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ENV) private readonly cfg: RealtimeEnv,
  ) {}

  afterInit(server: Server): void {
    this.stop = setupRealtime(server, {
      db: this.db,
      clock: this.clock,
      redis: this.redis,
      jwtSecret: this.cfg.JWT_ACCESS_SECRET,
      presenceTtlMs: this.cfg.PRESENCE_TTL_SECONDS * 1000,
      eventBudgetPerSecond: this.cfg.SOCKET_EVENT_BUDGET_PER_SECOND,
    }).stop;
  }

  onApplicationShutdown(): void {
    this.stop?.();
  }
}
