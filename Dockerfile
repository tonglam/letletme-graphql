# syntax=docker/dockerfile:1

FROM oven/bun:1.4.0-alpine@sha256:07235578f79ef8c6f97d94aee7938e76f5cdba5f21ae5dbfdd3d3d38058437eb AS base
WORKDIR /app

# Apply Alpine security updates that are newer than the pinned Bun image.
RUN apk upgrade --no-cache

FROM base AS deps
COPY bun.lock package.json ./
RUN bun install --frozen-lockfile --production

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production

ARG VCS_REVISION=unknown
ENV APP_REVISION=${VCS_REVISION}
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
