#!/usr/bin/env bash
# Launch the host web app with the Three.js workbench loaded from this directory.
#
#   ./start.sh                  # loopback; Windows opens http://localhost:<port>
#   ./start.sh --lan            # bind this machine's interface address (NAT-style access)
#   ./start.sh --port 4000      # any host web flag is forwarded
#
# WSL note: the default WSL config here is `networkingMode=mirrored`, where the
# Windows browser reaches a WSL service that listens on 127.0.0.1 — but not one
# bound to the interface address. Loopback is therefore the default; --lan adds
# the interface bind plus the matching --trusted-host entries.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS="${HARNESS_CHECKOUT:-${DSH_CHECKOUT:-}}"
if [[ -z "$HARNESS" ]]; then
  for candidate in "$HERE/../harness" "$HERE/../"*harness*; do
    if [[ -d "$candidate" ]]; then HARNESS="$candidate"; break; fi
  done
fi

if [[ -z "$HARNESS" || ! -d "$HARNESS" ]]; then
  echo "Host checkout not found. Set HARNESS_CHECKOUT to its path." >&2
  exit 1
fi

if [[ -d "$HOME/.local/node24/bin" ]]; then
  export PATH="$HOME/.local/node24/bin:$PATH"
fi

if [[ ! -d "$HARNESS/node_modules" ]]; then
  echo "Dependencies are not installed in $HARNESS." >&2
  echo "Run:  cd $HARNESS && pnpm install && pnpm run build" >&2
  exit 1
fi

PORT=3080
HOST=""
LAN=0
forward=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="${2:-3080}"; forward+=("$1" "$2"); shift 2 ;;
    --port=*) PORT="${1#--port=}"; forward+=("$1"); shift ;;
    --host) HOST="${2:-}"; forward+=("$1" "$2"); shift 2 ;;
    --host=*) HOST="${1#--host=}"; forward+=("$1"); shift ;;
    --lan) LAN=1; shift ;;
    *) forward+=("$1"); shift ;;
  esac
done

WSL=0
if grep -qi microsoft /proc/version 2>/dev/null; then
  WSL=1
  if [[ $LAN -eq 1 && -z "$HOST" ]]; then HOST="$(hostname -I 2>/dev/null | awk '{print $1}')"; fi
  if [[ ! " ${forward[*]-} " =~ " --no-open " ]]; then forward+=(--no-open); fi
fi

# A --patch overlay inserts the plugin by absolute path, so this checkout does
# not need to live in the host profile. Regenerated on every launch.
cat > "$HERE/.dev.patch.yml" <<EOF
- insert:
    - id: three-workbench
      name: '$HERE/index.js'
EOF

net=()
if [[ -n "$HOST" ]]; then
  net=(--host "$HOST" --trusted-host "$HOST:$PORT" --trusted-host "localhost:$PORT" --trusted-host "127.0.0.1:$PORT")
  echo "workbench: binding $HOST:$PORT (interface address)" >&2
else
  echo "workbench: binding loopback:$PORT — open http://localhost:$PORT from Windows" >&2
fi

cd "$HARNESS"
exec pnpm dsh web --patch "$HERE/.dev.patch.yml" "${net[@]}" "${forward[@]}"
