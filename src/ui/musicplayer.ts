// Plays music in the editor, one thing at a time: a level's music (or a song of the ROM in a level) or a submap's
// song by emulating the game with its sound unit – the level (the overworld on that submap) is loaded, and once
// the game has started the music only the SPC700 runs on (gameplay would go on and e.g. Mario die) – or an SPC
// file (AddmusicK's output for a song not yet inserted). Once only the SPC700 runs, it runs in a worker (musicworker.ts)
// that feeds the audio output directly, so computing in the page doesn't make the music stutter.

import type { App } from './app.ts';
import { LevelEmulator } from '../core/levelemu.ts';
import { Apu, apuReady, loadApu, APU_RATE } from '../core/apu.ts';
import { AudioOut } from './audio.ts';
import type { MusicMessage, MusicReply } from './musicworker.ts';

const AHEAD = APU_RATE / 8; // sample pairs kept queued
const CHUNK = 1066; // samples (pairs × 2) per step once only the SPC runs, about one frame (without the worker)
const START_FRAMES = 40; // frames run after the level (the overworld) has loaded, so the game sends the music

type Listener = (label: string | null) => void;

// the label of the open level's music, looped by the app bar's toggle while editing
export const LEVEL_MUSIC = 'level-music';
// the label of submap `map`'s song, listened to in the overworld workspace (isSubmapMusic: any of them)
export const submapMusicLabel = (map: number): string => `submap:${map}`;
export const isSubmapMusic = (label: string | null): boolean => !!label?.startsWith('submap:');

class MusicPlayer {
  private audio: AudioOut | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private emu: LevelEmulator | null = null; // with a sound unit, booted for the current ROM
  private spcApu: Apu | null = null;
  private worker: Worker | null = null;
  private noWorker = false; // it failed: the SPC700 runs in the page
  private listeners = new Set<Listener>();
  private token = 0;
  label: string | null = null;
  error: string | null = null;

  onChange(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  private emit(): void { for (const l of this.listeners) l(this.label); }

  get playing(): boolean { return this.label !== null; }
  // background work waits while something is listened to; not for the level's music, which plays on
  // while editing (the work would wait until it is turned off)
  get holdsBackground(): boolean { return this.playing && this.label !== LEVEL_MUSIC; }

  stop(): void {
    this.token++;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.post({ type: 'stop' });
    this.audio?.close();
    this.audio = null;
    if (this.label !== null) { this.label = null; this.emit(); }
  }

  // start within the click: the audio context needs the user's gesture
  private begin(label: string): { audio: AudioOut; token: number } {
    this.stop();
    this.error = null;
    this.audio = new AudioOut(AHEAD);
    this.label = label;
    this.emit();
    return { audio: this.audio, token: this.token };
  }

  private post(m: MusicMessage, transfer: Transferable[] = []): void { this.worker?.postMessage(m, transfer); }

  // hands playing over to the worker (state: the sound unit's, or spc: a file); false if there's none
  private toWorker(audio: AudioOut, m: { state?: Uint8Array; spc?: Uint8Array }): boolean {
    if (this.noWorker) return false;
    if (!this.worker) {
      try {
        const w = new Worker(new URL('./musicworker.ts', import.meta.url), { type: 'module' });
        w.onmessage = (e: MessageEvent<MusicReply>) => { this.error = e.data.error; this.stop(); };
        w.onerror = (e) => { console.error(e); w.terminate(); this.worker = null; this.noWorker = true; this.stop(); };
        this.worker = w;
      } catch { this.noWorker = true; return false; }
    }
    const ch = new MessageChannel();
    if (!audio.feed(ch.port1)) return false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.post({ type: 'play', ...m, port: ch.port2, rate: audio.sampleRate }, [ch.port2, ...(m.state ? [m.state.buffer] : []), ...(m.spc ? [m.spc.buffer] : [])]);
    return true;
  }

  // runs next() while the output wants samples, unless handOff() handed playing over to the worker
  private run(audio: AudioOut, token: number, next: () => Int16Array | null, handOff: () => boolean): void {
    this.timer = setInterval(() => {
      if (token !== this.token) return;
      if (audio.failed) { this.error = audio.failReason; this.stop(); return; }
      if (!audio.ready) return;
      if (handOff()) return;
      for (let n = 0; n < 8 && audio.buffered() < audio.lead; n++) {
        const s = next();
        if (!s) { this.stop(); return; }
        audio.push(s);
      }
    }, 15);
  }

  // the music of `level` as the game plays it (song: another song of the ROM in its place)
  playLevel(app: App, level: number, label: string, song?: number): Promise<void> {
    return this.playGame(app, label, (emu) => {
      const ov = { ...app.buildOverrides(), ...(song !== undefined ? { music: song } : {}) };
      if (level !== app.level.number) { delete ov.layer1; delete ov.layer2; delete ov.sprites; delete ov.bgData; delete ov.byteOwner; delete ov.secondaryHeader; }
      const r = emu.load(level, ov);
      if (!r.ok) throw new Error(r.error ?? 'level load failed');
    });
  }

  // the song of submap `map` as the game plays it: a new game, the overworld loaded there (with the overworld's
  // sound bank, which without AddmusicK is another than the levels'); events: the event bits the game has
  playSubmap(app: App, map: number, label: string, events?: Uint8Array): Promise<void> {
    return this.playGame(app, label, (emu) => emu.loadOverworldOn(map, events));
  }

  // the game emulated with its sound unit: start() gets it to where the music plays, then it runs on until the
  // game has sent the music, after which only the SPC700 runs
  private async playGame(app: App, label: string, start: (emu: LevelEmulator) => void): Promise<void> {
    const { audio, token } = this.begin(label);
    try {
      if (!apuReady()) await loadApu();
      if (token !== this.token) return;
      if (!this.emu || this.emu.rom !== app.rom) {
        this.emu = new LevelEmulator(app.rom);
        this.emu.snes.apu = new Apu();
      }
      const emu = this.emu;
      start(emu);
      const s = emu.snes, apu = s.apu!;
      let frames = 0, handed = false;
      this.run(audio, token, () => {
        if (frames < START_FRAMES) {
          frames++;
          s.runFrame();
          return s.audio;
        }
        return apu.play(CHUNK);
      }, () => {
        if (frames < START_FRAMES || handed) return false;
        handed = true;
        return this.toWorker(audio, { state: apu.save() });
      });
    } catch (e) {
      if (token !== this.token) return;
      this.error = String((e as Error).message ?? e);
      this.stop();
    }
  }

  // an SPC file (an SPC700 memory dump with the song started)
  async playSpc(spc: Uint8Array, label: string): Promise<void> {
    const { audio, token } = this.begin(label);
    try {
      if (!apuReady()) await loadApu();
      if (token !== this.token) return;
      this.spcApu ??= new Apu();
      if (!this.spcApu.loadSpc(spc)) throw new Error('not an SPC file');
      const apu = this.spcApu;
      let handed = false;
      this.run(audio, token, () => apu.play(CHUNK), () => {
        if (handed) return false;
        handed = true;
        return this.toWorker(audio, { spc: spc.slice() });
      });
    } catch (e) {
      if (token !== this.token) return;
      this.error = String((e as Error).message ?? e);
      this.stop();
    }
  }
}

export const musicPlayer = new MusicPlayer();
