// Direct OpenSky access (OAuth client-credentials) for local dev and any
// deployment without a Wingbits/OpenSky relay. Uses OPENSKY_CLIENT_ID/SECRET.
// This is the fallback the bbox tracker calls when getRelayBaseUrl() is null.

import type { PositionSample } from '../../../../src/generated/server/worldmonitor/aviation/v1/service_server';

let cachedToken: { value: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string | null> {
  const id = process.env.OPENSKY_CLIENT_ID;
  const secret = process.env.OPENSKY_CLIENT_SECRET;
  if (!id || !secret) return null;
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) return cachedToken.value;
  try {
    const res = await fetch(
      'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }),
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (!res.ok) return null;
    const body = await res.json() as { access_token?: string; expires_in?: number };
    if (!body.access_token) return null;
    cachedToken = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 1800) * 1000 };
    return cachedToken.value;
  } catch {
    return null;
  }
}

function parseStates(states: unknown[][]): PositionSample[] {
  const now = Date.now();
  return states
    .filter((s) => Array.isArray(s) && s[5] != null && s[6] != null)
    .map((s): PositionSample => ({
      icao24: String(s[0] ?? ''),
      callsign: String(s[1] ?? '').trim(),
      lat: Number(s[6]),
      lon: Number(s[5]),
      altitudeM: Number(s[7] ?? 0),
      groundSpeedKts: Number(s[9] ?? 0) * 1.944,
      trackDeg: Number(s[10] ?? 0),
      verticalRate: Number(s[11] ?? 0),
      onGround: Boolean(s[8]),
      source: 'POSITION_SOURCE_OPENSKY',
      observedAt: Number(s[4] ?? now / 1000) * 1000,
    }));
}

/** Fetch live positions in a bbox straight from OpenSky. Returns [] on any failure. */
export async function fetchOpenSkyBboxDirect(
  swLat: number, swLon: number, neLat: number, neLon: number,
): Promise<PositionSample[]> {
  const token = await getAccessToken();
  if (!token) return [];
  try {
    const url = new URL('https://opensky-network.org/api/states/all');
    url.searchParams.set('lamin', String(swLat));
    url.searchParams.set('lomin', String(swLon));
    url.searchParams.set('lamax', String(neLat));
    url.searchParams.set('lomax', String(neLon));
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const data = await res.json() as { states?: unknown[][] };
    return parseStates(data.states ?? []);
  } catch {
    return [];
  }
}
