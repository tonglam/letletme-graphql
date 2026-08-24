# syntax=docker/dockerfile:1

FROM oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0 AS base
RUN apk upgrade --no-cache libcrypto3 libssl3
WORKDIR /app

FROM base AS deps
COPY bun.lock package.json ./
RUN bun install --frozen-lockfile --production

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production

ARG VCS_REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/tonglam/letletme-graphql" \
	org.opencontainers.image.revision="${VCS_REVISION}"

COPY --from=deps --chown=bun:bun /app/package.json ./
COPY --from=deps --chown=bun:bun /app/bun.lock ./
COPY --from=deps --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun src ./src
COPY --chown=bun:bun scripts/check-database-contract.ts ./scripts/check-database-contract.ts
COPY --chown=bun:bun scripts/check-redis-connectivity.ts ./scripts/check-redis-connectivity.ts
COPY --chown=bun:bun scripts/rate-limit-report.ts ./scripts/rate-limit-report.ts

USER bun

EXPOSE 4000

CMD ["bun", "src/index.ts"]
