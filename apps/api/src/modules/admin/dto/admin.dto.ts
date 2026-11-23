import {
  agentInput,
  agentLimitInput,
  agentView,
  failedJobView,
  holidayInput,
  holidayView,
  idParam,
  jobIdParam,
  mailboxInput,
  mailboxView,
  okResponse,
  routingRuleInput,
  routingRuleView,
  teamHolidayParams,
  teamHoursInput,
  teamInput,
  teamView,
} from '@helpdesk/shared';
import { createZodDto } from 'nestjs-zod';

export class IdParamDto extends createZodDto(idParam) {}
export class TeamHolidayParamsDto extends createZodDto(teamHolidayParams) {}
export class TeamInputDto extends createZodDto(teamInput) {}
export class TeamHoursInputDto extends createZodDto(teamHoursInput) {}
export class TeamViewDto extends createZodDto(teamView) {}
export class HolidayInputDto extends createZodDto(holidayInput) {}
export class HolidayViewDto extends createZodDto(holidayView) {}
export class AgentInputDto extends createZodDto(agentInput) {}
export class AgentLimitInputDto extends createZodDto(agentLimitInput) {}
export class AgentViewDto extends createZodDto(agentView) {}
export class RoutingRuleInputDto extends createZodDto(routingRuleInput) {}
export class RoutingRuleViewDto extends createZodDto(routingRuleView) {}
export class MailboxInputDto extends createZodDto(mailboxInput) {}
export class MailboxViewDto extends createZodDto(mailboxView) {}
export class FailedJobViewDto extends createZodDto(failedJobView) {}
export class OkResponseDto extends createZodDto(okResponse) {}
export class JobIdParamDto extends createZodDto(jobIdParam) {}
