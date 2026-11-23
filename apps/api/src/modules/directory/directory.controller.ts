import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Db } from '@helpdesk/core';
import { directoryView, visibleTeamIds } from '@helpdesk/shared';
import { createZodDto } from 'nestjs-zod';
import { RequireAccess } from '../../common/auth/access';
import { CurrentAuth } from '../../common/auth/current-auth';
import type { RequestAuth } from '../../common/auth/request-auth';
import { ApiErrors } from '../../common/errors/api-errors.decorator';
import { appError } from '../../common/errors/app-error';
import { DB } from '../../infra/tokens';

class DirectoryDto extends createZodDto(directoryView) {}

/** Names the UI needs for menus (team change, transfer): all team names, colleagues only of the caller's own teams. */
@ApiTags('directory')
@RequireAccess('staff')
@Controller('directory')
export class DirectoryController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  @ApiOperation({ summary: 'Teams and the agents of my teams, for pickers' })
  @ApiOkResponse({ type: DirectoryDto })
  @ApiErrors()
  async get(@CurrentAuth() auth: RequestAuth): Promise<DirectoryDto> {
    if (auth.kind !== 'staff') throw appError('FORBIDDEN', 'Staff access required');
    const mine = visibleTeamIds(auth.principal);
    const teams = await this.db.$queryRaw<
      { id: string; name: string; time_zone: string }[]
    >`SELECT id, name, time_zone FROM teams ORDER BY name`;
    const agents = await this.db.$queryRaw<
      { id: string; name: string; team_id: string; on_shift: boolean; role: string }[]
    >`
      SELECT u.id, u.name, m.team_id, u.on_shift, m.role FROM team_members m JOIN users u ON u.id = m.user_id
       WHERE u.is_active AND (${mine === null ? null : [...mine]}::uuid[] IS NULL OR m.team_id = ANY(${mine === null ? null : [...mine]}::uuid[]))
       ORDER BY u.name`;
    return {
      teams: teams.map((t) => ({ id: t.id, name: t.name, timeZone: t.time_zone })),
      agents: agents.map((a) => ({
        id: a.id,
        name: a.name,
        teamId: a.team_id,
        onShift: a.on_shift,
        role: a.role as 'agent' | 'lead',
      })),
    };
  }
}
