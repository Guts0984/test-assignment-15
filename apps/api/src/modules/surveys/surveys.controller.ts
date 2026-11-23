import { Body, Controller, Get, Headers, Inject, Put } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import type { Db } from '@helpdesk/core';
import { surveyRatingInput, surveyView, type Clock } from '@helpdesk/shared';
import { createZodDto } from 'nestjs-zod';
import { RequireAccess } from '../../common/auth/access';
import { ApiErrors } from '../../common/errors/api-errors.decorator';
import { appError } from '../../common/errors/app-error';
import { hashToken } from '../auth/domain/crypto';
import { CLOCK, DB } from '../../infra/tokens';

class SurveyViewDto extends createZodDto(surveyView) {}
class SurveyRatingDto extends createZodDto(surveyRatingInput) {}

type SurveyRow = {
  ticket_number: bigint;
  subject: string;
  rating: number | null;
  comment: string | null;
  expires_at: Date;
  id: string;
};

@ApiTags('survey')
@ApiSecurity('survey-link')
@Controller('survey')
export class SurveysController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private async load(token: string | undefined): Promise<SurveyRow> {
    if (token === undefined || !/^[A-Za-z0-9_-]{43}$/.test(token))
      throw appError('LINK_INVALID', 'Invalid survey link');
    const rows = await this.db.$queryRaw<SurveyRow[]>`
      SELECT s.id, t.number AS ticket_number, t.subject, s.rating, s.comment, s.expires_at FROM surveys s JOIN tickets t ON t.id = s.ticket_id
       WHERE s.token_hash = ${hashToken(token)}`;
    const r = rows[0];
    if (r === undefined) throw appError('LINK_INVALID', 'Invalid survey link');
    if (r.expires_at.getTime() <= this.clock.now().getTime())
      throw appError('SURVEY_EXPIRED', 'This survey link has expired');
    return r;
  }

  private view(r: SurveyRow): SurveyViewDto {
    return {
      ticketNumber: Number(r.ticket_number),
      subject: r.subject,
      rating: r.rating,
      comment: r.comment,
      expiresAt: r.expires_at.toISOString(),
    };
  }

  @Get()
  @RequireAccess('public')
  @ApiOperation({ summary: 'The survey behind the link in the email (X-Survey-Token)' })
  @ApiOkResponse({ type: SurveyViewDto })
  @ApiErrors(410)
  async get(@Headers('x-survey-token') token: string | undefined): Promise<SurveyViewDto> {
    return this.view(await this.load(token));
  }

  @Put()
  @RequireAccess('public')
  @ApiOperation({
    summary:
      'Rate the answer 1-5 with an optional comment; the rating can be changed until the link expires (7 days)',
  })
  @ApiOkResponse({ type: SurveyViewDto })
  @ApiErrors(410)
  async rate(
    @Headers('x-survey-token') token: string | undefined,
    @Body() body: SurveyRatingDto,
  ): Promise<SurveyViewDto> {
    const s = await this.load(token);
    const now = this.clock.now();
    await this.db
      .$executeRaw`UPDATE surveys SET rating = ${body.rating}, comment = ${body.comment ?? null}, rated_at = ${now} WHERE id = ${s.id}::uuid AND expires_at > ${now}`;
    return this.view(await this.load(token));
  }
}
