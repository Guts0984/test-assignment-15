import { Controller, Headers, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { quickMessageId, upsertJob, type Db } from '@helpdesk/core';
import { email, inboundAccepted, normalizeEmail, type Clock } from '@helpdesk/shared';
import { createZodDto } from 'nestjs-zod';
import type { Request } from 'express';
import { RequireAccess } from '../../common/auth/access';
import { ApiErrors } from '../../common/errors/api-errors.decorator';
import { appError } from '../../common/errors/app-error';
import { CLOCK, DB, ENV } from '../../infra/tokens';
import { verifyInbound } from './domain/signature';

class InboundAcceptedDto extends createZodDto(inboundAccepted) {}
type InboundEnv = {
  readonly INBOUND_WEBHOOK_SECRET: string;
  readonly INBOUND_SIGNATURE_TOLERANCE_SECONDS: number;
};

@ApiTags('inbound')
@Controller('inbound')
export class InboundController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ENV) private readonly env: InboundEnv,
  ) {}

  @Post('mail')
  @HttpCode(202)
  @RequireAccess('public')
  @ApiOperation({
    summary:
      'Receive a raw RFC 822 email (called by the mail system; HMAC-signed). It is stored durably and processed by a worker.',
  })
  @ApiConsumes('message/rfc822')
  @ApiBody({ schema: { type: 'string', format: 'binary' } })
  @ApiResponse({ status: 202, type: InboundAcceptedDto })
  @ApiErrors(422)
  async receive(
    @Req() req: Request,
    @Headers('x-inbound-signature') signature: string | undefined,
    @Headers('x-envelope-to') envelopeTo: string | undefined,
  ): Promise<InboundAcceptedDto> {
    const raw: unknown = req.body;
    if (!Buffer.isBuffer(raw) || raw.length === 0)
      throw appError(
        'UNSUPPORTED_MEDIA_TYPE',
        'Send the raw message with Content-Type: message/rfc822',
      );
    const now = this.clock.now();
    const check = verifyInbound(
      this.env.INBOUND_WEBHOOK_SECRET,
      signature,
      raw,
      Date.now(),
      this.env.INBOUND_SIGNATURE_TOLERANCE_SECONDS,
    );
    if (check !== 'ok') throw appError('INBOUND_SIGNATURE_INVALID', 'Invalid inbound signature');
    const to = email.safeParse(normalizeEmail(envelopeTo ?? ''));
    if (!to.success)
      throw appError('VALIDATION_FAILED', 'X-Envelope-To must be a mailbox address', [
        { path: ['x-envelope-to'], code: 'invalid_string', message: 'invalid address' },
      ]);
    const messageId = quickMessageId(raw);
    const id = await this.db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO inbound_messages (mailbox_address, rfc_message_id, raw, received_at)
        VALUES (${to.data}, ${messageId}, ${raw}, ${now})
        ON CONFLICT (mailbox_address, rfc_message_id) DO NOTHING RETURNING id`;
      const row = rows[0];
      if (row === undefined) return null;
      await upsertJob(tx, {
        kind: 'inbound_process',
        ref: row.id,
        dedupeKey: `inbound:${row.id}`,
        runAt: now,
        now,
        payload: { inboundId: row.id },
      });
      return row.id;
    });
    return { status: id === null ? 'duplicate' : 'queued' };
  }
}
