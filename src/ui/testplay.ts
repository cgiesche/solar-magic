// "Test level": runs the edited level in the built-in emulator (video, sound, input) – or the game from the
// overworld (core/playsession.ts fromOverworld). The sound unit is emulated too (apu.ts): the game uploads and
// plays its music and sound effects itself.

import type { App } from './app.ts';
import { h, modal, toast } from './dom.ts';
import { LevelEmulator } from '../core/levelemu.ts';
import type { PPU } from '../core/ppu.ts';
import { PlaySession } from '../core/playsession.ts';
import { hex } from '../core/names.ts';
import type { StartEntrance } from '../core/level.ts';
import { l1XY, OW_EVENTS } from '../core/overworld.ts';
import type { ProgressSave } from '../core/owprogress.ts';
import { Apu, apuReady, loadApu } from '../core/apu.ts';
import { AudioOut } from './audio.ts';
import { musicPlayer } from './musicplayer.ts';
import { RAM, PAD, GM, marioX, marioY, levelLoaded } from '../core/ram.ts';
import { SlotWatch } from '../core/slotwatch.ts';
import { DeathWatch } from '../core/deaths.ts';
import { addDeath, levelVersion } from './deathmarks.ts';
import { projectId } from '../core/projectid.ts';
import { PlayLog } from '../core/playlog.ts';
import { playMeter, GRAPH_FRAMES } from './playmeter.ts';
import { applyTriggers, emptyTriggerView, customOn, switchName, isCustom, isManual, isOneShot, CUSTOM, MANUAL, ONE_SHOT } from '../core/extrigger.ts';
import { shownSwitches } from './triggerpanel.ts';
import { SaveSlot } from '../core/savestate.ts';
import type { SnesState } from '../core/snes.ts';

const KEYMAP: Record<string, number> = {
  ArrowUp: PAD.up, ArrowDown: PAD.down, ArrowLeft: PAD.left, ArrowRight: PAD.right,
  x: PAD.b, X: PAD.b, // B: jump
  z: PAD.y, Z: PAD.y, y: PAD.y, Y: PAD.y, // Y: run / fire
  s: PAD.a, S: PAD.a, // A: spin jump
  a: PAD.x, A: PAD.x, // X
  Enter: PAD.start, Shift: PAD.select, q: PAD.l, Q: PAD.l, w: PAD.r, W: PAD.r,
};

// Gamepad API "standard" layout, by position (an SNES-style pad lines up 1:1, an Xbox pad's bottom button is B)
const PADMAP: [number, number][] = [
  [0, PAD.b], [1, PAD.a], [2, PAD.y], [3, PAD.x], // bottom = B, right = A, left = Y, top = X
  [4, PAD.l], [5, PAD.r], [6, PAD.l], [7, PAD.r], // shoulders and triggers = L / R
  [8, PAD.select], [9, PAD.start], // Select, Start
  [12, PAD.up], [13, PAD.down], [14, PAD.left], [15, PAD.right], // d-pad
];
const PAD_PAUSE = 16; // home / guide button
const PAD_SELECT = 8, PAD_L = [4, 6], PAD_R = [5, 7]; // Select+L saves the state, Select+R loads it
const PAD_COMBO = PAD.select | PAD.l | PAD.r; // Select, L, R: not passed to the game while a combo is held
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
    if (ax < -0.5) bits |= PAD.left; else if (ax > 0.5) bits |= PAD.right;
    if (ay < -0.5) bits |= PAD.up; else if (ay > 0.5) bits |= PAD.down;
  }
  return { bits, pause, save, load, names };
}

let testEmu: LevelEmulator | null = null;
let soundMuted = false; // kept between test runs
// the one savestate (F5 / F8): kept between test runs, for its level on the ROM as it was then
const saveSlot = new SaveSlot<SnesState>();

// where test play starts: the open level (at: Mario's start tile instead of the main entrance, with the camera
// start, options and action of the entrance played from – PlaySession.test; show: a message box open once the level
// runs, messages.ts messageToShow; yoshi: Mario brings Yoshi along), or the overworld (a new game at the event
// progress with its save – owprogress.ts, none: a new file's –, Mario on layer 1 tile `tile` – < 0: at the start
// position; PlaySession.fromOverworld; showLevel: shows a tile of a level in the level editor, when a moment of the
// meters is shown)
type Start = { tx: number; ty: number; entrance?: StartEntrance };
type ShowMessage = { message: number; yoshi: boolean };
type ShowLevel = (level: number, at: { x: number; y: number }) => void;
type Origin = { kind: 'level'; at?: Start; show?: ShowMessage } | { kind: 'overworld'; tile: number; progress: number; save?: ProgressSave; showLevel: ShowLevel };

// fromSave: from the savestate instead of the start (when there is a usable one)
export function openTestPlay(app: App, at?: Start, fromSave = false, show?: ShowMessage): void {
  begin(app, { kind: 'level', at, show }, fromSave);
}
// the game from the overworld: events 0 … progress-1 passed (the overworld view's event progress) with the save
// learned for it (App.progressSave), Mario on layer 1 tile `tile` (l1Index; < 0: at the start position); the levels
// entered from there are the ROM's
// (save: while it is being learned, what gives it: the test starts then, the sound started within the key press)
export function openOverworldTestPlay(app: App, tile: number, progress: number, save: ProgressSave | Promise<ProgressSave | undefined> | undefined, showLevel: ShowLevel, fromSave = false): void {
  const o: Origin = { kind: 'overworld', tile, progress, showLevel };
  if (save instanceof Promise) begin(app, o, fromSave, save.then((v) => { o.save = v; }));
  else begin(app, { ...o, save }, fromSave);
}

// (ready: what the start waits for besides the sound emulator)
function begin(app: App, o: Origin, fromSave: boolean, ready?: Promise<void>): void {
  // saved first: the game loads the level from the ROM again when Mario dies and enters it again
  if (app.dirty) app.saveLevel(true);
  // the game plays its own music
  musicPlayer.stop();
  // the sound emulator loads once; the audio context must start within the key press or click
  const audio = new AudioOut(AUDIO_LEAD);
  if (!apuReady() || ready) {
    const go = () => start(app, o, audio, fromSave);
    Promise.all([apuReady() ? undefined : loadApu().catch(() => {}), ready]).then(go, go);
    return;
  }
  start(app, o, audio, fromSave);
}

// the savestate's place: a level's number, a test from the overworld's below 0, by its tile and event progress
const slotOf = (app: App, o: Origin) => (o.kind === 'level' ? app.level.number : -1 - ((o.tile + 1) * 0x100 + o.progress));

function start(app: App, o: Origin, audio: AudioOut, fromSave: boolean): void {
  if (!testEmu || testEmu.rom !== app.rom) {
    testEmu = new LevelEmulator(app.rom);
    if (apuReady()) testEmu.snes.apu = new Apu();
    testEmu.boot();
  }
  const emu = testEmu;
  const saved = fromSave ? saveSlot.get(app.rom, slotOf(app, o), app.dirty) : null;
  let p: PlaySession, ok = true;
  if (saved) p = PlaySession.resume(emu);
  else if (o.kind === 'level') {
    const lv = app.level;
    p = PlaySession.test(emu, lv.number, {
      ov: app.buildOverrides(), show: o.show,
      at: o.at && { ...o.at, level: { secondary: lv.secondary, maxScreen: lv.header.screens - 1, rows: app.entranceRows() } },
    });
    ok = p.render?.ok === true;
  } else {
    try { p = PlaySession.fromOverworld(emu, o.tile, o.progress, o.save); } catch (e) { p = PlaySession.resume(emu); ok = false; toast(`The overworld did not load: ${e instanceof Error ? e.message : e}`, 'error'); }
  }
  const ppu = p.attachPPU();
  // with the PPU attached: the frame on screen is part of the state
  if (saved) p.load(saved);
  play(app, o, audio, p, ppu, ok, !!saved);
}

// what the title says the test starts from
function originText(app: App, o: Origin): string {
  if (o.kind === 'level') return `Test level – ${hex(app.level.number, 3)}${o.at ? ` from ${hex(o.at.tx, 2)}/${hex(o.at.ty, 2)}` : ''}`;
  const { x, y } = l1XY(o.tile), progress = o.progress === 0 ? 'none' : o.progress >= OW_EVENTS ? 'all' : `up to ${hex(o.progress - 1, 2)}`;
  return `Test play – overworld, ${o.tile < 0 ? 'start position' : `tile ${hex(x, 2)},${hex(y, 2)} (${o.tile >= 0x400 ? 'submaps' : 'main map'})`}, event progress: ${progress}`;
}

function play(app: App, o: Origin, audio: AudioOut, p: PlaySession, ppu: PPU, ok: boolean, fromSave: boolean): void {
  const lv = app.level, slot = slotOf(app, o);
  const canvas = h('canvas', { width: 256, height: 224, class: 'play-canvas', tabIndex: 0 });
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(256, 224);
  const info = h('div', { class: 'hint' });
  // the sprite slots and Mario's deaths, watched from here on
  const watch = p.watch((s) => new SlotWatch(s)), deaths = p.watch((s) => new DeathWatch(s)), log = new PlayLog(GRAPH_FRAMES);
  const meter = playMeter(log, (tx, ty, level = lv.number) => {
    m.close();
    if (o.kind === 'overworld') o.showLevel(level, { x: tx, y: ty });
    else app.showUse(level, { x: tx, y: ty });
  }, (id) => app.spriteLabel(id));
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
  const usable = () => saveSlot.get(app.rom, slot, app.dirty);
  const saveState = () => { saveSlot.save(app.rom, slot, p.save()); say('State saved'); showRestartSaved(); };
  const loadState = () => {
    const st = usable();
    if (!st) { say('No savestate'); showRestartSaved(); return; }
    p.load(st);
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
    let busy = 0;
    try { busy = p.frame(keys | readPads().bits); } catch (e) { info.textContent = `Emulation error: ${e}`; paused = true; }
    if (p.audio) audio.push(p.audio);
    frames++;
    log.frame(frames, watch.usedAll(), watch.take(), busy, marioX(p.wram), marioY(p.wram), p.mode === GM.level ? levelLoaded(p.wram) : undefined);
    // kept as markers in the level he died in
    for (const d of deaths.take()) { log.died(frames, d); addDeath(projectId(app.rom), d, levelVersion(app.rom, d.level)); }
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
    if (audio.ready && p.hasSound) {
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
    // (from the overworld: the level being played, while one is)
    const where = o.kind === 'level' ? `Level ${hex(lv.number, 3)}` : p.mode === GM.level ? `Level ${hex(levelLoaded(p.wram), 3)}` : 'Overworld';
    info.textContent = `${where} · Frame ${frames}${paused ? ' · Pause' : ''} · Game mode ${hex(p.mode, 2)}`
      + (note && t < noteUntil ? ` · ${note}` : '')
      + (padNames.length ? ` · Gamepad: ${padNames.join(', ')}` : ' · Gamepad: none detected (press a button)')
      + (!p.hasSound || audio.failed ? ' · No sound' : soundMuted ? ' · Sound off (M)' : '');
    schedule();
  };
  // requestAnimationFrame pauses in hidden tabs; fall back to timers there
  const schedule = () => { if (document.hidden) setTimeout(() => loop(performance.now()), 16); else requestAnimationFrame(loop); };
  schedule();
  const stop = () => {
    if (!running) return;
    running = false;
    if (log.deaths.length) app.emit('change'); // the level view shows them
    p.close();
    audio.close();
    window.removeEventListener('keydown', kd, true);
    window.removeEventListener('keyup', ku, true);
  };
  // (the open level's triggers: from the overworld other levels are played)
  const triggers = o.kind === 'level' ? triggerControls(app, p.wram, () => canvas.focus()) : '';
  const m = modal(`${originText(app, o)}${fromSave ? ' – from the savestate' : ''}${ok ? '' : ' (load error)'}`, h('div', { class: 'play' },
    h('div', { class: 'play-main' }, canvas, meter.el),
    info,
    triggers,
    h('div', { class: 'hint play-help' }, `Controls: arrows · X = jump (B) · Z/Y = run/fire (Y) · S = spin jump · A = X button · Enter = Start · Shift = Select · Q/W = L/R · P = pause. Gamepad: d-pad/left stick, buttons by position as on the SNES pad (bottom = B, right = A, left = Y, top = X), shoulder buttons/triggers = L/R, Start/Select, Home = pause. M = sound on/off. F5 = save state, F8 = load state (gamepad: Select+L / Select+R; one slot, kept for this ${o.kind === 'level' ? 'level' : 'test from the overworld'} until it or the ROM changes). ${o.kind === 'level' ? 'The level is saved before the test.' : 'The open level is saved before the test; levels entered on the overworld play as saved.'}`),
  ), [
    { label: 'Restart from savestate', onClick: () => { setTimeout(() => begin(app, o, true), 0); } },
    { label: 'Restart', onClick: () => { setTimeout(() => begin(app, o, false), 0); } },
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
