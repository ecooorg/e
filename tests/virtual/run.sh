#!/usr/bin/env bash
# Offline test of the real server.ts against a scripted fake Gemini SDK (no API key, no network).
# Usage (after `npm install`):  bash tests/virtual/run.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"; export STUB_DIR="$TMP/stub"; mkdir -p "$STUB_DIR"
trap 'kill $SERVER_PID 2>/dev/null || true; rm -rf "$TMP"' EXIT
mkdir -p "$TMP/app/node_modules/@google"
cp "$ROOT/server.ts" "$TMP/app/"; mkdir -p "$TMP/app/src/config" && cp "$ROOT/src/config/support.ts" "$TMP/app/src/config/"; [ -d "$ROOT/dist" ] && cp -r "$ROOT/dist" "$TMP/app/dist" || mkdir "$TMP/app/dist"
for e in $(ls -A "$ROOT/node_modules"); do [ "$e" = "@google" ] || ln -s "$ROOT/node_modules/$e" "$TMP/app/node_modules/$e"; done
cp -r "$ROOT/tests/virtual/genai-stub" "$TMP/app/node_modules/@google/genai"
cd "$TMP/app"
NODE_ENV=production PORT=3111 RATE_LIMIT_PER_HOUR=5000 DAILY_CALL_CAP=5000 GEMINI_API_KEY=stub \
  node node_modules/tsx/dist/cli.mjs server.ts > "$TMP/server.log" 2>&1 &
SERVER_PID=$!
for i in $(seq 1 20); do curl -s -m 2 localhost:3111/api/health >/dev/null && break; sleep 1; done
node "$ROOT/tests/virtual/vtest.mjs"
