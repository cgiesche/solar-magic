// Plays music in the editor, one thing at a time: a level's music (or a song of the ROM in a level) by
// emulating the game with its sound unit – the level is loaded, and once the game has started the
// music only the SPC700 runs on (gameplay would go on and e.g. Mario die) – or an SPC file (AddmusicK's
// output for a song not yet inserted).

import type { App } from './app.ts';
import { LevelEmulator } from '../core/levelemu.ts';
import { Apu, apuReady, loadApu, APU_RATE } from '../core/apu.ts';
import { AudioOut } from './audio.ts';

const AHEAD = APU_RATE / 8; // sample pairs kept queued
const CHUNK = 1066; // samples (pairs × 2) per step once only the SPC runs, about one frame
const START_FRAMES = 40; // frames run after the level has loaded, so the game sends the music

type Listener = (label: string | null) => void;

class MusicPlayer {
  private audio: AudioOut | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private emu: LevelEmulator | null = null; // with a sound unit, booted for the current ROM
  private spcApu: Apu | null = null;
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

  stop(): void {
    this.token++;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
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

  private run(audio: AudioOut, token: number, next: () => Int16Array | null): void {
    this.timer = setInterval(() => {
      if (token !== this.token) return;
      if (audio.failed) { this.error = 'No audio output available'; this.stop(); return; }
      if (!audio.ready) return;
      for (let n = 0; n < 8 && audio.buffered() < audio.lead; n++) {
        const s = next();
        if (!s) { this.stop(); return; }
        audio.push(s);
      }
    }, 15);
  }

  // the music of `level` as the game plays it (song: another song of the ROM in its place)
  async playLevel(app: App, level: number, label: string, song?: number): Promise<void> {
    const { audio, token } = this.begin(label);
    try {
      if (!apuReady()) await loadApu();
      if (token !== this.token) return;
      if (!this.emu || this.emu.rom !== app.rom) {
        this.emu = new LevelEmulator(app.rom);
        this.emu.snes.apu = new Apu();
      }
      const emu = this.emu;
      emu.syncRom();
      const ov = { ...app.buildOverrides(), ...(song !== undefined ? { music: song } : {}) };
      if (level !== app.level.number) { delete ov.layer1; delete ov.layer2; delete ov.sprites; delete ov.bgData; delete ov.byteOwner; delete ov.secondaryHeader; }
      const r = emu.load(level, ov);
      if (!r.ok) throw new Error(r.error ?? 'level load failed');
      const s = emu.snes, apu = s.apu!;
      let frames = 0;
      this.run(audio, token, () => {
        if (frames < START_FRAMES) {
          frames++;
          s.runFrame();
          return s.audio;
        }
        return apu.play(CHUNK);
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
      this.run(audio, token, () => apu.play(CHUNK));
    } catch (e) {
      if (token !== this.token) return;
      this.error = String((e as Error).message ?? e);
      this.stop();
    }
  }
}

export const musicPlayer = new MusicPlayer();
