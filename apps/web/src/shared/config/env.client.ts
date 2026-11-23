import { loadEnv } from '@helpdesk/shared';
import { z } from 'zod';

export const clientEnvSchema = z.object({
  NEXT_PUBLIC_API_BASE_PATH: z.string().startsWith('/').default('/api/v1'),
  NEXT_PUBLIC_SOCKET_PATH: z.string().startsWith('/').default('/socket.io'),
  NEXT_PUBLIC_UNDO_SEND_SECONDS: z.coerce.number().int().min(1).default(10),
});

export type ClientEnv = Readonly<z.output<typeof clientEnvSchema>>;

// Next.js inlines NEXT_PUBLIC_* only when each one is referenced literally, so list them explicitly.
const loaded = loadEnv(clientEnvSchema, {
  NEXT_PUBLIC_API_BASE_PATH: process.env.NEXT_PUBLIC_API_BASE_PATH,
  NEXT_PUBLIC_SOCKET_PATH: process.env.NEXT_PUBLIC_SOCKET_PATH,
  NEXT_PUBLIC_UNDO_SEND_SECONDS: process.env.NEXT_PUBLIC_UNDO_SEND_SECONDS,
});
if (!loaded.ok) {
  throw new Error(loaded.error.message);
}

export const clientEnv: ClientEnv = loaded.value;
