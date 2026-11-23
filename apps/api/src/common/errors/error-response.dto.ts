import { errorResponseSchema } from '@helpdesk/shared';
import { createZodDto } from 'nestjs-zod';

export class ErrorResponseDto extends createZodDto(errorResponseSchema) {}
