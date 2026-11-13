#!/usr/bin/env bash
# Open the running workbench in the Windows default browser without ever
# printing the auth token or putting it in browser argv (D11).
#
# The tokenized URL is read from the server log by a short-lived local helper.
# The helper listens on 127.0.0.1 on a random port and hands the browser a
# one-time redirect from a tokenless URL. It exits after the first request (or
# after 30 seconds) and the 0600 temp directory is removed on shell exit.
set -euo pipefail

LOG="${1:-/tmp/three-workbench-server.log}"
if [[ ! -r "$LOG" ]]; then
  echo "Cannot read $LOG. Start the server first: ./start.sh" >&2
  exit 1
fi

# start.sh prefers the local Node 24 install; do the same when available.
if [[ -d "$HOME/.local/node24/bin" ]]; then
  export PATH="$HOME/.local/node24/bin:$PATH"
fi

umask 077
TMP="$(mktemp -d "${TMPDIR:-/tmp}/three-workbench-open.XXXXXX")"
URL_FILE="$TMP/browser-url"
HELPER_PID=""
cleanup() { rm -rf "$TMP"; }
on_signal() {
  if [[ -n "$HELPER_PID" ]]; then kill "$HELPER_PID" 2>/dev/null || true; fi
  cleanup
  exit 130
}
trap cleanup EXIT
trap on_signal INT TERM

# The helper's argv holds only paths, never the tokenized URL. It writes the
# tokenless URL to a 0600 file once its redirect server is listening.
node - "$LOG" "$URL_FILE" <<'NODE' &
'use strict'
const fs = require('node:fs')
const http = require('node:http')
const crypto = require('node:crypto')

const [, , logPath, urlFile] = process.argv
if (logPath === undefined || urlFile === undefined) process.exit(2)

let target
try {
  const text = fs.readFileSync(logPath, 'utf8')
  const matches = text.match(/https?:\/\/[^\s"'<>]+\?token=[A-Za-z0-9._~-]+/g)
  if (matches === null || matches.length === 0) {
    console.error('No startup URL found in the log. Start the server first: ./start.sh')
    process.exit(1)
  }
  target = new URL(matches[matches.length - 1])
} catch {
  console.error('Could not prepare the browser link.')
  process.exit(1)
}

// Mirrored WSL networking maps the Windows browser's localhost to WSL loopback.
// Keep non-loopback spellings intact for --lan/NAT setups.
if (target.hostname === '127.0.0.1' || target.hostname === '::1') target.hostname = 'localhost'

const nonce = crypto.randomBytes(16).toString('hex')
const server = http.createServer((request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' })
    response.end('Method not allowed.')
    return
  }
  if (request.url !== `/${nonce}/`) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('Not found.')
    return
  }
  response.writeHead(302, {
    location: target.href,
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    connection: 'close',
  })
  response.end()
  // One handoff only: exit once the redirect is on the wire, or after a grace
  // period so a slow flush cannot leave the helper behind.
  response.on('finish', () => setImmediate(() => process.exit(0)))
  setTimeout(() => process.exit(0), 1000).unref()
})

server.on('error', () => process.exit(1))
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port
  const tokenless = `http://localhost:${String(port)}/${nonce}/`
  try {
    fs.writeFileSync(urlFile, `${tokenless}\n`, { mode: 0o600, flag: 'wx' })
  } catch {
    server.close()
    process.exit(1)
  }
  // The link is short-lived even if no browser ever asks for it.
  setTimeout(() => {
    server.close()
    process.exit(1)
  }, 30000).unref()
})
NODE
HELPER_PID=$!

# Wait until the helper has bound its port and written the tokenless URL.
for _ in $(seq 1 50); do
  if [[ -s "$URL_FILE" ]]; then break; fi
  if ! kill -0 "$HELPER_PID" 2>/dev/null; then break; fi
  sleep 0.1
done
if [[ ! -s "$URL_FILE" ]]; then
  echo "Could not prepare a browser link from $LOG. Start the server first: ./start.sh" >&2
  exit 1
fi
BROWSER_URL="$(cat "$URL_FILE")"

opened=0
if command -v powershell.exe >/dev/null 2>&1; then
  powershell.exe -NoProfile -Command "Start-Process '$BROWSER_URL'" >/dev/null 2>&1 && opened=1
fi
if [[ $opened -eq 0 ]] && command -v cmd.exe >/dev/null 2>&1; then
  cmd.exe /c start "" "$BROWSER_URL" >/dev/null 2>&1 && opened=1
fi

if [[ $opened -eq 1 ]]; then
  echo "Opened in the Windows default browser."
  # Give the browser a moment to follow the one-time redirect so the helper can
  # exit cleanly; it also self-terminates after 30 seconds.
  for _ in $(seq 1 100); do
    if ! kill -0 "$HELPER_PID" 2>/dev/null; then break; fi
    sleep 0.1
  done
  exit 0
fi

echo "Automatic open failed. Open this short-lived, token-free link in a browser:" >&2
cat "$URL_FILE" >&2
echo "(The helper stops after 30 seconds or the first visit.)" >&2
exit 1
