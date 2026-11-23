import { Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Db } from '@helpdesk/core';
import { notificationList, okResponse, type Clock } from '@helpdesk/shared';
import { createZodDto } from 'nestjs-zod';
import { RequireAccess } from '../../common/auth/access';
import { CurrentAuth } from '../../common/auth/current-auth';
import type { RequestAuth } from '../../common/auth/request-auth';
import { ApiErrors } from '../../common/errors/api-errors.decorator';
import { appError } from '../../common/errors/app-error';
import { CLOCK, DB } from '../../infra/tokens';

class NotificationListDto extends createZodDto(notificationList) {}
class NotificationsOkDto extends createZodDto(okResponse) {}

@ApiTags('notifications')
@RequireAccess('staff')
@Controller('notifications')
export class NotificationsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'SLA warnings (agent) and breach escalations (team lead), newest first',
  })
  @ApiOkResponse({ type: NotificationListDto })
  @ApiErrors()
  async list(@CurrentAuth() auth: RequestAuth): Promise<NotificationListDto> {
    if (auth.kind !== 'staff') throw appError('FORBIDDEN', 'Staff access required');
    const rows = await this.db.$queryRaw<
      {
        id: string;
        kind: string;
        ticket_id: string | null;
        data: Record<string, unknown>;
        created_at: Date;
        read_at: Date | null;
      }[]
    >`
      SELECT id, kind, ticket_id, data, created_at, read_at FROM notifications WHERE user_id = ${auth.user.id}::uuid ORDER BY created_at DESC LIMIT 50`;
    const unread = await this.db.$queryRaw<
      { n: bigint }[]
    >`SELECT count(*)::bigint AS n FROM notifications WHERE user_id = ${auth.user.id}::uuid AND read_at IS NULL`;
    return {
      items: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        ticketId: r.ticket_id,
        data: r.data,
        createdAt: r.created_at.toISOString(),
        read: r.read_at !== null,
      })),
      unread: Number(unread[0]?.n ?? 0),
    };
  }

  @Post('read')
  @HttpCode(200)
  @ApiOperation({ summary: 'Mark all my notifications as read' })
  @ApiOkResponse({ type: NotificationsOkDto })
  @ApiErrors()
  async read(@CurrentAuth() auth: RequestAuth): Promise<NotificationsOkDto> {
    if (auth.kind !== 'staff') throw appError('FORBIDDEN', 'Staff access required');
    await this.db
      .$executeRaw`UPDATE notifications SET read_at = ${this.clock.now()} WHERE user_id = ${auth.user.id}::uuid AND read_at IS NULL`;
    return { ok: true };
  }
}
