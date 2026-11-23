import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequireAccess } from '../../common/auth/access';
import { ApiErrors } from '../../common/errors/api-errors.decorator';
import { ADMIN } from '../../infra/tokens';
import type { AdminUseCases } from './admin.usecases';
import {
  AgentInputDto,
  AgentLimitInputDto,
  AgentViewDto,
  FailedJobViewDto,
  HolidayInputDto,
  HolidayViewDto,
  IdParamDto,
  JobIdParamDto,
  MailboxInputDto,
  MailboxViewDto,
  OkResponseDto,
  RoutingRuleInputDto,
  RoutingRuleViewDto,
  TeamHolidayParamsDto,
  TeamHoursInputDto,
  TeamInputDto,
  TeamViewDto,
} from './dto/admin.dto';
import { unwrap } from './unwrap';

@ApiTags('admin')
@RequireAccess('admin')
@Controller('admin')
export class AdminController {
  constructor(@Inject(ADMIN) private readonly admin: AdminUseCases) {}

  @Get('teams')
  @ApiOperation({ summary: 'List teams' })
  @ApiOkResponse({ type: [TeamViewDto] })
  @ApiErrors()
  teams(): Promise<TeamViewDto[]> {
    return this.admin.listTeams();
  }

  @Post('teams')
  @ApiOperation({ summary: 'Create a team with working hours and time zone' })
  @ApiCreatedResponse({ type: TeamViewDto })
  @ApiErrors(409)
  async createTeam(@Body() body: TeamInputDto): Promise<TeamViewDto> {
    return unwrap(await this.admin.createTeam(body));
  }

  @Put('teams/:id')
  @ApiOperation({ summary: 'Change a team hours and time zone' })
  @ApiOkResponse({ type: TeamViewDto })
  @ApiErrors(409)
  async updateTeam(@Param() p: IdParamDto, @Body() body: TeamHoursInputDto): Promise<TeamViewDto> {
    return unwrap(await this.admin.updateTeam(p.id, body));
  }

  @Get('teams/:id/holidays')
  @ApiOperation({ summary: 'Team holidays' })
  @ApiOkResponse({ type: [HolidayViewDto] })
  @ApiErrors()
  holidays(@Param() p: IdParamDto): Promise<HolidayViewDto[]> {
    return this.admin.listHolidays(p.id);
  }

  @Post('teams/:id/holidays')
  @ApiOperation({ summary: 'Add a team holiday' })
  @ApiCreatedResponse({ type: HolidayViewDto })
  @ApiErrors(409)
  async addHoliday(@Param() p: IdParamDto, @Body() body: HolidayInputDto): Promise<HolidayViewDto> {
    return unwrap(await this.admin.addHoliday(p.id, body));
  }

  @Delete('teams/:id/holidays/:holidayId')
  @ApiOperation({ summary: 'Remove a team holiday' })
  @ApiOkResponse({ type: OkResponseDto })
  @ApiErrors()
  async removeHoliday(@Param() p: TeamHolidayParamsDto): Promise<OkResponseDto> {
    return unwrap(await this.admin.removeHoliday(p.id, p.holidayId));
  }

  @Get('agents')
  @ApiOperation({ summary: 'List staff with teams, limits and languages' })
  @ApiOkResponse({ type: [AgentViewDto] })
  @ApiErrors()
  agents(): Promise<AgentViewDto[]> {
    return this.admin.listAgents();
  }

  @Post('agents')
  @ApiOperation({ summary: 'Add an agent to teams' })
  @ApiCreatedResponse({ type: AgentViewDto })
  @ApiErrors(409)
  async createAgent(@Body() body: AgentInputDto): Promise<AgentViewDto> {
    return unwrap(await this.admin.createAgent(body));
  }

  @Put('agents/:id')
  @ApiOperation({ summary: 'Update an agent and team memberships' })
  @ApiOkResponse({ type: AgentViewDto })
  @ApiErrors(409)
  async updateAgent(@Param() p: IdParamDto, @Body() body: AgentInputDto): Promise<AgentViewDto> {
    return unwrap(await this.admin.updateAgent(p.id, body));
  }

  @Patch('agents/:id/limits')
  @ApiOperation({ summary: 'Set concurrent ticket limit and languages' })
  @ApiOkResponse({ type: AgentViewDto })
  @ApiErrors()
  async limits(@Param() p: IdParamDto, @Body() body: AgentLimitInputDto): Promise<AgentViewDto> {
    return unwrap(await this.admin.updateLimits(p.id, body));
  }

  @Get('routing-rules')
  @ApiOperation({ summary: 'Routing rules in evaluation order' })
  @ApiOkResponse({ type: [RoutingRuleViewDto] })
  @ApiErrors()
  rules(): Promise<RoutingRuleViewDto[]> {
    return this.admin.listRules();
  }

  @Post('routing-rules')
  @ApiOperation({ summary: 'Create a routing rule (recipient, subject words, language)' })
  @ApiCreatedResponse({ type: RoutingRuleViewDto })
  @ApiErrors()
  async createRule(@Body() body: RoutingRuleInputDto): Promise<RoutingRuleViewDto> {
    return unwrap(await this.admin.createRule(body));
  }

  @Put('routing-rules/:id')
  @ApiOperation({ summary: 'Replace a routing rule' })
  @ApiOkResponse({ type: RoutingRuleViewDto })
  @ApiErrors()
  async updateRule(
    @Param() p: IdParamDto,
    @Body() body: RoutingRuleInputDto,
  ): Promise<RoutingRuleViewDto> {
    return unwrap(await this.admin.updateRule(p.id, body));
  }

  @Delete('routing-rules/:id')
  @ApiOperation({ summary: 'Delete a routing rule' })
  @ApiOkResponse({ type: OkResponseDto })
  @ApiErrors()
  async deleteRule(@Param() p: IdParamDto): Promise<OkResponseDto> {
    return unwrap(await this.admin.deleteRule(p.id));
  }

  @Get('mailboxes')
  @ApiOperation({ summary: 'Support addresses and their default teams' })
  @ApiOkResponse({ type: [MailboxViewDto] })
  @ApiErrors()
  mailboxes(): Promise<MailboxViewDto[]> {
    return this.admin.listMailboxes();
  }

  @Post('mailboxes')
  @ApiOperation({ summary: 'Add a support address' })
  @ApiCreatedResponse({ type: MailboxViewDto })
  @ApiErrors(409)
  async createMailbox(@Body() body: MailboxInputDto): Promise<MailboxViewDto> {
    return unwrap(await this.admin.createMailbox(body));
  }

  @Get('jobs/failed')
  @ApiOperation({ summary: 'Background jobs that exhausted their retries' })
  @ApiOkResponse({ type: [FailedJobViewDto] })
  @ApiErrors()
  failedJobs(): Promise<FailedJobViewDto[]> {
    return this.admin.listFailedJobs();
  }

  @Post('jobs/:id/retry')
  @HttpCode(200)
  @ApiOperation({ summary: 'Re-arm a failed job' })
  @ApiOkResponse({ type: OkResponseDto })
  @ApiErrors()
  async retryJob(@Param() p: JobIdParamDto): Promise<OkResponseDto> {
    return unwrap(await this.admin.retryFailedJob(p.id));
  }
}
