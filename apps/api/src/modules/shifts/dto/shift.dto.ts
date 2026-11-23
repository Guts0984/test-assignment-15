import { okResponse, shiftInput } from '@helpdesk/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export class ShiftInputDto extends createZodDto(shiftInput) {}
export class ShiftResponseDto extends createZodDto(
  okResponse.extend({ onShift: z.boolean(), returnedTickets: z.number().int() }),
) {}
