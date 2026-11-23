import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { timeResponse, type Clock } from '@helpdesk/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { RequireAccess } from '../../common/auth/access';
import { ApiErrors } from '../../common/errors/api-errors.decorator';
import { CLOCK } from '../../infra/tokens';

class TimeDto extends createZodDto(timeResponse) {}
class HealthDto extends createZodDto(z.object({ status: z.literal('ok') })) {}

@ApiTags('system')
@Controller()
export class TimeController {
  constructor(@Inject(CLOCK) private readonly clock: Clock) {}

  @Get('time')
  @RequireAccess('public')
  @ApiOperation({ summary: 'Server clock; SLA countdowns in the UI are computed from it' })
  @ApiOkResponse({ type: TimeDto })
  @ApiErrors()
  time(): TimeDto {
    return { now: this.clock.now().toISOString() };
  }

  @Get('health')
  @RequireAccess('public')
  @ApiOperation({ summary: 'Liveness probe' })
  @ApiOkResponse({ type: HealthDto })
  @ApiErrors()
  health(): HealthDto {
    return { status: 'ok' };
  }
}
