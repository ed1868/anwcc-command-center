// Recent earthquakes straight from USGS (free, no key, CORS-open). The app's
// own seismology layer reads a Redis-seeded RPC that's empty on a local box, so
// the voice agent fetches USGS directly for reliable data.

export interface QuakeRecord {
  place: string;
  magnitude: number;
  lat: number;
  lon: number;
  depthKm: number;
  time: string;
}

let cache: { records: QuakeRecord[]; at: number } | null = null;
const CACHE_MS = 2 * 60_000;

/** M2.5+ earthquakes in the last 24h, strongest first. */
export async function fetchRecentQuakes(): Promise<QuakeRecord[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.records;
  try {
    const res = await fetch('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson');
    if (!res.ok) return cache?.records ?? [];
    const data = await res.json() as { features?: Array<{ properties?: { mag?: number; place?: string; time?: number }; geometry?: { coordinates?: number[] } }> };
    const records: QuakeRecord[] = (data.features ?? [])
      .map((f) => {
        const c = f.geometry?.coordinates;
        if (!c || typeof c[0] !== 'number' || typeof c[1] !== 'number') return null;
        return {
          place: f.properties?.place ?? 'unknown',
          magnitude: f.properties?.mag ?? 0,
          lon: c[0], lat: c[1], depthKm: typeof c[2] === 'number' ? c[2] : 0,
          time: f.properties?.time ? new Date(f.properties.time).toISOString() : '',
        };
      })
      .filter((r): r is QuakeRecord => r !== null)
      .sort((a, b) => b.magnitude - a.magnitude);
    cache = { records, at: Date.now() };
    return records;
  } catch {
    return cache?.records ?? [];
  }
}
