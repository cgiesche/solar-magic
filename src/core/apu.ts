// The SNES sound unit (SPC700 + S-DSP): snes_spc 0.9.0 by Shay Green (blargg, LGPL-2.1), compiled
// to WebAssembly (tools/build-spc.sh). Attached to a Snes (snes.apu) it replaces the fake of the
// upload protocol: the game sends its sound engine and music itself and the SPC700 runs it, so what
// plays is exactly what the ROM plays (vanilla, AddmusicK or anything else).

import type { SpcModule } from '../vendor/spc/spc.mjs';

export const APU_RATE = 32000; // stereo sample pairs per second
// SPC clocks (1.024 MHz) per frame of the emulated SNES (21.477 MHz / (1364 × 262) ≈ 60.1 fps)
export const APU_CLOCKS_PER_FRAME = 17039;

let mod: SpcModule | null = null;
let loading: Promise<SpcModule> | null = null;

export function apuReady(): boolean {
  return mod !== null;
}
export function loadApu(): Promise<SpcModule> {
  if (mod) return Promise.resolve(mod);
  loading ??= import('../vendor/spc/spc.mjs').then((a) => a.default()).then((m) => (mod = m));
  return loading;
}

const freed = new FinalizationRegistry<[number, number]>(([h, buf]) => { mod?._spcw_delete(h); mod?._free(buf); });
const MAX_FRAME_SAMPLES = 4096; // per end of frame (a frame has ~1065; long upload loops run several frames' time)

export class Apu {
  private readonly m: SpcModule;
  private readonly h: number;
  private readonly buf: number;

  constructor() {
    if (!mod) throw new Error('The sound emulator is not loaded yet');
    this.m = mod;
    this.h = mod._spcw_new();
    if (!this.h) throw new Error('Could not create the sound emulator');
    this.buf = mod._malloc(MAX_FRAME_SAMPLES * 2);
    freed.register(this, [this.h, this.buf], this);
  }

  reset(): void { this.m._spcw_reset(this.h); }
  // time: SPC clocks since the current frame began
  read(time: number, port: number): number { return this.m._spcw_read(this.h, time, port); }
  write(time: number, port: number, v: number): void { this.m._spcw_write(this.h, time, port, v); }

  // runs to time and starts the next frame; the samples of the frame (stereo interleaved, a copy)
  endFrame(time: number): Int16Array {
    const n = this.m._spcw_end_frame(this.h, time, this.buf, MAX_FRAME_SAMPLES);
    return this.m.HEAP16.slice(this.buf >> 1, (this.buf >> 1) + n);
  }

  // count samples (2 per stereo pair) with no CPU on the other side
  play(count: number): Int16Array {
    const out = new Int16Array(count);
    for (let o = 0; o < count; o += MAX_FRAME_SAMPLES) {
      const n = Math.min(MAX_FRAME_SAMPLES, count - o);
      this.m._spcw_play(this.h, n, this.buf);
      out.set(this.m.HEAP16.subarray(this.buf >> 1, (this.buf >> 1) + n), o);
    }
    return out;
  }

  save(): Uint8Array {
    const m = this.m;
    const p = m._malloc(m._spcw_state_size());
    try {
      const n = m._spcw_save(this.h, p);
      return m.HEAPU8.slice(p, p + n);
    } finally { m._free(p); }
  }
  load(st: Uint8Array): void {
    const m = this.m;
    const p = m._malloc(st.length);
    try {
      m.HEAPU8.set(st, p);
      m._spcw_load(this.h, p);
    } finally { m._free(p); }
  }

  // loads an .spc file (an SPC700 memory dump); false if it isn't one
  loadSpc(data: Uint8Array): boolean {
    const m = this.m;
    const p = m._malloc(data.length);
    try {
      m.HEAPU8.set(data, p);
      return m._spcw_load_spc(this.h, p, data.length) !== 0;
    } finally { m._free(p); }
  }

  mute(mask: number): void { this.m._spcw_mute(this.h, mask); }

  // the SPC's 64 KB of RAM (a copy)
  ram(): Uint8Array {
    const p = this.m._spcw_ram(this.h);
    return this.m.HEAPU8.slice(p, p + 0x10000);
  }

  dispose(): void {
    freed.unregister(this);
    this.m._spcw_delete(this.h);
    this.m._free(this.buf);
  }
}
