// adsb.lol — free, no-key community ADS-B aggregator. Primary live-position
// source: broader coverage than OpenSky's metered tier, and its records carry
// aircraft type + registration (surfaced to the voice agent via a separate
// proxy; PositionSample itself is a fixed proto shape). Queried by radius, so a
// viewport bbox is converted to centre + nautical-mile radius (capped at 250nm,
// the API max).

import type { PositionSample } from '../../../../src/generated/server/worldmonitor/aviation/v1/service_server';

interface AdsbLolAircraft {
  hex?: string;
  flight?: string;
  lat?: number;
  lon?: number;
  alt_baro?: number | 'ground';
  gs?: number;
  track?: number;
  baro_rate?: number;
  t?: string;   // ICAO type code, e.g. B763
  r?: string;   // registration / tail number
}

function bboxToRadiusNm(swLat: number, swLon: number, neLat: number, neLon: number): { lat: number; lon: number; nm: number } {
  const lat = (swLat + neLat) / 2;
  const lon = (swLon + neLon) / 2;
  const midRad = (lat * Math.PI) / 180;
  const latSpanKm = Math.abs(neLat - swLat) * 111;
  const lonSpanKm = Math.abs(neLon - swLon) * 111 * Math.cos(midRad);
  const halfDiagKm = 0.5 * Math.hypot(latSpanKm, lonSpanKm);
  const nm = Math.min(250, Math.max(10, Math.round(halfDiagKm / 1.852)));
  return { lat, lon, nm };
}

function toPositionSample(a: AdsbLolAircraft): PositionSample | null {
  if (typeof a.lat !== 'number' || typeof a.lon !== 'number' || !a.hex) return null;
  const onGround = a.alt_baro === 'ground';
  const altFt = typeof a.alt_baro === 'number' ? a.alt_baro : 0;
  return {
    icao24: a.hex,
    callsign: (a.flight ?? '').trim(),
    lat: a.lat,
    lon: a.lon,
    altitudeM: altFt * 0.3048,
    groundSpeedKts: typeof a.gs === 'number' ? a.gs : 0,
    trackDeg: typeof a.track === 'number' ? a.track : 0,
    verticalRate: typeof a.baro_rate === 'number' ? a.baro_rate : 0,
    onGround,
    // Closest existing proto enum value — this IS ADS-B position data. Adding a
    // dedicated ADSBLOL enum would require regenerating the protobufs.
    source: 'POSITION_SOURCE_OPENSKY',
    observedAt: Date.now(),
  };
}

/** Fetch live positions for a bbox from adsb.lol. Returns [] on any failure. */
export async function fetchAdsbLolBbox(
  swLat: number, swLon: number, neLat: number, neLon: number,
): Promise<PositionSample[]> {
  const { lat, lon, nm } = bboxToRadiusNm(swLat, swLon, neLat, neLon);
  try {
    const res = await fetch(`https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${nm}`, {
      // adsb.lol 403s requests without a descriptive User-Agent.
      headers: { Accept: 'application/json', 'User-Agent': 'worldmonitor-selfhost/1.0' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const data = await res.json() as { ac?: AdsbLolAircraft[] };
    return (data.ac ?? [])
      .map(toPositionSample)
      .filter((p): p is PositionSample => p !== null);
  } catch {
    return [];
  }
}
