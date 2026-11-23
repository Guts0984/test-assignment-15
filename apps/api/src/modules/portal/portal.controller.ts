import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  StreamableFile,
  UploadedFiles,
  UseInterceptors,
  Header,
} from '@nestjs/common';
import {
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { appendCustomerMessage, type TicketConfig } from '@helpdesk/core';
import {
  attachmentIdParam,
  portalReplyInput,
  portalReplyResult,
  portalTicketView,
} from '@helpdesk/shared';
import { createZodDto } from 'nestjs-zod';
import { RequireAccess } from '../../common/auth/access';
import { CurrentAuth } from '../../common/auth/current-auth';
import type { RequestAuth } from '../../common/auth/request-auth';
import { ApiErrors } from '../../common/errors/api-errors.decorator';
import { appError } from '../../common/errors/app-error';
import {
  AttachmentsInterceptor,
  MULTIPART_BODY,
  parseFields,
  toAttachments,
} from '../../common/http/uploads';
import { TICKETS, TICKET_CFG } from '../../infra/tokens';
import type { TicketService } from '../tickets/tickets.service';

class PortalTicketDto extends createZodDto(portalTicketView) {}
class PortalReplyResultDto extends createZodDto(portalReplyResult) {}
class PortalAttachmentParamDto extends createZodDto(attachmentIdParam) {}

const customer = (auth: RequestAuth) => {
  if (auth.kind !== 'customer') throw appError('LINK_INVALID', 'Invalid link');
  return auth.principal;
};

/** Customer endpoints: the link token names exactly one ticket and nothing else is reachable with it. */
@ApiTags('portal')
@ApiSecurity('ticket-link')
@RequireAccess('customer')
@Controller('portal')
export class PortalController {
  constructor(
    @Inject(TICKETS) private readonly svc: TicketService,
    @Inject(TICKET_CFG) private readonly cfg: TicketConfig,
  ) {}

  @Get('ticket')
  @ApiOperation({
    summary:
      'The conversation behind the email link (customer-visible messages only, never internal notes)',
  })
  @ApiOkResponse({ type: PortalTicketDto })
  @ApiErrors(410)
  async ticket(@CurrentAuth() auth: RequestAuth): Promise<PortalTicketDto> {
    const p = customer(auth);
    const t = await this.svc.db.$queryRaw<{ number: bigint; subject: string; status: string }[]>`
      SELECT number, subject, status FROM tickets WHERE id = ${p.ticketId}::uuid AND customer_id = ${p.customerId}::uuid`;
    const head = t[0];
    if (head === undefined) throw appError('LINK_INVALID', 'Invalid link');
    const msgs = await this.svc.db.$queryRaw<
      {
        id: string;
        direction: string;
        author_name: string | null;
        author_kind: string;
        body: string;
        created_at: Date;
      }[]
    >`
      SELECT m.id, m.direction, COALESCE(m.author_name, u.name) AS author_name, m.author_kind, m.body, m.created_at
        FROM messages m LEFT JOIN users u ON u.id = m.author_user_id
       WHERE m.ticket_id = ${p.ticketId}::uuid AND m.kind = 'public' AND m.cancelled_at IS NULL AND m.auto_kind IS NULL
         AND (m.direction = 'inbound' OR m.released_at IS NOT NULL)
       ORDER BY m.seq`;
    const atts = await this.svc.db.$queryRaw<
      { id: string; message_id: string; filename: string; content_type: string; size: number }[]
    >`
      SELECT a.id, a.message_id, a.filename, a.content_type, a.size FROM attachments a JOIN messages m ON m.id = a.message_id
       WHERE m.ticket_id = ${p.ticketId}::uuid AND m.kind = 'public' AND m.cancelled_at IS NULL AND (m.direction = 'inbound' OR m.released_at IS NOT NULL)`;
    return {
      number: Number(head.number),
      subject: head.subject,
      status: head.status as PortalTicketDto['status'],
      canReply: true,
      messages: msgs.map((m) => ({
        id: m.id,
        direction: m.direction as 'inbound' | 'outbound',
        authorName: m.author_kind === 'agent' ? m.author_name : null,
        body: m.body,
        createdAt: m.created_at.toISOString(),
        attachments: atts
          .filter((a) => a.message_id === m.id)
          .map((a) => ({
            id: a.id,
            filename: a.filename,
            contentType: a.content_type,
            size: a.size,
          })),
      })),
      serverTime: this.svc.now().toISOString(),
    };
  }

  @Post('replies')
  @UseInterceptors(AttachmentsInterceptor)
  @ApiOperation({
    summary:
      'Reply from the portal. On a closed ticket this opens a new request linked to the old one.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody(MULTIPART_BODY)
  @ApiCreatedResponse({ type: PortalReplyResultDto })
  @ApiErrors(410)
  async reply(
    @CurrentAuth() auth: RequestAuth,
    @Body() fields: Record<string, unknown>,
    @UploadedFiles() files: Express.Multer.File[] | undefined,
  ): Promise<PortalReplyResultDto> {
    const p = customer(auth);
    const input = parseFields(portalReplyInput, fields);
    const attachments = toAttachments(files, this.cfg.maxAttachmentBytes);
    const owner = await this.svc.db.$queryRaw<
      { email: string; name: string; subject: string; language: string }[]
    >`
      SELECT c.email, c.name, t.subject, t.language FROM tickets t JOIN customers c ON c.id = t.customer_id WHERE t.id = ${p.ticketId}::uuid`;
    const o = owner[0];
    if (o === undefined) throw appError('LINK_INVALID', 'Invalid link');
    return this.svc.command(async (c) => {
      const r = await appendCustomerMessage(
        c,
        p.ticketId,
        {
          body: input.body,
          attachments,
          rfcMessageId: null,
          inboundMessageId: null,
          customerEmail: o.email,
          customerName: o.name,
          subject: o.subject,
          suppressAcknowledgement: false,
        },
        { priority: 'normal', language: o.language as 'en' },
      );
      if (!r.ok) return r;
      const id = r.value.kind === 'follow_up' ? r.value.created.ticketId : r.value.ticketId;
      const n = await c.tx.$queryRaw<
        { number: bigint }[]
      >`SELECT number FROM tickets WHERE id = ${id}::uuid`;
      return {
        ok: true as const,
        value: { number: Number(n[0]?.number ?? 0), newRequest: r.value.kind === 'follow_up' },
      };
    });
  }

  @Get('attachments/:id')
  @ApiOperation({ summary: 'Download an attachment of a customer-visible message' })
  @ApiProduces('application/octet-stream')
  @ApiOkResponse({ description: 'File bytes' })
  @ApiErrors(410)
  @Header('X-Content-Type-Options', 'nosniff')
  async attachment(
    @CurrentAuth() auth: RequestAuth,
    @Param() prm: PortalAttachmentParamDto,
  ): Promise<StreamableFile> {
    const p = customer(auth);
    const rows = await this.svc.db.$queryRaw<{ filename: string; data: Buffer }[]>`
      SELECT a.filename, a.data FROM attachments a JOIN messages m ON m.id = a.message_id
       WHERE a.id = ${prm.id}::uuid AND m.ticket_id = ${p.ticketId}::uuid AND m.kind = 'public' AND m.cancelled_at IS NULL
         AND (m.direction = 'inbound' OR m.released_at IS NOT NULL)`;
    const r = rows[0];
    if (r === undefined) throw appError('NOT_FOUND', 'Attachment not found');
    return new StreamableFile(Buffer.from(r.data), {
      type: 'application/octet-stream',
      disposition: `attachment; filename="${r.filename.replace(/["\r\n\\]/g, '_')}"`,
    });
  }
}
