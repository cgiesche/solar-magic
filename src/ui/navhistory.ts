// Browser back/forward through the editor: each place (workspace, level, overworld map, graphics tab,
// a jump with Ctrl+click or a link) is a history entry; what is chosen there (tile, color, file,
// animation, level scroll position) is kept in the entry and comes back with it, but is no step of its own.
// The place is in the URL hash too, so a reload stays there.
import type { EditMode } from './app.ts';
import type { WsTab } from './gfxworkspace.ts';

export type NavLoc =
  | { w: 'level'; level: number; mode?: EditMode; cx?: number; cy?: number } // cx/cy: tile in the middle of the view
  | { w: 'ow'; map: number }
  | { w: 'gfx'; tab: WsTab; pal?: number; m16?: number; bg?: boolean; gfx?: number; anim?: { global: boolean; slot: number } };

const hx = (n: number) => n.toString(16).toUpperCase();
const num = (s: string | undefined, max: number): number | null => {
  if (!s || !/^[0-9a-f]+$/i.test(s)) return null;
  const n = parseInt(s, 16);
  return n <= max ? n : null;
};

export function toHash(l: NavLoc): string {
  if (l.w === 'level') return `#level/${hx(l.level)}`;
  if (l.w === 'ow') return `#ow/${l.map}`;
  if (l.tab === 'pal') return `#gfx/pal${l.pal !== undefined ? `/${hx(l.pal)}` : ''}`;
  if (l.tab === 'map16') return `#gfx/map16${l.bg ? '/bg' : ''}${l.m16 !== undefined ? `/${hx(l.m16)}` : ''}`;
  if (l.tab === 'gfx') return `#gfx/gfx${l.gfx !== undefined ? `/${hx(l.gfx)}` : ''}`;
  return `#gfx/anim${l.anim ? `/${l.anim.global ? 'g' : 'l'}${hx(l.anim.slot)}` : ''}`;
}

export function fromHash(hash: string): NavLoc | null {
  const p = hash.replace(/^#/, '').split('/');
  if (p[0] === 'level' && p.length === 2) {
    const n = num(p[1], 0x1ff);
    return n === null ? null : { w: 'level', level: n };
  }
  if (p[0] === 'ow' && p.length === 2 && /^[0-6]$/.test(p[1])) return { w: 'ow', map: Number(p[1]) };
  if (p[0] !== 'gfx') return null;
  const tab = p[1], rest = p.slice(2);
  if (tab === 'pal' && rest.length <= 1) {
    if (!rest.length) return { w: 'gfx', tab };
    const n = num(rest[0], 0xff);
    return n === null ? null : { w: 'gfx', tab, pal: n };
  }
  if (tab === 'map16') {
    const bg = rest[0] === 'bg';
    const r = bg ? rest.slice(1) : rest;
    if (r.length > 1) return null;
    if (!r.length) return { w: 'gfx', tab, bg };
    const n = num(r[0], 0xffff);
    return n === null ? null : { w: 'gfx', tab, m16: n, bg };
  }
  if (tab === 'gfx' && rest.length <= 1) {
    if (!rest.length) return { w: 'gfx', tab };
    const n = num(rest[0], 0xfff);
    return n === null ? null : { w: 'gfx', tab, gfx: n };
  }
  if (tab === 'anim' && rest.length <= 1) {
    if (!rest.length) return { w: 'gfx', tab };
    const m = /^([gl])([0-9a-f]+)$/i.exec(rest[0]);
    const n = m ? num(m[2], 0xff) : null;
    return n === null ? null : { w: 'gfx', tab, anim: { global: m![1].toLowerCase() === 'g', slot: n } };
  }
  return null;
}

// the place without what is chosen there: a different key is a new history step
export function stepKey(l: NavLoc): string {
  return l.w === 'level' ? `level/${l.level}` : l.w === 'ow' ? `ow/${l.map}` : `gfx/${l.tab}`;
}

export function sameLoc(a: NavLoc, b: NavLoc): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

interface NavState { nav: NavLoc; idx: number }
const isState = (s: unknown): s is NavState => !!s && typeof s === 'object' && 'nav' in s && 'idx' in s && typeof (s as NavState).idx === 'number';

export class NavHistory {
  private cur = 0; // index of the shown entry
  private max = 0; // index of the newest entry (forward possible below it)
  private last: NavLoc;
  private restoring = false;
  private reverting = false;
  private timer = 0;
  private jump = false;
  private capture: () => NavLoc;
  private restore: (l: NavLoc) => Promise<boolean>;
  private blocked: () => boolean;
  onChange: () => void = () => {};

  // capture: the place shown now; restore: show a place (false: the user stayed);
  // blocked: no navigation now (a dialog is open)
  constructor(capture: () => NavLoc, restore: (l: NavLoc) => Promise<boolean>, blocked: () => boolean) {
    this.capture = capture;
    this.restore = restore;
    this.blocked = blocked;
    const s: unknown = history.state;
    if (isState(s)) { this.cur = this.max = s.idx; }
    this.last = capture();
    this.write(false);
    // the entry holds what is chosen right before each action, so going back finds it as it was left
    window.addEventListener('pointerdown', () => this.sync(), true);
    window.addEventListener('keydown', () => this.sync(), true);
    window.addEventListener('popstate', (e) => void this.pop(e.state));
  }

  get canBack(): boolean { return this.cur > 0; }
  get canForward(): boolean { return this.cur < this.max; }

  // a place was opened (jump: an explicit jump, a step even within the same place)
  mark(jump = false): void {
    if (this.restoring) return;
    this.jump ||= jump;
    if (this.timer) return;
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      const j = this.jump;
      this.jump = false;
      const now = this.capture();
      if (stepKey(now) !== stepKey(this.last) || (j && !sameLoc(now, this.last))) {
        this.last = now;
        this.cur = this.max = this.cur + 1;
        this.write(true);
      } else this.sync();
    }, 0);
  }

  sync(): void {
    if (this.restoring || this.timer) return;
    const now = this.capture();
    if (sameLoc(now, this.last)) return;
    this.last = now;
    this.write(false);
  }

  private write(push: boolean): void {
    const s: NavState = { nav: this.last, idx: this.cur };
    const url = location.pathname + location.search + toHash(this.last);
    try {
      if (push) history.pushState(s, '', url);
      else history.replaceState(s, '', url);
    } catch { /* throttled by the browser */ }
    this.onChange();
  }

  private async pop(s: unknown): Promise<void> {
    if (this.reverting) { this.reverting = false; return; }
    // a hash typed by hand: a new entry after the shown one
    const typed = !isState(s);
    const nav = typed ? fromHash(location.hash) : s.nav;
    const idx = typed ? this.cur + 1 : s.idx;
    if (!nav) return;
    // not shown: back to the entry before, a typed one becomes the place still shown
    const stay = () => { if (typed) { this.cur = this.max = idx; this.write(false); } else this.revert(idx); };
    if (this.restoring || this.blocked()) { stay(); return; }
    this.restoring = true;
    let ok = false;
    try { ok = await this.restore(nav); } finally { this.restoring = false; }
    if (!ok) { stay(); return; }
    this.cur = idx;
    this.max = typed ? idx : Math.max(this.max, idx);
    this.last = this.capture();
    this.write(false); // with what restoring did not bring back exactly
  }

  // back to the shown entry after a navigation that did not happen
  private revert(to: number): void {
    if (to === this.cur) return;
    this.reverting = true;
    history.go(this.cur - to);
  }
}
