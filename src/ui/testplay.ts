// "Test level": runs the edited level in the built-in emulator (video, sound, input). The sound unit
// is emulated too (apu.ts): the game uploads and plays its music and sound effects itself.

import type { App } from './app.ts';
import { h, modal } from './dom.ts';
import { LevelEmulator } from '../core/levelemu.ts';
import { PPU } from '../core/ppu.ts';
import { hex } from '../core/names.ts';
import { levelTranslevel, encodeSecondaryHeader, startHeader, entrancePos, mainSpot, type StartEntrance } from '../core/level.ts';
import { Apu, apuReady, loadApu } from '../core/apu.ts';
import { AudioOut } from './audio.ts';
import { musicPlayer } from './musicplayer.ts';
import { GM, RAM, marioX, marioY, setMarioPos } from '../core/ram.ts';
import { SlotWatch } from '../core/slotwatch.ts';
import { DeathWatch } from '../core/deaths.ts';
import { addDeath } from './deathmarks.ts';
import { PlayLog, cpuLoad } from '../core/playlog.ts';
import { playMeter, GRAPH_FRAMES } from './playmeter.ts';
import { applyTriggers, emptyTriggerView, customOn, switchName, isCustom, isManual, isOneShot, CUSTOM, MANUAL, ONE_SHOT } from '../core/extrigger.ts';
import { shownSwitches } from './triggerpanel.ts';
import { SaveSlot } from '../core/savestate.ts';
import { joinHooks, type SnesState } from '../core/snes.ts';

const KEYMAP: Record<string, number> = {
  ArrowUp: 0x0800, ArrowDown: 0x0400, ArrowLeft: 0x0200, ArrowRight: 0x0100,
  x: 0x8000, X: 0x8000, // B: jump
  z: 0x4000, Z: 0x4000, y: 0x4000, Y: 0x4000, // Y: run / fire
  s: 0x0080, S: 0x0080, // A: spin jump
  a: 0x0040, A: 0x0040, // X
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
const PAD_SELECT = 8, PAD_L = [4, 6], PAD_R = [5, 7]; // Select+L saves the state, Select+R loads it
const PAD_COMBO = 0x2000 | 0x0020 | 0x0010; // Select, L, R: not passed to the game while a combo is held
const AUDIO_LEAD = 1800; // sample pairs to keep queued at first (~56 ms; grows after underruns)

// buttons of all connected gamepads; pause: the pause button is held on one of them; save / load: Select+L /
// Select+R held on one of them (Select, L and R are then left out of bits)
function readPads(): { bits: number; pause: boolean; save: boolean; load: boolean; names: string[] } {
  let bits = 0, pause = false, save = false, load = false;
  const names: string[] = [];
  for (const p of navigator.getGamepads?.() ?? []) {
    if (!p || !p.connected) continue;
    names.push(p.id.replace(/\s*\(.*$/, '') || `Gamepad ${p.index + 1}`);
    const pressed = (i: number) => !!p.buttons[i]?.pressed;
    let pb = 0;
    for (const [i, bit] of PADMAP) if (pressed(i)) pb |= bit;
    if (pressed(PAD_PAUSE)) pause = true;
    const sel = pressed(PAD_SELECT), l = sel && PAD_L.some(pressed), r = sel && PAD_R.some(pressed);
    if (l) save = true;
    if (r) load = true;
    bits |= l || r ? pb & ~PAD_COMBO : pb;
    const ax = p.axes[0] ?? 0, ay = p.axes[1] ?? 0;
    if (ax < -0.5) bits |= 0x0200; else if (ax > 0.5) bits |= 0x0100;
    if (ay < -0.5) bits |= 0x0800; else if (ay > 0.5) bits |= 0x0400;
  }
  return { bits, pause, save, load, names };
}

let testEmu: LevelEmulator | null = null;
let soundMuted = false; // kept between test runs
// the one savestate (F5 / F8): kept between test runs, for its level on the ROM as it was then
const saveSlot = new SaveSlot<SnesState>();

// at: Mario's start tile (his feet stand in it) instead of the main entrance, with the camera start, options
// (face left, water) and action of the entrance played from (a secondary entrance's; else the main entrance's
// without an action); fromSave: from the savestate instead of the level start (when there is a usable one)
type Start = { tx: number; ty: number; entrance?: StartEntrance };
export function openTestPlay(app: App, at?: Start, fromSave = false): void {
  // saved first: the game loads the level from the ROM again when Mario dies and enters it again
  if (app.dirty) app.saveLevel(true);
  // the game plays its own music
  musicPlayer.stop();
  // the sound emulator loads once; the audio context must start within the key press or click
  const audio = new AudioOut(AUDIO_LEAD);
  if (!apuReady()) {
    loadApu().then(() => start(app, at, audio, fromSave), () => start(app, at, audio, fromSave));
    return;
  }
  start(app, at, audio, fromSave);
}

function start(app: App, at: Start | undefined, audio: AudioOut, fromSave: boolean): void {
  if (!testEmu || testEmu.rom !== app.rom) {
    testEmu = new LevelEmulator(app.rom);
    if (apuReady()) testEmu.snes.apu = new Apu();
    testEmu.boot();
  }
  const emu = testEmu;
  const lv = app.level;
  const saved = fromSave ? saveSlot.get(app.rom, lv.number, app.dirty) : null;
  const r = saved ? { ok: true } : loadLevel(app, emu, at);
  const ppu = new PPU(emu.snes);
  emu.snes.ppu = ppu;
  // with the PPU attached: the picture on screen is part of the state
  if (saved) emu.snes.loadState(saved);
  play(app, at, audio, emu, ppu, r.ok, !!saved);
}

// loads the level in a game in progress, Mario at the start position
function loadLevel(app: App, emu: LevelEmulator, at: Start | undefined): { ok: boolean } {
  const lv = app.level;
  const ov = app.buildOverrides();
  // the start position: the nearest main entrance setting loads the level around it (camera, tilemap; FG and
  // BG start as set), in gameplay Mario is then moved to the exact pixel – with an entrance action by how far
  // the setting is from it, keeping where the action put him (in the pipe, shot out of it)
  const start = at && { x: at.tx * 16, y: at.ty * 16 - 16 };
  let move: { x: number; y: number } | undefined;
  if (start) {
    const sec = startHeader(app.rom, lv.secondary, start.x, start.y, lv.header.screens - 1, app.entranceRows(), at.entrance);
    const p = entrancePos(app.rom, mainSpot(sec), (sec.verticalPositioning & 1) !== 0);
    if (sec.entranceAction) move = { x: start.x - p.x, y: start.y - p.y };
    ov.secondaryHeader = encodeSecondaryHeader(sec);
  }
  // a game in progress (lives, overworld with Mario on the level's tile, entered from there so that the
  // midway point counts): dying returns there
  const translevel = levelTranslevel(app.rom, lv.number);
  let r: ReturnType<LevelEmulator['load']>;
  try {
    emu.startGame(translevel);
    r = emu.loadInGame(lv.number, translevel, ov);
  } catch {
    r = emu.load(lv.number, { ...ov, translevel });
  }
  const s = emu.snes;
  if (start && r.ok) {
    try { for (let i = 0; i < 80 && s.wram[RAM.gameMode] !== GM.level; i++) s.runFrame(); } catch { /* shown when playing */ }
    const w = s.wram;
    if (move) setMarioPos(w, marioX(w) + move.x, marioY(w) + move.y);
    else setMarioPos(w, start.x, start.y);
  }
  return r;
}

function play(app: App, at: Start | undefined, audio: AudioOut, emu: LevelEmulator, ppu: PPU, ok: boolean, fromSave: boolean): void {
  const s = emu.snes, lv = app.level;
  const canvas = h('canvas', { width: 256, height: 224, class: 'play-canvas', tabIndex: 0 });
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(256, 224);
  const info = h('div', { class: 'hint' });
  // the sprite slots and Mario's deaths, watched from here on
  const watch = new SlotWatch(s), deaths = new DeathWatch(s), log = new PlayLog(GRAPH_FRAMES);
  s.hook = joinHooks(watch.hook, deaths.hook);
  const meter = playMeter(log, (tx, ty, level = lv.number) => { m.close(); app.showUse(level, { x: tx, y: ty }); }, (id) => app.spriteLabel(id));
  let keys = 0;
  let running = true;
  let paused = false;
  let last = performance.now();
  let acc = 0;
  let frames = 0;
  let padPause = false;
  let padSave = false, padLoad = false;
  let padNames: string[] = [];
  // a brief note in the info line (savestate saved / loaded), until `until`
  let note = '', noteUntil = 0;
  const say = (t: string) => { note = t; noteUntil = performance.now() + 2000; };
  const usable = () => saveSlot.get(app.rom, lv.number, app.dirty);
  const saveState = () => { saveSlot.save(app.rom, lv.number, s.saveState()); say('State saved'); showRestartSaved(); };
  const loadState = () => {
    const st = usable();
    if (!st) { say('No savestate'); showRestartSaved(); return; }
    s.loadState(st);
    watch.reset();
    deaths.reset();
    log.cut();
    audio.resync();
    say('State loaded');
  };
  audio.setMuted(soundMuted);
  const onKey = (down: boolean) => (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return; // the trigger's frame
    const bit = KEYMAP[e.key];
    if (e.key === 'p' || e.key === 'P') { if (down) setPaused(!paused); e.preventDefault(); return; }
    if (e.key === 'm' || e.key === 'M') { if (down) { soundMuted = !soundMuted; audio.setMuted(soundMuted); } e.preventDefault(); return; }
    if (e.key === 'F5' || e.key === 'F8') {
      e.preventDefault(); // F5 would reload the page
      e.stopPropagation();
      if (down && !e.repeat) { if (e.key === 'F5') saveState(); else loadState(); }
      return;
    }
    if (bit === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    keys = down ? keys | bit : keys & ~bit;
  };
  const kd = onKey(true), ku = onKey(false);
  window.addEventListener('keydown', kd, true);
  window.addEventListener('keyup', ku, true);
  const setPaused = (p: boolean) => { paused = p; audio.resync(); };
  const frame = () => {
    s.joy1 = keys | readPads().bits;
    const mode = s.wram[RAM.gameMode];
    try { s.runFrame(); } catch (e) { info.textContent = `Emulation error: ${e}`; paused = true; }
    if (s.audio) audio.push(s.audio);
    frames++;
    log.frame(frames, watch.usedAll(), watch.take(), cpuLoad(s, mode), marioX(s.wram), marioY(s.wram));
    // kept as markers in the level he died in
    for (const d of deaths.take()) { log.died(frames, d); addDeath(app.romName, d); }
  };
  const loop = (t: number) => {
    if (!running) return;
    acc += Math.min(100, t - last);
    last = t;
    const pad = readPads();
    if (pad.pause && !padPause) setPaused(!paused);
    padPause = pad.pause;
    if (pad.save && !padSave) saveState();
    padSave = pad.save;
    if (pad.load && !padLoad) loadState();
    padLoad = pad.load;
    padNames = pad.names;
    let n = 0;
    if (audio.ready && s.apu) {
      // paced by the audio clock: keep ~3 frames queued
      acc = 0;
      while (!paused && audio.buffered() < audio.lead && n < 4) { frame(); n++; }
    } else {
      while (acc >= 1000 / 60 && n < 4) {
        acc -= 1000 / 60;
        if (!paused) frame();
        n++;
      }
    }
    new Uint32Array(img.data.buffer).set(ppu.frame);
    ctx.putImageData(img, 0, 0);
    meter.update();
    info.textContent = `Level ${hex(lv.number, 3)} · Frame ${frames}${paused ? ' · Pause' : ''} · Game mode ${hex(s.wram[RAM.gameMode], 2)}`
      + (note && t < noteUntil ? ` · ${note}` : '')
      + (padNames.length ? ` · Gamepad: ${padNames.join(', ')}` : ' · Gamepad: none detected (press a button)')
      + (!s.apu || audio.failed ? ' · No sound' : soundMuted ? ' · Sound off (M)' : '');
    schedule();
  };
  // requestAnimationFrame pauses in hidden tabs; fall back to timers there
  const schedule = () => { if (document.hidden) setTimeout(() => loop(performance.now()), 16); else requestAnimationFrame(loop); };
  schedule();
  const stop = () => {
    if (!running) return;
    running = false;
    if (log.deaths.length) app.emit('change'); // the level view shows them
    s.ppu = null;
    s.hook = null;
    audio.close();
    window.removeEventListener('keydown', kd, true);
    window.removeEventListener('keyup', ku, true);
  };
  const triggers = triggerControls(app, s.wram, () => canvas.focus());
  const m = modal(`Test level – ${hex(lv.number, 3)}${fromSave ? ' from the savestate' : at ? ` from ${hex(at.tx, 2)}/${hex(at.ty, 2)}` : ''}${ok ? '' : ' (load error)'}`, h('div', { class: 'play' },
    h('div', { class: 'play-main' }, canvas, meter.el),
    info,
    triggers,
    h('div', { class: 'hint play-help' }, 'Controls: arrows · X = jump (B) · Z/Y = run/fire (Y) · S = spin jump · A = X button · Enter = Start · Shift = Select · Q/W = L/R · P = pause. Gamepad: d-pad/left stick, buttons by position as on the SNES pad (bottom = B, right = A, left = Y, top = X), shoulder buttons/triggers = L/R, Start/Select, Home = pause. M = sound on/off. F5 = save state, F8 = load state (gamepad: Select+L / Select+R; one slot, kept for this level until it or the ROM changes). The level is saved before the test.'),
  ), [
    { label: 'Restart from savestate', onClick: () => { setTimeout(() => openTestPlay(app, at, true), 0); } },
    { label: 'Restart', onClick: () => { setTimeout(() => openTestPlay(app, at), 0); } },
    { label: 'Quit', primary: true },
  ], stop);
  // shown while there is a savestate to start from
  function showRestartSaved(): void { m.buttons[0].hidden = !usable(); }
  showRestartSaved();
  canvas.focus();
}

// fires one of the level's ExAnimation triggers in the running game (extrigger.ts): a one-shot plays once,
// a custom trigger turns on or off, a manual one shows the frame, a game condition is set (the view's
// triggers are set at the start already)
function triggerControls(app: App, w: Uint8Array, done: () => void): HTMLElement | string {
  const used = [...shownSwitches(app).keys()];
  if (!used.length) return '';
  const sel = h('select', { title: 'An animation trigger of this level' }, used.map((t) => h('option', { value: String(t) }, t === 0x03 ? 'ON/OFF switch' : switchName(t))));
  const frame = h('input', { class: 'hex', value: '00', size: 3, maxLength: 2, spellcheck: false, title: 'The frame to show (hex 00–FE)' });
  const btn = h('button');
  const label = () => {
    const t = Number(sel.value);
    frame.style.display = isManual(t) ? '' : 'none';
    btn.textContent = isManual(t) ? 'Show frame' : isCustom(t) || t === 0x03 ? 'Switch' : isOneShot(t) ? 'Fire' : 'Set';
  };
  sel.addEventListener('change', label);
  btn.addEventListener('click', () => {
    const t = Number(sel.value), v = emptyTriggerView();
    if (isManual(t)) v.manual.set(t - MANUAL, Math.min(0xfe, parseInt(frame.value, 16) || 0));
    else if (isCustom(t)) v.custom.set(t - CUSTOM, !customOn(w, t - CUSTOM));
    else if (isOneShot(t)) v.oneShot.add(t - ONE_SHOT);
    else if (t === 0x03) w[RAM.onOff] ^= 1;
    else v.game.add(t);
    applyTriggers(w, v);
    done();
  });
  label();
  return h('div', { class: 'row' }, h('span', { class: 'hint' }, 'Animation trigger'), sel, frame, btn);
}
