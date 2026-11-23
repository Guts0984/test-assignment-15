import { Body, Controller, Inject, Put } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequireAccess } from '../../common/auth/access';
import { CurrentAuth } from '../../common/auth/current-auth';
import type { RequestAuth } from '../../common/auth/request-auth';
import { ApiErrors } from '../../common/errors/api-errors.decorator';
import { appError } from '../../common/errors/app-error';
import { SHIFTS } from '../../infra/tokens';
import { ShiftInputDto, ShiftResponseDto } from './dto/shift.dto';
import type { ShiftUseCases } from './shifts.usecases';

@ApiTags('shifts')
@Controller('me')
export class ShiftsController {
  constructor(@Inject(SHIFTS) private readonly shifts: ShiftUseCases) {}

  @Put('shift')
  @RequireAccess('staff')
  @ApiOperation({ summary: 'Go on or off shift; new tickets are only assigned to agents on shift' })
  @ApiOkResponse({ type: ShiftResponseDto })
  @ApiErrors()
  async setShift(
    @CurrentAuth() auth: RequestAuth,
    @Body() body: ShiftInputDto,
  ): Promise<ShiftResponseDto> {
    if (auth.kind !== 'staff') throw appError('FORBIDDEN', 'Staff access required');
    const r = await this.shifts.setShift(auth.user.id, body.onShift);
    return { ok: true, ...r };
  }
}
