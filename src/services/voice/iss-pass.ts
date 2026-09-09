// ISS overhead-pass prediction for the voice agent. Fetches the ISS TLE (via
// the /api/iss-tle proxy → CelesTrak) and propagates it with satellite.js to
// find the next time the station rises above the horizon for a location.

import * as satellite from 'satellite.js';

export interface IssPass {
  found: boolean;
  startsInMinutes?: number;
  startTimeIso?: string;
  durationMinutes?: number;
  maxElevationDeg?: number;
  approxDirection?: string;
}

const HORIZON_DEG = 10; // usable-visibility threshold
const STEP_SECONDS = 30;
const SEARCH_HOURS = 24;

let tleCache: { line1: string; line2: string; fetchedAt: number } | null = null;

async function getIssTle(): Promise<{ line1: string; line2: string } | null> {
  if (tleCache && Date.now() - tleCache.fetchedAt < 30 * 60_000) return tleCache;
  try {
    const res = await fetch('/api/iss-tle');
    if (!res.ok) return null;
    const d = await res.json() as { line1?: string; line2?: string; error?: string };
    if (!d.line1 || !d.line2) return null;
    tleCache = { line1: d.line1, line2: d.line2, fetchedAt: Date.now() };
    return tleCache;
  } catch {
    return null;
  }
}

function compassFromAzimuth(azDeg: number): string {
  const dirs = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
  return dirs[Math.round(((azDeg % 360) / 45)) % 8]!;
}

/** Next ISS pass over (lat, lon). Elevation must exceed HORIZON_DEG to count. */
export async function nextIssPass(lat: number, lon: number): Promise<IssPass> {
  const tle = await getIssTle();
  if (!tle) return { found: false };

  const satrec = satellite.twoline2satrec(tle.line1, tle.line2);
  const observer = {
    latitude: satellite.degreesToRadians(lat),
    longitude: satellite.degreesToRadians(lon),
    height: 0.05, // km above ellipsoid; ground level is fine for pass timing
  };

  const start = Date.now();
  let riseAt: number | null = null;
  let maxEl = -90;
  let maxElAz = 0;

  for (let sec = 0; sec <= SEARCH_HOURS * 3600; sec += STEP_SECONDS) {
    const t = new Date(start + sec * 1000);
    const pv = satellite.propagate(satrec, t);
    if (!pv || typeof pv.position === 'boolean' || !pv.position) continue;
    const gmst = satellite.gstime(t);
    const ecf = satellite.eciToEcf(pv.position, gmst);
    const look = satellite.ecfToLookAngles(observer, ecf);
    const elDeg = satellite.radiansToDegrees(look.elevation);

    if (elDeg >= HORIZON_DEG) {
      if (riseAt === null) riseAt = sec;
      if (elDeg > maxEl) {
        maxEl = elDeg;
        maxElAz = satellite.radiansToDegrees(look.azimuth);
      }
    } else if (riseAt !== null) {
      // Pass ended — return the first complete one.
      return {
        found: true,
        startsInMinutes: Math.round(riseAt / 60),
        startTimeIso: new Date(start + riseAt * 1000).toISOString(),
        durationMinutes: Math.round((sec - riseAt) / 60),
        maxElevationDeg: Math.round(maxEl),
        approxDirection: compassFromAzimuth(maxElAz),
      };
    }
  }

  // A pass in progress at the end of the window, or none found.
  if (riseAt !== null) {
    return {
      found: true,
      startsInMinutes: Math.round(riseAt / 60),
      startTimeIso: new Date(start + riseAt * 1000).toISOString(),
      maxElevationDeg: Math.round(maxEl),
      approxDirection: compassFromAzimuth(maxElAz),
    };
  }
  return { found: false };
}
