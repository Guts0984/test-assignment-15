# One image builds the whole workspace; compose picks the process (api, worker, mail-stub, migrate) by command.
FROM node:24-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@12.6.0
WORKDIR /repo

FROM base AS build
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/mail-stub/package.json apps/mail-stub/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY packages packages
COPY apps apps
RUN pnpm --filter @helpdesk/shared build \
 && pnpm --filter @helpdesk/core build \
 && pnpm --filter @helpdesk/api build \
 && pnpm --filter @helpdesk/worker build \
 && pnpm --filter @helpdesk/mail-stub build

FROM build AS web-build
ARG NEXT_PUBLIC_API_BASE_PATH=/api/v1
ARG NEXT_PUBLIC_SOCKET_PATH=/socket.io
ARG NEXT_PUBLIC_UNDO_SEND_SECONDS=10
ENV NEXT_PUBLIC_API_BASE_PATH=$NEXT_PUBLIC_API_BASE_PATH NEXT_PUBLIC_SOCKET_PATH=$NEXT_PUBLIC_SOCKET_PATH NEXT_PUBLIC_UNDO_SEND_SECONDS=$NEXT_PUBLIC_UNDO_SEND_SECONDS
RUN pnpm --filter @helpdesk/web build

FROM base AS app
ENV NODE_ENV=production
COPY --from=build /repo /repo
USER node
CMD ["node", "apps/api/dist/main.js"]

FROM base AS web
ENV NODE_ENV=production
COPY --from=web-build /repo/apps/web/.next/standalone /web
COPY --from=web-build /repo/apps/web/.next/static /web/apps/web/.next/static
USER node
ENV HOSTNAME=0.0.0.0
CMD ["sh", "-c", "PORT=${WEB_PORT:-3000} node /web/apps/web/server.js"]
