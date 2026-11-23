import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { RequireAccess } from '../../common/auth/access';
import { CurrentAuth } from '../../common/auth/current-auth';
import type { RequestAuth } from '../../common/auth/request-auth';
import { ApiErrors } from '../../common/errors/api-errors.decorator';
import { appError } from '../../common/errors/app-error';
import { ACCESS_REVOKER, AUTH, ENV } from '../../infra/tokens';
import type { AuthUseCases } from './auth.usecases';
import { clearRefreshCookie, readCookie, REFRESH_COOKIE, refreshCookie } from './domain/cookies';
import { AuthResponseDto, LoginDto, OkDto, UserViewDto } from './dto/auth.dto';

type AuthEnv = { readonly REFRESH_TOKEN_TTL_DAYS: number; readonly PUBLIC_BASE_URL: string };

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AUTH) private readonly auth: AuthUseCases,
    @Inject(ENV) private readonly env: AuthEnv,
    @Inject(ACCESS_REVOKER) private readonly revoker: { disconnectUser: (userId: string) => void },
  ) {}

  private get secure(): boolean {
    return this.env.PUBLIC_BASE_URL.startsWith('https://');
  }

  @Post('login')
  @HttpCode(200)
  @RequireAccess('public')
  @ApiOperation({ summary: 'Staff login (email + password)' })
  @ApiOkResponse({ type: AuthResponseDto })
  @ApiErrors(401)
  async login(
    @Body() body: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponseDto> {
    const r = await this.auth.login(body.email, body.password);
    if (!r.ok) throw appError('INVALID_CREDENTIALS', 'Invalid email or password');
    res.setHeader(
      'set-cookie',
      refreshCookie(r.value.refreshToken, this.env.REFRESH_TOKEN_TTL_DAYS * 86_400, this.secure),
    );
    return {
      accessToken: r.value.accessToken,
      expiresInSeconds: r.value.expiresInSeconds,
      user: r.value.user,
    };
  }

  @Post('refresh')
  @HttpCode(200)
  @RequireAccess('public')
  @ApiOperation({ summary: 'Rotate the refresh cookie and get a new access token' })
  @ApiOkResponse({ type: AuthResponseDto })
  @ApiErrors(401)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponseDto> {
    const token = readCookie(req.headers.cookie, REFRESH_COOKIE);
    const r = token === null ? null : await this.auth.refresh(token);
    if (r === null || !r.ok) {
      res.setHeader('set-cookie', clearRefreshCookie(this.secure));
      throw appError('UNAUTHORIZED', 'Session expired');
    }
    res.setHeader(
      'set-cookie',
      refreshCookie(r.value.refreshToken, this.env.REFRESH_TOKEN_TTL_DAYS * 86_400, this.secure),
    );
    return {
      accessToken: r.value.accessToken,
      expiresInSeconds: r.value.expiresInSeconds,
      user: r.value.user,
    };
  }

  @Post('logout')
  @HttpCode(200)
  @RequireAccess('public')
  @ApiOperation({ summary: 'Revoke the session' })
  @ApiOkResponse({ type: OkDto })
  @ApiErrors()
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<OkDto> {
    const userId = await this.auth.logout(readCookie(req.headers.cookie, REFRESH_COOKIE));
    // The token version was bumped, so every open WebSocket of this user is cut on both api copies.
    if (userId !== null) this.revoker.disconnectUser(userId);
    res.setHeader('set-cookie', clearRefreshCookie(this.secure));
    return { ok: true };
  }

  @Get('me')
  @RequireAccess('staff')
  @ApiOperation({ summary: 'The signed-in staff member' })
  @ApiOkResponse({ type: UserViewDto })
  @ApiErrors()
  async me(@CurrentAuth() auth: RequestAuth): Promise<UserViewDto> {
    if (auth.kind !== 'staff') throw appError('FORBIDDEN', 'Staff access required');
    const user = await this.auth.me(auth.user.id);
    if (user === null) throw appError('UNAUTHORIZED', 'Authentication required');
    return user;
  }
}
