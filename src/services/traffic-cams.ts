// Public traffic cameras (Caltrans + TfL London) as webcam-layer markers.
// Fetched via the /api/trafficcams dev proxy and mapped to WebcamEntry so they
// render through the existing webcams ScatterplotLayer and click handling.
//
// The openable snapshot/video URL is carried in `webcamId` (a full http URL);
// resolveWebcamStreamUrl returns it verbatim when it detects a URL, so clicking
// a traffic-cam marker opens the live image instead of a Windy page.

import type { WebcamEntry } from '@/generated/client/worldmonitor/webcam/v1/service_client';

interface TrafficCamRecord {
  id: string;
  title: string;
  lat: number;
  lon: number;
  image: string;
  video: string | null;
  provider: string;
}

let cache: { key: string; markers: WebcamEntry[]; at: number } | null = null;
const CACHE_MS = 60_000;

// webcamId → the camera's stream sources, so the map click can open the live
// HLS video (Caltrans) or refreshing snapshot in the in-app viewer.
export interface TrafficCamStreams { title: string; provider: string; hls: string | null; mp4: string | null; image: string; }
const registry = new Map<string, TrafficCamStreams>();

export function getTrafficCam(webcamId: string): TrafficCamStreams | undefined {
  return registry.get(webcamId);
}

export async function fetchTrafficCams(bounds: { w: number; s: number; e: number; n: number }): Promise<WebcamEntry[]> {
  const key = `${bounds.w.toFixed(1)},${bounds.s.toFixed(1)},${bounds.e.toFixed(1)},${bounds.n.toFixed(1)}`;
  if (cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.markers;
  try {
    const params = new URLSearchParams({
      lamin: String(bounds.s), lamax: String(bounds.n), lomin: String(bounds.w), lomax: String(bounds.e),
    });
    const res = await fetch(`/api/trafficcams?${params}`);
    if (!res.ok) return [];
    const data = await res.json() as { cams?: TrafficCamRecord[] };
    const markers: WebcamEntry[] = (data.cams ?? []).map((c) => {
      const isHls = !!c.video && /\.m3u8($|\?)/i.test(c.video);
      const isMp4 = !!c.video && /\.mp4($|\?)/i.test(c.video);
      // Stable id per camera; the click handler looks up the stream sources.
      const webcamId = `traffic:${c.id}`;
      registry.set(webcamId, {
        title: c.title,
        provider: c.provider,
        hls: isHls ? c.video : null,
        mp4: isMp4 ? c.video : null,
        image: c.image,
      });
      return {
        webcamId,
        title: `${c.title} · ${c.provider}`,
        lat: c.lat,
        lng: c.lon,
        category: 'traffic',
        country: c.provider === 'TfL London' ? 'GB' : 'US',
      };
    });
    cache = { key, markers, at: Date.now() };
    return markers;
  } catch {
    return [];
  }
}
