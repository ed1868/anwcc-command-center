# Ai Nomads World Command Center — Feature Reference

A complete reference for the Command Center's capabilities: what each one does,
the voice commands that trigger it, and any data-source notes. Every command
below is a real tool wired into Jarvis (`src/services/voice/actions.ts`).

- **Quick overview:** [`README.md`](../README.md)
- **Local runbook (how to run it):** [`COMMAND-CENTER.md`](../COMMAND-CENTER.md)

---

## Jarvis voice agent

The Command Center is driven by **Jarvis**, an always-listening realtime voice
agent.

- **Transport:** OpenAI Realtime API over **WebRTC**. The browser gets an
  ephemeral token from the `realtime-token` dev proxy and connects directly.
- **No wake word:** click **VOICE** in the header, allow the mic, and talk.
  Jarvis is always listening while connected.
- **Natural voice + barge-in:** it speaks in a natural voice and you can
  interrupt it mid-sentence — it stops talking and listens.
- **Live transcript:** the assistant's speech streams to screen as it talks.
- **Amber particle-core HUD:** a 240-particle amber "core" overlay
  (`src/components/JarvisOverlay.ts`) pulses through states — `CORE · LINKING`,
  `CORE · LISTENING`, `CORE · EXECUTING` — so you can see what it's doing.

Jarvis calls tools to *act* on the command center, not just answer: it flies the
map, opens panels, draws annotations, opens cameras, and pushes proactive
alerts.

> **Requires** `OPENAI_API_KEY` in `.env.local`.

Example: *"What can you do?"* — Jarvis enumerates its own live capabilities
(available map layers with their on/off state, dashboard panels, and data
queries).

![The Jarvis particle core HUD while speaking](screenshots/jarvis-core.png)

---

## Map control & navigation

Fly the map camera anywhere and change the view.

- *"Zoom to Taiwan."* / *"Fly to Reykjavik."* — flies to a place at a sensible zoom.
- *"Take me to street level in Miami."* — district/street-level detail (up to zoom 17).
- *"Focus on Iran."* — highlights the country and opens its intelligence context.
- *"Show me a continental view of Europe."* — jumps to a continental preset.

**Notes:** Jarvis supplies coordinates for any named place from its own
geographic knowledge; zoom scales from ~3 (country) to ~16–17 (street level).
Continental requests use named region presets rather than a raw fly-to.

---

## Live flights

Live aircraft tracking over any area.

- *"What flights are over Florida right now?"* — scans **all** aircraft in a
  bounding box and reports the total, then names notable flights with **callsign,
  aircraft type, tail number (registration), altitude, and from→to route**, and
  offers to fly you there.
- *"Show me all air traffic."* — toggles a live overlay of every transponder in
  the current viewport (commercial + military), refreshing every ~20s.
- *"What's the military picture?"* — current tracked military aircraft, totals
  plus notable contacts.

**Data sources:**
- **Aircraft positions:** [adsb.lol](https://adsb.lol) (free, no key) — a
  whole-sky ADS-B snapshot carrying aircraft type and registration. Falls back
  to **OpenSky** automatically if adsb.lol is rate-limited.
- **Routes (from→to):** [adsbdb.com](https://adsbdb.com), looked up per callsign
  (a `null` route means it wasn't found — Jarvis won't invent one).
- **Wingbits** (extra commercial coverage) is wired but needs a fresh
  `WINGBITS_API_KEY`; everything else works without it.

![Live aircraft over a region](screenshots/flights.png)

---

## Analyst engine

Ask analytical questions over live data and get computed answers — not just raw
feeds — across **flights, earthquakes, and fires**.

- *"How many flights over Texas above 30,000 feet?"* — filtered count.
- *"What's the biggest fire near LA?"* / *"Strongest quake in Japan today?"* —
  the extreme (biggest / strongest / highest).
- *"Which of those is closest?"* — a **follow-up** that refines the previous
  result set instead of starting over.

**How it works:** the area is given either as a point + radius (`near LA`) or a
bounding box Jarvis derives from geography. Filters include min/max altitude and
aircraft type (flights), minimum magnitude (quakes), and minimum fire radiative
power (fires). Aggregations: `count`, `list`, `nearest`, and `extreme`.

---

## Live city cameras

Open a live video feed of a city, or several at once.

- *"Watch Miami."* / *"Show me Tokyo live."* / *"Eyes on Kyiv."* — finds the
  nearest live city camera, flies there, opens the webcams panel, and starts the
  stream.
- *"Put Miami, Times Square, and Tokyo on the wall."* — opens a **camera wall**:
  a surveillance grid of 2–9 live city cameras playing at once.

**Data source:** curated, verified-live **YouTube live channels**. Current
city coverage: **Kyiv, Rome/Italy, New York (Times Square), Chicago, Miami, Key
West, Taipei, Tokyo, Sydney.** If a requested city isn't covered, Jarvis reads
back a few cities that are.

![A multi-camera surveillance wall](screenshots/camera-wall.png)

---

## Traffic cameras

Put thousands of live public **traffic** cameras on the map as clickable
markers.

- *"Show me traffic cameras in LA."* / *"Freeway cameras in the Bay Area."* /
  *"Street cameras in London."* — flies to the location and drops every nearby
  public traffic cam as a marker; Jarvis reports the count. Clicking a marker
  opens its live feed.

**Data sources & feed types:**
- **California — Caltrans (CA DOT):** live **HLS video** (`streamingVideoURL`) —
  California cams play continuous live video.
- **Florida — Florida DOT (FL511):** live **JPEG snapshots** at
  `/map/Cctv/{itemId}`, auto-refreshed roughly every 15–30s (HLS there needs a
  session token, so the viewer uses the auto-refreshing snapshot).
- **London — TfL JamCams:** snapshot image, with a video URL when available.

Coverage is **California, Florida, and London**. Outside those, the count is 0
and Jarvis says so.

![Traffic camera markers over LA](screenshots/traffic-cams-map.png)

---

## Situation briefing

- *"Give me the brief."* / *"Situation report."* / *"What's happening in the
  world?"* — compiles a **cross-domain intelligence briefing** (breaking alerts,
  headlines, conflict hotspots, earthquakes, the air picture, and market movers)
  and delivers it as a spoken situation report.

---

## Conflict deep-dive

- *"What's happening in the Red Sea?"* / *"Situation in Taiwan."* / *"Brief me on
  the Sahel."* — pulls the matching **live news headlines and clusters** plus any
  geo for a place, conflict, or topic, so Jarvis can explain the situation and
  annotate the map as it talks.

---

## Map annotations ("whiteboard the world")

Jarvis draws on the map while it speaks.

- *"Outline Taiwan."* — highlights the country.
- *"Mark the Strait of Hormuz."* — drops a labeled marker.
- *"Draw a line from Kyiv to Moscow."* — draws a line/arrow between places.

Marks **accumulate** until cleared; say *"clear the map"* to remove them. Jarvis
supplies coordinates from its own geography knowledge and narrates naturally
while the marks appear.

![A country outlined on the map](screenshots/annotations.png)

---

## Watch mode (proactive alerts)

While connected, Jarvis proactively monitors for major events and interrupts to
tell you — **spoken plus an on-screen toast**.

- Alerts on **major earthquakes (M5+)** and **breaking-news alerts** as they happen.
- **On by default** while connected.
- *"Stop watching."* / *"Turn off alerts."* — pause it. *"Keep an eye out."* /
  *"Resume monitoring."* — turn it back on.

---

## Space

- *"When's the next ISS pass over Miami?"* — predicts the next visible pass of
  the International Space Station over a location (CelesTrak TLE + satellite.js).
- *"When's the next rocket launch?"* / *"Upcoming launches."* / *"Next SpaceX
  launch."* — upcoming launches worldwide with site, vehicle, mission, launch
  time, and pad coordinates. **Source:** The Space Devs Launch Library 2.

---

## Data layers

Toggle map data layers by voice — *"Show me the satellites,"* *"Turn on ships,"*
*"Hide the fires."*

| Layer | Source |
|---|---|
| Satellites | CelesTrak / intelligence RPC |
| Ships (AIS) | AISStream, via the relay (`AISSTREAM_API_KEY`) |
| Fires | NASA FIRMS (seeded to Redis; `NASA_FIRMS_API_KEY`) |
| Conflicts, nuclear sites, undersea cables, datacenters | bundled intelligence layers |

---

## Markets, earthquakes & news

- *"How are the markets?"* — latest indices, commodities, and FX loaded in the
  dashboard (seeded by the relay; `FINNHUB_API_KEY` etc.).
- *"Any big earthquakes today?"* — recent earthquakes, strongest first (USGS).
- *"Latest headlines."* — top items from the live news feed, alerts first.

---

## Dashboard panels

Jarvis can open or focus dashboard panels: `live-news`, `intel`, `markets`,
`commodities`, `economic`, `tech`, `crypto`, `ai`, `politics`, regional panels
(`us`, `europe`, `middleeast`, `asia`, `africa`, `latam`), `energy`,
`polymarket`, `monitors`, `insights`, and more — e.g. *"Open the markets panel,"*
*"Show me the intel panel."*

---

## Under the hood

- **Voice code:** `src/services/voice/` — `realtime.ts` (WebRTC session,
  barge-in, transcript), `actions.ts` (the full tool surface), `analyst.ts`,
  `air-traffic.ts`, `watch-mode.ts`, `iss-pass.ts`, `usgs-quakes.ts`.
- **UI:** `src/components/JarvisOverlay.ts` (particle-core HUD),
  `CameraViewer.ts`, `CameraWall.ts`, `VoiceControl.ts`.
- **Dev proxies** (`vite.config.ts`, dev-only): `realtime-token`, `adsblol`,
  `opensky`, `route-lookup`, `iss-tle`, `traffic-cams`, `rocket-launches`.
- **Backend:** Redis + Upstash-compatible Redis-REST + AIS relay via
  `docker-compose.yml`; one-command startup with `./scripts/dev-up.sh`.
