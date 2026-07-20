# syntax=docker/dockerfile:1

FROM oven/bun:1.2.12@sha256:6b75f9df71c53160c42a517efa70904ec39ba0eefd09c6c715d86facc9db33e2 AS base
WORKDIR /app

FROM base AS deps
COPY bun.lock package.json ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.2.12@sha256:6b75f9df71c53160c42a517efa70904ec39ba0eefd09c6c715d86facc9db33e2 AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/package.json ./
COPY --from=deps /app/bun.lock ./
COPY --from=deps /app/node_modules ./node_modules
COPY src ./src
COPY scripts/migrate.ts ./scripts/migrate.ts
COPY migrations/forward ./migrations/forward

RUN groupadd -g 1001 appuser \
    && useradd -r -u 1001 -g appuser appuser \
    && chown -R appuser:appuser /app
USER appuser

EXPOSE 4000

CMD ["bun", "src/index.ts"]
