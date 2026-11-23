import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import {
  cancelReply,
  changePriority,
  changeStatus,
  changeTeam,
  createNote,
  createReply,
  mergeTickets,
  takeTicket,
  transferTicket,
} from '@helpdesk/core';
import {
  canViewReports,
  canViewTeamDashboard,
  canViewTicket,
  isLeadOf,
  leadTeamIds,
  visibleTeamIds,
} from '@helpdesk/shared';
import { RequireAccess } from '../../common/auth/access';
import { CurrentAuth } from '../../common/auth/current-auth';
import type { RequestAuth } from '../../common/auth/request-auth';
import { ApiErrors } from '../../common/errors/api-errors.decorator';
import { appError } from '../../common/errors/app-error';
import { TICKETS } from '../../infra/tokens';
import {
  AttachmentIdParamDto,
  DashboardDto,
  DashboardParamsDto,
  MergeInputDto,
  NoteCreatedDto,
  NoteInputDto,
  OkDto,
  PriorityInputDto,
  QueueQueryDto,
  ReplyCreatedDto,
  ReplyIdParamsDto,
  ReplyInputDto,
  ReportDto,
  ReportQueryDto,
  SearchQueryDto,
  SearchResultsDto,
  StatusInputDto,
  TicketTeamInputDto,
  TicketDetailDto,
  TicketIdParamDto,
  TicketListDto,
  TransferInputDto,
} from './dto/tickets.dto';
import { createTtlCache } from './domain/ttl-cache';
import { loadTicketDetail } from './repo/ticket-detail';
import {
  agentQueue,
  periodReport,
  searchTickets,
  teamDashboard,
  unassignedQueue,
} from './repo/ticket-queries';
import type { TicketService } from './tickets.service';

const staff = (auth: RequestAuth) => {
  if (auth.kind !== 'staff') throw appError('FORBIDDEN', 'Staff access required');
  return auth;
};

/** Period reports are heavy aggregates over tens of thousands of tickets; identical requests within 15 s share one result. */
const reportCache = createTtlCache<Awaited<ReturnType<typeof periodReport>>>(15_000, () => Date.now());

@ApiTags('tickets')
@RequireAccess('staff')
@Controller()
export class TicketsController {
  constructor(@Inject(TICKETS) private readonly svc: TicketService) {}

  @Get('tickets/queue')
  @ApiOperation({ summary: 'My tickets, most urgent SLA deadline first' })
  @ApiOkResponse({ type: TicketListDto })
  @ApiErrors()
  async queue(@CurrentAuth() auth: RequestAuth, @Query() q: QueueQueryDto): Promise<TicketListDto> {
    const a = staff(auth);
    const items = await agentQueue(this.svc.db, a.user.id, q.limit);
    return { items, serverTime: this.svc.now().toISOString(), nextCursor: null };
  }

  @Get('tickets/unassigned')
  @ApiOperation({ summary: 'Tickets waiting in the queue of my teams' })
  @ApiOkResponse({ type: TicketListDto })
  @ApiErrors()
  async unassigned(
    @CurrentAuth() auth: RequestAuth,
    @Query() q: QueueQueryDto,
  ): Promise<TicketListDto> {
    const a = staff(auth);
    const teams = visibleTeamIds(a.principal);
    if (q.teamId !== undefined && teams !== null && !teams.includes(q.teamId))
      throw appError('NOT_FOUND', 'Team not found');
    const items = await unassignedQueue(this.svc.db, { teamIds: teams }, q.teamId ?? null, q.limit);
    return { items, serverTime: this.svc.now().toISOString(), nextCursor: null };
  }

  @Get('tickets/:id')
  @ApiOperation({
    summary: 'Ticket with the whole correspondence (including internal notes) and its history',
  })
  @ApiOkResponse({ type: TicketDetailDto })
  @ApiErrors()
  async detail(
    @CurrentAuth() auth: RequestAuth,
    @Param() p: TicketIdParamDto,
  ): Promise<TicketDetailDto> {
    await this.svc.requireTicket(auth, p.id, 'view');
    const d = await loadTicketDetail(this.svc.db, p.id);
    if (d === null) throw appError('NOT_FOUND', 'Ticket not found');
    return { ...d, serverTime: this.svc.now().toISOString() };
  }

  @Post('tickets/:id/replies')
  @ApiOperation({
    summary:
      'Reply to the customer; the email is held for 10 seconds so it can be undone. 409 TICKET_HAS_NEW_MESSAGES when someone wrote in the meantime.',
  })
  @ApiCreatedResponse({ type: ReplyCreatedDto })
  @ApiErrors(409)
  async reply(
    @CurrentAuth() auth: RequestAuth,
    @Param() p: TicketIdParamDto,
    @Body() body: ReplyInputDto,
  ): Promise<ReplyCreatedDto> {
    const a = staff(auth);
    const t = await this.svc.requireTicket(a, p.id);
    const r = await this.svc.command((c) =>
      createReply(c, {
        ticketId: t.ticketId,
        actor: this.svc.actorFor(a, t.teamId),
        authorName: a.user.name,
        body: body.body,
        lastSeenSeq: body.lastSeenSeq,
        confirmNewMessages: body.confirmNewMessages,
      }),
    );
    return {
      messageId: r.messageId,
      seq: r.seq,
      sendAfter: r.sendAfter.toISOString(),
      serverTime: this.svc.now().toISOString(),
    };
  }

  @Delete('tickets/:id/replies/:messageId')
  @ApiOperation({ summary: 'Undo a reply within its 10-second window' })
  @ApiOkResponse({ type: OkDto })
  @ApiErrors(409)
  async undo(@CurrentAuth() auth: RequestAuth, @Param() p: ReplyIdParamsDto): Promise<OkDto> {
    const a = staff(auth);
    const t = await this.svc.requireTicket(a, p.id);
    const author = await this.svc.db.$queryRaw<
      { author_user_id: string | null }[]
    >`SELECT author_user_id FROM messages WHERE id = ${p.messageId}::uuid AND ticket_id = ${t.ticketId}::uuid`;
    if (author[0] === undefined) throw appError('NOT_FOUND', 'Reply not found');
    if (author[0].author_user_id !== a.user.id && !isLeadOf(a.principal, t.teamId))
      throw appError('FORBIDDEN', 'Only the author or a lead can undo this reply');
    await this.svc.command((c) =>
      cancelReply(c, {
        ticketId: t.ticketId,
        messageId: p.messageId,
        actor: this.svc.actorFor(a, t.teamId),
      }),
    );
    return { ok: true };
  }

  @Post('tickets/:id/notes')
  @ApiOperation({ summary: 'Internal note the customer never sees' })
  @ApiCreatedResponse({ type: NoteCreatedDto })
  @ApiErrors()
  async note(
    @CurrentAuth() auth: RequestAuth,
    @Param() p: TicketIdParamDto,
    @Body() body: NoteInputDto,
  ): Promise<NoteCreatedDto> {
    const a = staff(auth);
    const t = await this.svc.requireTicket(a, p.id);
    return this.svc.command((c) =>
      createNote(c, {
        ticketId: t.ticketId,
        actor: this.svc.actorFor(a, t.teamId),
        authorName: a.user.name,
        body: body.body,
      }),
    );
  }

  @Put('tickets/:id/status')
  @ApiOperation({ summary: 'Change status (allowed transitions depend on the role)' })
  @ApiOkResponse({ type: OkDto })
  @ApiErrors(409)
  async status(
    @CurrentAuth() auth: RequestAuth,
    @Param() p: TicketIdParamDto,
    @Body() body: StatusInputDto,
  ): Promise<OkDto> {
    const a = staff(auth);
    const t = await this.svc.requireTicket(a, p.id);
    await this.svc.command((c) =>
      changeStatus(c, {
        ticketId: t.ticketId,
        actor: this.svc.actorFor(a, t.teamId),
        to: body.status,
      }),
    );
    return { ok: true };
  }

  @Put('tickets/:id/priority')
  @ApiOperation({ summary: 'Change priority; the SLA is recalculated from the creation time' })
  @ApiOkResponse({ type: OkDto })
  @ApiErrors(409)
  async priority(
    @CurrentAuth() auth: RequestAuth,
    @Param() p: TicketIdParamDto,
    @Body() body: PriorityInputDto,
  ): Promise<OkDto> {
    const a = staff(auth);
    const t = await this.svc.requireTicket(a, p.id);
    await this.svc.command((c) =>
      changePriority(c, {
        ticketId: t.ticketId,
        actor: this.svc.actorFor(a, t.teamId),
        priority: body.priority,
      }),
    );
    return { ok: true };
  }

  @Put('tickets/:id/team')
  @ApiOperation({ summary: 'Move the ticket to another team' })
  @ApiOkResponse({ type: OkDto })
  @ApiErrors(409)
  async team(
    @CurrentAuth() auth: RequestAuth,
    @Param() p: TicketIdParamDto,
    @Body() body: TicketTeamInputDto,
  ): Promise<OkDto> {
    const a = staff(auth);
    const t = await this.svc.requireTicket(a, p.id);
    await this.svc.command((c) =>
      changeTeam(c, {
        ticketId: t.ticketId,
        actor: this.svc.actorFor(a, t.teamId),
        teamId: body.teamId,
      }),
    );
    return { ok: true };
  }

  @Post('tickets/:id/transfer')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Hand the ticket to a colleague (leads and admins can reassign any ticket of the team)',
  })
  @ApiOkResponse({ type: OkDto })
  @ApiErrors(409)
  async transfer(
    @CurrentAuth() auth: RequestAuth,
    @Param() p: TicketIdParamDto,
    @Body() body: TransferInputDto,
  ): Promise<OkDto> {
    const a = staff(auth);
    const t = await this.svc.requireTicket(a, p.id);
    await this.svc.command((c) =>
      transferTicket(c, {
        ticketId: t.ticketId,
        actor: this.svc.actorFor(a, t.teamId),
        toUserId: body.assigneeId,
        leadOverride: isLeadOf(a.principal, t.teamId),
      }),
    );
    return { ok: true };
  }

  @Post('tickets/:id/take')
  @HttpCode(200)
  @ApiOperation({ summary: 'Take an unassigned ticket' })
  @ApiOkResponse({ type: OkDto })
  @ApiErrors(409)
  async take(@CurrentAuth() auth: RequestAuth, @Param() p: TicketIdParamDto): Promise<OkDto> {
    const a = staff(auth);
    const t = await this.svc.requireTicket(a, p.id);
    await this.svc.command((c) =>
      takeTicket(c, { ticketId: t.ticketId, actor: this.svc.actorFor(a, t.teamId) }),
    );
    return { ok: true };
  }

  @Post('tickets/:id/merge')
  @HttpCode(200)
  @ApiOperation({ summary: 'Merge this duplicate into the main ticket of the same customer' })
  @ApiOkResponse({ type: OkDto })
  @ApiErrors(409)
  async merge(
    @CurrentAuth() auth: RequestAuth,
    @Param() p: TicketIdParamDto,
    @Body() body: MergeInputDto,
  ): Promise<OkDto> {
    const a = staff(auth);
    const source = await this.svc.requireTicket(a, p.id);
    await this.svc.requireTicket(a, body.targetTicketId);
    await this.svc.command((c) =>
      mergeTickets(c, {
        sourceId: source.ticketId,
        targetId: body.targetTicketId,
        actor: this.svc.actorFor(a, source.teamId),
      }),
    );
    return { ok: true };
  }

  @Get('search')
  @ApiOperation({ summary: 'Find tickets by correspondence text, customer or number' })
  @ApiOkResponse({ type: SearchResultsDto })
  @ApiErrors()
  async search(
    @CurrentAuth() auth: RequestAuth,
    @Query() q: SearchQueryDto,
  ): Promise<SearchResultsDto> {
    const a = staff(auth);
    const offset = q.cursor !== undefined && /^\d{1,7}$/.test(q.cursor) ? Number(q.cursor) : 0;
    const items = await searchTickets(
      this.svc.db,
      { teamIds: visibleTeamIds(a.principal) },
      q.q,
      q.limit,
      offset,
    );
    return {
      items,
      serverTime: this.svc.now().toISOString(),
      nextCursor: items.length === q.limit ? String(offset + q.limit) : null,
    };
  }

  @Get('dashboard/teams/:teamId')
  @ApiOperation({
    summary: 'Team lead dashboard: agent load, unassigned queue, at-risk and overdue tickets',
  })
  @ApiOkResponse({ type: DashboardDto })
  @ApiErrors()
  async dashboard(
    @CurrentAuth() auth: RequestAuth,
    @Param() p: DashboardParamsDto,
  ): Promise<DashboardDto> {
    const a = staff(auth);
    if (!canViewTeamDashboard(a.principal, p.teamId)) throw appError('NOT_FOUND', 'Team not found');
    const now = this.svc.now();
    return {
      teamId: p.teamId,
      serverTime: now.toISOString(),
      ...(await teamDashboard(this.svc.db, p.teamId, now)),
    };
  }

  @Get('reports')
  @ApiOperation({
    summary: 'First response, resolution, SLA share and ratings per team and agent for a period',
  })
  @ApiOkResponse({ type: ReportDto })
  @ApiErrors()
  async report(@CurrentAuth() auth: RequestAuth, @Query() q: ReportQueryDto): Promise<ReportDto> {
    const a = staff(auth);
    const allowed = leadTeamIds(a.principal);
    if (q.teamId !== undefined && !canViewReports(a.principal, q.teamId))
      throw appError('NOT_FOUND', 'Team not found');
    if (allowed !== null && allowed.length === 0)
      throw appError('FORBIDDEN', 'Reports are available to team leads and administrators');
    const teamIds = q.teamId !== undefined ? [q.teamId] : allowed;
    const filter = { from: q.from, to: q.to, teamIds, agentId: q.agentId ?? null, priority: q.priority ?? null };
    const data = await reportCache.get(JSON.stringify(filter), () => periodReport(this.svc.db, filter));
    return { from: q.from, to: q.to, ...data };
  }

  @Get('attachments/:id')
  @ApiOperation({ summary: 'Download an attachment of a ticket you can access' })
  @ApiProduces('application/octet-stream')
  @ApiOkResponse({ description: 'File bytes' })
  @ApiErrors()
  @Header('X-Content-Type-Options', 'nosniff')
  async attachment(
    @CurrentAuth() auth: RequestAuth,
    @Param() p: AttachmentIdParamDto,
  ): Promise<StreamableFile> {
    const a = staff(auth);
    const rows = await this.svc.db.$queryRaw<
      { filename: string; content_type: string; data: Buffer; ticket_id: string }[]
    >`
      SELECT a.filename, a.content_type, a.data, m.ticket_id FROM attachments a JOIN messages m ON m.id = a.message_id WHERE a.id = ${p.id}::uuid`;
    const r = rows[0];
    if (r === undefined) throw appError('NOT_FOUND', 'Attachment not found');
    const b = await this.svc.brief(r.ticket_id);
    if (b === null || !canViewTicket(a.principal, b))
      throw appError('NOT_FOUND', 'Attachment not found');
    return new StreamableFile(Buffer.from(r.data), {
      type: 'application/octet-stream',
      disposition: `attachment; filename="${r.filename.replace(/["\r\n\\]/g, '_')}"`,
    });
  }
}
