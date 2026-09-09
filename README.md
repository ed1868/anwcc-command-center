# Ai Nomads World Command Center

**A real-time global intelligence command center — driven by your voice.** Live
conflicts, markets, civil and military aviation, maritime AIS, live camera
feeds, space, earthquakes, fires, and OSINT signals fused into one
situational-awareness workspace, with the **Jarvis** realtime voice agent on
top. Talk to it and the world map responds.

Built and maintained by **Eddie Ruiz** ([@ed1868](https://github.com/ed1868)),
the Command Center extends the open-source intelligence dashboard with a custom
**Jarvis voice agent** (hands-free briefings and control), **live flight
tracking**, **live camera walls**, an integrated **AI analyst engine**, and
**proactive watch mode** across every data stream.

> Built on the open-source [worldmonitor](https://github.com/koala73/worldmonitor)
> project by Elie Habib and contributors (AGPL-3.0). This is a derivative work;
> see [`NOTICE.md`](NOTICE.md) and [`LICENSE`](LICENSE).

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Voice: OpenAI Realtime](https://img.shields.io/badge/Voice-OpenAI%20Realtime%20(WebRTC)-10a37f?style=flat)](https://platform.openai.com/docs/guides/realtime)

![The Jarvis particle core while speaking](docs/screenshots/jarvis-core.png)

---

## Meet Jarvis

Jarvis is an **always-listening realtime voice agent** built on the **OpenAI
Realtime API over WebRTC**. Click **VOICE** in the header, allow the mic, and
just talk — **no wake word**. It responds in a natural voice, supports
**barge-in** (interrupt it mid-sentence and it stops to listen), streams a
**live transcript**, and renders an **amber particle-core HUD** that pulses as
it listens, thinks, and speaks.

Jarvis doesn't just answer — it *drives the command center*. Ask a question and
it flies the map, opens panels, draws annotations, spins up camera walls, and
alerts you to breaking events without being asked.

### Talk to it

Everything below is a real command wired into Jarvis's tool surface:

**Move the map**
- *"Zoom to Taiwan."* · *"Focus on Iran."* · *"Show me a continental view of Europe."*
- *"Take me to street level in Miami."* (zooms to district / street detail)

**Aircraft**
- *"What flights are over Florida right now?"* — count, plus callsign, aircraft
  type, tail number, and from→to route for notable flights; then offers to fly you there.
- *"Show me all air traffic."* — every live transponder in view, refreshing continuously.
- *"What's the military picture?"* — tracked military aircraft.

**Analyst engine**
- *"How many flights over Texas above 30,000 feet?"*
- *"What's the biggest fire near LA?"* · *"Strongest quake in Japan today?"*
- Follow up: *"Which of those is closest?"* — it refines the previous result set.

**Live cameras**
- *"Watch Miami."* · *"Show me Tokyo live."* — opens the nearest live city webcam.
- *"Put Miami, Times Square, and Tokyo on the wall."* — a multi-camera surveillance grid.
- *"Show traffic cams in LA."* — thousands of California/Florida/London public
  traffic cameras as clickable map markers (California plays continuous live video).

**Intelligence**
- *"Give me the brief."* — a spoken cross-domain situation report.
- *"What's happening in the Red Sea?"* — pulls live news, explains it, and annotates the map.
- *"Outline Taiwan."* · *"Draw a line from Kyiv to Moscow."* — Jarvis draws on the map as it talks.

**Space**
- *"When's the next ISS pass over Miami?"* · *"When's the next rocket launch?"*

**Watch mode (proactive)**
- While connected, Jarvis proactively alerts you — spoken and as an on-screen
  toast — to major earthquakes (M5+) and breaking-news alerts. Say *"stop
  watching"* to pause it, *"keep an eye out"* to resume.

**Everything else**
- *"How are the markets?"* · *"Any big earthquakes today?"* · *"Latest headlines."*
- Toggle data layers: satellites, ships (AIS), fires, conflicts, nuclear sites,
  undersea cables, datacenters, and more.
- *"What can you do?"* — Jarvis enumerates its own capabilities live.

See **[docs/FEATURES.md](docs/FEATURES.md)** for the complete capability
reference, example commands, and data-source notes.

---

## Features at a glance

| Capability | What it does | Ask Jarvis |
|---|---|---|
| **Jarvis voice agent** | Always-listening OpenAI Realtime voice with barge-in, live transcript, and an amber particle-core HUD | *"What can you do?"* |
| **Map control** | Fly to any place, street-level zoom, continental presets, country focus | *"Zoom to Taiwan"* |
| **Live flights** | All aircraft via adsb.lol — callsign, type, tail number, from→to route; military picture | *"What flights are over Florida?"* |
| **Analyst engine** | Counts, extremes, and nearest over flights / quakes / fires, with follow-ups | *"Biggest fire near LA?"* |
| **Live city cameras** | Nearest live webcam, or a multi-camera surveillance wall | *"Put Miami and Tokyo on the wall"* |
| **Traffic cameras** | Thousands of CA / FL / London public traffic cams as map markers | *"Show traffic cams in LA"* |
| **Situation brief** | Spoken cross-domain intelligence report | *"Give me the brief"* |
| **Conflict deep-dive** | Live news + explanation + map annotation for any hotspot | *"What's happening in the Red Sea?"* |
| **Map annotations** | Outline countries, drop markers, draw lines/arrows while talking | *"Outline Taiwan"* |
| **Watch mode** | Proactive spoken + on-screen alerts for major quakes and breaking news | *"Stop watching"* |
| **Space** | Next ISS pass over a place; upcoming rocket launches | *"Next ISS pass over Miami"* |
| **Data layers** | Satellites, ships (AIS), fires (NASA FIRMS), conflicts, nuclear, cables, datacenters | *"Show me the satellites"* |
| **Markets & news** | Live indices, commodities, crypto, and the news feed | *"How are the markets?"* |

![Live aircraft over a region](docs/screenshots/flights.png)

---

## Quick start

**Prerequisites:** Docker Desktop, Node 20+, and an `OPENAI_API_KEY` (for Jarvis).

```bash
git clone https://github.com/ed1868/anwcc-command-center.git
cd anwcc-command-center
npm install

# Recreate the two gitignored env files (see "Environment" below):
#   .env.local  — app + seeder keys (OPENAI_API_KEY, etc.) + Docker wiring
#   .env        — Docker Compose secrets

./scripts/dev-up.sh        # or: make up
```

Then open **http://localhost:3100**, click **VOICE**, allow the mic, and start talking.

`./scripts/dev-up.sh` starts Docker Desktop if needed, brings up the backend
containers (Redis + AIS relay), seeds fire data in the background, and launches
the app. Stop everything with `./scripts/dev-down.sh` (or `make down`).

For the full local runbook — what runs where, the container topology, and
troubleshooting — see **[COMMAND-CENTER.md](COMMAND-CENTER.md)**.

### Environment

Both `.env.local` and `.env` are gitignored and must be recreated on a new
machine. Generate secrets with `openssl rand -hex 32`.

- **`.env.local`** — `OPENAI_API_KEY` (Jarvis), plus optional data keys
  (OpenSky, NASA FIRMS, AISStream, Finnhub, …) and the Docker wiring block
  (`WS_RELAY_URL`, `UPSTASH_REDIS_REST_URL`, …).
- **`.env`** — Docker Compose secrets (`REDIS_TOKEN`, `REDIS_PASSWORD`,
  `WM_SESSION_SECRET`, `RELAY_SHARED_SECRET`) plus any flight/data keys the
  relay needs.

Only `OPENAI_API_KEY` is required to talk to Jarvis; most map layers work with
no keys at all. See `.env.example` for the full list.

---

## Under the hood

- **Voice** — `src/services/voice/` : `realtime.ts` (WebRTC session, barge-in,
  transcript), `actions.ts` (the full tool surface Jarvis calls), plus
  `analyst.ts`, `air-traffic.ts`, `watch-mode.ts`, `iss-pass.ts`. The HUD lives
  in `src/components/JarvisOverlay.ts`; camera UI in `CameraViewer.ts` /
  `CameraWall.ts`.
- **Dev proxies** — the app reaches live upstreams through Vite dev middleware
  (see `vite.config.ts`): `realtime-token` (ephemeral OpenAI token),
  `adsblol` + `opensky` (flights), `route-lookup` (from→to), `iss-tle`,
  `traffic-cams` (Caltrans + Florida DOT + TfL), and `rocket-launches`. These
  are dev-only and don't exist in a production build.
- **Backend** — a Docker Compose stack (`docker-compose.yml`) runs Redis, an
  Upstash-compatible Redis-REST front, and the AIS relay (ships + market/crypto
  seeding). One command (`./scripts/dev-up.sh`) brings it all up.

---

## License & attribution

**AGPL-3.0-only.** The Ai Nomads World Command Center is a derivative work of
the open-source [worldmonitor](https://github.com/koala73/worldmonitor) project
by Elie Habib and contributors, distributed under the same license. Under the
AGPL (§13), users who interact with a network deployment are entitled to its
corresponding source — this repository. See [`NOTICE.md`](NOTICE.md) for the
full attribution and source-availability notice and [`LICENSE`](LICENSE) for the
license text.

- Upstream project: [koala73/worldmonitor](https://github.com/koala73/worldmonitor) (AGPL-3.0)
- Derivative work: **Ai Nomads World Command Center**, by Eddie Ruiz ([@ed1868](https://github.com/ed1868))
