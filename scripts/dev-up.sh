#!/usr/bin/env bash
# =============================================================================
# World Command Center — one-command startup
# =============================================================================
# Brings up the whole local stack:
#   1. Docker Desktop (starts it if the daemon is down)
#   2. Backend containers: redis, redis-rest, ais-relay (flights/ships/markets)
#   3. Fire data seed (background; refreshes stale FIRMS data)
#   4. A 3-hour fire-refresh loop so data stays live
#   5. The Vite dev server on http://localhost:3100 (foreground)
#
# Usage:  ./scripts/dev-up.sh        (Ctrl-C stops the dev server)
#         ./scripts/dev-down.sh      (stops containers + refresh loop)
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

RELAY="worldmonitor-ais-relay"
SEED_PIDFILE="/tmp/wm-seed-loop.pid"
DEV_PORT="${DEV_PORT:-3100}"

say() { printf '\033[1;36m▸ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }

# --- 1. Docker daemon -------------------------------------------------------
if ! docker info >/dev/null 2>&1; then
  say "Docker daemon is down — launching Docker Desktop…"
  open -a Docker || { warn "Could not launch Docker Desktop. Start it manually and re-run."; exit 1; }
  printf '  waiting for daemon'
  for _ in $(seq 1 30); do
    if docker info >/dev/null 2>&1; then echo " up."; break; fi
    printf '.'; sleep 3
  done
  docker info >/dev/null 2>&1 || { echo; warn "Docker didn't come up in time. Try again once it's running."; exit 1; }
fi

# --- 2. Backend containers --------------------------------------------------
if [ ! -f .env ]; then
  warn ".env (compose secrets) is missing. See COMMAND-CENTER.md → Setup."
  exit 1
fi
say "Starting backend containers (redis, redis-rest, ais-relay)…"
# Reuse existing images for a fast, reliable start. If an image is missing
# (first run, or after `docker compose down --rmi`), build it once.
if ! docker image inspect worldmonitor-ais-relay:latest >/dev/null 2>&1 \
   || ! docker image inspect worldmonitor-redis-rest:latest >/dev/null 2>&1; then
  say "First run — building backend images (a few minutes)…"
  docker compose build redis-rest ais-relay
fi
docker compose up -d redis redis-rest ais-relay

say "Waiting for the relay to report healthy…"
for _ in $(seq 1 40); do
  status="$(docker inspect --format '{{.State.Health.Status}}' "$RELAY" 2>/dev/null || echo starting)"
  [ "$status" = "healthy" ] && { echo "  relay healthy."; break; }
  sleep 3
done

# --- 3. Fire seed (background — only if data is missing/stale) ---------------
TOKEN="$(grep '^UPSTASH_REDIS_REST_TOKEN=' .env.local | cut -d= -f2- || true)"
have_fires=""
if [ -n "$TOKEN" ]; then
  have_fires="$(curl -s -m 8 -H "Authorization: Bearer $TOKEN" \
    "http://localhost:8079/get/wildfire:fires-bootstrap:v1" 2>/dev/null | grep -c '"result":"' || true)"
fi
if [ "${have_fires:-0}" = "0" ]; then
  say "Seeding fire data in the background (~6 min; the map fills in when ready)…"
  nohup node --env-file=.env.local scripts/seed-fire-detections.mjs >/tmp/wm-seed-fires.log 2>&1 &
else
  say "Fire data already present — the refresh loop will keep it current."
fi

# --- 4. Fire-refresh loop (single instance) ---------------------------------
if [ -f "$SEED_PIDFILE" ] && kill -0 "$(cat "$SEED_PIDFILE" 2>/dev/null)" 2>/dev/null; then
  say "Fire-refresh loop already running (pid $(cat "$SEED_PIDFILE"))."
else
  nohup "$ROOT/scripts/seed-refresh-loop.sh" >/tmp/wm-seed-loop.log 2>&1 &
  echo $! > "$SEED_PIDFILE"
  say "Fire-refresh loop started (pid $(cat "$SEED_PIDFILE"), every 3h)."
fi

# --- 5. Dev server (foreground) ---------------------------------------------
say "Starting the command center on http://localhost:${DEV_PORT}"
echo   "  relay :3004  ·  redis-rest :8079  ·  Ctrl-C stops the dev server (backend keeps running)."
exec npm run dev
