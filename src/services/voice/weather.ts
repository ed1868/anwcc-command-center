// Weather & storms for the voice agent (via the /api/weather proxy):
// NHC active tropical cyclones, NWS severe-weather alerts, Open-Meteo current.

export interface ActiveStorm {
  name: string;
  classification: string; // TD / TS / HU
  category: string | null;
  windKt: number | null;
  lat: number | null;
  lon: number | null;
  movement: string | null;
  pressureMb: number | null;
  basin: string | null;
}

const WMO: Record<number, string> = {
  0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'fog', 48: 'freezing fog', 51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 71: 'light snow', 73: 'snow', 75: 'heavy snow',
  80: 'rain showers', 81: 'rain showers', 82: 'violent rain showers',
  95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'severe thunderstorm with hail',
};

function classify(c: string): string {
  const t = (c || '').toUpperCase();
  if (t === 'HU') return 'Hurricane';
  if (t === 'TS') return 'Tropical Storm';
  if (t === 'TD') return 'Tropical Depression';
  if (t === 'STS') return 'Severe Tropical Storm';
  if (t === 'TY') return 'Typhoon';
  return c || 'Cyclone';
}

export async function fetchActiveStorms(): Promise<ActiveStorm[]> {
  try {
    const r = await fetch('/api/weather?kind=storms');
    if (!r.ok) return [];
    const d = await r.json() as { activeStorms?: Array<Record<string, unknown>> };
    return (d.activeStorms ?? []).map((s) => ({
      name: String(s.name ?? 'Unnamed'),
      classification: classify(String(s.classification ?? '')),
      category: s.category != null ? String(s.category) : null,
      windKt: typeof s.intensity === 'string' ? Number(s.intensity) : (typeof s.intensity === 'number' ? s.intensity : null),
      lat: s.latitudeNumeric != null ? Number(s.latitudeNumeric) : null,
      lon: s.longitudeNumeric != null ? Number(s.longitudeNumeric) : null,
      movement: s.movementDir != null && s.movementSpeed != null ? `${s.movementDir} at ${s.movementSpeed} kt` : null,
      pressureMb: s.pressure != null ? Number(s.pressure) : null,
      basin: s.basin != null ? String(s.basin) : null,
    }));
  } catch {
    return [];
  }
}

export async function fetchWeatherAlerts(lat: number, lon: number): Promise<Array<{ event: string; severity: string; headline: string; area: string }>> {
  try {
    const r = await fetch(`/api/weather?kind=alerts&lat=${lat}&lon=${lon}`);
    if (!r.ok) return [];
    const d = await r.json() as { features?: Array<{ properties?: { event?: string; severity?: string; headline?: string; areaDesc?: string } }> };
    return (d.features ?? []).slice(0, 8).map((f) => ({
      event: f.properties?.event ?? 'Alert',
      severity: f.properties?.severity ?? 'Unknown',
      headline: f.properties?.headline ?? '',
      area: f.properties?.areaDesc ?? '',
    }));
  } catch {
    return [];
  }
}

export async function fetchCurrentWeather(lat: number, lon: number): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(`/api/weather?kind=current&lat=${lat}&lon=${lon}`);
    if (!r.ok) return null;
    const d = await r.json() as { current?: Record<string, number> };
    const c = d.current;
    if (!c) return null;
    return {
      temperatureF: Math.round(c.temperature_2m),
      feelsLikeF: Math.round(c.apparent_temperature),
      humidityPct: c.relative_humidity_2m,
      windKt: Math.round(c.wind_speed_10m),
      gustKt: Math.round(c.wind_gusts_10m),
      conditions: WMO[c.weather_code] ?? `code ${c.weather_code}`,
    };
  } catch {
    return null;
  }
}
