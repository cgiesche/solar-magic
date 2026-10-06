// Audio output of the emulated sound unit: 32 kHz stereo frames from Snes.audio go through an
// AudioWorklet queue to the speakers. The audio clock paces the emulation: buffered() tells how much
// is still queued, so a player runs frames until enough is buffered instead of by wall-clock time.

import { APU_RATE } from '../core/apu.ts';

const WORKLET = `
class SmweOut extends AudioWorkletProcessor {
  constructor() {
    super();
    this.q = []; this.pos = 0; this.len = 0; this.gain = 1;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.clear) { this.q = []; this.pos = 0; this.len = 0; return; }
      if (d.gain !== undefined) { this.gain = d.gain; return; }
      this.q.push(d); this.len += d.length / 2;
      // far behind (a hidden tab, a stall): drop the oldest instead of lagging forever
      while (this.len > ${APU_RATE / 2} && this.q.length > 1) { const x = this.q.shift(); this.len -= x.length / 2 - this.pos / 2; this.pos = 0; }
    };
  }
  process(inputs, outputs) {
    const out = outputs[0], l = out[0], r = out[1] ?? out[0], g = this.gain;
    for (let i = 0; i < l.length; i++) {
      const b = this.q[0];
      if (!b) { l[i] = 0; r[i] = 0; continue; }
      l[i] = b[this.pos] * g; r[i] = b[this.pos + 1] * g;
      this.pos += 2; this.len--;
      if (this.pos >= b.length) { this.q.shift(); this.pos = 0; }
    }
    return true;
  }
}
registerProcessor('smwe-out', SmweOut);
`;

let workletUrl: string | null = null;

export class AudioOut {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private pushed = 0; // sample pairs sent since start
  private start = 0; // ctx.currentTime when pushed was 0
  private volume = 1;
  muted = false;
  failed = false;

  constructor() {
    try {
      this.ctx = new AudioContext({ sampleRate: APU_RATE, latencyHint: 'interactive' });
    } catch {
      try { this.ctx = new AudioContext({ latencyHint: 'interactive' }); } catch { this.failed = true; return; }
    }
    const ctx = this.ctx;
    workletUrl ??= URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    ctx.audioWorklet.addModule(workletUrl).then(() => {
      if (!this.ctx) return;
      this.node = new AudioWorkletNode(ctx, 'smwe-out', { numberOfInputs: 0, outputChannelCount: [2] });
      this.node.connect(ctx.destination);
      this.node.port.postMessage({ gain: this.muted ? 0 : this.volume });
      this.resync();
    }).catch(() => { this.failed = true; });
    void ctx.resume().catch(() => undefined);
  }

  get ready(): boolean { return !!this.node && this.ctx?.state === 'running'; }

  // sample pairs still queued (estimated from the audio clock)
  buffered(): number {
    if (!this.ctx || !this.node) return 0;
    return Math.max(0, this.pushed - (this.ctx.currentTime - this.start) * this.rate());
  }

  private rate(): number { return this.ctx?.sampleRate ?? APU_RATE; }

  // after a pause: start counting afresh
  resync(): void {
    if (!this.ctx) return;
    this.pushed = 0;
    this.start = this.ctx.currentTime;
    this.node?.port.postMessage({ clear: true });
  }

  push(samples: Int16Array): void {
    if (!this.node || !this.ctx) return;
    if (this.ctx.state !== 'running') { void this.ctx.resume().catch(() => undefined); return; }
    // queue ran dry (or never started): the clock went on without us
    if (this.buffered() <= 0) { this.pushed = 0; this.start = this.ctx.currentTime; }
    const ratio = this.rate() / APU_RATE;
    let f: Float32Array;
    if (ratio === 1) {
      f = new Float32Array(samples.length);
      for (let i = 0; i < samples.length; i++) f[i] = samples[i] / 32768;
    } else {
      // the context refused 32 kHz: resample linearly
      const n = Math.floor(samples.length / 2 * ratio);
      f = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        const x = i / ratio, j = Math.floor(x), t = x - j;
        const j1 = Math.min(j + 1, samples.length / 2 - 1);
        f[i * 2] = (samples[j * 2] * (1 - t) + samples[j1 * 2] * t) / 32768;
        f[i * 2 + 1] = (samples[j * 2 + 1] * (1 - t) + samples[j1 * 2 + 1] * t) / 32768;
      }
    }
    this.pushed += f.length / 2;
    this.node.port.postMessage(f, [f.buffer]);
  }

  setMuted(m: boolean): void {
    this.muted = m;
    this.node?.port.postMessage({ gain: m ? 0 : this.volume });
  }

  close(): void {
    this.node?.disconnect();
    this.node = null;
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
  }
}
