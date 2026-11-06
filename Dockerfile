# syntax=docker/dockerfile:1

FROM oven/bun:1.4.2-alpine@sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f AS base
WORKDIR /app

# The pinned Bun image contains Alpine 3.22.5's vulnerable OpenSSL and zlib packages.
# Fetch the patched packages from versioned artifact paths and verify their
# checksums before installing them. Installing local artifacts with an empty
# repository file keeps the image independent of mutable APK indexes.
ARG TARGETARCH
RUN set -eux; \
	case "$TARGETARCH" in \
		amd64) \
			alpine_arch=x86_64; \
			libcrypto_sha256=3f5825ced5fde1c66a5376a3f6076b3c08538ad52d9ef23f069857e212d9175a; \
			libssl_sha256=6801c740b9760b5b08da8db6367ebc18b2cc4dbaf371f7148429538b8bb04e23; \
			zlib_sha256=af24e502645e2b392cae833856d776691ac21655362e5db69d7b89f147f76216; \
			;; \
		arm64) \
			alpine_arch=aarch64; \
			libcrypto_sha256=ede2ef7eca3b65a42e902aaf7890f9c5647dca0c55123a817179ad9f3bc6ef24; \
			libssl_sha256=338c9f6154582b4b76455a59f95538bcea8df039c5c72916dd2d8d0d844c9583; \
			zlib_sha256=2d274cb1b2a36d0e8347d802e6dea8648cab952ea5fae1989ab72e725842a2c3; \
			;; \
		*) echo "Unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
	esac; \
	base_url="https://dl-cdn.alpinelinux.org/alpine/v3.22/main/$alpine_arch"; \
	wget --no-verbose --output-document=/tmp/libcrypto3.apk "$base_url/libcrypto3-3.5.9-r0.apk"; \
	wget --no-verbose --output-document=/tmp/libssl3.apk "$base_url/libssl3-3.5.9-r0.apk"; \
	wget --no-verbose --output-document=/tmp/zlib.apk "$base_url/zlib-1.3.2-r1.apk"; \
	echo "$libcrypto_sha256  /tmp/libcrypto3.apk" | sha256sum -c -; \
	echo "$libssl_sha256  /tmp/libssl3.apk" | sha256sum -c -; \
	echo "$zlib_sha256  /tmp/zlib.apk" | sha256sum -c -; \
	apk add --no-cache --repositories-file /dev/null /tmp/libcrypto3.apk /tmp/libssl3.apk /tmp/zlib.apk; \
	rm -f /tmp/libcrypto3.apk /tmp/libssl3.apk /tmp/zlib.apk

FROM base AS deps
COPY bun.lock package.json ./
COPY patches ./patches
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
COPY --chown=bun:bun scripts/check-database-execution.ts ./scripts/check-database-execution.ts
COPY --chown=bun:bun scripts/check-database-contract.ts ./scripts/check-database-contract.ts
COPY --chown=bun:bun scripts/check-redis-connectivity.ts ./scripts/check-redis-connectivity.ts
COPY --chown=bun:bun scripts/lib ./scripts/lib
COPY --chown=bun:bun scripts/rate-limit-report.ts ./scripts/rate-limit-report.ts
COPY --chown=bun:bun scripts/rate-limit-serving-process-check.ts ./scripts/rate-limit-serving-process-check.ts

RUN mkdir -p "$RATE_LIMIT_TELEMETRY_SPOOL_DIR" && \
	chown -R bun:bun "$RATE_LIMIT_TELEMETRY_SPOOL_DIR"

USER bun

EXPOSE 4000

CMD ["bun", "src/index.ts"]
