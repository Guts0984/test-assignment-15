import { Body, Controller, HttpCode, Inject, Post, Headers } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { DbClock } from '@helpdesk/core';
import { testClockInput } from '@helpdesk/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { RequireAccess } from '../../common/auth/access';
import { ApiErrors } from '../../common/errors/api-errors.decorator';
import { appError } from '../../common/errors/app-error';
import { safeEqual } from '../auth/domain/crypto';
import { DB_CLOCK, ENV } from '../../infra/tokens';

class TestClockInputDto extends createZodDto(testClockInput) {}
class TestClockViewDto extends createZodDto(z.object({ now: z.string(), offsetMs: z.number() })) {}

/** Only registered when TEST_CLOCK_ENABLED=true (never in the default compose profile). */
@ApiTags('test-control')
@Controller('test')
export class TestControlController {
  constructor(
    @Inject(DB_CLOCK) private readonly clock: DbClock,
    @Inject(ENV) private readonly env: { readonly TEST_CONTROL_TOKEN?: string },
  ) {}

  @Post('clock')
  @HttpCode(200)
  @RequireAccess('public')
  @ApiOperation({ summary: 'Set or advance the shared test clock (tests only)' })
  @ApiOkResponse({ type: TestClockViewDto })
  @ApiErrors()
  async setClock(
    @Headers('x-test-control-token') token: string | undefined,
    @Body() body: TestClockInputDto,
  ): Promise<TestClockViewDto> {
    const expected = this.env.TEST_CONTROL_TOKEN ?? '';
    if (expected === '' || token === undefined || !safeEqual(token, expected))
      throw appError('FORBIDDEN', 'Invalid test control token');
    const target = body.offsetMs ?? this.clock.offsetMs() + (body.advanceMs ?? 0);
    await this.clock.setOffsetMs(target);
    return { now: this.clock.now().toISOString(), offsetMs: this.clock.offsetMs() };
  }
}
