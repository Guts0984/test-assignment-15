import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import { AppModule } from './app.module';
import { requestContext, requireJsonBodies } from './common/http/request-context';
import { env as appEnv, type Env } from './config/env';
import { CLOCK } from './infra/tokens';
import type { Clock } from '@helpdesk/shared';

export type ApiApp = NestExpressApplication;

const helmetWithCsp = helmet();
// Swagger UI needs inline scripts, so the docs path gets the other defaults without a CSP.
const helmetNoCsp = helmet({ contentSecurityPolicy: false });

export const buildOpenApiDocument = (app: ApiApp) => {
  const config = new DocumentBuilder()
    .setTitle('Helpdesk API')
    .setDescription(
      'Support desk: tickets, SLA, assignment, mail. Every error uses one shared body: { error: { code, message, details?, requestId? } }.',
    )
    .setVersion('1.0.0')
    .addBearerAuth()
    .addApiKey({ type: 'apiKey', name: 'X-Ticket-Token', in: 'header' }, 'ticket-link')
    .build();
  return cleanupOpenApiDoc(SwaggerModule.createDocument(app, config));
};

/** Builds the fully configured API (used by main.ts, the OpenAPI emitter and every test). */
export const createApiApp = async (
  env: Env = appEnv,
  options: { readonly logger?: boolean } = {},
): Promise<ApiApp> => {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(env), {
    bodyParser: false,
    logger: options.logger === true ? ['error', 'warn', 'log'] : ['error', 'warn'],
  });
  app.setGlobalPrefix('api/v1');
  app.disable('x-powered-by');
  app.set(
    'trust proxy',
    env.TRUSTED_PROXY_CIDRS.split(',')
      .map((s) => s.trim())
      .filter((s) => s !== ''),
  );
  app.use((req: { path: string }, res: unknown, next: () => void) =>
    (req.path.startsWith('/docs') ? helmetNoCsp : helmetWithCsp)(req as never, res as never, next),
  );
  const allowed = new Set(
    env.CORS_ALLOWED_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter((s) => s !== ''),
  );
  app.enableCors({
    origin: (origin, cb) => cb(null, origin !== undefined && allowed.has(origin)),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: [
      'content-type',
      'authorization',
      'x-ticket-token',
      'x-request-id',
      'x-test-control-token',
    ],
    exposedHeaders: ['x-server-time', 'x-request-id', 'x-api-instance'],
    maxAge: 600,
  });
  const clock = app.get<Clock>(CLOCK);
  app.use(requestContext(clock, env.API_INSTANCE_ID));
  app.use(requireJsonBodies(['/api/v1/public/', '/api/v1/portal/', '/api/v1/inbound/']));
  app.useBodyParser('json', { limit: env.JSON_BODY_LIMIT_BYTES });
  const document = buildOpenApiDocument(app);
  SwaggerModule.setup('docs', app, document, { jsonDocumentUrl: 'docs/openapi.json' });
  app.enableShutdownHooks();
  return app;
};
