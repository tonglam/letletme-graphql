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
LEGACY_PROJECT=${LEGACY_PROJECT:-letletme_graphql}
ACTIVE_SLOT_FILE=${ACTIVE_SLOT_FILE:-/var/lib/letletme-graphql/active-slot}
SWITCH_HELPER=${SWITCH_HELPER:-/usr/local/sbin/letletme-graphql-switch-slot}
PUBLIC_GRAPHQL_HEALTH_URL=${PUBLIC_GRAPHQL_HEALTH_URL:-}
PUBLIC_GRAPHQL_URL=${PUBLIC_GRAPHQL_URL:-}
RELEASE_MANIFEST_DIR=${RELEASE_MANIFEST_DIR:-$VPS_WORKDIR/releases}
CANDIDATE_READY_ATTEMPTS=${CANDIDATE_READY_ATTEMPTS:-30}
PUBLIC_HEALTH_ATTEMPTS=${PUBLIC_HEALTH_ATTEMPTS:-15}
PUBLIC_HEALTH_DELAY_SECONDS=${PUBLIC_HEALTH_DELAY_SECONDS:-1}
RATE_LIMIT_ROLLOUT=${RATE_LIMIT_ROLLOUT:-preserve}
DEPLOY_LOCK_PATH=${DEPLOY_LOCK_PATH:-/var/lock/letletme-platform-deploy.lock}

test -n "$PUBLIC_GRAPHQL_HEALTH_URL" || {
  echo "PUBLIC_GRAPHQL_HEALTH_URL is required for public cutover verification" >&2
  exit 1
}
test -n "$PUBLIC_GRAPHQL_URL" || {
  echo "PUBLIC_GRAPHQL_URL is required for public field-level verification" >&2
  exit 1
}
[[ "$PUBLIC_HEALTH_ATTEMPTS" =~ ^[1-9][0-9]*$ ]]
[[ "$PUBLIC_HEALTH_DELAY_SECONDS" =~ ^[0-9]+$ ]]

case "$DEPLOY_LOCK_PATH" in
  /*) ;;
  *) echo "DEPLOY_LOCK_PATH must be an absolute path" >&2; exit 1 ;;
esac
test "$DEPLOY_LOCK_PATH" != "/"
command -v flock >/dev/null 2>&1 || {
  echo "flock is required for deployment serialization" >&2
  exit 1
}
if [ -L "$DEPLOY_LOCK_PATH" ] || [ ! -f "$DEPLOY_LOCK_PATH" ]; then
  echo "deployment lock must be a provisioned regular file: $DEPLOY_LOCK_PATH" >&2
  exit 1
fi
exec 9<>"$DEPLOY_LOCK_PATH"
if ! flock -w 300 9; then
  echo "timed out waiting for the platform deployment lock" >&2
  exit 1
fi

mkdir -p -- "$(dirname "$VPS_WORKDIR")"
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
  candidate_project="$GREEN_PROJECT"
  candidate_port=4002
else
  active_project="$GREEN_PROJECT"
  candidate_project="$BLUE_PROJECT"
  candidate_port=4000
fi
if [ "$LEGACY_PROJECT" = "$BLUE_PROJECT" ] || [ "$LEGACY_PROJECT" = "$GREEN_PROJECT" ]; then
  echo "LEGACY_PROJECT must be distinct from the canonical slot projects" >&2
  exit 1
fi

umask 077
mkdir -p "$VPS_WORKDIR" "$RELEASE_MANIFEST_DIR"
env_source=${GRAPHQL_ENV_FILE:-}
candidate_env="$VPS_WORKDIR/.env.deploy.$inactive_slot"
candidate_env_next=$(mktemp "$VPS_WORKDIR/.env.deploy.$inactive_slot.next.XXXXXX")
docker_config_dir=$(mktemp -d "$VPS_WORKDIR/.docker-config.XXXXXX")
chmod 700 "$docker_config_dir"
export DOCKER_CONFIG="$docker_config_dir"
candidate_started=false
promotion_committed=false
rollback_verified=false
manifest=""
cleanup_sensitive_files() {
  if [ "${candidate_started:-false}" = true ] && [ "${promotion_committed:-false}" != true ]; then
    if [ "${switched:-false}" != true ] || [ "${rollback_verified:-false}" = true ]; then
      compose down --remove-orphans >/dev/null 2>&1 || true
    else
      echo "preserving candidate slot because active-slot rollback is unverified" >&2
    fi
  fi
  if [ -n "$candidate_env_next" ]; then rm -f -- "$candidate_env_next"; fi
  if [ -n "$manifest" ]; then rm -f -- "$manifest"; fi
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
if grep -qE "^[[:space:]]*(REDIS_HOST|REDIS_PORT|REDIS_PASSWORD|RATE_LIMIT_REDIS_HOST|RATE_LIMIT_REDIS_PORT|RATE_LIMIT_REDIS_PASSWORD|GRAPHQL_BROWSER_INGRESS_RATE_LIMIT|GRAPHQL_AUTHENTICATED_RATE_LIMIT|GRAPHQL_ANONYMOUS_RATE_LIMIT|${retired_snapshot_key}|DATA_API_URL|DATA_API_KEY|DATA_URL|DATA_AUTH_HEADER|LETLETME_GRAPHQL_REDIS_HOST|LETLETME_GRAPHQL_REDIS_PORT|LETLETME_GRAPHQL_REDIS_PASSWORD)[[:space:]]*=" "$candidate_env_next"; then
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
  if [ -s "$candidate_env_next" ] && [ -n "$(tail -c 1 "$candidate_env_next")" ]; then
    printf '\n' >> "$candidate_env_next"
  fi
  printf 'GRAPHQL_RATE_LIMIT_MODE=%s\n' "$mode" >> "$candidate_env_next"
}

case "$RATE_LIMIT_ROLLOUT" in
  preserve)
    active_env="$VPS_WORKDIR/.env.deploy.$active_slot"
    if [ -f "$active_env" ]; then
      active_rate_limit_mode=$(sed -n 's/^GRAPHQL_RATE_LIMIT_MODE=//p' "$active_env")
      if [ -z "$active_rate_limit_mode" ]; then
        active_rate_limit_mode=shadow-v4
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

# This script is streamed to the remote shell through stdin. Keep container
# probes from consuming the remaining deployment script as their own stdin;
# otherwise the remote shell can reach EOF after a successful probe and report
# a false-positive deployment before the slot switch and public checks run.
compose_exec() {
  compose exec -T "$@" < /dev/null
}

compose config --quiet
compose pull graphql

# The pre-blue/green service owns port 4000 under Docker Compose's implicit
# work-directory project. Keep it available as the first green cutover's
# rollback target, then retire it only when green is already authoritative and
# a later deployment is about to reuse port 4000 for canonical blue.
retire_legacy_bootstrap_before_blue() {
  local container remaining
  if [ "$active_slot" != green ] || [ "$inactive_slot" != blue ]; then
    return 0
  fi
  while IFS= read -r container; do
    [ -n "$container" ] || continue
    docker container rm --force "$container" >/dev/null
  done < <(docker ps --all \
    --filter "label=com.docker.compose.project=$LEGACY_PROJECT" \
    --filter "label=com.docker.compose.service=graphql" \
    --format '{{.ID}}')
  remaining=$(docker ps --all \
    --filter "label=com.docker.compose.project=$LEGACY_PROJECT" \
    --filter "label=com.docker.compose.service=graphql" \
    --format '{{.ID}}' | head -n 1)
  if [ -n "$remaining" ]; then
    echo "legacy GraphQL bootstrap project could not be retired" >&2
    return 1
  fi
}
retire_legacy_bootstrap_before_blue
candidate_started=true
compose up -d --no-deps --no-build --force-recreate graphql

candidate_url="http://127.0.0.1:$candidate_port"
candidate_ready=false
for _ in $(seq 1 "$CANDIDATE_READY_ATTEMPTS"); do
  if candidate_health=$(curl --fail --silent --show-error --max-time 3 "$candidate_url/health/ready"); then
    if jq -e --arg deploySha "$DEPLOY_SHA" \
      '.status == "ok" and .deploySha == $deploySha' <<<"$candidate_health" >/dev/null; then
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

anonymous_status=$(curl --silent --show-error --max-time 5 --output /dev/null --write-out '%{http_code}' \
  --header 'Content-Type: application/json' \
  --data '{"query":"query { currentEventInfo { season } }"}' \
  "$candidate_url/graphql")
test "$anonymous_status" = 401

# The candidate contract probe is deliberately executed inside the container,
# where the service token is already supplied by the candidate environment.
compose_exec graphql bun -e '
  const token = process.env.GRAPHQL_SERVICE_TOKEN;
  if (!token) throw new Error("Missing GRAPHQL_SERVICE_TOKEN");
  const request = async (query, variables = {}) => {
    const response = await fetch("http://127.0.0.1:4000/graphql", {
      method: "POST",
      redirect: "error",
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
    entryLookup(id: -1) { status retryable entry { id } source persistenceState }
  }`);
  if (!/^[0-9]{4}$/.test(data?.currentEventInfo?.season ?? "")) {
    throw new Error("Current-season contract failed");
  }
  if (data?.entryLookup?.status !== "INVALID_ID" || data.entryLookup.retryable !== false || data.entryLookup.entry !== null) {
    throw new Error("Entry lookup contract failed");
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

# Validate the immutable public acceptance destinations before switching slots
# or forwarding the service token. These exact routes are owned by the VPS Ops
# Nginx contract; a pair of attacker-controlled URLs must not be able to approve
# a cutover or receive GraphQL credentials.
compose_exec \
  -e PUBLIC_GRAPHQL_HEALTH_URL="$PUBLIC_GRAPHQL_HEALTH_URL" \
  -e PUBLIC_GRAPHQL_URL="$PUBLIC_GRAPHQL_URL" \
  graphql bun -e '
  const expectedOrigin = "https://api.letletme.top";
  const validate = (name, raw, expectedPathname) => {
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error(`${name} is not a valid URL`);
    }
    if (parsed.origin !== expectedOrigin ||
        parsed.pathname !== expectedPathname ||
        parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error(`${name} is outside the allowlisted public GraphQL route`);
    }
  };
  validate(
    "PUBLIC_GRAPHQL_HEALTH_URL",
    process.env.PUBLIC_GRAPHQL_HEALTH_URL,
    "/api/graphql/health/ready",
  );
  validate(
    "PUBLIC_GRAPHQL_URL",
    process.env.PUBLIC_GRAPHQL_URL,
    "/api/graphql",
  );
  console.log(JSON.stringify({ status: "public_graphql_urls_validated" }));
'

old_slot="$active_slot"
switched=false
old_public_health=""
old_public_revision=""
old_local_revision=""
old_active_container=$(docker ps --all \
  --filter "label=com.docker.compose.project=$active_project" \
  --filter "label=com.docker.compose.service=graphql" \
  --format '{{.ID}}' | head -n 1)
if [ -n "$old_active_container" ]; then
  old_local_revision=$(docker inspect \
    --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
    "$old_active_container" || true)
fi
if old_public_health=$(curl --fail --silent --show-error --max-time 5 "$PUBLIC_GRAPHQL_HEALTH_URL"); then
  old_public_revision=$(jq -r \
    'select(.status == "ok" and (.deploySha | type == "string") and (.deploySha | length > 0)) | .deploySha' \
    <<<"$old_public_health" || true)
fi
if [ -z "$old_public_revision" ]; then
  old_public_revision="$old_local_revision"
fi
if [ -z "$old_public_revision" ]; then
  echo "previous public GraphQL identity unavailable; cutover will require the new revision" >&2
fi
rollback_switch() {
  if [ "$switched" != true ]; then return 0; fi
  rollback_verified=false
  if ! sudo -n "$SWITCH_HELPER" "$old_slot"; then
    echo "slot rollback helper failed; active routing is uncertain" >&2
    return 1
  fi
  if [ ! -f "$ACTIVE_SLOT_FILE" ] || [ "$(tr -d '[:space:]' < "$ACTIVE_SLOT_FILE")" != "$old_slot" ]; then
    echo "slot rollback did not restore active slot $old_slot" >&2
    return 1
  fi
  rollback_verified=true
  switched=false
}
rollback_on_error() {
  local status=$?
  trap - ERR
  trap - INT TERM HUP
  if [ "${promotion_committed:-false}" != true ] && ! rollback_switch; then
    echo "automatic rollback could not prove restoration of $old_slot" >&2
  fi
  exit "$status"
}
trap rollback_on_error ERR
rollback_on_signal() {
  local status="$1"
  trap - ERR INT TERM HUP
  if [ "${promotion_committed:-false}" != true ] && ! rollback_switch; then
    echo "signal interrupted cutover and rollback could not be verified" >&2
  fi
  exit "$status"
}
trap 'rollback_on_signal 129' HUP
trap 'rollback_on_signal 130' INT
trap 'rollback_on_signal 143' TERM
switched=true
sudo -n "$SWITCH_HELPER" "$inactive_slot"

public_health_url="$PUBLIC_GRAPHQL_HEALTH_URL"
public_health=""
public_health_ready=false
for attempt in $(seq 1 "$PUBLIC_HEALTH_ATTEMPTS"); do
  if ! public_health=$(curl --fail --silent --show-error --max-time 5 "$public_health_url"); then
    echo "public GraphQL health probe failed after switching to $inactive_slot on attempt $attempt" >&2
    if ! rollback_switch; then
      echo "public probe failed and rollback could not be verified" >&2
    fi
    exit 1
  fi
  if jq -e --arg deploySha "$DEPLOY_SHA" \
    '.status == "ok" and .deploySha == $deploySha' <<<"$public_health" >/dev/null; then
    public_health_ready=true
    break
  fi
  if [ -z "$old_public_revision" ] || ! jq -e --arg deploySha "$old_public_revision" \
    '.status == "ok" and .deploySha == $deploySha' <<<"$public_health" >/dev/null; then
    echo "public GraphQL health identity is neither the new nor previous revision" >&2
    if ! rollback_switch; then
      echo "public identity mismatch and rollback could not be verified" >&2
    fi
    exit 1
  fi
  if [ "$attempt" -lt "$PUBLIC_HEALTH_ATTEMPTS" ]; then
    sleep "$PUBLIC_HEALTH_DELAY_SECONDS"
  fi
done
if [ "$public_health_ready" != true ]; then
  if [ -n "$public_health" ]; then
    echo "public GraphQL health identity does not match $DEPLOY_SHA after ${PUBLIC_HEALTH_ATTEMPTS} attempts" >&2
  else
    echo "public GraphQL health probe failed after switching to $inactive_slot" >&2
  fi
  if ! rollback_switch; then
    echo "public identity mismatch and rollback could not be verified" >&2
  fi
  exit 1
fi

# Health alone does not prove Nginx is routing the expected GraphQL protocol.
# Execute the same hard-cut fields through the public TLS endpoint before the
# old slot is released as the rollback target.
compose_exec -e PUBLIC_GRAPHQL_URL="$PUBLIC_GRAPHQL_URL" graphql bun -e '
  const token = process.env.GRAPHQL_SERVICE_TOKEN;
  const url = process.env.PUBLIC_GRAPHQL_URL;
  if (!token || !url) throw new Error("Missing public acceptance configuration");
  const response = await fetch(url, {
    method: "POST",
    redirect: "error",
    headers: { "Content-Type": "application/json", "X-GraphQL-Service-Token": token },
    body: JSON.stringify({ query: `query PublicContract {
      currentEventInfo { season }
      entryLookup(id: -1) { status retryable entry { id } source persistenceState }
    }` }),
    signal: AbortSignal.timeout(5000),
  });
  const payload = await response.json();
  if (response.status !== 200 || payload.errors) throw new Error("Public GraphQL contract failed");
  if (!/^[0-9]{4}$/.test(payload.data?.currentEventInfo?.season ?? "") ||
      payload.data?.entryLookup?.status !== "INVALID_ID" ||
      payload.data.entryLookup.retryable !== false ||
      payload.data.entryLookup.entry !== null) {
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
active_container=$(docker ps --all \
  --filter "label=com.docker.compose.project=$active_project" \
  --filter "label=com.docker.compose.service=graphql" \
  --format '{{.ID}}' | head -n 1)
old_image=""
if [ -n "$active_container" ]; then
  old_image=$(docker inspect --format '{{.Config.Image}}' "$active_container" || true)
fi
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
trap '' INT TERM HUP
mv "$manifest" "$RELEASE_MANIFEST_DIR/$DEPLOY_SHA.json"
manifest=""
promotion_committed=true
switched=false
trap - INT TERM HUP

# The durable manifest is the point after which cleanup is allowed. Keep both
# slot image IDs and remove only older images in this repository; Docker also
# refuses to remove an image referenced by any unexpected container.
prune_superseded_repository_images() {
  local image_repository active_image_id candidate_image_id image_id
  image_repository=${IMAGE_REF%@sha256:*}
  active_image_id=""
  candidate_image_id=$(docker inspect --format '{{.Image}}' "$candidate_container")
  if [ -n "$active_container" ]; then
    active_image_id=$(docker inspect --format '{{.Image}}' "$active_container" || true)
  fi
  while IFS= read -r image_id; do
    [ -n "$image_id" ] || continue
    if [ "$image_id" = "$active_image_id" ] || [ "$image_id" = "$candidate_image_id" ]; then
      continue
    fi
    if ! docker image rm "$image_id" >/dev/null; then
      echo "retained superseded GraphQL image still referenced by a container: $image_id" >&2
    fi
  done < <(docker image ls --no-trunc --format '{{.ID}}' "$image_repository" | sort -u)
}
prune_superseded_repository_images
echo "blue-green deployment switched $old_slot -> $inactive_slot at $DEPLOY_SHA"
