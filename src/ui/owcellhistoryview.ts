// A layer 1 cell's history over the game (#359) in a popup: the mouse resting on a cell of the overworld map for a
// moment (no button held – painting and dragging go on as before) shows what each event changes there, in number order
// and the player's words (core/owcellhistory.ts); a click on an entry sets the playthrough strip there (ADR 0013).
// The popup stays while the mouse is on it, and goes when the mouse rests on another cell, a button is pressed or the
// map scrolls.

import { h } from './dom.ts';
import type { OverworldView } from './overworld.ts';
import { cellHistory, historyWords } from '../core/owcellhistory.ts';
import { eventRunners, eventWords } from '../core/owevents.ts';
import { cellText } from '../core/oweventtiles.ts';
import { l1Hex } from '../core/owl1sheet.ts';
import type { PathKind } from '../core/owpaths.ts';

const REST_MS = 700; // the mouse resting on a cell this long shows its history
const LEAVE_MS = 300; // the time to move from the cell into the popup
// a tile's path kind in a word (none for a tile that is no path)
const KIND_WORDS: Record<PathKind, string> = { walk: 'path', climb: 'climbing path', swim: 'water path', exit: 'exit path', stop: 'stop', level: 'level tile', none: '' };

// View → Cell history kept in the browser (on unless switched off)
const PREF = 'ow-cell-history';

export class CellHistoryPopup {
  private el = h('div', { class: 'ow-history' });
  private cell = -1; // the cell shown (-1: none)
  private rest = 0; // the timer showing the cell rested on
  private leave = 0; // the timer hiding the popup after the mouse left its cell
  private at = { x: 0, y: 0 }; // where the mouse rests (client pixels)
  private over = false; // the mouse on the popup
  on = loadOn(); // shown at all (View → Cell history, kept in the browser)

  // the popup's own mouse: on it it stays, left it goes
  constructor(private view: OverworldView) {
    this.el.addEventListener('mouseenter', () => { this.over = true; clearTimeout(this.leave); clearTimeout(this.rest); });
    this.el.addEventListener('mouseleave', () => { this.over = false; this.close(); });
    // (a press anywhere else: gone)
    window.addEventListener('mousedown', (e) => { if (this.el.isConnected && !this.el.contains(e.target as Node)) this.close(); }, true);
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
    if (busy) { this.close(); return; }
    if (i === this.cell) { clearTimeout(this.leave); return; }
    if (this.cell >= 0 && !this.over) { clearTimeout(this.leave); this.leave = window.setTimeout(() => { if (!this.over) this.hide(); }, LEAVE_MS); }
    if (i < 0 || !this.on) return;
    this.at = { x, y };
    this.rest = window.setTimeout(() => this.show(i), REST_MS);
  }

  // no popup, none coming (the map scrolled or zoomed, another submap or mode, a button pressed elsewhere)
  close(): void {
    clearTimeout(this.rest);
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
    const tile = (t: number) => { const k = kinds?.[t]; return k && KIND_WORDS[k] ? `${l1Hex(t)} ${KIND_WORDS[k]}` : l1Hex(t); };
    const entries = historyWords(cellHistory(rom, i, kinds ? v.isLevelTile : undefined), tile, (e) => eventWords(runners, e, v.levelWords));
    this.cell = i;
    const build = () => {
      let now = 0;
      entries.forEach((x, k) => { if (x.event <= v.event) now = k; });
      this.el.replaceChildren(
        h('div', { class: 'ow-history-head' }, `Tile at ${cellText(i)} over the game`),
        ...entries.map((x, k) => h('button', {
          class: `ow-history-entry${k === now ? ' active' : ''}`,
          title: x.event < 0 ? 'Show the map before events in the strip' : 'Show the map as after this event in the strip (painting goes into it)',
          onclick: () => { v.setEvent(x.event); build(); },
        }, k ? `→ ${x.text}` : x.text)),
        ...(entries.length === 1 ? [h('div', { class: 'hint' }, 'No event changes it.')] : []),
      );
    };
    build();
    document.body.append(this.el);
    const r = this.el.getBoundingClientRect();
    this.el.style.left = `${Math.max(4, Math.min(this.at.x + 14, innerWidth - r.width - 4))}px`;
    this.el.style.top = `${Math.max(4, Math.min(this.at.y + 14, innerHeight - r.height - 4))}px`;
  }
}

// whether the popup is on (View → Cell history; a browser without storage: on)
function loadOn(): boolean {
  try { return localStorage.getItem(PREF) !== '0'; } catch { return true; }
}
// View → Cell history kept
function storeOn(on: boolean): void {
  try { localStorage.setItem(PREF, on ? '1' : '0'); } catch { /* no storage */ }
}
