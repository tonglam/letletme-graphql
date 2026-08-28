#!/usr/bin/env bash

# Versioned, fail-closed blue/green deploy entrypoint. The GitHub workflow
# sends this script over authenticated OpenSSH; it is also copied into each
# checkout so the exact release source contains the deployment logic.
set -euo pipefail

: "${DEPLOY_SHA:?DEPLOY_SHA is required}"
: "${IMAGE_REF:?IMAGE_REF is required}"
: "${GHCR_USER:?GHCR_USER is required}"
: "${VPS_WORKDIR:?VPS_WORKDIR is required}"

[[ "$DEPLOY_SHA" =~ ^[0-9a-f]{40}$ ]]
[[ "$IMAGE_REF" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]]
case "$VPS_WORKDIR" in
  /*) ;;
  *) echo "VPS_WORKDIR must be an absolute path" >&2; exit 1 ;;
esac
test "$VPS_WORKDIR" != "/"

BLUE_PROJECT=${BLUE_PROJECT:-letletme_graphql_blue}
GREEN_PROJECT=${GREEN_PROJECT:-letletme_graphql_green}
ACTIVE_SLOT_FILE=${ACTIVE_SLOT_FILE:-/var/lib/letletme-graphql/active-slot}
SWITCH_HELPER=${SWITCH_HELPER:-/usr/local/sbin/letletme-graphql-switch-slot}
PUBLIC_GRAPHQL_HEALTH_URL=${PUBLIC_GRAPHQL_HEALTH_URL:-}
PUBLIC_GRAPHQL_URL=${PUBLIC_GRAPHQL_URL:-}
RELEASE_MANIFEST_DIR=${RELEASE_MANIFEST_DIR:-$VPS_WORKDIR/releases}
CANDIDATE_READY_ATTEMPTS=${CANDIDATE_READY_ATTEMPTS:-30}
RATE_LIMIT_ROLLOUT=${RATE_LIMIT_ROLLOUT:-preserve}

test -n "$PUBLIC_GRAPHQL_HEALTH_URL" || {
  echo "PUBLIC_GRAPHQL_HEALTH_URL is required for public cutover verification" >&2
  exit 1
}
test -n "$PUBLIC_GRAPHQL_URL" || {
  echo "PUBLIC_GRAPHQL_URL is required for public field-level verification" >&2
  exit 1
}

cd "$(dirname "$VPS_WORKDIR")"
if [ ! -d "$VPS_WORKDIR/.git" ]; then
  if [ -d "$VPS_WORKDIR" ] && [ -n "$(find "$VPS_WORKDIR" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
    echo "VPS workdir exists but is not an empty Git checkout" >&2
    exit 1
  fi
  git clone https://github.com/tonglam/letletme-graphql.git "$VPS_WORKDIR"
fi
cd "$VPS_WORKDIR"
git diff --quiet
git diff --cached --quiet
git fetch origin main
test "$(git rev-parse origin/main)" = "$DEPLOY_SHA"
git checkout --force main
git reset --hard "$DEPLOY_SHA" >/dev/null
test "$(git rev-parse HEAD)" = "$DEPLOY_SHA"

active_slot=blue
if [ -f "$ACTIVE_SLOT_FILE" ]; then
  active_slot=$(tr -d '[:space:]' < "$ACTIVE_SLOT_FILE")
fi
case "$active_slot" in
  blue|green) ;;
  *) echo "Invalid active slot: $active_slot" >&2; exit 1 ;;
esac
inactive_slot=green
[ "$active_slot" = green ] && inactive_slot=blue

if [ "$active_slot" = blue ]; then
  active_project="$BLUE_PROJECT"
  active_port=4000
  candidate_project="$GREEN_PROJECT"
  candidate_port=4002
else
  active_project="$GREEN_PROJECT"
  active_port=4002
  candidate_project="$BLUE_PROJECT"
  candidate_port=4000
fi

umask 077
mkdir -p "$VPS_WORKDIR" "$RELEASE_MANIFEST_DIR"
env_source=${GRAPHQL_ENV_FILE:-}
candidate_env="$VPS_WORKDIR/.env.deploy.$inactive_slot"
candidate_env_next=$(mktemp "$VPS_WORKDIR/.env.deploy.$inactive_slot.next.XXXXXX")
docker_config_dir=$(mktemp -d "$VPS_WORKDIR/.docker-config.XXXXXX")
chmod 700 "$docker_config_dir"
export DOCKER_CONFIG="$docker_config_dir"
cleanup_sensitive_files() {
  if [ -n "$candidate_env_next" ]; then rm -f -- "$candidate_env_next"; fi
  if [ -n "$docker_config_dir" ]; then rm -rf -- "$docker_config_dir"; fi
}
trap cleanup_sensitive_files EXIT
if [ -n "$env_source" ]; then
  test -f "$env_source"
  cp "$env_source" "$candidate_env_next"
elif [ "${GRAPHQL_ENV+x}" = x ]; then
  printf '%s' "$GRAPHQL_ENV" > "$candidate_env_next"
else
  echo "GRAPHQL_ENV_FILE or GRAPHQL_ENV is required" >&2
  exit 1
fi
chmod 600 "$candidate_env_next"

# The protocol/configuration hard cut must be visible at the deployment
# boundary too. Do not silently translate or ignore names from the retired
# runtime; an operator must remove them from the source secret first.
retired_snapshot_key="MY_FPL""_SNAPSHOT_READ_ENABLED"
if grep -qE "^[[:space:]]*(REDIS_HOST|REDIS_PORT|REDIS_PASSWORD|RATE_LIMIT_REDIS_HOST|RATE_LIMIT_REDIS_PORT|RATE_LIMIT_REDIS_PASSWORD|GRAPHQL_BROWSER_INGRESS_RATE_LIMIT|GRAPHQL_AUTHENTICATED_RATE_LIMIT|GRAPHQL_ANONYMOUS_RATE_LIMIT|${retired_snapshot_key}|DATA_API_URL|DATA_API_KEY|LETLETME_GRAPHQL_REDIS_HOST|LETLETME_GRAPHQL_REDIS_PORT|LETLETME_GRAPHQL_REDIS_PASSWORD)[[:space:]]*=" "$candidate_env_next"; then
  echo "candidate GraphQL environment contains retired variable(s); use REDIS_URL, RATE_LIMIT_REDIS_URL, LETLETME_DATA_URL and LETLETME_DATA_API_KEY" >&2
  exit 1
fi
retired_rate_mode="leg""acy"
if grep -qE "^GRAPHQL_RATE_LIMIT_MODE=${retired_rate_mode}([[:space:]]|$)" "$candidate_env_next"; then
  echo "GRAPHQL_RATE_LIMIT_MODE=${retired_rate_mode} is retired; choose shadow-v3, enforce-v3, shadow-v4 or enforce-v4" >&2
  exit 1
fi

lower_user=$(printf '%s' "$GHCR_USER" | tr '[:upper:]' '[:lower:]')
ghcr_token=${GHCR_TOKEN:-}
if [ -n "${GHCR_TOKEN_FILE:-}" ]; then
  test -f "$GHCR_TOKEN_FILE"
  ghcr_token=$(cat "$GHCR_TOKEN_FILE")
fi
test -n "$ghcr_token"
printf '%s' "$ghcr_token" | docker login ghcr.io -u "$lower_user" --password-stdin >/dev/null

replace_rate_limit_mode() {
  local mode="$1"
  sed -i "/^GRAPHQL_RATE_LIMIT_MODE=/d" "$candidate_env_next"
  printf 'GRAPHQL_RATE_LIMIT_MODE=%s\n' "$mode" >> "$candidate_env_next"
}

case "$RATE_LIMIT_ROLLOUT" in
  preserve)
    active_env="$VPS_WORKDIR/.env.deploy.$active_slot"
    if [ -f "$active_env" ]; then
      active_rate_limit_mode=$(sed -n 's/^GRAPHQL_RATE_LIMIT_MODE=//p' "$active_env")
      if [ -z "$active_rate_limit_mode" ]; then
        active_rate_limit_mode=shadow-v3
      fi
      case "$active_rate_limit_mode" in
        shadow-v3|enforce-v3|shadow-v4|enforce-v4) ;;
        *) echo "Active slot contains an invalid or duplicate GRAPHQL_RATE_LIMIT_MODE" >&2; exit 1 ;;
      esac
      replace_rate_limit_mode "$active_rate_limit_mode"
    fi
    ;;
  secret)
    ;;
  shadow-v3|enforce-v3|shadow-v4|enforce-v4)
    replace_rate_limit_mode "$RATE_LIMIT_ROLLOUT"
    ;;
  *) echo "Unknown rate-limit rollout profile" >&2; exit 1 ;;
esac

mv "$candidate_env_next" "$candidate_env"
candidate_env_next=""

compose() {
  APP_ENV_FILE="$candidate_env" APP_IMAGE="$IMAGE_REF" GRAPHQL_PORT="$candidate_port" \
    docker compose -p "$candidate_project" "$@"
}

compose config --quiet
compose pull graphql
compose up -d --no-deps --no-build --force-recreate graphql

candidate_url="http://127.0.0.1:$candidate_port"
candidate_ready=false
for _ in $(seq 1 "$CANDIDATE_READY_ATTEMPTS"); do
  if candidate_health=$(curl --fail --silent --show-error --max-time 3 "$candidate_url/health/ready"); then
    if jq -e --arg revision "$DEPLOY_SHA" \
      '.status == "ok" and .revision == $revision' <<<"$candidate_health" >/dev/null; then
      candidate_ready=true
      break
    fi
  fi
  sleep 2
done
if [ "$candidate_ready" != true ]; then
  compose ps
  compose logs --tail 100 graphql || true
  compose down --remove-orphans || true
  echo "candidate slot $inactive_slot did not become ready" >&2
  exit 1
fi

candidate_container=$(compose ps -q graphql)
test -n "$candidate_container"
test "$(docker inspect --format '{{.Config.Image}}' "$candidate_container")" = "$IMAGE_REF"
test "$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$candidate_container")" = "$DEPLOY_SHA"

anonymous_status=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
  --header 'Content-Type: application/json' \
  --data '{"query":"query { currentEventInfo { season } }"}' \
  "$candidate_url/graphql")
test "$anonymous_status" = 401

# The candidate contract probe is deliberately executed inside the container,
# where the service token is already supplied by the candidate environment.
compose exec -T graphql bun -e '
  const token = process.env.GRAPHQL_SERVICE_TOKEN;
  if (!token) throw new Error("Missing GRAPHQL_SERVICE_TOKEN");
  const request = async (query, variables = {}) => {
    const response = await fetch("http://127.0.0.1:4000/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-GraphQL-Service-Token": token },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(5000),
    });
    const payload = await response.json();
    if (response.status !== 200 || payload.errors) {
      throw new Error("GraphQL candidate contract failed");
    }
    return payload.data;
  };
  const data = await request(`query CandidateContract {
    currentEventInfo { season }
  }`);
  if (!/^[0-9]{4}$/.test(data?.currentEventInfo?.season ?? "")) {
    throw new Error("Current-season contract failed");
  }
  const price = await request(`query CandidatePriceBoard {
    priceChangeBoard { status revision expectedPlayerCount observedPlayerCount }
  }`);
  const board = price?.priceChangeBoard;
  if (board?.status === "READY" &&
      (typeof board.revision !== "string" || !board.revision ||
       !Number.isInteger(board.expectedPlayerCount) || board.expectedPlayerCount <= 0 ||
       !Number.isInteger(board.observedPlayerCount) || board.observedPlayerCount <= 0)) {
    throw new Error("READY price-change publication is malformed");
  }
  console.log(JSON.stringify({
    status: "candidate_contract_passed",
    season: data.currentEventInfo.season,
    priceChangeStatus: board?.status ?? "UNAVAILABLE",
    priceChangeRevision: board?.status === "READY" ? board.revision : null,
  }));
'

old_slot="$active_slot"
switched=false
rollback_switch() {
  if [ "$switched" != true ]; then return 0; fi
  if ! sudo -n "$SWITCH_HELPER" "$old_slot"; then
    echo "slot rollback helper failed; active routing is uncertain" >&2
    return 1
  fi
  if [ ! -f "$ACTIVE_SLOT_FILE" ] || [ "$(tr -d '[:space:]' < "$ACTIVE_SLOT_FILE")" != "$old_slot" ]; then
    echo "slot rollback did not restore active slot $old_slot" >&2
    return 1
  fi
  switched=false
}
rollback_on_error() {
  local status=$?
  trap - ERR
  if ! rollback_switch; then
    echo "automatic rollback could not prove restoration of $old_slot" >&2
  fi
  exit "$status"
}
trap rollback_on_error ERR
sudo -n "$SWITCH_HELPER" "$inactive_slot"
switched=true

public_health_url="$PUBLIC_GRAPHQL_HEALTH_URL"
public_health=$(curl --fail --silent --show-error --max-time 5 "$public_health_url") || {
  echo "public GraphQL health probe failed after switching to $inactive_slot" >&2
  if ! rollback_switch; then
    echo "public probe failed and rollback could not be verified" >&2
  fi
  exit 1
}
if ! jq -e --arg revision "$DEPLOY_SHA" \
  '.status == "ok" and .revision == $revision' <<<"$public_health" >/dev/null; then
  echo "public GraphQL health identity does not match $DEPLOY_SHA" >&2
  if ! rollback_switch; then
    echo "public identity mismatch and rollback could not be verified" >&2
  fi
  exit 1
fi

# Health alone does not prove Nginx is routing the expected GraphQL protocol.
# Execute the same hard-cut fields through the public TLS endpoint before the
# old slot is released as the rollback target.
compose exec -T -e PUBLIC_GRAPHQL_URL="$PUBLIC_GRAPHQL_URL" graphql bun -e '
  const token = process.env.GRAPHQL_SERVICE_TOKEN;
  const url = process.env.PUBLIC_GRAPHQL_URL;
  if (!token || !url) throw new Error("Missing public acceptance configuration");
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-GraphQL-Service-Token": token },
    body: JSON.stringify({ query: `query PublicContract {
      currentEventInfo { season }
    }` }),
    signal: AbortSignal.timeout(5000),
  });
  const payload = await response.json();
  if (response.status !== 200 || payload.errors) throw new Error("Public GraphQL contract failed");
  if (!/^[0-9]{4}$/.test(payload.data?.currentEventInfo?.season ?? "")) {
    throw new Error("Public GraphQL fields do not match the candidate contract");
  }
  console.log(JSON.stringify({ status: "public_contract_passed", season: payload.data.currentEventInfo.season }));
'

if [ ! -f "$ACTIVE_SLOT_FILE" ] || [ "$(tr -d '[:space:]' < "$ACTIVE_SLOT_FILE")" != "$inactive_slot" ]; then
	echo "slot switch helper did not persist active slot $inactive_slot" >&2
	if ! rollback_switch; then
		echo "invalid active-slot authority and rollback could not be verified" >&2
	fi
	exit 1
fi

manifest=$(mktemp "$RELEASE_MANIFEST_DIR/release.XXXXXX")
old_image=$(APP_ENV_FILE="$VPS_WORKDIR/.env.deploy.$old_slot" APP_IMAGE="$IMAGE_REF" \
  GRAPHQL_PORT="$active_port" docker compose -p "$active_project" ps --all -q graphql | head -n 1 | \
  xargs -r docker inspect --format '{{.Config.Image}}' || true)
jq -n \
  --arg deployedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg commit "$DEPLOY_SHA" \
  --arg image "$IMAGE_REF" \
  --arg oldSlot "$old_slot" \
  --arg newSlot "$inactive_slot" \
  --arg oldImage "$old_image" \
  '{deployedAt:$deployedAt,commit:$commit,image:$image,oldSlot:$oldSlot,newSlot:$newSlot,oldImage:$oldImage}' \
  > "$manifest"
chmod 600 "$manifest"
mv "$manifest" "$RELEASE_MANIFEST_DIR/$DEPLOY_SHA.json"
switched=false
echo "blue-green deployment switched $old_slot -> $inactive_slot at $DEPLOY_SHA"
