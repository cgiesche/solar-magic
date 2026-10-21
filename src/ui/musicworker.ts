// Web Worker playing music once only the SPC700 runs on (see musicplayer.ts): the sound unit's state
// (or an SPC file) comes in with a port of the audio worklet, which asks for sample pairs as it needs
// them. Computing in the page then doesn't make the music stutter.

import { Apu, loadApu, APU_RATE } from '../core/apu.ts';
import { toOutput } from './audio.ts';

export type MusicMessage =
  | { type: 'play'; state?: Uint8Array; spc?: Uint8Array; port: MessagePort; rate: number }
  | { type: 'stop' };
export type MusicReply = { type: 'error'; error: string };

const scope = self as unknown as { postMessage(m: MusicReply): void; onmessage: ((e: MessageEvent<MusicMessage>) => void) | null };
let apu: Apu | null = null;
let port: MessagePort | null = null;
let token = 0;

const stop = () => {
  token++;
  if (port) { port.onmessage = null; port.close(); port = null; }
};

scope.onmessage = async (e) => {
  const m = e.data;
  stop();
  if (m.type !== 'play') return;
  const t = token;
  try {
    await loadApu();
    if (t !== token) { m.port.close(); return; }
    apu ??= new Apu();
    if (m.spc) { if (!apu.loadSpc(m.spc)) throw new Error('not an SPC file'); } else if (m.state) apu.load(m.state);
    const a = apu, ratio = m.rate / APU_RATE;
    port = m.port;
    // n sample pairs at the output rate
    port.onmessage = (q: MessageEvent<number>) => port?.postMessage(...out(toOutput(a.play(Math.ceil(q.data / ratio) * 2), m.rate)));
  } catch (err) {
    m.port.close();
    scope.postMessage({ type: 'error', error: String((err as Error).message ?? err) });
  }
};

const out = (f: Float32Array): [Float32Array, Transferable[]] => [f, [f.buffer]];
