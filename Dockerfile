# syntax=docker/dockerfile:1

FROM oven/bun:1.4.0-alpine@sha256:07235578f79ef8c6f97d94aee7938e76f5cdba5f21ae5dbfdd3d3d38058437eb AS base
WORKDIR /app

# The pinned Bun image contains Alpine 3.22.5's vulnerable OpenSSL packages.
# Fetch the patched packages from versioned artifact paths and verify their
# checksums before installing them. Installing local artifacts with an empty
# repository file keeps the image independent of mutable APK indexes.
ARG TARGETARCH
RUN set -eux; \
	case "$TARGETARCH" in \
		amd64) \
			alpine_arch=x86_64; \
			libcrypto_sha256=1d111bc0ad6380fdda22e6513941dc2e7988d6b1621d535bed6b3fa5ef086fae; \
			libssl_sha256=e8d3ea5e9750cb1f4c4b459d172630925fe6bc13c113c590ac36c78013821e62; \
			;; \
		arm64) \
			alpine_arch=aarch64; \
			libcrypto_sha256=094c5816644ade889f74387e8d91aad89dc9a05eda150494e3f91b80ffc15460; \
			libssl_sha256=2b175c982f9ff9a80fc88fa587f6db0ae1c58eef4b3f7fe69e8f066be9ff1090; \
			;; \
		*) echo "Unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
	esac; \
	base_url="https://dl-cdn.alpinelinux.org/alpine/v3.22/main/$alpine_arch"; \
	wget --no-verbose --output-document=/tmp/libcrypto3.apk "$base_url/libcrypto3-3.5.8-r0.apk"; \
	wget --no-verbose --output-document=/tmp/libssl3.apk "$base_url/libssl3-3.5.8-r0.apk"; \
	echo "$libcrypto_sha256  /tmp/libcrypto3.apk" | sha256sum -c -; \
	echo "$libssl_sha256  /tmp/libssl3.apk" | sha256sum -c -; \
	apk add --no-cache --repositories-file /dev/null /tmp/libcrypto3.apk /tmp/libssl3.apk; \
	rm -f /tmp/libcrypto3.apk /tmp/libssl3.apk

FROM base AS deps
COPY bun.lock package.json ./
RUN bun install --frozen-lockfile --production

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV RATE_LIMIT_TELEMETRY_SPOOL_DIR=/var/lib/letletme-graphql/rate-limit-telemetry

ARG VCS_REVISION=unknown
ENV DEPLOY_SHA=${VCS_REVISION}
LABEL org.opencontainers.image.source="https://github.com/tonglam/letletme-graphql" \
	org.opencontainers.image.revision="${VCS_REVISION}"

COPY --from=deps --chown=bun:bun /app/package.json ./
COPY --from=deps --chown=bun:bun /app/bun.lock ./
COPY --from=deps --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun src ./src
COPY --chown=bun:bun scripts/check-database-contract.ts ./scripts/check-database-contract.ts
COPY --chown=bun:bun scripts/check-redis-connectivity.ts ./scripts/check-redis-connectivity.ts
COPY --chown=bun:bun scripts/lib ./scripts/lib
COPY --chown=bun:bun scripts/rate-limit-report.ts ./scripts/rate-limit-report.ts

RUN mkdir -p "$RATE_LIMIT_TELEMETRY_SPOOL_DIR" && \
	chown -R bun:bun "$RATE_LIMIT_TELEMETRY_SPOOL_DIR"

USER bun

EXPOSE 4000

CMD ["bun", "src/index.ts"]
