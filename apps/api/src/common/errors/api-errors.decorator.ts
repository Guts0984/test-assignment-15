import { applyDecorators } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import { ErrorResponseDto } from './error-response.dto';

/** Declares the shared error body for every failure status on an operation. */
export const ApiErrors = (...statuses: readonly number[]): MethodDecorator & ClassDecorator => {
  const all = [...new Set([400, 401, 403, 404, 413, 415, 500, ...statuses])];
  return applyDecorators(
    ...all.map((status) =>
      ApiResponse({ status, description: 'Error in the shared format', type: ErrorResponseDto }),
    ),
  );
};
