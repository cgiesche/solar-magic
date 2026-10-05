// "Test level": runs the edited level in the built-in emulator (video + input, no sound).

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

// Gamepad API "standard" layout, by position (an SNES-style pad lines up 1:1, an Xbox pad's bottom button is B)
const PADMAP: [number, number][] = [
  [0, 0x8000], [1, 0x0080], [2, 0x4000], [3, 0x0040], // bottom = B, right = A, left = Y, top = X
  [4, 0x0020], [5, 0x0010], [6, 0x0020], [7, 0x0010], // shoulders and triggers = L / R
  [8, 0x2000], [9, 0x1000], // Select, Start
  [12, 0x0800], [13, 0x0400], [14, 0x0200], [15, 0x0100], // d-pad
];
const PAD_PAUSE = 16; // home / guide button

// buttons of all connected gamepads; pause: the pause button is held on one of them
function readPads(): { bits: number; pause: boolean; names: string[] } {
  let bits = 0, pause = false;
  const names: string[] = [];
  for (const p of navigator.getGamepads?.() ?? []) {
    if (!p || !p.connected) continue;
    names.push(p.id.replace(/\s*\(.*$/, '') || `Gamepad ${p.index + 1}`);
    const pressed = (i: number) => !!p.buttons[i]?.pressed;
    for (const [i, bit] of PADMAP) if (pressed(i)) bits |= bit;
    if (pressed(PAD_PAUSE)) pause = true;
    const ax = p.axes[0] ?? 0, ay = p.axes[1] ?? 0;
    if (ax < -0.5) bits |= 0x0200; else if (ax > 0.5) bits |= 0x0100;
    if (ay < -0.5) bits |= 0x0800; else if (ay > 0.5) bits |= 0x0400;
  }
  return { bits, pause, names };
}

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
  // a game in progress (lives, overworld with Mario on the level's tile): dying returns there
  const translevel = levelTranslevel(app.rom, lv.number);
  let r: ReturnType<LevelEmulator['load']>;
  try {
    emu.startGame(translevel);
    r = emu.load(lv.number, { ...ov, translevel, continueState: true });
  } catch {
    r = emu.load(lv.number, { ...ov, translevel });
  }
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
  let padPause = false;
  let padNames: string[] = [];
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
    const pad = readPads();
    if (pad.pause && !padPause) paused = !paused;
    padPause = pad.pause;
    padNames = pad.names;
    let n = 0;
    while (acc >= 1000 / 60 && n < 4) {
      acc -= 1000 / 60;
      if (!paused) {
        s.joy1 = keys | pad.bits;
        try { s.runFrame(); } catch (e) { info.textContent = `Emulation error: ${e}`; paused = true; }
        frames++;
      }
      n++;
    }
    new Uint32Array(img.data.buffer).set(ppu.frame);
    ctx.putImageData(img, 0, 0);
    info.textContent = `Level ${hex(lv.number, 3)} · Frame ${frames}${paused ? ' · Pause' : ''} · Game mode ${hex(s.wram[0x100], 2)}`
      + (padNames.length ? ` · Gamepad: ${padNames.join(', ')}` : ' · Gamepad: none detected (press a button)');
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
  const m = modal(`Test level – ${hex(lv.number, 3)}${at ? ` from ${hex(at.tx, 2)}/${hex(at.ty, 2)}` : ''}${r.ok ? '' : ' (load error)'}`, h('div', { class: 'play' },
    canvas,
    info,
    h('div', { class: 'hint' }, 'Controls: arrows · X = jump (B) · Z/Y = run/fire (Y) · A = spin jump · S = X button · Enter = Start · Shift = Select · Q/W = L/R · P = pause. Gamepad: d-pad/left stick, buttons by position as on the SNES pad (bottom = B, right = A, left = Y, top = X), shoulder buttons/triggers = L/R, Start/Select, Home = pause. No sound. Unsaved changes are included in the test.'),
  ), [{ label: 'Restart', onClick: () => { setTimeout(() => openTestPlay(app, at), 0); } }, { label: 'Quit', primary: true }], stop);
  void m;
  canvas.focus();
}
