// Curated live city webcams (verified-live YouTube channels) as map markers.
// Rendered through the webcams layer; clicking a marker opens the channel's
// CURRENT live stream in the CameraViewer (see DeckGLMap.showWebcamClickPopup).
// Shared by the map feed and the voice agent's watch_camera.

import type { WebcamEntry } from '@/generated/client/worldmonitor/webcam/v1/service_client';

export interface CityCam { id: string; city: string; lat: number; lon: number; handle: string; fallback: string; }

export const CITY_CAMS: CityCam[] = [
  { id: 'kyiv', city: 'Kyiv / DW Live', lat: 50.45, lon: 30.52, handle: '@DWNews', fallback: 'LuKwFajn37U' },
  { id: 'italy', city: 'Italy (SkylineWebcams)', lat: 41.90, lon: 12.50, handle: '@SkylineWebcams', fallback: 'kUfuwa8mDrA' },
  { id: 'nyc', city: 'Times Square, NYC', lat: 40.76, lon: -73.98, handle: '@EarthCam', fallback: 'qbsgcchN2-Y' },
  { id: 'chicago', city: 'Chicago', lat: 41.88, lon: -87.63, handle: '@abc7chicago', fallback: 'sj2cWegO1OU' },
  { id: 'miami', city: 'Miami (Local 10)', lat: 25.76, lon: -80.19, handle: '@WPLGLocal10', fallback: 'Rr387XjUXCY' },
  { id: 'key-west', city: 'Key West, FL', lat: 24.56, lon: -81.78, handle: '@SloppyJoesBarKeyWest', fallback: 'rbMK4p6zUwI' },
  { id: 'taipei', city: 'Taipei', lat: 25.03, lon: 121.57, handle: '@JackyWuTaipei', fallback: 'z_fY1pj1VBw' },
  { id: 'tokyo', city: 'Tokyo (ANN News)', lat: 35.68, lon: 139.69, handle: '@ANNnewsCH', fallback: 'ZRiZsmMf4uY' },
  { id: 'sydney', city: 'Sydney', lat: -33.87, lon: 151.21, handle: '@WebcamSydney', fallback: '7pcL-0Wo77U' },
];

const byWebcamId = new Map<string, CityCam>();
for (const c of CITY_CAMS) byWebcamId.set(`citycam:${c.id}`, c);

export function getCityCam(webcamId: string): CityCam | undefined {
  return byWebcamId.get(webcamId);
}

/** City-cam markers for the webcams layer, filtered to a viewport bbox. */
export function cityCamMarkers(bounds: { w: number; s: number; e: number; n: number }): WebcamEntry[] {
  return CITY_CAMS
    .filter((c) => c.lat >= bounds.s && c.lat <= bounds.n && c.lon >= bounds.w && c.lon <= bounds.e)
    .map((c) => ({
      webcamId: `citycam:${c.id}`,
      title: `📹 ${c.city}`,
      lat: c.lat,
      lng: c.lon,
      category: 'citycam',
      country: '',
    }));
}
