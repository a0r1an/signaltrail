# syntax=docker/dockerfile:1.7
# One image per server process: --build-arg APP=ingestion or APP=event-processor.
# Build from the repository root: docker build -f infra/host/Dockerfile .
ARG NODE_IMAGE=node:24.21.0-bookworm-slim

FROM ${NODE_IMAGE} AS build
ARG APP
RUN test "$APP" = ingestion || test "$APP" = event-processor
RUN corepack enable && corepack prepare pnpm@10.27.0 --activate
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile --filter "@signaltrail/${APP}..."
RUN pnpm --filter "@signaltrail/${APP}..." build
# Self-contained production tree: the app's dist plus built workspace dependencies.
RUN pnpm --filter "@signaltrail/${APP}" deploy --prod --legacy /out

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/package.json ./
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/dist ./dist
USER node
STOPSIGNAL SIGTERM
CMD ["node", "dist/main.js"]
