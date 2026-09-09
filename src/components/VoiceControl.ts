// Header mic button + status readout for the realtime voice agent.
// Mounts into .header-right like IntelligenceGapBadge.

import type { AppContext } from '@/app/app-context';
import { VoiceSession, type VoiceStatus } from '@/services/voice/realtime';
import { createVoiceActionRegistry, setWatchModeController } from '@/services/voice/actions';
import { startWatchMode, type WatchAlert } from '@/services/voice/watch-mode';
import { JarvisOverlay } from './JarvisOverlay';

const STATUS_LABELS: Record<VoiceStatus, string> = {
  idle: 'VOICE',
  connecting: 'LINKING',
  listening: 'LISTENING',
  executing: 'EXECUTING',
  error: 'ERROR',
};

const BAR_COUNT = 4;

export class VoiceControl {
  private session: VoiceSession;
  private root: HTMLElement;
  private statusEl: HTMLElement;
  private bars: HTMLElement[] = [];
  private errorDetail = '';
  private overlay: JarvisOverlay | null = null;
  private ctx: AppContext;
  private watch: { stop(): void } | null = null;
  private watchEnabled = true;

  constructor(ctx: AppContext) {
    this.ctx = ctx;
    this.session = new VoiceSession(createVoiceActionRegistry(ctx), {
      onStatus: (status, detail) => {
        this.renderStatus(status, detail);
        this.ensureOverlay().setStatus(status);
        this.syncWatchMode(status);
      },
      onLevels: (mic, assistant) => {
        const level = Math.max(mic, assistant);
        this.renderLevels(level);
        this.overlay?.setLevel(level);
      },
      onTranscript: (text, final) => this.overlay?.setTranscript(text, final),
    });

    this.root = document.createElement('button');
    this.root.className = 'voice-control';
    this.root.title = 'Voice agent — talk to the command center';
    this.root.setAttribute('aria-label', 'Toggle voice agent');

    const meter = document.createElement('span');
    meter.className = 'voice-control-meter';
    for (let i = 0; i < BAR_COUNT; i++) {
      const bar = document.createElement('span');
      bar.className = 'voice-control-bar';
      this.bars.push(bar);
      meter.appendChild(bar);
    }
    this.statusEl = document.createElement('span');
    this.statusEl.className = 'voice-control-status';
    this.statusEl.textContent = STATUS_LABELS.idle;

    this.root.appendChild(meter);
    this.root.appendChild(this.statusEl);
    this.root.addEventListener('click', () => this.session.toggle());

    // Let the voice agent toggle watch mode ("stop watching" / "start alerts").
    setWatchModeController({
      set: (on: boolean) => { this.watchEnabled = on; this.syncWatchMode(this.session.status); },
      isEnabled: () => this.watchEnabled,
    });

    this.injectStyles();
    this.mount();
  }

  private mount(): void {
    const headerRight = document.querySelector('.header-right');
    if (headerRight) headerRight.insertBefore(this.root, headerRight.firstChild);
  }

  private renderStatus(status: VoiceStatus, detail: string): void {
    this.root.dataset.status = status;
    this.errorDetail = status === 'error' ? detail : '';
    this.statusEl.textContent = STATUS_LABELS[status];
    this.root.title = this.errorDetail
      ? `Voice agent error: ${this.errorDetail} — click to retry`
      : status === 'idle'
        ? 'Voice agent — talk to the command center'
        : detail || STATUS_LABELS[status];
    if (status === 'idle' || status === 'error') this.renderLevels(0);
  }

  private renderLevels(level: number): void {
    this.bars.forEach((bar, i) => {
      const threshold = (i + 1) / (BAR_COUNT + 1);
      bar.style.transform = `scaleY(${level >= threshold ? Math.min(1, 0.3 + level) : 0.25})`;
    });
  }

  private injectStyles(): void {
    if (document.getElementById('voice-control-styles')) return;
    const style = document.createElement('style');
    style.id = 'voice-control-styles';
    style.textContent = `
      .voice-control {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 4px 10px; margin-right: 8px;
        background: var(--surface); color: var(--text-secondary);
        border: 1px solid var(--border); border-radius: 4px;
        font: inherit; font-size: 11px; letter-spacing: 0.08em;
        cursor: pointer; transition: color 0.2s, border-color 0.2s;
      }
      .voice-control:hover { color: var(--text); border-color: var(--accent); }
      .voice-control[data-status="listening"],
      .voice-control[data-status="executing"] { color: var(--accent); border-color: var(--accent); }
      .voice-control[data-status="connecting"] { color: var(--text-secondary); border-color: var(--accent); opacity: 0.8; }
      .voice-control[data-status="error"] { color: #e5534b; border-color: #e5534b; }
      .voice-control-meter { display: inline-flex; align-items: center; gap: 2px; height: 12px; }
      .voice-control-bar {
        width: 2px; height: 100%; background: currentColor; border-radius: 1px;
        transform: scaleY(0.25); transition: transform 0.1s linear;
      }
      .voice-control-status { min-width: 62px; text-align: left; }
    `;
    document.head.appendChild(style);
  }

  private ensureOverlay(): JarvisOverlay {
    if (!this.overlay) this.overlay = new JarvisOverlay();
    return this.overlay;
  }

  // Run watch mode only while the voice session is live and watch is enabled.
  private syncWatchMode(status: VoiceStatus): void {
    const shouldRun = this.watchEnabled && (status === 'listening' || status === 'executing');
    if (shouldRun && !this.watch) {
      this.watch = startWatchMode(this.ctx, this.session, (a) => this.showWatchToast(a));
    } else if (!shouldRun && this.watch) {
      this.watch.stop();
      this.watch = null;
    }
  }

  private showWatchToast(alert: WatchAlert): void {
    this.injectToastStyles();
    const toast = document.createElement('div');
    toast.className = `watch-toast watch-toast-${alert.kind}`;
    toast.innerHTML = `<span class="watch-toast-kind">${alert.kind === 'seismic' ? '⚠ SEISMIC' : '⚡ BREAKING'}</span>`;
    const body = document.createElement('div');
    body.className = 'watch-toast-body';
    body.textContent = `${alert.headline} — ${alert.detail}`;
    toast.appendChild(body);
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('watch-toast-show'));
    setTimeout(() => {
      toast.classList.remove('watch-toast-show');
      setTimeout(() => toast.remove(), 400);
    }, 9000);
  }

  private injectToastStyles(): void {
    if (document.getElementById('watch-toast-styles')) return;
    const style = document.createElement('style');
    style.id = 'watch-toast-styles';
    style.textContent = `
      .watch-toast {
        position: fixed; top: 56px; right: 16px; z-index: 9500; max-width: 380px;
        background: var(--surface, #0d1220); border: 1px solid var(--border, #2a3344);
        border-left: 3px solid #ff5a3c; border-radius: 6px; padding: 10px 14px;
        box-shadow: 0 8px 30px rgba(0,0,0,0.5);
        font-family: 'SF Mono', ui-monospace, Menlo, monospace;
        opacity: 0; transform: translateX(20px); transition: opacity .35s, transform .35s;
      }
      .watch-toast-show { opacity: 1; transform: translateX(0); }
      .watch-toast-seismic { border-left-color: #f0a63c; }
      .watch-toast-kind { font-size: 10px; letter-spacing: .16em; color: #ff8a5a; }
      .watch-toast-seismic .watch-toast-kind { color: #f0a63c; }
      .watch-toast-body { margin-top: 4px; font-size: 12.5px; color: var(--text, #e6ecf5); line-height: 1.4; }
    `;
    document.head.appendChild(style);
  }

  destroy(): void {
    this.watch?.stop();
    this.watch = null;
    setWatchModeController(null);
    this.session.stop();
    this.overlay?.destroy();
    this.overlay = null;
    this.root.remove();
  }
}
