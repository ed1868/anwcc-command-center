// Proactive watch mode — turns Jarvis into a watch officer. Polls the live
// feeds for significant NEW events (major earthquakes, breaking-news alerts)
// and surfaces them unprompted: spoken through the voice session when one is
// live, and always as an on-screen alert toast.

import type { AppContext } from '@/app/app-context';
import type { VoiceSession } from './realtime';
import { fetchRecentQuakes } from './usgs-quakes';

const POLL_MS = 60_000;
const QUAKE_MIN_MAG = 5.0;
const MAX_SEEN = 400;

export interface WatchAlert { headline: string; detail: string; kind: 'seismic' | 'breaking'; }

interface WatchHandle { stop(): void; }

function boundedAdd(set: Set<string>, key: string): void {
  set.add(key);
  if (set.size > MAX_SEEN) {
    const first = set.values().next().value;
    if (first !== undefined) set.delete(first);
  }
}

export function startWatchMode(
  ctx: AppContext,
  session: VoiceSession,
  onAlert: (alert: WatchAlert) => void,
): WatchHandle {
  const seenQuakes = new Set<string>();
  const seenNews = new Set<string>();
  let stopped = false;
  // Prime the seen-sets so we only alert on events that arrive AFTER watch
  // mode starts (no backlog dump on activation).
  let primed = false;

  const emit = (alert: WatchAlert): void => {
    onAlert(alert);
    // Speak it if a voice session is live.
    session.injectProactive(
      `WATCH ALERT — ${alert.headline}. ${alert.detail}. Announce this to the operator now, concisely, then return to standby.`,
    );
  };

  const poll = async (): Promise<void> => {
    if (stopped) return;
    // Earthquakes (USGS)
    try {
      const quakes = await fetchRecentQuakes();
      for (const q of quakes) {
        const key = `${q.place}|${q.time}`;
        if (seenQuakes.has(key)) continue;
        boundedAdd(seenQuakes, key);
        if (primed && q.magnitude >= QUAKE_MIN_MAG) {
          emit({
            kind: 'seismic',
            headline: `Magnitude ${q.magnitude.toFixed(1)} earthquake`,
            detail: q.place,
          });
        }
      }
    } catch { /* skip cycle */ }

    // Breaking-news alerts (already flagged by the app's classifier)
    try {
      for (const n of ctx.allNews) {
        if (!n.isAlert) continue;
        const key = n.link || n.title;
        if (seenNews.has(key)) continue;
        boundedAdd(seenNews, key);
        if (primed) {
          emit({ kind: 'breaking', headline: 'Breaking', detail: `${n.title} (${n.source})` });
        }
      }
    } catch { /* skip */ }

    primed = true;
  };

  void poll();
  const timer = setInterval(() => { void poll(); }, POLL_MS);

  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
  };
}
