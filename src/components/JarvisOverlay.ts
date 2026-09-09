// Jarvis core overlay: an amber particle-sphere "entity" that appears while
// the voice session is active. Audio-reactive (mic + assistant levels pulse
// the core), with a status readout and the assistant's live transcript.
// Pointer-events pass through — the dashboard stays fully usable beneath it.

import type { VoiceStatus } from '@/services/voice/realtime';

const PARTICLES = 240;
const LINK_DISTANCE = 0.42;
const MAX_LINKS_PER_POINT = 3;
const CANVAS_SIZE = 380;

const STATUS_TEXT: Partial<Record<VoiceStatus, string>> = {
  connecting: 'CORE · LINKING',
  listening: 'CORE · LISTENING',
  executing: 'CORE · EXECUTING',
};

interface Particle {
  x: number; y: number; z: number;
  phase: number;
}

export class JarvisOverlay {
  private root: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx2d: CanvasRenderingContext2D | null;
  private statusEl: HTMLElement;
  private transcriptEl: HTMLElement;
  private particles: Particle[] = [];
  private links: Array<[number, number]> = [];
  private raf = 0;
  private angle = 0;
  private level = 0;
  private smoothedLevel = 0;
  private visible = false;
  private reducedMotion = false;
  private transcriptClearTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.reducedMotion = typeof matchMedia !== 'undefined'
      && matchMedia('(prefers-reduced-motion: reduce)').matches;

    this.root = document.createElement('div');
    this.root.className = 'jarvis-overlay';
    this.root.setAttribute('aria-hidden', 'true');

    this.canvas = document.createElement('canvas');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = CANVAS_SIZE * dpr;
    this.canvas.height = CANVAS_SIZE * dpr;
    this.canvas.style.width = `${CANVAS_SIZE}px`;
    this.canvas.style.height = `${CANVAS_SIZE}px`;
    this.ctx2d = this.canvas.getContext('2d');
    this.ctx2d?.scale(dpr, dpr);

    this.statusEl = document.createElement('div');
    this.statusEl.className = 'jarvis-status';

    this.transcriptEl = document.createElement('div');
    this.transcriptEl.className = 'jarvis-transcript';

    this.root.appendChild(this.canvas);
    this.root.appendChild(this.statusEl);
    this.root.appendChild(this.transcriptEl);

    this.buildParticles();
    this.injectStyles();
    document.body.appendChild(this.root);
  }

  private buildParticles(): void {
    // Fibonacci sphere for even coverage; per-point phase gives shimmer.
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < PARTICLES; i++) {
      const y = 1 - (i / (PARTICLES - 1)) * 2;
      const r = Math.sqrt(1 - y * y);
      const theta = golden * i;
      this.particles.push({
        x: Math.cos(theta) * r,
        y,
        z: Math.sin(theta) * r,
        phase: (i * 2654435761 % 1000) / 1000 * Math.PI * 2,
      });
    }
    // Precompute a sparse edge list so per-frame cost stays linear.
    const linkCount = new Array(PARTICLES).fill(0);
    for (let i = 0; i < PARTICLES; i++) {
      for (let j = i + 1; j < PARTICLES && linkCount[i] < MAX_LINKS_PER_POINT; j++) {
        if (linkCount[j] >= MAX_LINKS_PER_POINT) continue;
        const a = this.particles[i]!;
        const b = this.particles[j]!;
        const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
        if (d < LINK_DISTANCE) {
          this.links.push([i, j]);
          linkCount[i]++;
          linkCount[j]++;
        }
      }
    }
  }

  setStatus(status: VoiceStatus): void {
    const label = STATUS_TEXT[status];
    if (label) {
      this.statusEl.textContent = `◈ ${label}`;
      this.show();
    } else {
      this.hide();
    }
  }

  setLevel(level: number): void {
    this.level = Math.max(0, Math.min(1, level));
  }

  setTranscript(text: string, final: boolean): void {
    if (this.transcriptClearTimer) {
      clearTimeout(this.transcriptClearTimer);
      this.transcriptClearTimer = null;
    }
    this.transcriptEl.textContent = text;
    if (final && text) {
      // Let the last sentence linger, then fade it out.
      this.transcriptClearTimer = setTimeout(() => {
        this.transcriptEl.textContent = '';
      }, 6000);
    }
  }

  private show(): void {
    if (this.visible) return;
    this.visible = true;
    this.root.classList.add('jarvis-visible');
    if (!this.raf) this.raf = requestAnimationFrame(this.frame);
  }

  private hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.root.classList.remove('jarvis-visible');
    this.transcriptEl.textContent = '';
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  }

  private frame = (now: number): void => {
    this.raf = this.visible ? requestAnimationFrame(this.frame) : 0;
    const ctx = this.ctx2d;
    if (!ctx) return;

    this.smoothedLevel += (this.level - this.smoothedLevel) * 0.18;
    const level = this.smoothedLevel;
    if (!this.reducedMotion) {
      this.angle += 0.0035 + level * 0.012;
    }

    const c = CANVAS_SIZE / 2;
    const baseRadius = CANVAS_SIZE * 0.30 * (1 + level * 0.18);
    ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

    // Core glow
    const glow = ctx.createRadialGradient(c, c, 0, c, c, baseRadius * 1.5);
    glow.addColorStop(0, `rgba(255, 122, 26, ${0.28 + level * 0.35})`);
    glow.addColorStop(0.55, `rgba(255, 90, 10, ${0.10 + level * 0.15})`);
    glow.addColorStop(1, 'rgba(255, 90, 10, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

    // Project particles
    const sin = Math.sin(this.angle);
    const cos = Math.cos(this.angle);
    const projected: Array<{ px: number; py: number; depth: number }> = new Array(PARTICLES);
    for (let i = 0; i < PARTICLES; i++) {
      const p = this.particles[i]!;
      const rx = p.x * cos - p.z * sin;
      const rz = p.x * sin + p.z * cos;
      const wobble = this.reducedMotion ? 0 : Math.sin(now * 0.0011 + p.phase) * 0.035;
      const scale = baseRadius * (1 + wobble);
      projected[i] = {
        px: c + rx * scale,
        py: c + p.y * scale * 0.92,
        depth: (rz + 1) / 2,
      };
    }

    // Links
    ctx.lineWidth = 0.6;
    for (const [i, j] of this.links) {
      const a = projected[i]!;
      const b = projected[j]!;
      const depth = (a.depth + b.depth) / 2;
      ctx.strokeStyle = `rgba(255, 140, 46, ${0.05 + depth * (0.16 + level * 0.22)})`;
      ctx.beginPath();
      ctx.moveTo(a.px, a.py);
      ctx.lineTo(b.px, b.py);
      ctx.stroke();
    }

    // Points
    for (let i = 0; i < PARTICLES; i++) {
      const pt = projected[i]!;
      const size = 0.7 + pt.depth * 1.7;
      ctx.fillStyle = `rgba(255, ${170 + Math.round(pt.depth * 60)}, 107, ${0.25 + pt.depth * 0.65})`;
      ctx.beginPath();
      ctx.arc(pt.px, pt.py, size, 0, Math.PI * 2);
      ctx.fill();
    }
  };

  private injectStyles(): void {
    if (document.getElementById('jarvis-overlay-styles')) return;
    const style = document.createElement('style');
    style.id = 'jarvis-overlay-styles';
    style.textContent = `
      .jarvis-overlay {
        position: fixed; left: 50%; top: 44%;
        transform: translate(-50%, -50%) scale(0.9);
        display: flex; flex-direction: column; align-items: center;
        pointer-events: none; z-index: 8000;
        opacity: 0; transition: opacity 0.45s ease, transform 0.45s ease;
      }
      .jarvis-overlay.jarvis-visible {
        opacity: 1; transform: translate(-50%, -50%) scale(1);
      }
      .jarvis-status {
        margin-top: -34px;
        font-family: 'SF Mono', ui-monospace, Menlo, monospace;
        font-size: 11px; letter-spacing: 0.35em; text-transform: uppercase;
        color: #ffb36b; text-shadow: 0 0 12px rgba(255, 122, 26, 0.8);
      }
      .jarvis-transcript {
        margin-top: 10px; max-width: 520px; min-height: 1.2em;
        text-align: center;
        font-family: 'SF Mono', ui-monospace, Menlo, monospace;
        font-size: 12.5px; line-height: 1.5; letter-spacing: 0.04em;
        color: rgba(255, 214, 170, 0.92);
        text-shadow: 0 0 8px rgba(255, 122, 26, 0.5);
        display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;
        overflow: hidden;
      }
    `;
    document.head.appendChild(style);
  }

  destroy(): void {
    this.hide();
    if (this.transcriptClearTimer) clearTimeout(this.transcriptClearTimer);
    this.root.remove();
  }
}
