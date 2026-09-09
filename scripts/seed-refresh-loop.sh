#!/usr/bin/env bash
# Periodically re-seed data that isn't kept live by the always-on relay.
# Currently: NASA FIRMS wildfire detections (the relay seeds markets/crypto/
# commodities itself; fires come from a separate FIRMS pull). Runs until killed
# by dev-down.sh. Started in the background by dev-up.sh.
set -uo pipefail
cd "$(dirname "$0")/.."

INTERVAL="${SEED_REFRESH_INTERVAL_SEC:-10800}"  # 3 hours

while true; do
  sleep "$INTERVAL"
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] refreshing fire detections…"
  node --env-file=.env.local scripts/seed-fire-detections.mjs || echo "  fire refresh failed (will retry next cycle)"
done
