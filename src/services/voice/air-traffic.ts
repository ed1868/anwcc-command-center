// Live all-aircraft overlay for the voice agent. While enabled, periodically
// fetches every transponder in the current viewport from /api/opensky and
// renders civil traffic through the map's existing military-flight pipeline
// (render-only: military analytics read the military service, not the map).
// The app's own military refresh may briefly repaint military-only between
// our ticks; the next tick restores the full picture.

import type { AppContext } from '@/app/app-context';
import type { MilitaryFlight } from '@/types';
import { fetchMilitaryFlights } from '@/services/military-flights';

const REFRESH_MS = 20_000;
const MAX_RENDERED = 500;

let timer: ReturnType<typeof setInterval> | null = null;
let refreshing = false;

export function isAirTrafficOverlayActive(): boolean {
  return timer !== null;
}

function viewportBbox(ctx: AppContext): { south: number; north: number; west: number; east: number } | null {
  const center = ctx.map?.getCenter();
  const zoom = ctx.map?.getState()?.zoom ?? 2;
  if (!center) return null;
  // Approximate viewport span from zoom (web-mercator-ish; generous margins).
  const lonSpan = Math.min(160, 360 / Math.pow(2, zoom - 1));
  const latSpan = lonSpan * 0.55;
  return {
    south: Math.max(-85, center.lat - latSpan / 2),
    north: Math.min(85, center.lat + latSpan / 2),
    west: Math.max(-179.9, center.lon - lonSpan / 2),
    east: Math.min(179.9, center.lon + lonSpan / 2),
  };
}

function toRenderableFlight(s: Array<unknown>): MilitaryFlight | null {
  const lat = s[6];
  const lon = s[5];
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;
  const icao24 = String(s[0] ?? '');
  return {
    id: `adsb-${icao24}`,
    source: 'opensky-live',
    callsign: String(s[1] ?? '').trim() || icao24,
    hexCode: icao24,
    aircraftType: 'unknown',
    operator: 'other',
    operatorCountry: String(s[2] ?? ''),
    lat,
    lon,
    altitude: typeof s[7] === 'number' ? s[7] * 3.28084 : 0,
    heading: typeof s[10] === 'number' ? s[10] : 0,
    speed: typeof s[9] === 'number' ? s[9] * 1.94384 : 0,
    onGround: Boolean(s[8]),
    lastSeen: new Date(),
    confidence: 'low',
    note: 'Civil traffic (live ADS-B overlay)',
  };
}

async function refresh(ctx: AppContext): Promise<{ rendered: number } | { error: string }> {
  if (refreshing) return { rendered: 0 };
  refreshing = true;
  try {
    const bbox = viewportBbox(ctx);
    if (!bbox || !ctx.map) return { error: 'Map unavailable' };
    const params = new URLSearchParams({
      lamin: String(bbox.south), lamax: String(bbox.north),
      lomin: String(bbox.west), lomax: String(bbox.east),
    });
    const res = await fetch(`/api/opensky?${params}`);
    if (!res.ok) return { error: `OpenSky HTTP ${res.status}` };
    const body = await res.json() as { states?: Array<Array<unknown>> };

    const { flights: military } = await fetchMilitaryFlights();
    const militaryHexes = new Set(military.map((m) => m.hexCode));
    const civil = (body.states ?? [])
      .map(toRenderableFlight)
      .filter((f): f is MilitaryFlight => f !== null && !f.onGround && !militaryHexes.has(f.hexCode))
      .sort((a, b) => b.altitude - a.altitude)
      .slice(0, MAX_RENDERED);

    ctx.map.setMilitaryFlights([...military, ...civil], []);
    return { rendered: civil.length + military.length };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  } finally {
    refreshing = false;
  }
}

export async function setAirTrafficOverlay(ctx: AppContext, enabled: boolean): Promise<Record<string, unknown>> {
  if (!enabled) {
    if (timer) clearInterval(timer);
    timer = null;
    // Restore the military-only picture.
    const { flights } = await fetchMilitaryFlights();
    ctx.map?.setMilitaryFlights(flights, []);
    return { ok: true, airTraffic: 'off' };
  }
  if (!timer) {
    timer = setInterval(() => { void refresh(ctx); }, REFRESH_MS);
  }
  const first = await refresh(ctx);
  if ('error' in first) {
    if (timer) clearInterval(timer);
    timer = null;
    return { ok: false, error: first.error };
  }
  return {
    ok: true,
    airTraffic: 'on',
    aircraftRendered: first.rendered,
    note: 'Overlay refreshes every 20s for the current viewport; pan/zoom is picked up on the next tick.',
  };
}
