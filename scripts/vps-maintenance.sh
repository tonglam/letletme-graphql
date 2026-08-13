#!/usr/bin/env bash

set -euo pipefail

if [[ "${VPS_MAINTENANCE_LOCK_HELD:-0}" != "1" ]]; then
  echo 'vps-maintenance requires the host-wide maintenance lock' >&2
  exit 75
fi

state_dir=${VPS_MAINTENANCE_STATE_DIR:-/run/letletme-vps-ops}
state_file="$state_dir/deployments.tsv"
mkdir -p "$state_dir"

command_name=${1:-}
shift || true
service=''
run_id=''
old_image=''
new_image=''
reason=''
mode=''

case "$command_name" in
  deployment)
    action=${1:-}
    shift || true
    for argument in "$@"; do
      case "$argument" in
        --service=*) service=${argument#*=} ;;
        --run-id=*) run_id=${argument#*=} ;;
        --old-image=*) old_image=${argument#*=} ;;
        --new-image=*) new_image=${argument#*=} ;;
        --reason=*) reason=${argument#*=} ;;
        *) echo "unknown deployment argument: $argument" >&2; exit 64 ;;
      esac
    done
    ;;
  cleanup)
    action=cleanup
    for argument in "$@"; do
      case "$argument" in
        --service=*) service=${argument#*=} ;;
        --mode=*) mode=${argument#*=} ;;
        *) echo "unknown cleanup argument: $argument" >&2; exit 64 ;;
      esac
    done
    ;;
  *)
    echo "usage: vps-maintenance deployment {begin|commit|fail} ... | cleanup --mode=deploy --service=..." >&2
    exit 64
    ;;
esac

if [[ -z "$service" ]]; then
  echo 'vps-maintenance requires --service' >&2
  exit 64
fi

if [[ "$action" != cleanup && -z "$run_id" ]]; then
  echo 'deployment actions require --run-id' >&2
  exit 64
fi

if [[ "$action" == cleanup ]]; then
  [[ "$mode" == deploy ]] || { echo 'cleanup requires --mode=deploy' >&2; exit 64; }
  exit 0
fi

case "$action" in
  begin|commit|fail) ;;
  *) echo "unsupported deployment action: $action" >&2; exit 64 ;;
esac

mkdir -p "$state_dir"
touch "$state_file"
if [[ "$action" != begin ]]; then
  existing_row=$(awk -F '\t' -v service="$service" -v run_id="$run_id" \
    '($1 == service && $2 == run_id) { print; exit }' "$state_file")
  if [[ -n "$existing_row" ]]; then
    old_image=$(printf '%s\n' "$existing_row" | cut -f4)
    new_image=$(printf '%s\n' "$existing_row" | cut -f5)
  fi
fi
tmp_file=$(mktemp "$state_dir/.deployments.XXXXXX")
trap 'rm -f "$tmp_file"' EXIT

awk -F '\t' -v service="$service" -v run_id="$run_id" \
  '($1 != service || $2 != run_id) { print }' "$state_file" > "$tmp_file"

timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
safe_reason=$(printf '%s' "$reason" | tr '\t\r\n' '   ' | cut -c1-200)
case "$action" in
  begin)
    state=started
    ;;
  commit)
    state=committed
    ;;
  fail)
    state=failed
    ;;
esac
printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
  "$service" "$run_id" "$state" "$old_image" "$new_image" "$safe_reason" "$timestamp" >> "$tmp_file"
chmod 640 "$tmp_file"
mv "$tmp_file" "$state_file"
trap - EXIT
