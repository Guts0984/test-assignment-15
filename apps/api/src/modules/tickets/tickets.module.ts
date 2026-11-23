import { Global, Module } from '@nestjs/common';
import type { Db, RealtimePublisher, TicketConfig } from '@helpdesk/core';
import type { Clock } from '@helpdesk/shared';
import { CLOCK, DB, ENV, PUBLISHER, TICKETS, TICKET_CFG } from '../../infra/tokens';
import { TicketsController } from './tickets.controller';
import { createTicketService } from './tickets.service';

type TicketEnv = {
  SLA_WARNING_RATIO: number;
  UNDO_SEND_SECONDS: number;
  MAGIC_LINK_TTL_DAYS: number;
  SURVEY_TTL_DAYS: number;
  AUTO_CLOSE_AFTER_HOURS: number;
  MAIL_DOMAIN: string;
  PUBLIC_BASE_URL: string;
  MAX_ATTACHMENTS_BYTES: number;
};

@Global()
@Module({
  controllers: [TicketsController],
  providers: [
    {
      provide: TICKET_CFG,
      inject: [ENV],
      useFactory: (e: TicketEnv): TicketConfig => ({
        warningRatio: e.SLA_WARNING_RATIO,
        undoSeconds: e.UNDO_SEND_SECONDS,
        linkTtlDays: e.MAGIC_LINK_TTL_DAYS,
        surveyTtlDays: e.SURVEY_TTL_DAYS,
        autoCloseHours: e.AUTO_CLOSE_AFTER_HOURS,
        mailDomain: e.MAIL_DOMAIN,
        publicBaseUrl: e.PUBLIC_BASE_URL,
        maxAttachmentBytes: e.MAX_ATTACHMENTS_BYTES,
      }),
    },
    {
      provide: TICKETS,
      inject: [DB, CLOCK, TICKET_CFG, PUBLISHER],
      useFactory: (db: Db, clock: Clock, cfg: TicketConfig, publisher: RealtimePublisher) =>
        createTicketService({ db, clock, cfg, publisher }),
    },
  ],
  exports: [TICKETS, TICKET_CFG],
})
export class TicketsModule {}
