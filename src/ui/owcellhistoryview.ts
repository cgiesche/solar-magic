// A layer 1 cell's history over the game (#359) in a popup: the mouse resting on a cell of the overworld map for a
// moment (no button held – painting and dragging go on as before) shows what each event changes there, in number order
// and the player's words (core/owcellhistory.ts); a click on an entry sets the playthrough strip there (ADR 0013).
// The popup stays while the mouse is on it, and goes when the mouse rests on another cell, a button is pressed or the
// map scrolls.
// An event's layer 1 change there (its layer 1 changes, reveal, destroy) is moved to another event (#360,
// core/owmovechange.ts) by dragging its entry onto an event of the strip – the popup staying while dragged – or by its
// "Move to…" and a click on an event of the strip: the connected tiles the event changes, with Alt held this tile only.
// The map shows the tiles moving (red: refused), a label by the mouse what the drop does or why it can't; dropped, one
// ROM edit, the strip on the target event, a toast how many tiles moved. Layer 2 entries aren't moved.

import { h, toast } from './dom.ts';
import type { OverworldView } from './overworld.ts';
import { cellHistory, historyWords, layer1AtEveryProgress } from '../core/owcellhistory.ts';
import { eventRunners, eventWords, eventTitle, readEvents, type EventData, type EventRunner } from '../core/owevents.ts';
import { planMove, moveChange, BEFORE_EVENTS, type MoveAsk, type MovePlan } from '../core/owmovechange.ts';
import { cellText } from '../core/oweventtiles.ts';
import { l1Hex } from '../core/owl1sheet.ts';
import type { PathKind } from '../core/owpaths.ts';
import { refusalText, refusedToast } from './owrefusal.ts';

const REST_MS = 700; // the mouse resting on a cell this long shows its history
const LEAVE_MS = 300; // the time to move from the cell into the popup
const DRAG_PX = 4; // the mouse moved this far with the button held on an entry: a drag (else a click)
// a tile's path kind in a word (none for a tile that is no path)
const KIND_WORDS: Record<PathKind, string> = { walk: 'path', climb: 'climbing path', swim: 'water path', exit: 'exit path', stop: 'stop', level: 'level tile', none: '' };
// a layer 1 tile in words: its number and path kind ("66 path"; the editor has no names of tiles)
export function tileWords(kinds: readonly PathKind[] | null, t: number): string {
  const k = kinds?.[t];
  return k && KIND_WORDS[k] ? `${l1Hex(t)} ${KIND_WORDS[k]}` : l1Hex(t);
}

// View → Cell history kept in the browser (on unless switched off)
const PREF = 'ow-cell-history';

// a change being moved: the cell and event, dragged (the button held) or picked (after "Move to…"), the event of the
// strip under the mouse (null none), Alt held; the events, maps and level exits running the events read once (the ROM
// doesn't change meanwhile), the plans made per target and Alt
interface Moving {
  cell: number; from: number; drag: boolean; to: number | null; alt: boolean;
  d: EventData; maps: Uint16Array[]; runners: Map<number, EventRunner[]>; plans: Map<string, MovePlan>; label: HTMLElement;
}

export class CellHistoryPopup {
  private el = h('div', { class: 'ow-history' });
  private cell = -1; // the cell shown (-1: none)
  private rest = 0; // the timer showing the cell rested on
  private leave = 0; // the timer hiding the popup after the mouse left its cell
  private at = { x: 0, y: 0 }; // where the mouse rests (client pixels)
  private over = false; // the mouse on the popup
  on = loadOn(); // shown at all (View → Cell history, kept in the browser)
  private moving: Moving | null = null;
  private pressAt: { x: number; y: number; cell: number; from: number } | null = null; // the button pressed on a movable entry
  private dragged = false; // the press on an entry became a drag (its click then doesn't choose the event)

  // the popup's own mouse: on it it stays, left it goes (not while a change is dragged from it)
  constructor(private view: OverworldView) {
    this.el.addEventListener('mouseenter', () => { this.over = true; clearTimeout(this.leave); clearTimeout(this.rest); });
    this.el.addEventListener('mouseleave', () => { this.over = false; if (!this.moving && !this.pressAt) this.close(); });
    window.addEventListener('mousedown', (e) => {
      this.dragged = false;
      // (a move picked: the press goes to no other control – its click moves or cancels)
      if (this.moving && !this.moving.drag) { e.preventDefault(); e.stopPropagation(); return; }
      // (a press anywhere else: gone)
      if (this.el.isConnected && !this.el.contains(e.target as Node)) this.close();
    }, true);
    window.addEventListener('mousemove', (e) => this.moveOver(e));
    window.addEventListener('mouseup', (e) => { this.pressAt = null; if (this.moving?.drag) this.drop(e); });
    // (a move picked: a click on an event of the strip moves it there, anywhere else cancels)
    window.addEventListener('click', (e) => {
      if (!this.moving || this.moving.drag) return;
      e.preventDefault();
      e.stopPropagation();
      this.drop(e);
    }, true);
    const alt = (e: KeyboardEvent, on: boolean) => {
      if (!this.moving || e.key !== 'Alt') return;
      e.preventDefault(); // (no menu bar)
      this.moving.alt = on;
      this.preview();
    };
    window.addEventListener('keydown', (e) => alt(e, true));
    window.addEventListener('keyup', (e) => alt(e, false));
  }

  // View → Cell history switched on or off
  setOn(v: boolean): void {
    this.on = v;
    storeOn(v);
    if (!v) this.close();
  }

  // the mouse on cell i (l1Index; -1 off the map) at client x, y; busy: a button held or something dragged
  hover(i: number, x: number, y: number, busy: boolean): void {
    clearTimeout(this.rest);
    if (this.moving) return;
    if (busy) { this.close(); return; }
    if (i === this.cell) { clearTimeout(this.leave); return; }
    if (this.cell >= 0 && !this.over) { clearTimeout(this.leave); this.leave = window.setTimeout(() => { if (!this.over) this.hide(); }, LEAVE_MS); }
    if (i < 0 || !this.on) return;
    this.at = { x, y };
    this.rest = window.setTimeout(() => this.show(i), REST_MS);
  }

  // no popup, none coming (the map scrolled or zoomed, another submap or mode, a button pressed elsewhere) – it stays
  // while a change is dragged from it
  close(): void {
    clearTimeout(this.rest);
    if (this.moving?.drag) return;
    this.cancelMove();
    this.hide();
  }
  // the popup gone (one for the cell rested on next may still come)
  private hide(): void {
    clearTimeout(this.leave);
    this.cell = -1;
    this.over = false;
    this.el.remove();
  }

  // the popup for cell i, the entry at the strip's event progress marked
  private show(i: number): void {
    if (!this.view.root.isConnected) return; // (the overworld no longer shown)
    const v = this.view, rom = v.app.rom, runners = eventRunners(rom), kinds = v.pathKinds();
    const tile = (t: number) => tileWords(kinds, t);
    const hist = cellHistory(rom, i, kinds ? v.isLevelTile : undefined);
    const entries = historyWords(hist, tile, (e) => eventWords(runners, e, v.levelWords));
    // (an event's layer 1 change can be moved; the map before events and layer 2 steps not)
    const movable = (k: number) => k > 0 && !!hist.changes[k - 1].l1;
    this.cell = i;
    const build = () => {
      let now = 0;
      entries.forEach((x, k) => { if (x.event <= v.event) now = k; });
      this.el.replaceChildren(
        h('div', { class: 'ow-history-head' }, `Tile at ${cellText(i)} over the game`),
        ...entries.map((x, k) => h('div', { class: 'ow-history-row' },
          h('button', {
            class: `ow-history-entry${k === now ? ' active' : ''}${movable(k) ? ' movable' : ''}`,
            title: x.event < 0 ? 'Show the map before events in the strip'
              : `Show the map as after this event in the strip (painting goes into it)${movable(k) ? ' – drag it onto another event of the strip to move the change there (the connected tiles the event changes; Alt: this tile only)' : ' – a change of layer 2: its steps stay with the event'}`,
            onclick: () => { if (!this.dragged) { v.setEvent(x.event); build(); } this.dragged = false; },
            onmousedown: (e: MouseEvent) => { if (movable(k) && e.button === 0) this.press(e, i, x.event); },
          }, k ? `→ ${x.text}` : x.text),
          movable(k) ? h('button', {
            class: 'ow-history-move', title: 'Move this change to another event: then click the event in the strip (Alt held: this tile only; Esc cancels)',
            onclick: (e: MouseEvent) => { e.stopPropagation(); this.startMove(i, x.event, false, e); },
          }, 'Move to…') : null)),
        ...(entries.length === 1 ? [h('div', { class: 'hint' }, 'No event changes it.')] : []),
      );
    };
    build();
    document.body.append(this.el);
    const r = this.el.getBoundingClientRect();
    this.el.style.left = `${Math.max(4, Math.min(this.at.x + 14, innerWidth - r.width - 4))}px`;
    this.el.style.top = `${Math.max(4, Math.min(this.at.y + 14, innerHeight - r.height - 4))}px`;
  }

  // ---- a change moved to another event (#360) ----
  // the button pressed on a movable entry: a drag once the mouse moves
  private press(e: MouseEvent, cell: number, from: number): void {
    this.pressAt = { x: e.clientX, y: e.clientY, cell, from };
    this.dragged = false;
    e.preventDefault(); // (no text selected while dragging)
  }
  // a move begun (drag: the button held, the popup stays; else picked, the popup gone), the change's tiles shown
  private startMove(cell: number, from: number, drag: boolean, e: MouseEvent): void {
    const rom = this.view.app.rom, d = readEvents(rom);
    this.cancelMove();
    const label = h('div', { class: 'ow-move-label' });
    document.body.append(label);
    this.moving = { cell, from, drag, to: null, alt: e.altKey, d, maps: layer1AtEveryProgress(rom, d), runners: eventRunners(rom), plans: new Map(), label };
    if (!drag) this.hide();
    this.moveOver(e);
  }
  // the mouse moved: a press becoming a drag; while moving, the event of the strip under the mouse the target
  private moveOver(e: MouseEvent): void {
    const p = this.pressAt;
    if (p && !this.moving) {
      if (!(e.buttons & 1)) { this.pressAt = null; return; }
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_PX) return;
      this.pressAt = null;
      this.dragged = true;
      this.startMove(p.cell, p.from, true, e);
      return;
    }
    const m = this.moving;
    if (!m) return;
    if (m.drag && !(e.buttons & 1)) { this.cancelMove(); return; } // (the button let go outside the window)
    m.alt = e.altKey;
    m.to = targetAt(e);
    m.label.style.left = `${e.clientX + 14}px`;
    m.label.style.top = `${e.clientY + 14}px`;
    this.scrollStrip(e);
    this.preview();
  }
  // the mouse near the strip's ends scrolls it
  private scrollStrip(e: MouseEvent): void {
    const list = this.view.root.querySelector<HTMLElement>('.ow-strip-list');
    if (!list) return;
    const r = list.getBoundingClientRect();
    if (e.clientY < r.top - 20 || e.clientY > r.bottom + 20) return;
    if (e.clientX < r.left + 40) list.scrollLeft -= 16;
    else if (e.clientX > r.right - 40) list.scrollLeft += 16;
  }
  // the move of m's change to `to` (single: Alt held)
  private ask(m: Moving, to: number, single: boolean): MoveAsk {
    return { cell: m.cell, from: m.from, to, single, submap: (i) => this.view.submapHere(i) };
  }
  // what moving to `to` does (kept per target and Alt)
  private plan(m: Moving, to: number): MovePlan {
    const key = `${to}:${m.alt}`;
    let p = m.plans.get(key);
    if (!p) m.plans.set(key, p = planMove(this.view.app.rom, this.ask(m, to, m.alt), m.d, m.maps));
    return p;
  }
  // an event (or the map before events) in the player's words
  private words(runners: Map<number, EventRunner[]>, e: number): string {
    return e === BEFORE_EVENTS ? 'the map before events' : eventWords(runners, e, this.view.levelWords);
  }
  // the tiles moving on the map, the label what a drop does, the target event marked in the strip
  private preview(): void {
    const m = this.moving, v = this.view;
    if (!m) return;
    const to = m.to, p = this.plan(m, to ?? m.from), words = (e: number) => this.words(m.runners, e);
    const refused = to !== null && to !== m.from && !!p.refusal;
    v.movePreview = { cells: p.cells, refused };
    v.paint();
    for (const c of v.root.querySelectorAll<HTMLElement>('.ow-strip-chip')) {
      const here = to !== null && to !== m.from && c.dataset.event === String(to);
      c.classList.toggle('ow-drop', here && !refused);
      c.classList.toggle('ow-drop-refused', here && refused);
    }
    const n = `${p.cells.length} tile${p.cells.length === 1 ? '' : 's'}${m.alt ? '' : ' (Alt: this one only)'}`;
    m.label.textContent = to === null ? `Move ${n} from ${words(m.from)}: ${m.drag ? 'drop' : 'click'} on an event of the strip (Esc cancels)`
      : to === m.from ? `Already in ${words(m.from)}`
      : p.refusal ? refusalText(v.app.rom, p.refusal)
      : `Move ${n} from ${words(m.from)} to ${words(to)}${p.layer2 ? ` – the layer 2 look stays in ${words(m.from)}` : ''}`;
    m.label.classList.toggle('refused', refused);
  }
  // the drop (or the click after "Move to…"): on an event of the strip moved there, one ROM edit (refused: the reason);
  // elsewhere nothing
  private drop(e: MouseEvent): void {
    const m = this.moving;
    if (!m) return;
    const to = targetAt(e), single = e.altKey;
    this.cancelMove();
    if (to === null || to === m.from) return;
    const v = this.view, rom = v.app.rom, runners = m.runners, words = (x: number) => this.words(runners, x);
    const title = (x: number) => (x === BEFORE_EVENTS ? 'Before events' : eventTitle(runners, x));
    let done: MovePlan;
    try {
      done = v.app.romEdit(`${title(m.from)} → ${title(to)}: tiles moved`, () => moveChange(rom, this.ask(m, to, single)));
    } catch (err) {
      refusedToast(rom, err, 'Not moved: ');
      return;
    }
    this.hide();
    v.setEvent(to);
    const n = done.cells.length;
    toast(`${n} cell${n === 1 ? '' : 's'} moved from ${words(m.from)} to ${words(to)}${done.layer2 ? ` (the layer 2 look stays in ${words(m.from)})` : ''}`);
  }
  // no move under way (Esc, a drop, the popup closed); whether one was
  cancelMove(): boolean {
    const m = this.moving;
    this.pressAt = null;
    if (!m) return false;
    this.moving = null;
    m.label.remove();
    const v = this.view;
    v.movePreview = null;
    for (const c of v.root.querySelectorAll('.ow-drop, .ow-drop-refused')) c.classList.remove('ow-drop', 'ow-drop-refused');
    v.paint();
    if (!this.over) this.hide();
    return true;
  }
}

// the event of the strip at the mouse (-1 "Before events"; null: none)
function targetAt(e: MouseEvent): number | null {
  const chip = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>('.ow-strip-chip');
  const ev = chip?.dataset.event;
  return ev === undefined ? null : Number(ev);
}

// whether the popup is on (View → Cell history; a browser without storage: on)
function loadOn(): boolean {
  try { return localStorage.getItem(PREF) !== '0'; } catch { return true; }
}
// View → Cell history kept
function storeOn(on: boolean): void {
  try { localStorage.setItem(PREF, on ? '1' : '0'); } catch { /* no storage */ }
}
