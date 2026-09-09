// In-app live camera viewer modal. Plays a continuous HLS stream (hls.js),
// a plain video (.mp4), or an auto-refreshing JPEG snapshot — so a traffic-cam
// marker opens live video inside the dashboard instead of a raw file in a tab.

import Hls from 'hls.js';

export interface CameraSource {
  title: string;
  subtitle?: string;
  hls?: string | null;      // .m3u8 — continuous live video (preferred)
  mp4?: string | null;      // direct video file
  image?: string | null;    // JPEG snapshot (auto-refreshed)
  youtubeId?: string | null; // YouTube live video id → embedded player
}

let overlay: HTMLElement | null = null;
let hlsInstance: Hls | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

function teardown(): void {
  if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  overlay?.remove();
  overlay = null;
  document.removeEventListener('keydown', onKey);
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') teardown();
}

function injectStyles(): void {
  if (document.getElementById('camera-viewer-styles')) return;
  const style = document.createElement('style');
  style.id = 'camera-viewer-styles';
  style.textContent = `
    .camera-viewer-overlay {
      position: fixed; inset: 0; z-index: 9000;
      background: rgba(0,0,0,0.72); backdrop-filter: blur(3px);
      display: flex; align-items: center; justify-content: center;
    }
    .camera-viewer-frame {
      position: relative; background: #05070c;
      border: 1px solid var(--border, #2a3344); border-radius: 8px;
      box-shadow: 0 10px 60px rgba(0,0,0,0.6); overflow: hidden;
      width: min(880px, 92vw);
    }
    .camera-viewer-media { display: block; width: 100%; aspect-ratio: 16/9; background: #05070c; object-fit: contain; }
    .camera-viewer-bar {
      display: flex; align-items: baseline; gap: 8px; padding: 10px 14px;
      font-family: 'SF Mono', ui-monospace, Menlo, monospace;
      border-top: 1px solid var(--border, #2a3344); background: var(--surface, #0d1220);
    }
    .camera-viewer-title { color: var(--text, #e6ecf5); font-size: 13px; letter-spacing: .02em; }
    .camera-viewer-sub { color: var(--text-secondary, #8a97ab); font-size: 11px; }
    .camera-viewer-live {
      margin-left: auto; color: #ff5a3c; font-size: 10px; letter-spacing: .18em;
      display: inline-flex; align-items: center; gap: 5px;
    }
    .camera-viewer-live::before { content:''; width:7px; height:7px; border-radius:50%; background:#ff5a3c; box-shadow:0 0 8px #ff5a3c; }
    .camera-viewer-close {
      position: absolute; top: 8px; right: 10px; z-index: 2;
      width: 30px; height: 30px; border-radius: 50%;
      background: rgba(0,0,0,0.55); color: #fff; border: none; cursor: pointer;
      font-size: 18px; line-height: 1;
    }
    .camera-viewer-close:hover { background: rgba(0,0,0,0.8); }
  `;
  document.head.appendChild(style);
}

/** Open (or replace) the live camera viewer with the given source. */
export function openCameraViewer(source: CameraSource): void {
  injectStyles();
  teardown();

  overlay = document.createElement('div');
  overlay.className = 'camera-viewer-overlay';
  overlay.addEventListener('click', (e) => { if (e.target === overlay) teardown(); });

  const frame = document.createElement('div');
  frame.className = 'camera-viewer-frame';

  const close = document.createElement('button');
  close.className = 'camera-viewer-close';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Close');
  close.addEventListener('click', teardown);
  frame.appendChild(close);

  let isLive = false;

  if (source.youtubeId) {
    isLive = true;
    const iframe = document.createElement('iframe');
    iframe.className = 'camera-viewer-media';
    iframe.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(source.youtubeId)}?autoplay=1&mute=1&playsinline=1&rel=0`;
    iframe.allow = 'autoplay; encrypted-media; picture-in-picture';
    iframe.setAttribute('allowfullscreen', 'true');
    iframe.setAttribute('frameborder', '0');
    frame.appendChild(iframe);
  } else if (source.hls || source.mp4) {
    const video = document.createElement('video');
    video.className = 'camera-viewer-media';
    video.autoplay = true;
    video.muted = true;
    video.controls = true;
    video.playsInline = true;
    if (source.hls) {
      isLive = true;
      if (Hls.isSupported()) {
        hlsInstance = new Hls({ liveDurationInfinity: true, lowLatencyMode: true });
        hlsInstance.loadSource(source.hls);
        hlsInstance.attachMedia(video);
        hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => { void video.play().catch(() => { /* user can press play */ }); });
        hlsInstance.on(Hls.Events.ERROR, (_e, data) => {
          // On a fatal HLS error, fall back to the snapshot if we have one.
          if (data.fatal && source.image) swapToImage(frame, source.image);
        });
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = source.hls; // Safari native HLS
      } else if (source.image) {
        swapToImage(frame, source.image);
      }
    } else if (source.mp4) {
      video.src = source.mp4;
      video.loop = true;
    }
    frame.appendChild(video);
  } else if (source.image) {
    mountImage(frame, source.image);
  }

  const bar = document.createElement('div');
  bar.className = 'camera-viewer-bar';
  const title = document.createElement('span');
  title.className = 'camera-viewer-title';
  title.textContent = source.title;
  bar.appendChild(title);
  if (source.subtitle) {
    const sub = document.createElement('span');
    sub.className = 'camera-viewer-sub';
    sub.textContent = source.subtitle;
    bar.appendChild(sub);
  }
  const live = document.createElement('span');
  live.className = 'camera-viewer-live';
  live.textContent = isLive ? 'LIVE' : 'SNAPSHOT';
  bar.appendChild(live);
  frame.appendChild(bar);

  overlay.appendChild(frame);
  document.body.appendChild(overlay);
  document.addEventListener('keydown', onKey);
}

function mountImage(frame: HTMLElement, url: string): HTMLImageElement {
  const img = document.createElement('img');
  img.className = 'camera-viewer-media';
  const bust = () => { img.src = `${url}${url.includes('?') ? '&' : '?'}_t=${Date.now()}`; };
  bust();
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(bust, 3000); // refresh the snapshot every 3s
  frame.insertBefore(img, frame.firstChild);
  return img;
}

function swapToImage(frame: HTMLElement, url: string): void {
  if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
  frame.querySelector('.camera-viewer-media')?.remove();
  mountImage(frame, url);
  const badge = frame.querySelector('.camera-viewer-live');
  if (badge) badge.textContent = 'SNAPSHOT';
}

export function closeCameraViewer(): void {
  teardown();
}
