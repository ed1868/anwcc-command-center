// Multi-camera surveillance wall: plays several live feeds at once in a grid.
// Each tile handles HLS video (hls.js), a YouTube embed, an .mp4, or an
// auto-refreshing snapshot — the same source shapes as CameraViewer.

import Hls from 'hls.js';
import type { CameraSource } from './CameraViewer';

let overlay: HTMLElement | null = null;
const hlsInstances: Hls[] = [];
const refreshTimers: ReturnType<typeof setInterval>[] = [];

function teardown(): void {
  hlsInstances.forEach((h) => { try { h.destroy(); } catch { /* already gone */ } });
  hlsInstances.length = 0;
  refreshTimers.forEach((t) => clearInterval(t));
  refreshTimers.length = 0;
  overlay?.remove();
  overlay = null;
  document.removeEventListener('keydown', onKey);
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') teardown();
}

function mountTileMedia(tile: HTMLElement, source: CameraSource): void {
  if (source.youtubeId) {
    const iframe = document.createElement('iframe');
    iframe.className = 'camera-wall-media';
    iframe.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(source.youtubeId)}?autoplay=1&mute=1&playsinline=1&rel=0`;
    iframe.allow = 'autoplay; encrypted-media; picture-in-picture';
    iframe.setAttribute('frameborder', '0');
    tile.appendChild(iframe);
    return;
  }
  if (source.hls || source.mp4) {
    const video = document.createElement('video');
    video.className = 'camera-wall-media';
    video.autoplay = true; video.muted = true; video.playsInline = true;
    if (source.hls && Hls.isSupported()) {
      const hls = new Hls({ liveDurationInfinity: true });
      hls.loadSource(source.hls);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => { void video.play().catch(() => {}); });
      hls.on(Hls.Events.ERROR, (_e, d) => { if (d.fatal && source.image) mountSnapshot(tile, video, source.image); });
      hlsInstances.push(hls);
    } else if (source.hls && video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = source.hls;
    } else if (source.mp4) {
      video.src = source.mp4; video.loop = true;
    } else if (source.image) {
      mountSnapshot(tile, null, source.image); return;
    }
    tile.appendChild(video);
    return;
  }
  if (source.image) mountSnapshot(tile, null, source.image);
}

function mountSnapshot(tile: HTMLElement, replace: HTMLElement | null, url: string): void {
  replace?.remove();
  const img = document.createElement('img');
  img.className = 'camera-wall-media';
  const bust = () => { img.src = `${url}${url.includes('?') ? '&' : '?'}_t=${Date.now()}`; };
  bust();
  refreshTimers.push(setInterval(bust, 4000));
  tile.appendChild(img);
}

function injectStyles(): void {
  if (document.getElementById('camera-wall-styles')) return;
  const style = document.createElement('style');
  style.id = 'camera-wall-styles';
  style.textContent = `
    .camera-wall-overlay { position: fixed; inset: 0; z-index: 9000; background: rgba(3,5,10,0.92); backdrop-filter: blur(4px); display: flex; flex-direction: column; }
    .camera-wall-bar { display: flex; align-items: center; gap: 10px; padding: 10px 16px; border-bottom: 1px solid var(--border, #2a3344); font-family: 'SF Mono', ui-monospace, Menlo, monospace; }
    .camera-wall-title { color: var(--text, #e6ecf5); font-size: 12px; letter-spacing: .16em; text-transform: uppercase; }
    .camera-wall-live { color: #ff5a3c; font-size: 10px; letter-spacing: .18em; display: inline-flex; align-items: center; gap: 5px; }
    .camera-wall-live::before { content:''; width:7px; height:7px; border-radius:50%; background:#ff5a3c; box-shadow:0 0 8px #ff5a3c; }
    .camera-wall-close { margin-left: auto; width: 30px; height: 30px; border-radius: 50%; background: rgba(255,255,255,0.08); color: #fff; border: none; cursor: pointer; font-size: 18px; }
    .camera-wall-close:hover { background: rgba(255,255,255,0.18); }
    .camera-wall-grid { flex: 1; display: grid; gap: 2px; padding: 2px; overflow: hidden; }
    .camera-wall-cell { position: relative; background: #05070c; overflow: hidden; display: flex; align-items: center; justify-content: center; }
    .camera-wall-media { width: 100%; height: 100%; object-fit: cover; border: none; display: block; }
    .camera-wall-label { position: absolute; left: 8px; bottom: 8px; padding: 3px 8px; background: rgba(0,0,0,0.6); color: #ffd9a0; font-family: 'SF Mono', ui-monospace, Menlo, monospace; font-size: 11px; border-radius: 3px; }
  `;
  document.head.appendChild(style);
}

/** Open a grid of live camera feeds. */
export function openCameraWall(title: string, sources: CameraSource[]): void {
  injectStyles();
  teardown();
  const cams = sources.slice(0, 9);
  if (!cams.length) return;

  overlay = document.createElement('div');
  overlay.className = 'camera-wall-overlay';

  const bar = document.createElement('div');
  bar.className = 'camera-wall-bar';
  const t = document.createElement('span'); t.className = 'camera-wall-title'; t.textContent = title;
  const live = document.createElement('span'); live.className = 'camera-wall-live'; live.textContent = `${cams.length} LIVE`;
  const close = document.createElement('button'); close.className = 'camera-wall-close'; close.textContent = '×'; close.addEventListener('click', teardown);
  bar.append(t, live, close);
  overlay.appendChild(bar);

  const grid = document.createElement('div');
  grid.className = 'camera-wall-grid';
  const cols = cams.length <= 1 ? 1 : cams.length <= 4 ? 2 : 3;
  grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  for (const source of cams) {
    const cell = document.createElement('div');
    cell.className = 'camera-wall-cell';
    mountTileMedia(cell, source);
    const label = document.createElement('div');
    label.className = 'camera-wall-label';
    label.textContent = source.title;
    cell.appendChild(label);
    grid.appendChild(cell);
  }
  overlay.appendChild(grid);
  document.body.appendChild(overlay);
  document.addEventListener('keydown', onKey);
}

export function closeCameraWall(): void { teardown(); }
