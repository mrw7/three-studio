#!/usr/bin/env bash
# Start Three Studio without DeepSeek Harness.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE="${THREE_STUDIO_NODE:-}"
if [[ -z "$NODE" ]]; then
  if [[ -x "$HOME/.local/node24/bin/node" ]]; then
    NODE="$HOME/.local/node24/bin/node"
  else
    NODE="$(command -v node || true)"
  fi
fi
if [[ -z "$NODE" ]]; then
  echo "Node.js 24 or newer is required." >&2
  exit 1
fi
exec "$NODE" "$HERE/server.mjs" "$@"
