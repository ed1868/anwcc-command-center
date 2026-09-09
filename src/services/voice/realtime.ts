// Jarvis-style realtime voice agent for the World Command Center.
// Adapted from God's Eye View's gevRealtime.js (MIT, Bilawal Sidhu):
// OpenAI Realtime API over WebRTC — continuous mic, semantic VAD with
// barge-in, and function-calling into the app's action registry.

export type VoiceStatus = 'idle' | 'connecting' | 'listening' | 'executing' | 'error';

export interface VoiceToolDefinition {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface VoiceActionRegistry {
  instructions: string;
  tools: VoiceToolDefinition[];
  run(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface VoiceSessionCallbacks {
  onStatus?(status: VoiceStatus, detail: string): void;
  /** Mic + assistant output levels in [0,1], ~10Hz. */
  onLevels?(mic: number, assistant: number): void;
  /** Streaming transcript of the assistant's speech. `final` marks turn end. */
  onTranscript?(text: string, final: boolean): void;
}

const TOKEN_URL = '/api/realtime-token';
const REALTIME_CALLS_URL = 'https://api.openai.com/v1/realtime/calls';
const LEVEL_INTERVAL_MS = 100;

interface MintedToken {
  token: string;
  model: string | null;
}

async function fetchRealtimeToken(): Promise<MintedToken> {
  const res = await fetch(TOKEN_URL, { method: 'POST' });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) detail = typeof body.error === 'string' ? body.error : (body.error.message || detail);
    } catch { /* non-JSON error body */ }
    throw new Error(`Voice token request failed: ${detail}`);
  }
  const body = await res.json();
  if (body?.error) {
    const message = typeof body.error === 'string' ? body.error : (body.error.message || 'Voice token request failed');
    throw new Error(message);
  }
  const token = body?.value || body?.client_secret?.value;
  if (!token) throw new Error('Voice token response had no client secret');
  return { token, model: res.headers.get('X-Voice-Model') };
}

function createLevelMeter(stream: MediaStream, ctx: AudioContext): () => number {
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);
  return () => {
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = ((data[i] ?? 128) - 128) / 128;
      sum += v * v;
    }
    return Math.min(1, Math.sqrt(sum / data.length) * 4);
  };
}

export class VoiceSession {
  private registry: VoiceActionRegistry;
  private callbacks: VoiceSessionCallbacks;
  status: VoiceStatus = 'idle';

  private startEpoch = 0;
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private stream: MediaStream | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private audioCtx: AudioContext | null = null;
  private micLevel: (() => number) | null = null;
  private assistantLevel: (() => number) | null = null;
  private levelTimer: ReturnType<typeof setInterval> | null = null;
  private handledCallIds = new Set<string>();
  private tearingDown = false;
  private transcriptBuffer = '';

  constructor(registry: VoiceActionRegistry, callbacks: VoiceSessionCallbacks = {}) {
    this.registry = registry;
    this.callbacks = callbacks;
  }

  private setStatus(status: VoiceStatus, detail = ''): void {
    this.status = status;
    this.callbacks.onStatus?.(status, detail);
  }

  toggle(): void {
    if (this.status === 'idle' || this.status === 'error') void this.start();
    else this.stop();
  }

  async start(): Promise<void> {
    this.stop({ preserveStatus: true });
    if (!window.RTCPeerConnection || !navigator.mediaDevices?.getUserMedia) {
      this.setStatus('error', 'WebRTC microphone support unavailable');
      return;
    }
    const epoch = ++this.startEpoch;
    this.setStatus('connecting', 'Requesting session');

    let localStream: MediaStream | null = null;
    let localPc: RTCPeerConnection | null = null;
    try {
      const minted = await fetchRealtimeToken();
      if (this.abandoned(epoch, localStream, localPc)) return;

      try {
        localStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        });
      } catch (micError) {
        // Turn the browser's terse getUserMedia errors into something actionable.
        const name = (micError as { name?: string })?.name || '';
        const secure = window.isSecureContext;
        let detail: string;
        if (name === 'NotAllowedError' || name === 'SecurityError') {
          detail = 'Microphone blocked — click the mic/camera icon in the address bar and Allow, then retry';
        } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
          detail = secure
            ? 'No microphone found — check it is connected and that Chrome has mic access in macOS System Settings → Privacy → Microphone'
            : 'Microphone needs a secure page — open the app at http://localhost:3100, not a LAN IP';
        } else if (name === 'NotReadableError') {
          detail = 'Microphone is in use by another app — close it and retry';
        } else {
          detail = `Microphone unavailable (${name || 'unknown'})`;
        }
        this.setStatus('error', detail);
        return;
      }
      if (this.abandoned(epoch, localStream, localPc)) return;
      this.stream = localStream;

      this.audioCtx = new AudioContext();
      this.micLevel = createLevelMeter(localStream, this.audioCtx);
      this.startLevelLoop();

      document.querySelectorAll('audio[data-wm-voice-audio="true"]').forEach((el) => el.remove());
      this.audioEl = document.createElement('audio');
      this.audioEl.autoplay = true;
      this.audioEl.dataset.wmVoiceAudio = 'true';
      this.audioEl.style.display = 'none';
      document.body.appendChild(this.audioEl);

      localPc = new RTCPeerConnection();
      this.pc = localPc;
      this.pc.ontrack = (event) => {
        const remote = event.streams[0];
        if (!remote) return;
        if (this.audioEl) this.audioEl.srcObject = remote;
        if (this.audioCtx) this.assistantLevel = createLevelMeter(remote, this.audioCtx);
      };
      this.pc.onconnectionstatechange = () => {
        const state = this.pc?.connectionState;
        if (state === 'failed') this.fatal('Connection lost');
      };
      localStream.getTracks().forEach((track) => this.pc!.addTrack(track, localStream!));

      const dc = this.pc.createDataChannel('oai-events');
      this.dc = dc;
      dc.addEventListener('open', () => {
        this.sendEvent({
          type: 'session.update',
          session: {
            type: 'realtime',
            instructions: this.registry.instructions,
            tools: this.registry.tools,
            tool_choice: 'auto',
          },
        });
        this.setStatus('listening', 'Ask or command');
      });
      dc.addEventListener('message', (event) => void this.handleEvent(event));
      dc.addEventListener('close', () => {
        if (!this.tearingDown && this.dc === dc && this.status !== 'idle' && this.status !== 'error') {
          this.fatal('Session closed');
        }
      });

      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      if (this.abandoned(epoch, localStream, localPc)) return;

      const sdpResponse = await fetch(REALTIME_CALLS_URL, {
        method: 'POST',
        body: offer.sdp,
        headers: { Authorization: `Bearer ${minted.token}`, 'Content-Type': 'application/sdp' },
      });
      if (this.abandoned(epoch, localStream, localPc)) return;
      if (!sdpResponse.ok) {
        const body = await sdpResponse.text().catch(() => '');
        throw new Error(`Realtime SDP failed: HTTP ${sdpResponse.status}${body ? ` — ${body.slice(0, 200)}` : ''}`);
      }
      await this.pc.setRemoteDescription({ type: 'answer', sdp: await sdpResponse.text() });
      if (this.abandoned(epoch, localStream, localPc)) return;
    } catch (error) {
      if (epoch !== this.startEpoch) {
        releaseResources(localStream, localPc);
        return;
      }
      this.stop({ preserveStatus: true });
      this.setStatus('error', error instanceof Error ? error.message : String(error));
    }
  }

  stop(options: { preserveStatus?: boolean } = {}): void {
    this.startEpoch++;
    this.tearingDown = true;
    try {
      if (this.levelTimer) clearInterval(this.levelTimer);
      this.levelTimer = null;
      releaseResources(this.stream, this.pc);
      this.stream = null;
      this.pc = null;
      this.dc = null;
      this.audioEl?.remove();
      this.audioEl = null;
      void this.audioCtx?.close().catch(() => {});
      this.audioCtx = null;
      this.micLevel = null;
      this.assistantLevel = null;
      this.handledCallIds.clear();
    } finally {
      this.tearingDown = false;
    }
    if (!options.preserveStatus) this.setStatus('idle', '');
    this.callbacks.onLevels?.(0, 0);
  }

  private abandoned(epoch: number, localStream: MediaStream | null, localPc: RTCPeerConnection | null): boolean {
    if (epoch === this.startEpoch) return false;
    if (localStream && this.stream === localStream) this.stream = null;
    if (localPc && this.pc === localPc) {
      this.pc = null;
      this.dc = null;
    }
    releaseResources(localStream, localPc);
    return true;
  }

  private fatal(detail: string): void {
    this.stop({ preserveStatus: true });
    this.setStatus('error', detail);
  }

  private startLevelLoop(): void {
    if (this.levelTimer) clearInterval(this.levelTimer);
    this.levelTimer = setInterval(() => {
      this.callbacks.onLevels?.(this.micLevel?.() ?? 0, this.assistantLevel?.() ?? 0);
    }, LEVEL_INTERVAL_MS);
  }

  private sendEvent(payload: Record<string, unknown>): void {
    if (this.dc?.readyState !== 'open') return;
    try {
      this.dc.send(JSON.stringify(payload));
    } catch (error) {
      console.warn('[voice] failed to send event', error);
    }
  }

  /** Is the realtime data channel live (so proactive speech can be injected)? */
  get connected(): boolean {
    return this.dc?.readyState === 'open' && (this.status === 'listening' || this.status === 'executing');
  }

  /**
   * Proactively make the assistant speak — e.g. a watch-mode alert. Injects a
   * system-directed user turn and requests a response. No-op if not connected.
   */
  injectProactive(text: string): boolean {
    if (!this.connected) return false;
    this.sendEvent({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    });
    this.sendEvent({ type: 'response.create' });
    return true;
  }

  private async handleEvent(event: MessageEvent): Promise<void> {
    let payload: any;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }

    if (payload.type === 'error') {
      // Benign mid-session errors (e.g. a cancelled response) shouldn't kill the mic.
      console.warn('[voice] realtime error event', payload.error);
      return;
    }

    if (payload.type === 'response.output_audio_transcript.delta' && typeof payload.delta === 'string') {
      this.transcriptBuffer += payload.delta;
      this.callbacks.onTranscript?.(this.transcriptBuffer, false);
      return;
    }
    if (payload.type === 'response.output_audio_transcript.done') {
      const text = typeof payload.transcript === 'string' ? payload.transcript : this.transcriptBuffer;
      this.transcriptBuffer = '';
      this.callbacks.onTranscript?.(text, true);
      return;
    }
    if (payload.type === 'input_audio_buffer.speech_started') {
      this.transcriptBuffer = '';
      this.callbacks.onTranscript?.('', true);
      return;
    }

    if (payload.type === 'response.done' && this.status === 'executing') {
      this.setStatus('listening', 'Ask or command');
      return;
    }

    // Function calls surface on two event types; dedupe by call_id so each
    // call gets exactly one output (an unanswered call strands the session).
    let call: { name: string; callId: string; args: string } | null = null;
    if (payload.type === 'response.function_call_arguments.done' && payload.call_id) {
      call = { name: payload.name, callId: payload.call_id, args: payload.arguments || '{}' };
    } else if (payload.type === 'response.output_item.done' && payload.item?.type === 'function_call' && payload.item.call_id) {
      call = { name: payload.item.name, callId: payload.item.call_id, args: payload.item.arguments || '{}' };
    }
    if (!call || this.handledCallIds.has(call.callId)) return;
    this.handledCallIds.add(call.callId);
    if (this.handledCallIds.size > 200) {
      this.handledCallIds = new Set([...this.handledCallIds].slice(-100));
    }

    this.setStatus('executing', call.name.replace(/_/g, ' '));
    let result: Record<string, unknown>;
    try {
      result = await this.registry.run(call.name, JSON.parse(call.args));
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    this.sendEvent({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: call.callId, output: JSON.stringify(result) },
    });
    this.sendEvent({ type: 'response.create' });
    if (this.status === 'executing') this.setStatus('listening', 'Ask or command');
  }
}

function releaseResources(stream: MediaStream | null | undefined, pc: RTCPeerConnection | null | undefined): void {
  try {
    stream?.getTracks().forEach((track) => track.stop());
  } catch { /* already stopped */ }
  try {
    pc?.close();
  } catch { /* already closed */ }
}
