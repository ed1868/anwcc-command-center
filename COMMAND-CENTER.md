# Ai Nomads World Command Center — Local Runbook

The command center with the **Jarvis voice agent**, live flights, ships, fires,
satellites, ISS tracking, and public traffic cameras — running on your machine.

---

## Quick start

```bash
./scripts/dev-up.sh        # or: make up
```

That single command:
1. Starts **Docker Desktop** if it isn't running.
2. Brings up the **backend containers** (Redis + relay).
3. **Seeds fire data** in the background and starts a 3-hour refresh loop.
4. Launches the app at **http://localhost:3100**.

Stop it:

```bash
./scripts/dev-down.sh      # or: make down   (stops containers + refresh loop)
```

`Ctrl-C` in the terminal stops the dev server; the backend containers keep
running until `dev-down`.

---

## What runs where

| Piece | Where | What it does |
|---|---|---|
| **App (Vite dev server)** | http://localhost:3100 | The dashboard + Jarvis. Hot-reloads on code changes. |
| **AIS relay** | container `:3004` | Live ships (AIS) + seeds markets/crypto/commodities into Redis. |
| **Redis** | container `:6379` | Cache the app + relay read/write. |
| **Redis-REST** | container `:8079` | Upstash-compatible HTTP front for Redis (what the app talks to). |

The app reads flights, cameras, routes, and ISS data through **Vite dev
middleware** (see `vite.config.ts` → the `*Plugin()` functions). These are
dev-only proxies; they don't exist in a production build.

---

## Data sources

| Layer / feature | Source | Key? |
|---|---|---|
| **Flights** (map + Jarvis) | adsb.lol (primary, free) → OpenSky fallback | OpenSky creds optional |
| **Flight routes** (from/to) | adsbdb.com | none |
| **Ships** (AIS) | AISStream via the relay | `AISSTREAM_API_KEY` |
| **Fires** | NASA FIRMS (seeded to Redis) | `NASA_FIRMS_API_KEY` |
| **Satellites** | CelesTrak / intelligence RPC | none |
| **ISS pass** | CelesTrak TLE + satellite.js | none |
| **Traffic cameras** | Caltrans (CA) + TfL (London) | none |
| **City webcams** | curated YouTube live streams | none |
| **Markets / crypto** | seeded by the relay | `FINNHUB_API_KEY` etc. |

**Wingbits** (extra commercial flight coverage) is wired but its API key is
expired — get a fresh one from wingbits.com and set `WINGBITS_API_KEY` if you
want it. Everything else works without it.

---

## Talking to Jarvis

Click **VOICE** in the header, allow the mic, and just talk. Examples:

- *"What flights are over Florida right now?"* — count + airline, aircraft type, and route, then offers to fly you there
- *"Show me all air traffic"* — live planes on the map
- *"Show me traffic cameras in LA"* — thousands of freeway cams as clickable markers
- *"Show me Tokyo live"* — opens a city webcam
- *"When's the next ISS pass over Miami?"*
- *"Any big earthquakes today?"* · *"How are the markets?"* · *"Focus on Iran"*
- *"What can you do?"* — Jarvis lists its own capabilities

Needs `OPENAI_API_KEY` in `.env.local`.

---

## Setup (first time / new machine)

1. **Prerequisites**: Docker Desktop, Node 20+, and the repo's npm deps (`npm install`).
2. **`.env.local`** — app + seeder keys (OpenAI, OpenSky, NASA FIRMS, AISStream, etc.)
   plus the Docker wiring block (`WS_RELAY_URL`, `UPSTASH_REDIS_REST_URL`, …).
3. **`.env`** — Docker Compose secrets (`REDIS_TOKEN`, `REDIS_PASSWORD`,
   `WM_SESSION_SECRET`, `RELAY_SHARED_SECRET`, plus the flight/data keys). Both
   files are gitignored. Generate secrets with `openssl rand -hex 32`.
4. `./scripts/dev-up.sh` — the first run builds the backend images (a few
   minutes); later runs reuse them and start in seconds.

---

## Troubleshooting

- **Docker Desktop keeps quitting** — it has crashed mid-session on this machine
  before. `dev-up.sh` relaunches it automatically; if it won't stay up, raise its
  memory in Docker Desktop → Settings → Resources (8 GB+).
- **Map shows no fires** — the seed runs ~6 min in the background on first start;
  give it a moment, or run `node --env-file=.env.local scripts/seed-fire-detections.mjs`.
- **Changed relay/server code?** — `make rebuild` (regenerates the source manifest,
  then rebuilds the images). A plain `dev-up` reuses the old image.
- **Dev server died after a config edit** — editing `vite.config.ts` makes Vite
  restart itself; just run `npm run dev` (or `dev-up`) again.
- **Flights empty** — adsb.lol needs a User-Agent (handled); if it's rate-limited,
  the handler falls back to OpenSky automatically.
