import { env } from './config/env';
import { createApiApp } from './app.factory';

const bootstrap = async (): Promise<void> => {
  const app = await createApiApp(env, { logger: true });
  await app.listen(env.API_PORT, '0.0.0.0');
};

void bootstrap();
