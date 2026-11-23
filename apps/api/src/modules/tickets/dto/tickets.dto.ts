import {
  attachmentIdParam,
  dashboardParams,
  dashboardView,
  idParam,
  mergeInput,
  noteCreated,
  noteInput,
  okResponse,
  priorityChangeInput,
  queueQuery,
  reportQueryInput,
  reportView,
  replyCreated,
  replyIdParams,
  replyInput,
  searchQueryInput,
  searchResults,
  statusChangeInput,
  teamChangeInput,
  ticketDetail,
  ticketList,
  transferInput,
} from '@helpdesk/shared';
import { createZodDto } from 'nestjs-zod';

export class TicketIdParamDto extends createZodDto(idParam) {}
export class ReplyIdParamsDto extends createZodDto(replyIdParams) {}
export class AttachmentIdParamDto extends createZodDto(attachmentIdParam) {}
export class DashboardParamsDto extends createZodDto(dashboardParams) {}
export class QueueQueryDto extends createZodDto(queueQuery) {}
export class SearchQueryDto extends createZodDto(searchQueryInput) {}
export class ReportQueryDto extends createZodDto(reportQueryInput) {}
export class ReplyInputDto extends createZodDto(replyInput) {}
export class NoteInputDto extends createZodDto(noteInput) {}
export class StatusInputDto extends createZodDto(statusChangeInput) {}
export class PriorityInputDto extends createZodDto(priorityChangeInput) {}
export class TicketTeamInputDto extends createZodDto(teamChangeInput) {}
export class TransferInputDto extends createZodDto(transferInput) {}
export class MergeInputDto extends createZodDto(mergeInput) {}
export class TicketListDto extends createZodDto(ticketList) {}
export class TicketDetailDto extends createZodDto(ticketDetail) {}
export class ReplyCreatedDto extends createZodDto(replyCreated) {}
export class NoteCreatedDto extends createZodDto(noteCreated) {}
export class SearchResultsDto extends createZodDto(searchResults) {}
export class DashboardDto extends createZodDto(dashboardView) {}
export class ReportDto extends createZodDto(reportView) {}
export class OkDto extends createZodDto(okResponse) {}
