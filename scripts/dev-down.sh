#!/usr/bin/env bash
# Stop the local command-center backend: the fire-refresh loop + containers.
# The dev server is foreground — stop it with Ctrl-C in its own terminal.
set -uo pipefail
cd "$(dirname "$0")/.."

SEED_PIDFILE="/tmp/wm-seed-loop.pid"

say() { printf '\033[1;36m▸ %s\033[0m\n' "$*"; }

if [ -f "$SEED_PIDFILE" ]; then
  pid="$(cat "$SEED_PIDFILE" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill "$pid" 2>/dev/null; then say "Stopped fire-refresh loop (pid $pid)."; fi
  rm -f "$SEED_PIDFILE"
fi

if docker info >/dev/null 2>&1; then
  say "Stopping backend containers…"
  docker compose stop redis redis-rest ais-relay
  say "Done. Containers stopped (data volume kept). Run ./scripts/dev-up.sh to restart."
else
  say "Docker isn't running — nothing to stop."
fi
