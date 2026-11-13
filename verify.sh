#!/usr/bin/env bash
# Post-launch wiring check for the Three.js workbench.
#
#   ./verify.sh                      # routes only (no token needed)
#   TOKEN=... ./verify.sh            # also checks the boot graph
#
# The token is the `?token=` value the host web command prints at startup.
set -uo pipefail

BASE="${1:-http://127.0.0.1:3080}"
CURL=(curl --noproxy '*' -s)
fail=0
check() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    printf '  ok   %-34s %s\n' "$label" "$actual"
  else
    printf '  FAIL %-34s %s (expected %s)\n' "$label" "$actual" "$expected"
    fail=1
  fi
}

echo "Base: $BASE"

check "scene demo" 200 "$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$BASE/three-workbench/scene/demo")"
check "state demo" 200 "$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$BASE/three-workbench/state/demo")"
check "state unknown" 200 "$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$BASE/three-workbench/state/nobody")"
check "unknown scene" 404 "$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$BASE/three-workbench/scene/nobody")"
check "three.module.js" 200 "$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$BASE/three-workbench/runtime/three.module.js")"
check "three.core.js" 200 "$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$BASE/three-workbench/runtime/three.core.js")"
check "OrbitControls.js" 200 "$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$BASE/three-workbench/runtime/OrbitControls.js")"
check "runtime CORS" '*' "$("${CURL[@]}" -o /dev/null -D - "$BASE/three-workbench/runtime/three.module.js" | tr -d '\r' | awk -F': ' 'tolower($1)=="access-control-allow-origin"{print $2}')"
check "hidden runtime path" 404 "$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$BASE/three-workbench/runtime/package.json")"
check "GLTFExporter.js" 200 "$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$BASE/three-workbench/runtime/exporters/GLTFExporter.js")"
check "STLExporter.js" 200 "$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$BASE/three-workbench/runtime/exporters/STLExporter.js")"
check "OBJExporter.js" 200 "$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$BASE/three-workbench/runtime/exporters/OBJExporter.js")"
check "thumbnail missing" 404 "$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$BASE/three-workbench/thumbnail/none/1")"

if [[ -n "${TOKEN:-}" ]]; then
  jar="$(mktemp)"
  html="$(curl --noproxy '*' -s -c "$jar" -b "$jar" -L "$BASE/?token=$TOKEN")"
  rm -f "$jar"
  if grep -q 'three-workbench/client\.js' <<<"$html"; then
    printf '  ok   %-34s %s\n' "client bundle in boot graph" "present"
  else
    printf '  FAIL %-34s %s\n' "client bundle in boot graph" "missing"
    fail=1
  fi
else
  printf '  --   %-34s %s\n' "boot graph" "set TOKEN to check"
fi

echo
if [[ $fail -eq 0 ]]; then echo "All checks passed."; else echo "Some checks failed."; fi
exit $fail
