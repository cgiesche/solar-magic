// "Level testen": runs the edited level in the built-in emulator (video + input, no sound).

import type { App } from './app.ts';
import { h, modal } from './dom.ts';
import { LevelEmulator } from '../core/levelemu.ts';
import { PPU } from '../core/ppu.ts';
import { hex } from '../core/names.ts';
import { levelTranslevel, nearestEntrance, encodeSecondaryHeader } from '../core/level.ts';

const KEYMAP: Record<string, number> = {
  ArrowUp: 0x0800, ArrowDown: 0x0400, ArrowLeft: 0x0200, ArrowRight: 0x0100,
  x: 0x8000, X: 0x8000, // B: jump
  z: 0x4000, Z: 0x4000, y: 0x4000, Y: 0x4000, // Y: run / fire
  a: 0x0080, A: 0x0080, // A: spin jump
  s: 0x0040, S: 0x0040, // X
  Enter: 0x1000, Shift: 0x2000, q: 0x0020, Q: 0x0020, w: 0x0010, W: 0x0010,
};

let testEmu: LevelEmulator | null = null;

// at: Mario's start tile (his feet stand in it) instead of the main entrance
export function openTestPlay(app: App, at?: { tx: number; ty: number }): void {
  if (!testEmu || testEmu.rom !== app.rom) {
    testEmu = new LevelEmulator(app.rom);
    testEmu.boot();
  }
  const emu = testEmu;
  emu.syncRom();
  const lv = app.level;
  const ov = app.buildOverrides();
  // the start position: the nearest main entrance setting loads the level around it (camera, tilemap),
  // in gameplay Mario is then moved to the exact pixel
  const start = at && { x: at.tx * 16, y: at.ty * 16 - 16 };
  if (start) {
    const sec = { ...lv.secondary };
    const p = nearestEntrance(app.rom, start.x, start.y, (sec.verticalPositioning & 1) !== 0, lv.header.screens - 1);
    sec.entranceScreen = p.screen; sec.entranceX = p.ex; sec.entranceY = p.ey;
    sec.entranceAction = 0;
    ov.secondaryHeader = encodeSecondaryHeader(sec);
  }
  const r = emu.load(lv.number, { ...ov, translevel: levelTranslevel(app.rom, lv.number) });
  const s = emu.snes;
  if (start && r.ok) {
    try { for (let i = 0; i < 80 && s.wram[0x100] !== 0x14; i++) s.runFrame(); } catch { /* shown when playing */ }
    const w = s.wram;
    w[0x94] = start.x & 0xff; w[0x95] = start.x >> 8;
    w[0x96] = start.y & 0xff; w[0x97] = (start.y >> 8) & 0xff;
  }
  // sub-level loads keep the old timer; give the level its header time
  const hundreds = app.rom.r8(0x0584d7 + lv.header.time);
  s.wram[0x0f31] = hundreds; s.wram[0x0f32] = 0; s.wram[0x0f33] = 0;
  const ppu = new PPU(s);
  s.ppu = ppu;
  const canvas = h('canvas', { width: 256, height: 224, class: 'play-canvas', tabIndex: 0 });
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(256, 224);
  const info = h('div', { class: 'hint' });
  let keys = 0;
  let running = true;
  let paused = false;
  let last = performance.now();
  let acc = 0;
  let frames = 0;
  const onKey = (down: boolean) => (e: KeyboardEvent) => {
    const bit = KEYMAP[e.key];
    if (e.key === 'p' || e.key === 'P') { if (down) paused = !paused; e.preventDefault(); return; }
    if (bit === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    keys = down ? keys | bit : keys & ~bit;
  };
  const kd = onKey(true), ku = onKey(false);
  window.addEventListener('keydown', kd, true);
  window.addEventListener('keyup', ku, true);
  const loop = (t: number) => {
    if (!running) return;
    acc += Math.min(100, t - last);
    last = t;
    let n = 0;
    while (acc >= 1000 / 60 && n < 4) {
      acc -= 1000 / 60;
      if (!paused) {
        s.joy1 = keys;
        try { s.runFrame(); } catch (e) { info.textContent = `Emulationsfehler: ${e}`; paused = true; }
        frames++;
      }
      n++;
    }
    new Uint32Array(img.data.buffer).set(ppu.frame);
    ctx.putImageData(img, 0, 0);
    info.textContent = `Level ${hex(lv.number, 3)} · Frame ${frames}${paused ? ' · Pause' : ''} · Spielmodus ${hex(s.wram[0x100], 2)}`;
    schedule();
  };
  // requestAnimationFrame pauses in hidden tabs; fall back to timers there
  const schedule = () => { if (document.hidden) setTimeout(() => loop(performance.now()), 16); else requestAnimationFrame(loop); };
  schedule();
  const stop = () => {
    if (!running) return;
    running = false;
    s.ppu = null;
    window.removeEventListener('keydown', kd, true);
    window.removeEventListener('keyup', ku, true);
  };
  const m = modal(`Level testen – ${hex(lv.number, 3)}${at ? ` ab ${hex(at.tx, 2)}/${hex(at.ty, 2)}` : ''}${r.ok ? '' : ' (Ladefehler)'}`, h('div', { class: 'play' },
    canvas,
    info,
    h('div', { class: 'hint' }, 'Steuerung: Pfeile · X = Springen (B) · Z/Y = Rennen/Feuer (Y) · A = Drehsprung · S = X-Taste · Enter = Start · Shift = Select · Q/W = L/R · P = Pause. Ohne Ton. Ungespeicherte Änderungen werden mitgetestet.'),
  ), [{ label: 'Neu starten', onClick: () => { setTimeout(() => openTestPlay(app, at), 0); } }, { label: 'Beenden', primary: true }], stop);
  void m;
  canvas.focus();
}
