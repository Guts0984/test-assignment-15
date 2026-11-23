import { Injectable, Module, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { env } from './config/env';
import { startWorkerRuntime, type WorkerRuntime } from './runtime/runtime';

/** Thin Nest shell: starts the worker runtime on boot and stops it on shutdown. */
@Injectable()
export class WorkerHost implements OnModuleInit, OnApplicationShutdown {
  private runtime: WorkerRuntime | null = null;

  async onModuleInit(): Promise<void> {
    this.runtime = await startWorkerRuntime({
      databaseUrl: env.DATABASE_URL,
      redisUrl: env.REDIS_URL,
      queuePrefix: 'hd',
      testClock: env.TEST_CLOCK_ENABLED,
      smtp: { host: env.SMTP_HOST, port: env.SMTP_PORT, fromName: env.SMTP_FROM_NAME },
      mailDomain: env.MAIL_DOMAIN,
      concurrency: env.WORKER_CONCURRENCY,
      reconcileIntervalMs: env.RECONCILE_INTERVAL_MS,
      reconcileHorizonMs: env.RECONCILE_HORIZON_MS,
      jobMaxAttempts: env.JOB_MAX_ATTEMPTS,
      backoffBaseMs: env.JOB_BACKOFF_BASE_MS,
      backoffMaxMs: env.JOB_BACKOFF_MAX_MS,
      outboundLeaseMs: env.OUTBOUND_LEASE_MS,
      ticket: {
        warningRatio: env.SLA_WARNING_RATIO,
        undoSeconds: env.UNDO_SEND_SECONDS,
        linkTtlDays: env.MAGIC_LINK_TTL_DAYS,
        surveyTtlDays: env.SURVEY_TTL_DAYS,
        autoCloseHours: env.AUTO_CLOSE_AFTER_HOURS,
        mailDomain: env.MAIL_DOMAIN,
        publicBaseUrl: env.PUBLIC_BASE_URL,
        maxAttachmentBytes: 10 * 1024 * 1024,
      },
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.runtime?.stop();
  }
}

@Module({ providers: [WorkerHost] })
export class AppModule {}
