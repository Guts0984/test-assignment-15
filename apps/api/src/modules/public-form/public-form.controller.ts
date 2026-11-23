import { Body, Controller, Inject, Post, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiCreatedResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createTicketFromForm, isUniqueViolation, type TicketConfig } from '@helpdesk/core';
import { publicTicketCreated, publicTicketInput } from '@helpdesk/shared';
import { createZodDto } from 'nestjs-zod';
import { RequireAccess } from '../../common/auth/access';
import { ApiErrors } from '../../common/errors/api-errors.decorator';
import {
  AttachmentsInterceptor,
  MULTIPART_BODY,
  parseFields,
  toAttachments,
} from '../../common/http/uploads';
import { TICKETS, TICKET_CFG } from '../../infra/tokens';
import type { TicketService } from '../tickets/tickets.service';

class PublicTicketCreatedDto extends createZodDto(publicTicketCreated) {}

@ApiTags('public')
@Controller('public')
export class PublicFormController {
  constructor(
    @Inject(TICKETS) private readonly svc: TicketService,
    @Inject(TICKET_CFG) private readonly cfg: TicketConfig,
  ) {}

  @Post('tickets')
  @RequireAccess('public')
  @UseInterceptors(AttachmentsInterceptor)
  @ApiOperation({
    summary:
      'Contact form: subject, text and attachments up to 10 MB. The link to follow the request is emailed, never returned.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody(MULTIPART_BODY)
  @ApiCreatedResponse({ type: PublicTicketCreatedDto })
  @ApiErrors()
  async create(
    @Body() fields: Record<string, unknown>,
    @UploadedFiles() files: Express.Multer.File[] | undefined,
  ): Promise<PublicTicketCreatedDto> {
    const input = parseFields(publicTicketInput, fields);
    const attachments = toAttachments(files, this.cfg.maxAttachmentBytes);
    const run = () =>
      this.svc.command(async (c) => ({
        ok: true as const,
        value: await createTicketFromForm(c, { ...input, attachments }),
      }));
    // Two simultaneous submits with one idempotency key: the loser hits the unique Message-ID and simply re-reads the winner.
    const r = await run().catch((e: unknown) => (isUniqueViolation(e) ? run() : Promise.reject(e)));
    return {
      number: r.number,
      message: 'Your request was received. We emailed you a link to follow it.',
    };
  }
}
