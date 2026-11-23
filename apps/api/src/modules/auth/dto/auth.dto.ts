import { authResponse, loginInput, okResponse, userView } from '@helpdesk/shared';
import { createZodDto } from 'nestjs-zod';

export class LoginDto extends createZodDto(loginInput) {}
export class AuthResponseDto extends createZodDto(authResponse) {}
export class UserViewDto extends createZodDto(userView) {}
export class OkDto extends createZodDto(okResponse) {}
