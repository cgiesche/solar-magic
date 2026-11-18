// The title screen page's title screen movement (core/titlemovement.ts): a timeline of the buttons the game's table
// holds, with a playhead – the title screen's picture is the game's at that frame –, played on the page, checked
// against the run as recorded (out of sync: a problem here, with the frame where the runs part), and recorded: the title screen level played from the title screen's own state with the keyboard or a gamepad, the
// buttons fed to the game through its table; Stop writes the recording into the table as one ROM edit – a recording
// of more pairs than the table holds with the editor's patch, which has the table in free space. Where the game plays
// its title screen without a table (a patch's way), the page says what plays it.

import type { App } from './app.ts';
import { h } from './dom.ts';
import { uiToken } from './marks.ts';
import { KEYMAP, readPads } from './testplay.ts';
import type { LevelEmulator } from '../core/levelemu.ts';
import type { SnesState } from '../core/snes.ts';
import { MOVE, MOVE_BUTTONS, MAX_RECORD_FRAMES, PATCH_PAIRS, TITLE_MOVE_PATCH_NAME, TitleSession, titleMovement, movementDrift, movementFit, removeMovementPatch, runState, writeMovement, moveFrames, movePairs, movementPlace,
  type TitleMovement, type MovementRun, type MovePair, type MovementDrift, type MovementEnd, type TitlePlays } from '../core/titlemovement.ts';
import { asarReady, loadAsar } from '../core/asar.ts';

const FPS = 60.0988; // the game's frames per second
const LABELS = 44, ROW = 12, RULER = 14; // the timeline: the button names' column, a button's row, the ruler (CSS pixels)

export interface MovementHost {
  app: App;
  emulator(): LevelEmulator;
  shown(): boolean; // the title screen page is on screen
  head(state: SnesState | null): void; // the picture is the game's at this machine state (null: as booted)
  frame(frame: Uint32Array): void; // a frame of the game running, to show
}

export class MovementView {
  readonly panel = h('div', { class: 'panel game-move' });
  readonly strip = h('div', { class: 'game-timeline' });
  private host: MovementHost;
  private canvas = h('canvas', { class: 'game-timeline-canvas' });
  private info = h('span', { class: 'hint' });
  private mv: TitleMovement | null = null;
  private run: MovementRun | null = null;
  private drift: (MovementDrift & { since: 'recorded' | 'opened' }) | null = null; // out of sync: where the runs part
  private error = '';
  private plays: TitlePlays = 'table'; // what plays the title screen level
  private playhead = 0; // a frame of the run (its count: after the last)
  private session: TitleSession | null = null;
  private armed = false; // recording: waiting for the first button
  private keys = 0;
  private raf = 0;
  private last = 0;
  private acc = 0;
  private note: { text: string; warn: boolean } | null = null; // what the last recording came to
  private scrub = 0;

  constructor(host: MovementHost) {
    this.host = host;
    this.strip.append(this.canvas, this.info);
    this.strip.hidden = true;
    const at = (e: PointerEvent) => {
      const r = this.canvas.getBoundingClientRect(), n = this.total();
      return Math.round(Math.max(0, Math.min(1, (e.clientX - r.left - LABELS) / Math.max(1, r.width - LABELS))) * n);
    };
    this.canvas.addEventListener('pointerdown', (e) => { if (this.session || !this.run) return; this.canvas.setPointerCapture(e.pointerId); this.seek(at(e)); });
    this.canvas.addEventListener('pointermove', (e) => { if (this.canvas.hasPointerCapture(e.pointerId)) this.seek(at(e)); });
    new ResizeObserver(() => this.draw()).observe(this.canvas);
    window.addEventListener('keydown', (e) => this.onKey(e, true), true);
    window.addEventListener('keyup', (e) => this.onKey(e, false), true);
    window.addEventListener('blur', () => { this.keys = 0; });
  }

  // the game runs on the page (played or recorded): the picture is not painted on meanwhile
  get live(): boolean { return this.session !== null; }

  // The movement as of the ROM shown (a run on the page is ended, a recording dropped); the machine at the playhead,
  // for the picture (null: as booted).
  sync(): SnesState | null {
    this.end();
    this.error = '';
    try {
      const k = titleMovement(this.host.emulator());
      this.mv = k.movement;
      this.run = k.run;
      this.plays = k.plays;
      this.drift = movementDrift(this.host.emulator());
    } catch (e) {
      this.mv = this.run = this.drift = null;
      this.error = String(e instanceof Error ? e.message : e);
    }
    this.playhead = Math.min(this.playhead, this.run?.frames ?? 0);
    this.build();
    this.draw();
    return this.state();
  }

  // the page is left: nothing runs on
  leave(): void { this.end(); this.build(); }

  // Esc drops a recording, ends a run played; whether it was taken
  key(e: KeyboardEvent): boolean {
    if (e.key !== 'Escape' || !this.session) return false;
    this.stop(false);
    return true;
  }

  private state(): SnesState | null {
    return this.run && this.playhead > 0 ? runState(this.host.emulator(), this.run, this.playhead) : null;
  }

  // the frames the timeline shows
  private total(): number {
    return Math.max(1, this.session?.recording ? this.session.buttons.length : this.run?.frames ?? 0);
  }

  // the playhead set (the picture follows at the next animation frame: a frame far from a kept state takes a moment)
  private seek(frame: number): void {
    if (!this.run || this.session) return;
    this.playhead = Math.max(0, Math.min(this.run.frames, frame));
    this.draw();
    if (this.scrub) return;
    this.scrub = requestAnimationFrame(() => { this.scrub = 0; if (!this.session) this.host.head(this.state()); });
  }

  private play(): void {
    const mv = this.mv, run = this.run;
    if (!mv || !run || this.session) return;
    if (this.playhead >= run.frames) this.playhead = 0;
    const emu = this.host.emulator();
    this.session = new TitleSession(emu, mv, false, this.playhead > 0 ? { frame: this.playhead, state: runState(emu, run, this.playhead) } : undefined);
    this.note = null;
    this.start();
  }

  private record(): void {
    const mv = this.mv;
    if (!mv || this.session) return;
    this.session = new TitleSession(this.host.emulator(), mv, true);
    this.armed = true;
    this.keys = 0;
    this.note = null;
    this.playhead = 0;
    this.host.head(null);
    this.start();
  }

  private start(): void {
    this.last = performance.now();
    this.acc = 0;
    this.build();
    this.draw();
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame((t) => this.tick(t));
  }

  private tick(now: number): void {
    const s = this.session;
    if (!s) return;
    if (!this.host.shown()) { this.stop(false); return; }
    const pad = this.keys | (s.recording ? readPads().bits : 0);
    if (this.armed && pad) this.armed = false;
    this.acc = Math.min(4, this.acc + (now - this.last) * FPS / 1000);
    this.last = now;
    let ran = false;
    try {
      for (; this.acc >= 1 && !this.armed; this.acc--) { if (!s.frame(pad)) break; ran = true; }
    } catch (e) {
      this.note = { text: `The emulated game stopped: ${e instanceof Error ? e.message : e}`, warn: true };
      this.stop(false, true);
      return;
    }
    if (this.armed) this.acc = 0;
    if (ran) {
      this.host.frame(s.ppu.frame);
      if (!s.recording) this.playhead = s.frames;
      this.draw();
    }
    if (s.end) { this.stop(true); return; }
    this.raf = requestAnimationFrame((t) => this.tick(t));
  }

  // the run on the page ended without a word (the ROM changed, the page was left)
  private end(): void {
    cancelAnimationFrame(this.raf);
    this.session = null;
    this.armed = false;
    this.keys = 0;
  }

  // The run on the page stopped. A recording: `write` – written into the game's table (not one in which Mario died
  // or left the level, or one that doesn't fit); else dropped.
  private stop(write: boolean, keepNote = false): void {
    const s = this.session, mv = this.mv;
    if (!s) return;
    this.end();
    if (s.recording && mv && !keepNote) {
      const n = s.buttons.length, pairs = movePairs(s.buttons).length;
      if (!write) this.note = { text: 'The recording was dropped.', warn: false };
      else if (s.end === 'died') this.note = { text: `Mario died at frame ${n}: not written. On the title screen a death is a game over, after which the game loads the title screen level as a level to play, again and again.`, warn: true };
      else if (s.end === 'left') this.note = { text: `The level was left at frame ${n}: not written. The title screen movement ends where its table ends, not with the level.`, warn: true };
      else if (!n) this.note = { text: 'Nothing was recorded.', warn: false };
      else {
        const app = this.host.app, fit = movementFit(app.rom, mv, s.buttons);
        const put = () => {
          try {
            // (the ROM edit shows the page anew: sync)
            const how = app.romEdit('Title screen movement recorded', () => writeMovement(app.rom, mv, s.buttons, s.run()));
            this.note = { text: `Recorded: ${n} frames (${seconds(n)}), ${pairs} pair${pairs === 1 ? '' : 's'} of buttons and frames${n >= MAX_RECORD_FRAMES ? ' – the longest the editor records' : ''}`
              + `${how === 'patch' && !mv.patched ? ` – more than the game's table holds (${mv.capacity}): the table is in free space now, read by the editor's patch "${TITLE_MOVE_PATCH_NAME}"` : ''}.`, warn: false };
          } catch (e) {
            this.note = { text: `${e instanceof Error ? e.message : e}. Not written.`, warn: true };
          }
        };
        if (fit.how === 'patch' && !asarReady()) {
          // (the patch is assembled: the assembler loads first; the ROM changed meanwhile, the recording is not of it)
          this.note = { text: 'Loading the assembler …', warn: false };
          const done = () => { this.build(); this.draw(); };
          loadAsar().then(() => { if (this.mv === mv && !this.session) put(); else this.note = { text: 'The ROM changed meanwhile: the recording was not written.', warn: true }; done(); },
            (e) => { this.note = { text: `The assembler did not load (${e instanceof Error ? e.message : e}). Not written.`, warn: true }; done(); });
        } else put();
      }
    }
    this.build();
    this.draw();
    this.host.head(this.state());
  }

  private unpatch(): void {
    const app = this.host.app;
    try {
      app.romEdit('Title screen movement table removed', () => removeMovementPatch(app.rom));
      this.note = { text: 'The patch is removed: the game plays the table it had in place before.', warn: false };
    } catch (e) { this.note = { text: String(e instanceof Error ? e.message : e), warn: true }; }
    this.build();
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    const s = this.session;
    if (!s?.recording || e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.key === ' ') { e.preventDefault(); e.stopPropagation(); if (down) this.armed = false; return; }
    const bit = KEYMAP[e.key];
    if (bit === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    this.keys = down ? this.keys | bit : this.keys & ~bit;
  }

  private build(): void {
    const mv = this.mv, run = this.run, s = this.session;
    const p = (text: string, cls = 'hint game-screen-about') => h('p', { class: cls }, text);
    const out: HTMLElement[] = [h('div', { class: 'panel-title' }, 'Title screen movement')];
    if (!mv || !run) {
      out.push(p(this.error ? `The game does not reach its title screen: ${this.error}`
        : this.plays === 'player' ? 'The title screen level is played by the player here: the game passes the joypad on to it instead of buttons from a table (a patch does this, as Playable Title Screen). There is no title screen movement to record.'
        : this.plays === 'none' ? 'Mario is given no buttons on the title screen here: the game holds none, from no table (a patch does this, as No Title Screen Movement). There is no title screen movement to record.'
        : 'The game plays its title screen level with buttons that are not from a table of buttons and frames the editor reads: a patch plays it its own way (several movements or another format, as Multiple Title Screen Demos or Lunar Magic\'s Title Moves). The movement can\'t be recorded here.'));
      this.panel.replaceChildren(...out);
      this.strip.hidden = true;
      return;
    }
    this.strip.hidden = false;
    const btn = (label: string, title: string, run_: () => void, cls = '') => h('button', { class: cls, title, onclick: run_ }, label);
    // (first: they stay where they are when a note comes or goes)
    out.push(h('div', { class: 'game-move-buttons' }, ...(s
      ? [btn(s.recording ? 'Stop and write' : 'Stop', s.recording ? 'Ends the recording and writes it into the game\'s table' : 'Stops at this frame', () => this.stop(true), 'primary'),
        ...(s.recording ? [btn('Drop', 'Ends the recording without writing it (Esc)', () => this.stop(false))] : [])]
      : [btn('Play', 'Plays the movement from the playhead, as the game does', () => this.play()),
        btn('Record', 'Plays the title screen level from the title screen\'s start and records the buttons', () => this.record()),
        ...(mv.patched ? [btn('Remove the patch', 'Removes the editor\'s patch: the game plays the table it had in place before. Needed before a patch of the title screen\'s code is installed (Playable Title Screen, Multiple Title Screen Demos, No Title Screen Movement): beside this one it is refused as a conflict', () => this.unpatch())] : [])])));
    const used = movePairs(moveFrames(mv.pairs)).length;
    out.push(p(`The buttons the game plays the title screen level with: ${run.frames === mv.frames ? mv.frames : `${run.frames} of ${mv.frames}`} frames (${seconds(run.frames)}), then it loads the title screen again. `
      + (mv.patched ? `The table is in free space at ${movementPlace(mv)}, read by the editor's patch "${TITLE_MOVE_PATCH_NAME}": it holds ${mv.capacity} pairs of buttons and frames; this movement needs ${used}.`
        : `The game's table at ${movementPlace(mv)} holds ${mv.capacity} pairs of buttons and frames; this movement needs ${used}. A recording of more pairs moves the table to free space (an editor patch; up to ${PATCH_PAIRS} pairs).`)));
    if (run.end === 'died') out.push(p(`Mario dies at frame ${run.frames}. On the title screen a death is a game over, after which the game loads the title screen level as a level to play, again and again.`, 'warn-box game-move-note'));
    else if (run.end !== 'table') out.push(p(`The level is left at frame ${run.frames}, before the table ends.`, 'warn-box game-move-note'));
    const d = this.drift;
    if (d) {
      const ended = (e: MovementEnd) => (e === 'died' ? 'Mario had died' : e === 'left' ? 'the level was left' : 'the movement had ended');
      const where = d.was && d.now ? `Mario is at ${d.now.x}, ${d.now.y} after it, and was at ${d.was.x}, ${d.was.y}`
        : d.now ? `the run goes on there, and ${ended(d.endWas)}` : `${d.endNow === 'died' ? 'Mario dies' : d.endNow === 'left' ? 'the level is left' : 'the movement ends'} there, and the run went on`;
      out.push(h('div', { class: 'warn-box game-move-note' },
        `Out of sync: the game no longer plays the movement as ${d.since === 'recorded' ? 'it was recorded' : 'it did when the ROM was opened'}. The runs part at frame ${d.frame}: ${where} ${d.since === 'recorded' ? 'when recorded' : 'then'}. `
        + 'A change to the title screen level, its sprites, blocks or code does this. Record the movement again, or undo the change. ',
        h('button', { title: 'The playhead at the frame where the runs part', onclick: () => this.seek(d.frame) }, `Show frame ${d.frame}`)));
    }
    if (this.note) out.push(p(this.note.text, this.note.warn ? 'warn-box game-move-note' : 'hint game-screen-about'));
    if (s?.recording) out.push(p('Recording starts with the first button (Space: with none held). Arrow keys; X is B (jump), Z is Y (run, and what Y does when pressed) – or a gamepad. The game\'s table has no A, L, R, Start or Select: they are not recorded. A button of the table is pressed anew every frame it is held: Mario jumps again as soon as he lands while B is held.'));
    else out.push(p('Click the timeline for the picture at a frame. Recording replaces the movement; undo brings it back.'));
    this.panel.replaceChildren(...out);
  }

  // the timeline: a row per button, held where it is filled; a mark where Y is pressed; the playhead
  private draw(): void {
    const c = this.canvas, mv = this.mv, s = this.session;
    const w = c.clientWidth, hgt = RULER + MOVE_BUTTONS.length * ROW, dpr = window.devicePixelRatio || 1;
    c.style.height = `${hgt}px`;
    if (!w || !mv) { this.info.textContent = ''; return; }
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(hgt * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(hgt * dpr); }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = uiToken('--surface', '#13161b');
    ctx.fillRect(0, 0, w, hgt);
    const pairs: MovePair[] = s?.recording ? movePairs(s.buttons) : mv.pairs, n = this.total(), scale = (w - LABELS) / n;
    const x = (f: number) => LABELS + f * scale;
    ctx.font = `10px ${uiToken('--font-ui', 'sans-serif')}`;
    ctx.textBaseline = 'middle';
    MOVE_BUTTONS.forEach((b, k) => {
      const y = RULER + k * ROW;
      ctx.fillStyle = uiToken(k & 1 ? '--surface' : '--surface-2', '#1e232b');
      ctx.fillRect(LABELS, y, w - LABELS, ROW);
      ctx.fillStyle = uiToken('--text-muted', '#9aa3b2');
      ctx.fillText(b.name, 4, y + ROW / 2 + 0.5);
      let f = 0;
      for (const [bits, len] of pairs) {
        if (bits & b.bit) {
          ctx.fillStyle = uiToken('--accent', '#4d8dff');
          ctx.fillRect(x(f), y + 1, Math.max(1, len * scale), ROW - 2);
          if (b.bit === MOVE.y && bits & MOVE.yPress) { ctx.fillStyle = uiToken('--warning', '#f5a524'); ctx.fillRect(x(f), y, Math.max(2, scale), ROW); }
        }
        f += len;
      }
    });
    // the ruler: a tick every second (fewer where they would crowd)
    ctx.fillStyle = uiToken('--text-muted', '#9aa3b2');
    let step = 1;
    while (step * FPS * scale < 40) step *= step === 1 ? 5 : 2;
    for (let sec = 0; sec * FPS <= n; sec += step) {
      ctx.fillRect(x(sec * FPS), RULER - 3, 1, 3);
      ctx.fillText(`${sec}s`, x(sec * FPS) + 3, RULER / 2);
    }
    const run = this.run;
    if (run && !s?.recording && run.end !== 'table') { ctx.fillStyle = uiToken('--danger', '#ff6b6b'); ctx.fillRect(x(run.frames) - 1, RULER, 2, hgt - RULER); }
    if (this.drift && !s?.recording) { ctx.fillStyle = uiToken('--warning', '#f5a524'); ctx.fillRect(x(Math.min(this.drift.frame, n)) - 1, 0, 2, RULER); ctx.fillRect(x(Math.min(this.drift.frame, n)), RULER, 1, hgt - RULER); }
    const head = s?.recording ? s.buttons.length : this.playhead;
    ctx.fillStyle = uiToken('--text', '#e6e8ee');
    ctx.fillRect(Math.min(w - 1, x(head)), 0, 1, hgt);
    // the frame's line
    if (s?.recording) {
      this.info.textContent = this.armed ? 'Recording: waiting for the first button'
        : `Recording: frame ${s.buttons.length} (${seconds(s.buttons.length)}), ${pairs.length} pair${pairs.length === 1 ? '' : 's'} – the game's table holds ${mv.capacity}${mv.patched ? '' : `, in free space ${PATCH_PAIRS}`}`;
    } else if (run) {
      const frames = moveFrames(mv.pairs), b = frames[this.playhead] ?? 0;
      const held = MOVE_BUTTONS.filter((k) => b & k.bit).map((k) => k.name).join(' + ') || 'no button';
      this.info.textContent = `Frame ${this.playhead} of ${run.frames}${this.playhead < frames.length ? `: ${held}` : ''}${this.playhead > 0 ? ` – Mario at ${run.x[this.playhead - 1]}, ${run.y[this.playhead - 1]}` : ''}`;
    }
  }
}

const seconds = (frames: number) => `${(frames / FPS).toFixed(1)} s`;
