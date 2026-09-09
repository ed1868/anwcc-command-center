// Analyst engine for the voice agent: natural-language analytical queries over
// live data (flights, earthquakes, fires). Fetches the domain data for a
// spatial scope, applies filters, and computes an aggregation (count / list /
// nearest / extreme). Keeps the last result set so follow-ups ("which of those
// is closest?") refine it instead of re-fetching.

import { fetchRecentQuakes } from './usgs-quakes';

export type AnalystDomain = 'flights' | 'earthquakes' | 'fires';
export type AnalystAggregate = 'count' | 'list' | 'nearest' | 'extreme';

export interface AnalystQuery {
  domain: AnalystDomain;
  near?: { lat: number; lon: number; radiusKm?: number };
  bbox?: { latMin: number; latMax: number; lonMin: number; lonMax: number };
  minAltitudeFt?: number;
  maxAltitudeFt?: number;
  aircraftType?: string;
  minMagnitude?: number;
  minFrp?: number;
  aggregate?: AnalystAggregate;
  limit?: number;
  followUp?: boolean;
}

interface AnalystItem {
  label: string;
  lat: number;
  lon: number;
  rank: number; // domain's "importance" value: altitude / magnitude / frp
  detail: Record<string, unknown>;
}

interface LastResult { domain: AnalystDomain; scopeLabel: string; center: { lat: number; lon: number } | null; items: AnalystItem[]; }

let lastResult: LastResult | null = null;

function resolveBbox(q: AnalystQuery): { south: number; north: number; west: number; east: number; center: { lat: number; lon: number } | null } | null {
  if (q.bbox) {
    const { latMin, latMax, lonMin, lonMax } = q.bbox;
    return {
      south: Math.min(latMin, latMax), north: Math.max(latMin, latMax),
      west: Math.min(lonMin, lonMax), east: Math.max(lonMin, lonMax),
      center: { lat: (latMin + latMax) / 2, lon: (lonMin + lonMax) / 2 },
    };
  }
  if (q.near) {
    const r = q.near.radiusKm ?? 200;
    const dLat = r / 111;
    const dLon = r / (111 * Math.max(0.1, Math.cos((q.near.lat * Math.PI) / 180)));
    return {
      south: q.near.lat - dLat, north: q.near.lat + dLat,
      west: q.near.lon - dLon, east: q.near.lon + dLon,
      center: { lat: q.near.lat, lon: q.near.lon },
    };
  }
  return null;
}

function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  return Math.round(Math.hypot((a.lat - b.lat) * 111, (a.lon - b.lon) * 111 * Math.cos((a.lat * Math.PI) / 180)));
}

async function fetchFlights(box: { south: number; north: number; west: number; east: number }, q: AnalystQuery): Promise<AnalystItem[]> {
  const params = new URLSearchParams({ lamin: String(box.south), lamax: String(box.north), lomin: String(box.west), lomax: String(box.east) });
  const res = await fetch(`/api/adsblol?${params}`);
  if (!res.ok) return [];
  const body = await res.json() as { ac?: Array<{ flight?: string; hex?: string; t?: string; r?: string; alt_baro?: number | 'ground'; gs?: number; lat?: number; lon?: number }> };
  return (body.ac ?? [])
    .filter((a) => typeof a.lat === 'number' && typeof a.lon === 'number' && a.alt_baro !== 'ground')
    .map((a) => {
      const altFt = typeof a.alt_baro === 'number' ? a.alt_baro : 0;
      return {
        label: (a.flight ?? '').trim() || a.hex || 'unknown',
        lat: a.lat!, lon: a.lon!, rank: altFt,
        detail: { type: a.t ?? null, registration: a.r ?? null, altitudeFt: altFt, speedKt: typeof a.gs === 'number' ? Math.round(a.gs) : null },
      };
    })
    .filter((it) => (q.minAltitudeFt == null || it.rank >= q.minAltitudeFt)
      && (q.maxAltitudeFt == null || it.rank <= q.maxAltitudeFt)
      && (q.aircraftType == null || String((it.detail.type ?? '')).toUpperCase().includes(q.aircraftType.toUpperCase())));
}

async function fetchQuakes(box: { south: number; north: number; west: number; east: number }, q: AnalystQuery): Promise<AnalystItem[]> {
  const quakes = await fetchRecentQuakes();
  return quakes
    .filter((e) => e.lat >= box.south && e.lat <= box.north && e.lon >= box.west && e.lon <= box.east
      && (q.minMagnitude == null || e.magnitude >= q.minMagnitude))
    .map((e) => ({
      label: e.place, lat: e.lat, lon: e.lon, rank: e.magnitude,
      detail: { magnitude: e.magnitude, depthKm: e.depthKm, time: e.time },
    }));
}

async function fetchFires(box: { south: number; north: number; west: number; east: number }, q: AnalystQuery): Promise<AnalystItem[]> {
  const res = await fetch(`/api/wildfire/v1/list-fire-detections?bound_w=${box.west}&bound_s=${box.south}&bound_e=${box.east}&bound_n=${box.north}`);
  if (!res.ok) return [];
  const body = await res.json() as { fireDetections?: Array<{ location?: { latitude?: number; longitude?: number }; brightness?: number; frp?: number; region?: string; confidence?: string }> };
  return (body.fireDetections ?? [])
    .filter((f) => typeof f.location?.latitude === 'number' && typeof f.location?.longitude === 'number'
      && f.location.latitude >= box.south && f.location.latitude <= box.north
      && f.location.longitude >= box.west && f.location.longitude <= box.east
      && (q.minFrp == null || (f.frp ?? 0) >= q.minFrp))
    .map((f) => ({
      label: f.region || 'fire detection', lat: f.location!.latitude!, lon: f.location!.longitude!, rank: f.frp ?? f.brightness ?? 0,
      detail: { frpMW: f.frp ?? null, brightnessK: f.brightness ?? null, confidence: f.confidence ?? null },
    }));
}

const RANK_NAME: Record<AnalystDomain, string> = { flights: 'altitude (ft)', earthquakes: 'magnitude', fires: 'fire power (MW)' };

export async function runAnalystQuery(q: AnalystQuery): Promise<Record<string, unknown>> {
  const box = resolveBbox(q);
  if (!box && !(q.followUp && lastResult)) {
    return { ok: false, error: 'Provide a location (near lat/lon) or a bounding box.' };
  }

  let items: AnalystItem[];
  let center: { lat: number; lon: number } | null;
  let scopeLabel: string;

  if (q.followUp && lastResult && lastResult.domain === q.domain) {
    items = lastResult.items;
    center = box?.center ?? lastResult.center;
    scopeLabel = lastResult.scopeLabel;
  } else if (box) {
    if (q.domain === 'flights') items = await fetchFlights(box, q);
    else if (q.domain === 'earthquakes') items = await fetchQuakes(box, q);
    else items = await fetchFires(box, q);
    center = box.center;
    scopeLabel = q.near ? `within ${q.near.radiusKm ?? 200} km of ${q.near.lat.toFixed(2)}, ${q.near.lon.toFixed(2)}` : 'in the requested area';
  } else {
    return { ok: false, error: 'No scope available for follow-up.' };
  }

  lastResult = { domain: q.domain, scopeLabel, center, items };

  const aggregate = q.aggregate ?? 'count';
  const limit = Math.min(q.limit ?? 5, 15);

  const withDistance = center
    ? items.map((it) => ({ ...it, distanceKm: distanceKm(center!, it) }))
    : items.map((it) => ({ ...it, distanceKm: null as number | null }));

  const base = { ok: true, domain: q.domain, scope: scopeLabel, total: items.length, rankedBy: RANK_NAME[q.domain] };

  if (aggregate === 'count') return base;

  if (aggregate === 'nearest') {
    const sorted = [...withDistance].filter((i) => i.distanceKm != null).sort((a, b) => (a.distanceKm! - b.distanceKm!));
    return { ...base, aggregate, results: sorted.slice(0, limit).map((i) => ({ name: i.label, distanceKm: i.distanceKm, ...i.detail })) };
  }

  // 'extreme' (strongest/highest/biggest) and 'list' both sort by rank desc.
  const sorted = [...withDistance].sort((a, b) => b.rank - a.rank);
  return {
    ...base,
    aggregate,
    results: sorted.slice(0, limit).map((i) => ({ name: i.label, ...(i.distanceKm != null ? { distanceKm: i.distanceKm } : {}), ...i.detail })),
  };
}
