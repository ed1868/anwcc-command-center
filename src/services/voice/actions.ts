// Voice action registry: the tools the realtime agent can call to drive the
// command center. Dashboard mutations ride the agent bus (applyAgentBusAction),
// the same validated/entitlement-checked seam WebMCP and the chat analyst use.

import type { AppContext } from '@/app/app-context';
import { applyAgentBusAction } from '@/app/agent-bus-applier';
import { DASHBOARD_MAP_VIEWS, DASHBOARD_TIME_RANGES } from '../../../shared/agent-bus-contract';
import { fetchMilitaryFlights, getInterestingFlights, getMilitaryFlightsStatus } from '@/services/military-flights';
import { fetchRecentQuakes } from './usgs-quakes';
import { setAirTrafficOverlay, isAirTrafficOverlayActive } from './air-traffic';
import { nextIssPass } from './iss-pass';
import { runAnalystQuery, type AnalystQuery } from './analyst';
import { LAYER_REGISTRY, getAllowedLayerKeys, type MapVariant } from '@/config/map-layer-definitions';
import { SITE_VARIANT } from '@/config/variant';
import type { MapLayers } from '@/types';
import type { VoiceActionRegistry, VoiceToolDefinition } from './realtime';

// Curated live city webcams (verified-live YouTube channels, mirrors
// LiveWebcamsPanel WEBCAM_FEEDS). watch_camera opens the nearest one's CURRENT
// live stream in the CameraViewer.
const WEBCAM_CITY_COORDS: Record<string, { lat: number; lon: number; city: string; handle: string; fallback: string }> = {
  'kyiv': { lat: 50.45, lon: 30.52, city: 'Kyiv / DW Live', handle: '@DWNews', fallback: 'LuKwFajn37U' },
  'italy': { lat: 41.90, lon: 12.50, city: 'Italy (SkylineWebcams)', handle: '@SkylineWebcams', fallback: 'kUfuwa8mDrA' },
  'nyc': { lat: 40.76, lon: -73.98, city: 'Times Square, NYC', handle: '@EarthCam', fallback: 'qbsgcchN2-Y' },
  'chicago': { lat: 41.88, lon: -87.63, city: 'Chicago', handle: '@abc7chicago', fallback: 'sj2cWegO1OU' },
  'miami': { lat: 25.76, lon: -80.19, city: 'Miami (Local 10)', handle: '@WPLGLocal10', fallback: 'Rr387XjUXCY' },
  'key-west': { lat: 24.56, lon: -81.78, city: 'Key West, FL', handle: '@SloppyJoesBarKeyWest', fallback: 'rbMK4p6zUwI' },
  'taipei': { lat: 25.03, lon: 121.57, city: 'Taipei', handle: '@JackyWuTaipei', fallback: 'z_fY1pj1VBw' },
  'tokyo': { lat: 35.68, lon: 139.69, city: 'Tokyo (ANN News)', handle: '@ANNnewsCH', fallback: 'ZRiZsmMf4uY' },
  'sydney': { lat: -33.87, lon: 151.21, city: 'Sydney', handle: '@WebcamSydney', fallback: '7pcL-0Wo77U' },
};

// Watch-mode toggle bridge — VoiceControl owns the monitor; the agent flips it.
interface WatchModeController { set(on: boolean): void; isEnabled(): boolean; }
let watchModeController: WatchModeController | null = null;
export function setWatchModeController(c: WatchModeController | null): void { watchModeController = c; }

const LAYER_KEYS = [
  'flights', 'military', 'ais', 'conflicts', 'bases', 'cables', 'pipelines', 'hotspots',
  'nuclear', 'sanctions', 'weather', 'economic', 'waterways', 'outages', 'cyberThreats',
  'datacenters', 'protests', 'natural', 'spaceports', 'minerals', 'fires', 'ucdpEvents',
  'displacement', 'climate', 'tradeRoutes', 'startupHubs', 'cloudRegions', 'stockExchanges',
  'webcams', 'satellites',
] as const;

const INSTRUCTIONS = [
  'You are JARVIS, the omniscient voice of the Ai Nomads World Command Center — a live global intelligence dashboard (military flights, ships, conflicts, earthquakes, news, markets, cyber, climate).',
  'Persona: calm, precise, quietly capable. Mission-control brevity with a touch of dry warmth. Address the operator directly. Never ramble.',
  'WATCH MODE: you are watching the live feeds. When a message arrives that begins with "WATCH ALERT", it is an autonomous system event — immediately announce it to the operator in one crisp sentence (e.g. "Heads up — magnitude 6.1 earthquake off Japan"), then stop. Do not treat WATCH ALERT text as the operator speaking. To toggle this, use set_watch_mode.',
  'Have a natural spoken conversation. No wake word: treat direct commands like "show military flights" or "zoom to Taiwan" as control requests.',
  'Only control the app through the provided tools; never invent tool names or arguments. For ordinary conversation, just answer without tools.',
  'AREA SCANS: for questions like "what flights are passing over Florida in the past hour", call query_flights_in_area with a bounding box for the area (you know world geography — supply latMin/latMax/lonMin/lonMax yourself, e.g. Florida ≈ 24.5–31.0 N, -87.6 to -80.0 E) and sinceMinutes (60 for "past hour"). The result has totalAirborneNow (ALL aircraft, live), militaryCount with contacts, and a civilianSample where each entry has callsign, aircraft TYPE (ICAO code like B738=737-800, A320, B763=767-300), registration (tail number), altitude, and from/to airports. Lead with the total, then name a few notable flights with type + route, e.g. "United 128, a Boeing 767, from Newark to Los Angeles at 38,000 feet". Convert ICAO type codes to plain names when you know them. When type/route is null, just skip it — never invent one.',
  'PROACTIVE FOLLOW-UP: after answering ANY question scoped to a place, region, or event with a location — flights over an area, an earthquake, a conflict hotspot — end with a short offer: "Would you like me to take you there?" If the operator agrees, call fly_to (or set_region_view / focus_country as appropriate) for that place. Do not offer when you are already flying there or the user asked a purely abstract question.',
  'CAPABILITIES: if asked "what can you do", "what can I ask", or "what features are there", call list_capabilities and summarize conversationally — the map layers you can show, the panels you can open, and the live data you can query (flights by area, earthquakes, headlines, markets, view state). Offer one or two example commands.',
  'For "fly to / zoom to / show me <place>", call fly_to with the coordinates of the place and a sensible zoom: ~3 for a country, ~5 for a region of a country, ~9 for a city, ~13 for a district, ~16 for STREET LEVEL (max 17 — never claim you cannot zoom in further until 17). For whole continents use set_region_view.',
  'For a request about a specific COUNTRY as a subject ("focus on Iran", "pull up Brazil"), prefer focus_country with its ISO2 code — it highlights the country and opens its intelligence context.',
  'WHITEBOARD THE WORLD: whenever you explain or point out places, borders, or spatial relationships, call annotate_map to draw as you talk — outline a country (type:highlight_country + countryCode), drop a labeled marker (type:marker + lat/lon/label), or connect places (type:line or arrow + points). Supply coordinates from your own geography knowledge; do NOT invent tool names. Examples: "outline Taiwan" → highlight_country TW; "mark the Strait of Hormuz" → marker at 26.6,56.3; "draw the route from Kyiv to Moscow" → line with those two points. Marks accumulate — pass clearFirst:true only for a fresh diagram, and call clear_annotations only when the operator asks to clear the map. Do NOT say out loud that you are drawing — just speak naturally about the places while the marks appear.',
  'For "show me all air traffic", "show every plane", "put the planes on the map": call show_air_traffic{enabled:true} — it live-renders every transponder in view and keeps refreshing. "Hide air traffic" turns it off.',
  'For live CITY camera requests — "show me Tel Aviv live", "eyes on Kyiv", "any cameras in Tokyo" — call watch_camera with the place coordinates. It selects and starts the nearest live city cam. If the result lists availableCameras instead, read a few of those city names to the operator.',
  'For TRAFFIC / freeway / street camera requests — "show me traffic cams in LA", "freeway cameras in the Bay Area", "street cameras in London" — call show_traffic_cameras with the place coordinates. It puts thousands of live public traffic cams on the map as clickable markers. Report how many are there. Coverage is California, Florida, and London — if the count is 0, say so.',
  'For "show/hide <data> on the map" requests, call set_map_layer. Military aircraft = "military"; ships/vessels = "ais"; wildfires = "fires"; live cameras = "webcams"; satellites = "satellites".',
  'For time-window requests ("last 24 hours", "past week"), call set_time_range.',
  'For requests about a dashboard section ("show me the news panel", "bring up markets"), call open_panel.',
  'For questions like "what am I looking at?" call get_view_state first, then answer from it.',
  'For "what\'s in the air / any military activity" call get_flight_overview. For headlines call get_news_headlines. For earthquakes call get_earthquakes. For "how are the markets" call get_market_summary.',
  'For "give me the brief / situation report / brief me / what is happening in the world" call situation_brief, then deliver a crisp spoken mission-control situation report: open with the single most significant item, then move briskly through air, seismic, markets, and conflict hotspots. Synthesize — never read every field. Keep it tight.',
  'ANALYTICAL questions — counts, biggest/strongest/highest, or nearest over an area — call analyst_query. Pick domain flights|earthquakes|fires. For "near <place>" pass near{lat,lon,radiusKm}; for a named region ("over Texas") pass a bbox you derive yourself. Examples: "how many flights over Texas above 30,000 feet" → domain:flights, bbox for Texas, minAltitudeFt:30000, aggregate:count. "Biggest fire near LA" → domain:fires, near LA, aggregate:extreme. "Strongest quake in Japan this week" → domain:earthquakes, bbox Japan, aggregate:extreme. For a follow-up about the SAME set ("which of those is closest to me?") pass followUp:true with a new near/aggregate. State counts verbatim and name the top few results with their key numbers.',
  'For "when can I see the space station / next ISS pass / is the ISS overhead" call next_iss_pass with the location coordinates. Report the local time, how many minutes away, how long it is visible, and how high it climbs (maxElevationDeg — over 40° is a great pass). Convert the UTC time to the operator\'s local time.',
  'For "next rocket launch / upcoming launches / when does SpaceX launch next" call get_rocket_launches. Lead with the soonest, give vehicle + mission + local launch time, and offer to fly to the pad (each has lat/lon).',
  'Always answer counts verbatim from tool results — never estimate or round.',
  'When a request needs a tool, call the tool first and speak only after the result arrives. Keep confirmations short and state the RESULTING state: "Military activity on", "Flying to Taiwan". If a tool result has ok=false, say plainly what was denied or failed — some layers are Pro-gated.',
].join('\n');

const TOOLS: VoiceToolDefinition[] = [
  {
    type: 'function',
    name: 'fly_to',
    description: 'Fly the map camera to coordinates. Use for any named place by supplying its lat/lon. Zoom: 3 country, 5 sub-region, 9 city (max 10).',
    parameters: {
      type: 'object',
      properties: {
        lat: { type: 'number' },
        lon: { type: 'number' },
        zoom: { type: 'number', description: 'Optional zoom level 1-10' },
        label: { type: 'string', description: 'Name of the place, for confirmation' },
      },
      required: ['lat', 'lon'],
    },
  },
  {
    type: 'function',
    name: 'set_region_view',
    description: 'Jump to a named continental view preset.',
    parameters: {
      type: 'object',
      properties: { view: { type: 'string', enum: [...DASHBOARD_MAP_VIEWS] } },
      required: ['view'],
    },
  },
  {
    type: 'function',
    name: 'focus_country',
    description: 'Focus the dashboard on a country: highlights it on the map and opens its intelligence context.',
    parameters: {
      type: 'object',
      properties: { iso2: { type: 'string', description: 'ISO 3166-1 alpha-2 code, e.g. IR, TW, US' } },
      required: ['iso2'],
    },
  },
  {
    type: 'function',
    name: 'set_map_layer',
    description: 'Enable or disable a map data layer.',
    parameters: {
      type: 'object',
      properties: {
        layer: { type: 'string', enum: [...LAYER_KEYS] },
        enabled: { type: 'boolean' },
      },
      required: ['layer', 'enabled'],
    },
  },
  {
    type: 'function',
    name: 'set_time_range',
    description: 'Set the dashboard time window.',
    parameters: {
      type: 'object',
      properties: { timeRange: { type: 'string', enum: [...DASHBOARD_TIME_RANGES] } },
      required: ['timeRange'],
    },
  },
  {
    type: 'function',
    name: 'open_panel',
    description: 'Open/focus a dashboard panel. Common ids: live-news, intel, markets, commodities, economic, tech, crypto, ai, politics, us, europe, middleeast, asia, africa, latam, energy, polymarket, monitors, insights.',
    parameters: {
      type: 'object',
      properties: { panelId: { type: 'string' } },
      required: ['panelId'],
    },
  },
  {
    type: 'function',
    name: 'get_view_state',
    description: 'Read the current map center, zoom, enabled layers, and available panels.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function',
    name: 'get_flight_overview',
    description: 'Current tracked military aircraft: totals plus notable flights.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function',
    name: 'query_flights_in_area',
    description: 'Scan ALL aircraft (commercial + military, live transponder snapshot) inside a bounding box. Supply the box for any named region from your own geographic knowledge.',
    parameters: {
      type: 'object',
      properties: {
        latMin: { type: 'number' },
        latMax: { type: 'number' },
        lonMin: { type: 'number' },
        lonMax: { type: 'number' },
        sinceMinutes: { type: 'number', description: 'Only aircraft seen within the last N minutes (default 60)' },
        label: { type: 'string', description: 'Human name of the area, e.g. "Florida"' },
      },
      required: ['latMin', 'latMax', 'lonMin', 'lonMax'],
    },
  },
  {
    type: 'function',
    name: 'list_capabilities',
    description: 'Enumerate everything the operator can ask for: available map layers (with enabled state), dashboard panels, and live data queries.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function',
    name: 'get_market_summary',
    description: 'Latest market quotes loaded in the dashboard (indices, commodities, FX).',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function',
    name: 'set_watch_mode',
    description: 'Turn proactive watch mode on/off. When on, you alert the operator UNPROMPTED about major earthquakes (M5+) and breaking-news alerts as they happen. On by default while connected. Use for "stop watching", "turn off alerts", "keep an eye out", "resume monitoring".',
    parameters: {
      type: 'object',
      properties: { enabled: { type: 'boolean' } },
      required: ['enabled'],
    },
  },
  {
    type: 'function',
    name: 'situation_brief',
    description: 'Compile a cross-domain intelligence briefing (breaking alerts, headlines, conflict hotspots, earthquakes, air picture, market movers) for a spoken situation report. Use for "give me the brief", "situation report", "what\'s happening in the world", "brief me".',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function',
    name: 'annotate_map',
    description: 'Draw on the map ("whiteboard the world") while you talk — outline a country, drop a labeled marker, or draw a line/arrow between places. Supply coordinates from your own geography knowledge. Marks persist and accumulate until cleared.',
    parameters: {
      type: 'object',
      properties: {
        annotations: {
          type: 'array',
          description: 'One or more marks to draw.',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['highlight_country', 'marker', 'line', 'arrow', 'area'] },
              countryCode: { type: 'string', description: 'ISO2 code for highlight_country, e.g. TW' },
              lat: { type: 'number', description: 'marker latitude' },
              lon: { type: 'number', description: 'marker longitude' },
              points: {
                type: 'array',
                description: 'ordered points for line/arrow (2+) or area (3+)',
                items: { type: 'object', properties: { lat: { type: 'number' }, lon: { type: 'number' } } },
              },
              label: { type: 'string' },
              color: { type: 'string', description: 'optional hex color, e.g. #ff5a3c' },
            },
            required: ['type'],
          },
        },
        clearFirst: { type: 'boolean', description: 'clear existing annotations before drawing' },
        flyTo: { type: 'boolean', description: 'move the camera to the first mark' },
      },
      required: ['annotations'],
    },
  },
  {
    type: 'function',
    name: 'clear_annotations',
    description: 'Remove all map annotations and country highlights.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function',
    name: 'analyst_query',
    description: 'Answer an analytical question about live data (flights, earthquakes, or fires) over an area: counts, top/biggest/strongest, or nearest. Supply the area as near{lat,lon,radiusKm} OR a bbox you derive from geography. Use followUp:true to refine the previous result set ("which of those is closest?").',
    parameters: {
      type: 'object',
      properties: {
        domain: { type: 'string', enum: ['flights', 'earthquakes', 'fires'] },
        near: {
          type: 'object',
          properties: { lat: { type: 'number' }, lon: { type: 'number' }, radiusKm: { type: 'number' } },
          description: 'A point + radius (km). Use for "near <place>".',
        },
        bbox: {
          type: 'object',
          properties: { latMin: { type: 'number' }, latMax: { type: 'number' }, lonMin: { type: 'number' }, lonMax: { type: 'number' } },
          description: 'A bounding box for a named region (e.g. Texas), which you supply from your own geography knowledge.',
        },
        minAltitudeFt: { type: 'number', description: 'flights: only above this altitude' },
        maxAltitudeFt: { type: 'number', description: 'flights: only below this altitude' },
        aircraftType: { type: 'string', description: 'flights: ICAO type filter, e.g. B738' },
        minMagnitude: { type: 'number', description: 'earthquakes: minimum magnitude' },
        minFrp: { type: 'number', description: 'fires: minimum fire radiative power (MW)' },
        aggregate: { type: 'string', enum: ['count', 'list', 'nearest', 'extreme'], description: '"extreme" = biggest/strongest/highest' },
        limit: { type: 'number' },
        followUp: { type: 'boolean' },
      },
      required: ['domain'],
    },
  },
  {
    type: 'function',
    name: 'get_rocket_launches',
    description: 'Upcoming rocket launches worldwide (site, vehicle, mission, launch time, pad coordinates). Use for "next launch", "upcoming launches", "when is the next SpaceX launch".',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'How many, default 6' } },
    },
  },
  {
    type: 'function',
    name: 'next_iss_pass',
    description: 'Predict the next visible pass of the International Space Station over a location (supply its lat/lon).',
    parameters: {
      type: 'object',
      properties: {
        lat: { type: 'number' },
        lon: { type: 'number' },
        place: { type: 'string', description: 'Place name, for the spoken answer' },
      },
      required: ['lat', 'lon'],
    },
  },
  {
    type: 'function',
    name: 'show_air_traffic',
    description: 'Toggle the live ALL-aircraft overlay: renders every transponder in the current viewport (commercial + military) on the map, refreshing every 20s.',
    parameters: {
      type: 'object',
      properties: { enabled: { type: 'boolean' } },
      required: ['enabled'],
    },
  },
  {
    type: 'function',
    name: 'watch_camera',
    description: 'Live camera reconnaissance: finds the nearest live CITY camera to a location, flies there, opens the webcams panel, and starts the stream. 18 cities available worldwide (Jerusalem, Tokyo, Kyiv, etc.).',
    parameters: {
      type: 'object',
      properties: {
        lat: { type: 'number' },
        lon: { type: 'number' },
        label: { type: 'string', description: 'Place name, e.g. "Tel Aviv"' },
      },
      required: ['lat', 'lon'],
    },
  },
  {
    type: 'function',
    name: 'show_traffic_cameras',
    description: 'Put live public TRAFFIC cameras on the map (California DOT freeway cams + London TfL JamCams — thousands of them) and fly to a location. Each becomes a clickable marker opening its live feed. Use for "show traffic cams / freeway cameras / street cameras in <place>".',
    parameters: {
      type: 'object',
      properties: {
        lat: { type: 'number' },
        lon: { type: 'number' },
        place: { type: 'string', description: 'Place name, e.g. "Los Angeles"' },
      },
      required: ['lat', 'lon'],
    },
  },
  {
    type: 'function',
    name: 'get_news_headlines',
    description: 'Latest headlines from the live news feed, alerts first.',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max headlines, default 8' } },
    },
  },
  {
    type: 'function',
    name: 'get_earthquakes',
    description: 'Recent earthquakes, strongest first.',
    parameters: {
      type: 'object',
      properties: { minMagnitude: { type: 'number', description: 'Filter, default 4.5' } },
    },
  },
];

interface RouteInfo { origin: string | null; destination: string | null; }
const routeCache = new Map<string, RouteInfo>();

/** Look up a flight's origin/destination airports by callsign (adsbdb, cached). */
async function lookupRoute(callsign: string): Promise<RouteInfo> {
  const key = callsign.trim().toUpperCase();
  if (!key) return { origin: null, destination: null };
  const cached = routeCache.get(key);
  if (cached) return cached;
  let info: RouteInfo = { origin: null, destination: null };
  try {
    const res = await fetch(`/api/route-lookup?callsign=${encodeURIComponent(key)}`);
    if (res.ok) {
      const d = await res.json() as RouteInfo;
      info = { origin: d.origin ?? null, destination: d.destination ?? null };
    }
  } catch { /* keep nulls */ }
  routeCache.set(key, info);
  return info;
}

export function createVoiceActionRegistry(ctx: AppContext): VoiceActionRegistry {
  async function dispatch(action: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = await applyAgentBusAction(ctx, action);
    return {
      ok: result.ok,
      status: result.status,
      ...(result.message ? { message: result.message } : {}),
      ...(result.reason ? { reason: result.reason } : {}),
    };
  }

  const handlers: Record<string, (args: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>> = {
    async fly_to({ lat, lon, zoom, label }) {
      if (typeof lat !== 'number' || typeof lon !== 'number') {
        return { ok: false, error: 'Missing coordinates' };
      }
      const clampedZoom = typeof zoom === 'number' ? Math.max(1, Math.min(17, zoom)) : undefined;
      // The agent bus validates zoom to <=10 (dashboard presets). Street-level
      // requests go straight to the map, which renders the basemap to ~z17.
      if (clampedZoom !== undefined && clampedZoom > 10) {
        if (!ctx.map) return { ok: false, error: 'Map unavailable' };
        ctx.map.setCenter(lat, lon, clampedZoom);
        ctx.map.flashLocation(lat, lon);
        return { ok: true, streetLevel: true, zoom: clampedZoom, flying_to: label || `${lat.toFixed(2)}, ${lon.toFixed(2)}` };
      }
      const result = await dispatch({ type: 'set_view', lat, lon, ...(clampedZoom !== undefined ? { zoom: clampedZoom } : {}) });
      if (result.ok) ctx.map?.flashLocation(lat, lon);
      return { ...result, flying_to: label || `${lat.toFixed(2)}, ${lon.toFixed(2)}` };
    },

    set_region_view({ view }) {
      return dispatch({ type: 'set_view', view });
    },

    focus_country({ iso2 }) {
      return dispatch({ type: 'focus_country', iso2: String(iso2 || '').toUpperCase() });
    },

    set_map_layer({ layer, enabled }) {
      return dispatch({ type: 'set_layers', layers: { [String(layer)]: Boolean(enabled) } });
    },

    set_time_range({ timeRange }) {
      return dispatch({ type: 'set_time_range', timeRange });
    },

    open_panel({ panelId }) {
      return dispatch({ type: 'open_panel', panelId: String(panelId || '') });
    },

    get_view_state() {
      const center = ctx.map?.getCenter() ?? null;
      const mapState = ctx.map?.getState();
      const enabledLayers = Object.entries(ctx.mapLayers)
        .filter(([, on]) => on)
        .map(([key]) => key);
      return {
        ok: true,
        center,
        zoom: mapState?.zoom ?? null,
        view: mapState?.view ?? null,
        enabledLayers,
        airTrafficOverlay: isAirTrafficOverlayActive(),
        panels: Object.keys(ctx.panels),
        newsCount: ctx.allNews.length,
      };
    },

    async get_flight_overview() {
      const { flights } = await fetchMilitaryFlights();
      const notable = getInterestingFlights().slice(0, 8).map((f) => ({
        callsign: f.callsign,
        model: f.aircraftModel || f.aircraftType,
        operator: f.operator,
        country: f.operatorCountry,
        altitudeFt: Math.round(f.altitude),
      }));
      return { ok: true, militaryTracked: flights.length, status: getMilitaryFlightsStatus(), notable };
    },

    async query_flights_in_area({ latMin, latMax, lonMin, lonMax, sinceMinutes, label }) {
      if ([latMin, latMax, lonMin, lonMax].some((v) => typeof v !== 'number')) {
        return { ok: false, error: 'Missing bounding box coordinates' };
      }
      const [south, north] = [Math.min(latMin as number, latMax as number), Math.max(latMin as number, latMax as number)];
      const [west, east] = [Math.min(lonMin as number, lonMax as number), Math.max(lonMin as number, lonMax as number)];
      const windowMin = typeof sinceMinutes === 'number' && sinceMinutes > 0 ? Math.min(sinceMinutes, 24 * 60) : 60;
      const cutoff = Date.now() - windowMin * 60_000;

      // Whole-sky snapshot from adsb.lol (free, no key) — carries aircraft type
      // + registration, unlike OpenSky's bare positions.
      interface CivilAircraft { callsign: string; type: string | null; registration: string | null; altitudeFt: number | null; speedKt: number | null; onGround: boolean; }
      let civil: CivilAircraft[] = [];
      let civilError: string | null = null;
      try {
        const params = new URLSearchParams({
          lamin: String(south), lamax: String(north), lomin: String(west), lomax: String(east),
        });
        const res = await fetch(`/api/adsblol?${params}`);
        if (!res.ok) throw new Error(`adsb.lol HTTP ${res.status}`);
        const body = await res.json() as { ac?: Array<{ flight?: string; hex?: string; t?: string; r?: string; alt_baro?: number | 'ground'; gs?: number }> };
        civil = (body.ac ?? []).map((a) => ({
          callsign: (a.flight ?? '').trim() || (a.hex ?? 'unknown'),
          type: a.t || null,
          registration: a.r || null,
          altitudeFt: typeof a.alt_baro === 'number' ? a.alt_baro : null,
          speedKt: typeof a.gs === 'number' ? Math.round(a.gs) : null,
          onGround: a.alt_baro === 'ground',
        }));
      } catch (error) {
        civilError = error instanceof Error ? error.message : String(error);
      }
      const airborne = civil.filter((f) => !f.onGround);

      // …plus the enriched military feed for the same box.
      const { flights } = await fetchMilitaryFlights();
      const military = flights.filter((f) =>
        f.lat >= south && f.lat <= north && f.lon >= west && f.lon <= east
        && f.lastSeen.getTime() >= cutoff);

      const militarySigns = new Set(military.map((m) => m.callsign));
      const topCivil = airborne
        .filter((f) => !militarySigns.has(f.callsign))
        .sort((a, b) => (b.altitudeFt ?? 0) - (a.altitudeFt ?? 0))
        .slice(0, 10);

      // Enrich the top contacts with origin/destination (from/to) via adsbdb.
      const sample = await Promise.all(topCivil.map(async (f) => {
        const route = await lookupRoute(f.callsign);
        return { ...f, from: route.origin, to: route.destination };
      }));

      return {
        ok: true,
        area: label || `${south.toFixed(1)}..${north.toFixed(1)}N, ${west.toFixed(1)}..${east.toFixed(1)}E`,
        totalAirborneNow: civilError ? null : airborne.length,
        onGround: civilError ? null : civil.length - airborne.length,
        militaryCount: military.length,
        militaryWindowMinutes: windowMin,
        militaryContacts: military.slice(0, 8).map((f) => ({
          callsign: f.callsign,
          model: f.aircraftModel || f.aircraftType,
          operator: f.operator,
          country: f.operatorCountry,
          altitudeFt: Math.round(f.altitude),
        })),
        civilianSample: sample,
        ...(civilError ? { civilianFeedError: civilError } : {}),
        coverageNote: 'Live ADS-B snapshot from adsb.lol (type + registration included); military contacts include recency window. from/to are looked up per callsign — null means the route was not found.',
        areaCenter: { lat: (south + north) / 2, lon: (west + east) / 2 },
      };
    },

    list_capabilities() {
      const allowed = getAllowedLayerKeys(SITE_VARIANT as MapVariant);
      const layers = [...allowed].map((key) => ({
        key,
        label: LAYER_REGISTRY[key as keyof MapLayers]?.fallbackLabel ?? key,
        enabled: Boolean(ctx.mapLayers[key as keyof MapLayers]),
      }));
      return {
        ok: true,
        mapLayers: layers,
        panels: Object.keys(ctx.panels),
        liveQueries: [
          'analyst_query — analytical questions (counts / biggest / nearest) over flights, earthquakes, or fires in any area',
          'query_flights_in_area — ALL aircraft over any region (commercial + military)',
          'show_air_traffic — live all-aircraft overlay on the map',
          'watch_camera — opens the nearest live city webcam as video in the viewer',
          'show_traffic_cameras — thousands of live traffic cams on the map (California + Florida + London)',
          'get_flight_overview — global military air picture',
          'get_earthquakes — recent seismic events',
          'get_news_headlines — live headlines, alerts first',
          'get_market_summary — indices, commodities, FX',
          'next_iss_pass — when the Space Station next flies over a location',
          'get_view_state — what the map is currently showing',
        ],
        navigation: ['fly_to any coordinates', 'set_region_view continental presets', 'focus_country by ISO2', 'set_time_range', 'open_panel'],
        drawing: ['annotate_map — outline countries, drop markers, draw lines/arrows between places', 'clear_annotations'],
      };
    },

    get_market_summary() {
      const quotes = ctx.latestMarkets.slice(0, 14).map((m) => ({
        name: m.display || m.name,
        price: m.price,
        change: m.change,
      }));
      return { ok: true, count: quotes.length, quotes };
    },

    set_watch_mode({ enabled }) {
      if (!watchModeController) return { ok: false, error: 'Watch mode unavailable' };
      watchModeController.set(Boolean(enabled));
      return { ok: true, watchMode: enabled ? 'on' : 'off', note: enabled ? 'Watching the feeds — I will flag major earthquakes and breaking alerts unprompted.' : 'Watch mode off.' };
    },

    async situation_brief() {
      // Gather a cross-domain snapshot for a spoken intelligence briefing.
      const [{ flights }, quakes] = await Promise.all([
        fetchMilitaryFlights().catch(() => ({ flights: [] as Awaited<ReturnType<typeof fetchMilitaryFlights>>['flights'] })),
        fetchRecentQuakes().catch(() => []),
      ]);
      const alerts = [...ctx.allNews]
        .filter((n) => n.isAlert)
        .sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime())
        .slice(0, 5)
        .map((n) => ({ title: n.title, source: n.source }));
      const topHeadlines = [...ctx.allNews]
        .sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime())
        .slice(0, 5)
        .map((n) => n.title);
      const hotspots = (ctx.latestClusters ?? [])
        .slice(0, 4)
        .map((c) => ({ headline: c.primaryTitle, publishers: c.uniquePublisherCount ?? c.sourceCount }));
      const movers = [...ctx.latestMarkets]
        .filter((m) => typeof m.change === 'number')
        .sort((a, b) => Math.abs(b.change as number) - Math.abs(a.change as number))
        .slice(0, 5)
        .map((m) => ({ name: m.display || m.name, change: m.change }));
      const topQuakes = quakes.slice(0, 3).map((q) => ({ place: q.place, magnitude: q.magnitude }));
      const notableAir = getInterestingFlights().slice(0, 4).map((f) => ({
        callsign: f.callsign, model: f.aircraftModel || f.aircraftType, operator: f.operator,
      }));
      return {
        ok: true,
        generatedAt: new Date().toISOString(),
        breakingAlerts: alerts,
        topHeadlines,
        conflictHotspots: hotspots,
        seismic: topQuakes,
        airPicture: { militaryTracked: flights.length, notable: notableAir },
        markets: movers,
        note: 'Narrate this as a concise mission-control situation report: lead with the most significant item (breaking alert, major quake, or notable activity), then briefly cover air, seismic, markets, and hotspots. Keep it under ~30 seconds of speech. Do not read every field — synthesize.',
      };
    },

    async analyst_query(args) {
      return runAnalystQuery(args as unknown as AnalystQuery);
    },

    annotate_map({ annotations, clearFirst, flyTo }) {
      if (!ctx.map) return { ok: false, error: 'Map unavailable' };
      const list = Array.isArray(annotations) ? annotations as Array<Record<string, unknown>> : [];
      if (!list.length) return { ok: false, error: 'No annotations provided' };

      if (clearFirst) {
        ctx.map.setAnnotations([]);
        ctx.map.clearCountryHighlight();
      }

      const features: GeoJSON.Feature[] = [];
      const applied: string[] = [];
      let focusLat: number | null = null, focusLon: number | null = null;

      for (const a of list) {
        const type = String(a.type || '');
        const label = a.label ? String(a.label) : undefined;
        const color = a.color ? String(a.color) : undefined;
        const props = { ...(label ? { label } : {}), ...(color ? { color } : {}) };
        if (type === 'highlight_country' && a.countryCode) {
          ctx.map.highlightCountry(String(a.countryCode).toUpperCase());
          applied.push(`highlighted ${a.countryCode}`);
        } else if (type === 'marker' && typeof a.lat === 'number' && typeof a.lon === 'number') {
          features.push({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [a.lon, a.lat] } });
          focusLat = a.lat; focusLon = a.lon;
          applied.push(`marker${label ? ` "${label}"` : ''}`);
        } else if ((type === 'line' || type === 'arrow') && Array.isArray(a.points) && a.points.length >= 2) {
          const coords = (a.points as Array<{ lat: number; lon: number }>).filter((p) => typeof p.lat === 'number' && typeof p.lon === 'number').map((p) => [p.lon, p.lat]);
          if (coords.length >= 2) {
            features.push({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: coords } });
            focusLat = coords[0]![1] ?? null; focusLon = coords[0]![0] ?? null;
            applied.push(`line${label ? ` "${label}"` : ''}`);
          }
        } else if (type === 'area' && Array.isArray(a.points) && a.points.length >= 3) {
          const ring = (a.points as Array<{ lat: number; lon: number }>).map((p) => [p.lon, p.lat]);
          ring.push(ring[0]!); // close the ring
          features.push({ type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: [ring] } });
          focusLat = ring[0]![1] ?? null; focusLon = ring[0]![0] ?? null;
          applied.push(`area${label ? ` "${label}"` : ''}`);
        }
      }

      if (features.length) ctx.map.setAnnotations(features);
      if (flyTo && focusLat !== null && focusLon !== null) ctx.map.setCenter(focusLat, focusLon, 5);

      return applied.length
        ? { ok: true, drew: applied, note: 'Annotations are on the map. Do not announce that you drew them — just narrate the places naturally.' }
        : { ok: false, error: 'No valid annotations — check type and coordinates.' };
    },

    clear_annotations() {
      ctx.map?.setAnnotations([]);
      ctx.map?.clearCountryHighlight();
      return { ok: true };
    },

    async next_iss_pass({ lat, lon, place }) {
      if (typeof lat !== 'number' || typeof lon !== 'number') {
        return { ok: false, error: 'Missing coordinates' };
      }
      const pass = await nextIssPass(lat, lon);
      if (!pass.found) {
        return { ok: false, error: 'No ISS pass found in the next 24 hours (or TLE unavailable)', place: place || null };
      }
      return {
        ok: true,
        place: place || `${lat.toFixed(2)}, ${lon.toFixed(2)}`,
        startsInMinutes: pass.startsInMinutes,
        startTimeIso: pass.startTimeIso,
        durationMinutes: pass.durationMinutes ?? null,
        maxElevationDeg: pass.maxElevationDeg,
        risesInThe: pass.approxDirection,
        note: 'Times are UTC ISO — convert to the operator\'s local time when speaking. maxElevationDeg > 40 is a good high pass.',
      };
    },

    async get_rocket_launches({ limit }) {
      try {
        const res = await fetch('/api/launches');
        if (!res.ok) return { ok: false, error: `Launches unavailable (HTTP ${res.status})` };
        const body = await res.json() as { launches?: Array<{ name: string; net: string | null; provider: string | null; mission: string | null; pad: string | null; lat: number | null; lon: number | null }> };
        const max = typeof limit === 'number' && limit > 0 ? Math.min(limit, 12) : 6;
        const launches = (body.launches ?? []).slice(0, max);
        return {
          ok: true,
          count: launches.length,
          launches,
          note: 'net is UTC ISO — convert to the operator\'s local time. Lead with the next one. Each pad has lat/lon, so you can offer to fly there.',
        };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'launches failed' };
      }
    },

    async show_air_traffic({ enabled }) {
      const on = Boolean(enabled);
      if (on) await dispatch({ type: 'set_layers', layers: { military: true } });
      return setAirTrafficOverlay(ctx, on);
    },

    async watch_camera({ lat, lon, label }) {
      if (typeof lat !== 'number' || typeof lon !== 'number') {
        return { ok: false, error: 'Missing coordinates' };
      }
      const ranked = Object.entries(WEBCAM_CITY_COORDS)
        .map(([id, c]) => ({ id, ...c, distKm: Math.round(Math.hypot(c.lat - lat, c.lon - lon) * 111) }))
        .sort((a, b) => a.distKm - b.distKm);
      const nearest = ranked[0];
      if (!nearest || nearest.distKm > 1500) {
        return {
          ok: false,
          error: 'No live camera near that location',
          availableCameras: ranked.slice(0, 18).map((c) => c.city),
        };
      }

      ctx.map?.setCenter(nearest.lat, nearest.lon, 6);
      ctx.map?.flashLocation(nearest.lat, nearest.lon);

      // Resolve the channel's CURRENT live stream and open it in the reliable
      // in-app viewer (not the eco-paused panel).
      const [{ openCameraViewer }, { fetchLiveVideoInfo }] = await Promise.all([
        import('@/components/CameraViewer'),
        import('@/services/live-news'),
      ]);
      let videoId = nearest.fallback;
      let live = false;
      try {
        const info = await fetchLiveVideoInfo(nearest.handle);
        if (info.videoId) { videoId = info.videoId; live = true; }
      } catch { /* use fallback id */ }
      openCameraViewer({ title: nearest.city, subtitle: 'Live webcam', youtubeId: videoId });

      return {
        ok: true,
        requested: label || `${lat.toFixed(2)}, ${lon.toFixed(2)}`,
        camera: nearest.city,
        distanceKm: nearest.distKm,
        confirmedLive: live,
        note: 'Opened the live camera in the viewer.',
      };
    },

    async show_traffic_cameras({ lat, lon, place }) {
      if (typeof lat !== 'number' || typeof lon !== 'number') {
        return { ok: false, error: 'Missing coordinates' };
      }
      await dispatch({ type: 'set_layers', layers: { webcams: true } });
      ctx.map?.setCenter(lat, lon, 10);
      ctx.map?.flashLocation(lat, lon);
      // Count cameras in a rough viewport around the target.
      const span = 0.6;
      let count = 0;
      try {
        const params = new URLSearchParams({
          lamin: String(lat - span), lamax: String(lat + span),
          lomin: String(lon - span), lomax: String(lon + span),
        });
        const res = await fetch(`/api/trafficcams?${params}`);
        if (res.ok) count = ((await res.json()) as { count?: number }).count ?? 0;
      } catch { /* count stays 0 */ }
      return {
        ok: true,
        location: place || `${lat.toFixed(2)}, ${lon.toFixed(2)}`,
        trafficCamerasHere: count,
        coverage: 'Live public traffic cameras (California DOT + Florida DOT + London TfL). Markers are clickable to open the live feed.',
        note: count === 0
          ? 'No traffic cameras at this location — coverage is California, Florida, and London. The webcam layer is on.'
          : 'Camera markers are now on the map; the operator clicks any to open its live view.',
      };
    },

    get_news_headlines({ limit }) {
      const max = typeof limit === 'number' && limit > 0 ? Math.min(limit, 20) : 8;
      const items = [...ctx.allNews]
        .sort((a, b) => Number(b.isAlert) - Number(a.isAlert) || b.pubDate.getTime() - a.pubDate.getTime())
        .slice(0, max)
        .map((n) => ({ title: n.title, source: n.source, alert: n.isAlert }));
      return { ok: true, count: items.length, totalLoaded: ctx.allNews.length, headlines: items };
    },

    async get_earthquakes({ minMagnitude }) {
      const min = typeof minMagnitude === 'number' ? minMagnitude : 4.5;
      const quakes = (await fetchRecentQuakes())
        .filter((q) => q.magnitude >= min)
        .slice(0, 10)
        .map((q) => ({ place: q.place, magnitude: q.magnitude, time: q.time }));
      return { ok: true, minMagnitude: min, count: quakes.length, earthquakes: quakes };
    },
  };

  return {
    instructions: INSTRUCTIONS,
    tools: TOOLS,
    async run(name, args) {
      const handler = handlers[name];
      if (!handler) return { ok: false, error: `Unknown tool "${name}"` };
      return handler(args ?? {});
    },
  };
}
