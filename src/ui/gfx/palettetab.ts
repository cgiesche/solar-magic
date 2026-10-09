// Palettes tab: the level's 16 palette rows, labelled by where their colors come from (FG/BG/sprite
// palette of the header, global colors), with a color editor, row tools and the header palette choice.
// Colors are written to the ROM location they were loaded from (traced during emulation); before a
// shared palette is changed the user decides between all levels and an own palette for this level.

import type { App } from '../app.ts';
import type { GfxWorkspace, WsPanel } from '../gfxworkspace.ts';
import { menuButton } from '../menu.ts';
import { h, clear, toast, choose, pickerOpen } from '../dom.ts';
import { downloadBytes, pickFile } from '../platform.ts';
import { snesColorToRGBA, cgramToRGBA } from '../../core/gfx.ts';
import { pcToSnes } from '../../core/rom.ts';
import { hex } from '../../core/names.ts';
import { customPalette, setCustomPalette } from '../../core/patches.ts';
import { parsePrimaryHeader, L1_PTRS, type PrimaryHeader } from '../../core/level.ts';
import type { LevelRender } from '../../core/levelemu.ts';

// vanilla palette tables (bank $00)
const BACK_AREA = 0x00b0a0;
const BG_PALS = 0x00b0b0;
const FG_PALS = 0x00b190;
const SPR_PALS = 0x00b318;
const PAL_SIZE = 0x18; // 12 colors: two rows of 6 (colors 2-7)

type Kind = 'back' | 'bg' | 'fg' | 'spr' | 'l3' | 'mario' | 'global' | 'own' | 'none';
interface Origin { kind: Kind; num: number }

export function rgbOf(c: number): [number, number, number] {
  return [c & 31, (c >> 5) & 31, (c >> 10) & 31];
}
export function cssOf(c: number): string {
  const v = snesColorToRGBA(c);
  return `rgb(${v & 255},${(v >> 8) & 255},${(v >> 16) & 255})`;
}
const to8 = (v: number) => (v << 3) | (v >> 2);
export function htmlOf(c: number): string {
  return '#' + rgbOf(c).map((v) => to8(v).toString(16).padStart(2, '0')).join('');
}
function parseHtml(s: string): number | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(s.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return ((n >> 19) & 31) | (((n >> 11) & 31) << 5) | (((n >> 3) & 31) << 10);
}

function originOf(addr: number): Origin {
  if (addr < 0) return { kind: 'none', num: 0 };
  const inTable = (base: number, n: number, size: number) => addr >= base && addr < base + n * size;
  if (inTable(BACK_AREA, 8, 2)) return { kind: 'back', num: (addr - BACK_AREA) >> 1 };
  if (inTable(BG_PALS, 8, PAL_SIZE)) return { kind: 'bg', num: Math.floor((addr - BG_PALS) / PAL_SIZE) };
  if (addr >= 0x00b170 && addr < 0x00b190) return { kind: 'l3', num: 0 };
  if (inTable(FG_PALS, 8, PAL_SIZE)) return { kind: 'fg', num: Math.floor((addr - FG_PALS) / PAL_SIZE) };
  if (addr >= 0x00b2c8 && addr < SPR_PALS) return { kind: 'mario', num: 0 };
  if (inTable(SPR_PALS, 8, PAL_SIZE)) return { kind: 'spr', num: Math.floor((addr - SPR_PALS) / PAL_SIZE) };
  return { kind: 'global', num: 0 };
}

function originName(o: Origin): string {
  switch (o.kind) {
    case 'back': return `Back area color ${o.num}`;
    case 'bg': return `BG palette ${o.num}`;
    case 'fg': return `FG palette ${o.num}`;
    case 'spr': return `Sprite palette ${o.num}`;
    case 'l3': return 'Layer 3 / status bar';
    case 'mario': return 'Mario';
    case 'global': return 'Global';
    case 'own': return 'Own palette';
    default: return 'set by the game';
  }
}

export class PaletteTab implements WsPanel {
  root: HTMLElement;
  private app: App;
  private trace: LevelRender | null = null;
  private custom = 0;
  private sel = 0x21;
  private selEnd = 0x21; // range end (same row) for gradients
  private clip: number[] | null = null;
  // per level: change shared palettes for all levels without asking again
  private shareOk = new Set<number>();
  private headers: Map<number, PrimaryHeader> | null = null;
  private rows = h('div', { class: 'pt-rows' });
  private detail = h('div', { class: 'pt-detail' });
  private headerBox = h('div', { class: 'pt-header' });
  private bar = h('div', { class: 'ws-bar' });
  private swatches: HTMLElement[] = [];
  private rowLabels: HTMLElement[] = [];
  private visible = false;

  constructor(app: App, _ws: GfxWorkspace) {
    this.app = app;
    this.root = h('div', { class: 'pt' }, this.bar, h('div', { class: 'pt-main' }, h('div', { class: 'pt-left' }, this.rows, this.headerBox), this.detail));
    app.on('render', () => { if (this.visible) { this.retrace(); this.paint(); } });
    app.on('rom-change', () => {
      this.headers = null;
      if (!this.visible) return;
      const c = customPalette(app.rom, app.level.number);
      if (c !== this.custom) { this.custom = c; this.buildBar(); }
      this.paint();
    });
    app.on('level', () => { this.trace = null; this.headers = null; });
    app.on('animated', () => { if (this.visible) this.paint(); });
    app.on('level-header', () => { this.headers = null; if (this.visible) this.buildHeader(); });
    this.buildRows();
  }

  previewHint(): string {
    return 'Click: pick the color under the mouse (eyedropper)';
  }

  show(): void {
    this.visible = true;
    this.retrace();
    this.buildBar();
    this.paint();
  }
  hide(): void { this.visible = false; }

  select(i: number): void {
    this.sel = this.selEnd = i & 0xff;
    this.paint();
  }

  // ---------- data ----------
  private retrace(): void {
    const app = this.app;
    this.custom = customPalette(app.rom, app.level.number);
    if (this.trace && this.tracedFor === app.render) return;
    this.trace = app.emu.load(app.level.number, { ...app.buildOverrides(), trackSources: true });
    this.tracedFor = app.render;
  }
  private tracedFor: LevelRender | null = null;

  private backAreaAddr(): number {
    return BACK_AREA + this.app.level.header.backAreaColor * 2;
  }

  // SNES address the color is loaded from, -1 when it has no fixed place
  src(i: number): number {
    if (this.custom) return this.custom + i * 2;
    if (i === 0) return this.backAreaAddr();
    const r = this.trace;
    if (!r) return -1;
    const a = r.cgramSrc[i * 2], b = r.cgramSrc[i * 2 + 1];
    return a >= 0 && b === a + 1 ? pcToSnes(a) : -1;
  }

  color(i: number): number {
    const a = this.src(i);
    if (a >= 0) return this.app.rom.r16(a);
    const c = this.app.render.cgram;
    return c[i * 2] | (c[i * 2 + 1] << 8);
  }

  origin(i: number): Origin {
    if (this.custom) return { kind: 'own', num: 0 };
    return originOf(this.src(i));
  }

  private levelHeaders(): Map<number, PrimaryHeader> {
    if (this.headers) return this.headers;
    const m = new Map<number, PrimaryHeader>();
    for (const n of this.app.usedLevels()) {
      if (customPalette(this.app.rom, n)) continue; // own palette: not affected by shared ones
      try { m.set(n, parsePrimaryHeader(this.app.rom.bytes(this.app.rom.r24(L1_PTRS + n * 3), 5))); } catch { /* unreadable */ }
    }
    if (!customPalette(this.app.rom, this.app.level.number)) m.set(this.app.level.number, this.app.level.header);
    return (this.headers = m);
  }

  // levels a change of the color affects (null: just this one)
  affected(i: number): number[] | null {
    const o = this.origin(i);
    if (o.kind === 'own' || o.kind === 'none') return null;
    const all = [...this.levelHeaders().entries()];
    const key: Partial<Record<Kind, keyof PrimaryHeader>> = { back: 'backAreaColor', bg: 'bgPalette', fg: 'fgPalette', spr: 'spritePalette' };
    const k = key[o.kind];
    return all.filter(([, hd]) => !k || hd[k] === o.num).map(([n]) => n);
  }

  // ---------- editing ----------
  // before changing shared colors: all levels or an own palette for this one; false = cancelled
  private async allowed(idx: number[]): Promise<boolean> {
    const app = this.app, lvl = app.level.number;
    if (this.custom || this.shareOk.has(lvl)) return true;
    const users = new Set<number>();
    const kinds = new Set<string>();
    for (const i of idx) {
      const a = this.affected(i);
      if (!a) continue;
      a.forEach((n) => users.add(n));
      kinds.add(originName(this.origin(i)));
    }
    users.delete(lvl);
    if (!users.size) return true;
    const list = [...users].sort((a, b) => a - b);
    const body = h('div', { style: 'max-width:480px; display:flex; flex-direction:column; gap:8px' },
      h('p', { style: 'margin:0' }, `This color belongs to ${[...kinds].join(', ')}. It is also used by ${list.length} other level${list.length === 1 ? '' : 's'}:`),
      h('p', { class: 'hint mono', style: 'margin:0' }, list.slice(0, 24).map((n) => hex(n, 3)).join(' ') + (list.length > 24 ? ' …' : '')),
      h('p', { class: 'hint', style: 'margin:0' }, '“Only this level” creates an own palette with all 256 colors for this level (installs a small patch once for that). Other levels no longer change along with it.'),
    );
    const c = await choose('Change shared palette?', body, [
      { label: 'Cancel' },
      { label: `Change for all ${list.length + 1} levels` },
      { label: 'Only this level', primary: true },
    ]);
    if (c === 1) { this.shareOk.add(lvl); return true; }
    if (c === 2) return this.makeOwn();
    return false;
  }

  private makeOwn(): boolean {
    const app = this.app;
    const pal = new Uint8Array(512);
    for (let i = 0; i < 256; i++) { const v = this.color(i); pal[i * 2] = v & 0xff; pal[i * 2 + 1] = v >> 8; }
    try {
      this.custom = app.romEdit(`Own palette for level ${hex(app.level.number, 3)}`, () => setCustomPalette(app.rom, app.level.number, pal));
    } catch (e) { toast(String(e instanceof Error ? e.message : e), 'error'); return false; }
    this.headers = null;
    this.buildBar();
    return true;
  }

  private dropOwn(): void {
    const app = this.app;
    app.romEdit(`Own palette of level ${hex(app.level.number, 3)} removed`, () => setCustomPalette(app.rom, app.level.number, null));
    this.custom = 0;
    this.trace = null;
    this.headers = null;
    app.flushRomChange();
    this.retrace();
    this.buildBar();
    this.paint();
  }

  // writes colors (index -> SNES value); key merges quick successive changes (slider drags)
  private async write(changes: [number, number][], label: string, key: string | null = null): Promise<void> {
    const ok = changes.filter(([i]) => this.src(i) >= 0);
    const locked = changes.length - ok.length;
    if (locked && changes.length > 1) toast(`${locked} color${locked > 1 ? 's' : ''} set by the game skipped (only editable with an own palette)`);
    if (!ok.length) return;
    if (!(await this.allowed(ok.map(([i]) => i)))) { this.paint(); return; }
    this.app.romEdit(label, () => { for (const [i, v] of ok) this.app.rom.w16(this.src(i), v & 0x7fff); }, key);
    this.paint();
  }

  private setColor(v: number, key: string | null = null): void {
    void this.write([[this.sel, v]], `Color ${hex(this.sel >> 4, 1)}·${hex(this.sel & 15, 1)}`, key);
  }

  // ---------- UI ----------
  private buildBar(): void {
    const app = this.app;
    clear(this.bar);
    const own = this.custom !== 0;
    this.bar.append(
      h('span', { class: 'prop-title' }, `Level ${hex(app.level.number, 3)}`),
      own ? h('span', { class: 'badge' }, 'own palette') : h('span', { class: 'badge muted', title: 'Colors come from the shared palette tables (FG/BG/sprite palette of the header)' }, 'shared palettes'),
      own ? h('button', { onclick: () => this.dropOwn(), title: 'Use the header\'s shared palettes again' }, 'Remove own palette')
        : h('button', { onclick: () => { if (this.makeOwn()) this.paint(); }, title: 'All 256 colors for this level only (also makes the gray colors editable)' }, 'Create own palette'),
      h('span', { class: 'sep' }),
      h('button', { onclick: () => this.copyRow(), title: 'Copy the selected palette (16 colors) (Ctrl+C)' }, 'Copy palette'),
      h('button', { onclick: () => this.pasteRow(), title: 'Paste the copied palette into the selected one (Ctrl+V)' }, 'Paste palette'),
      h('button', { onclick: () => this.gradient(), title: 'Shift+click marks a range in the palette; the colors in between become a gradient' }, 'Gradient'),
      h('span', { class: 'spacer' }),
      menuButton({ label: 'Import/Export', items: [
        { label: 'Import (.pal) …', title: 'Take colors from a .pal file (RGB)', onClick: () => void this.importPal() },
        { label: 'Export (.pal)', title: 'All 256 colors as .pal (RGB, 768 bytes)', onClick: () => this.exportPal() },
      ] }),
    );
  }

  private buildRows(): void {
    clear(this.rows);
    this.swatches = [];
    this.rowLabels = [];
    for (let row = 0; row < 16; row++) {
      const label = h('div', { class: 'pt-row-label' });
      const cells = h('div', { class: 'pt-cells' });
      for (let c = 0; c < 16; c++) {
        const i = row * 16 + c;
        const sw = h('div', { class: 'pt-sw' });
        sw.addEventListener('mousedown', (e) => {
          e.preventDefault();
          if (e.shiftKey && (this.sel >> 4) === row) this.selEnd = i;
          else this.sel = this.selEnd = i;
          this.paint();
        });
        this.swatches.push(sw);
        cells.appendChild(sw);
      }
      this.rowLabels.push(label);
      this.rows.appendChild(h('div', { class: 'pt-row' }, h('span', { class: 'pt-row-num mono' }, hex(row, 1)), cells, label));
    }
  }

  paint(): void {
    if (!this.trace) return;
    const lo = Math.min(this.sel, this.selEnd), hi = Math.max(this.sel, this.selEnd);
    for (let i = 0; i < 256; i++) {
      const sw = this.swatches[i];
      const locked = this.src(i) < 0;
      sw.style.background = cssOf(this.color(i));
      sw.classList.toggle('sel', i === this.sel);
      sw.classList.toggle('range', i >= lo && i <= hi && lo !== hi);
      const animated = !!this.app.animated()?.colors.has(i);
      sw.classList.toggle('locked', locked);
      sw.classList.toggle('animated', animated);
      sw.title = `Color ${hex(i >> 4, 1)}·${hex(i & 15, 1)} – ${locked ? 'set by the game, not editable (only with an own palette)' : originName(this.origin(i))}${animated ? ' · animated: the game keeps rewriting it' : ''}`;
    }
    for (let row = 0; row < 16; row++) {
      const names: string[] = [];
      for (let c = 0; c < 16; c++) {
        const i = row * 16 + c;
        if (this.src(i) < 0 || (row === 0 && c === 0 && !this.custom)) continue;
        const n = originName(this.origin(i));
        if (!names.includes(n)) names.push(n);
      }
      this.rowLabels[row].textContent = this.custom ? (row === 0 ? 'Own palette of this level' : '') : names.filter((n) => n !== 'Global' || names.length === 1).join(' · ');
    }
    this.buildDetail();
    this.buildHeader();
  }

  private buildDetail(): void {
    const d = this.detail;
    // an open native color picker closes when its input is replaced: rebuild once it is done (change)
    if (pickerOpen(d)) return;
    clear(d);
    const i = this.sel;
    const c = this.color(i);
    const editable = this.src(i) >= 0;
    const o = this.origin(i);
    const users = editable ? this.affected(i) : null;
    const others = users ? users.filter((n) => n !== this.app.level.number).length : 0;
    d.append(
      h('div', { class: 'pt-big', style: { background: cssOf(c) } }),
      h('div', { class: 'prop-title' }, `Color ${hex(i >> 4, 1)}·${hex(i & 15, 1)}`, h('span', { class: 'hint' }, `  Palette ${hex(i >> 4, 1)}, color ${hex(i & 15, 1)}`)),
      h('div', { class: 'hint' }, editable ? `${originName(o)} · ${o.kind === 'own' ? 'applies to this level only' : others ? `also in ${others} other level${others === 1 ? '' : 's'}` : 'this level only'}` : ''),
      this.app.animated()?.colors.has(i) ? h('div', { class: 'warn-box' }, 'Animated: the game keeps rewriting this color (flashing coins, ?-blocks etc.). A change here is barely or not at all visible in the game.') : '',
    );
    if (!editable) {
      d.append(
        h('p', { class: 'pt-locked' }, 'The game sets this color at run time (status bar, animation etc.) – it has no fixed place in the palette tables.'),
        h('button', { onclick: () => { if (this.makeOwn()) this.paint(); } }, 'Create own palette (makes all colors editable)'),
      );
      return;
    }
    const [R, G, B] = rgbOf(c);
    const vals = [R, G, B];
    const htmlIn = h('input', { class: 'mono', value: htmlOf(c), size: 8, spellcheck: false, title: 'HTML color; rounded to the 15-bit SNES color' });
    htmlIn.addEventListener('change', () => { const v = parseHtml(htmlIn.value); if (v === null) htmlIn.value = htmlOf(c); else this.setColor(v); });
    const picker = h('input', { type: 'color', value: htmlOf(c) });
    picker.addEventListener('input', () => { const v = parseHtml(picker.value); if (v !== null) this.setColor(v, `pal:${i}`); });
    picker.addEventListener('change', () => { picker.blur(); this.buildDetail(); });
    const big = d.firstChild as HTMLElement;
    const sliders = ['Red', 'Green', 'Blue'].map((l, k) => {
      const inp = h('input', { type: 'range', min: 0, max: 31, value: String(vals[k]), class: `pt-slider pt-${'rgb'[k]}` });
      const num = h('input', { type: 'number', min: 0, max: 31, value: String(vals[k]), class: 'pt-num' });
      const cur = () => vals[0] | (vals[1] << 5) | (vals[2] << 10);
      inp.addEventListener('input', () => {
        vals[k] = Number(inp.value); num.value = inp.value;
        big.style.background = cssOf(cur());
        this.swatches[i].style.background = cssOf(cur());
      });
      inp.addEventListener('change', () => this.setColor(cur(), `pal:${i}`));
      num.addEventListener('change', () => { vals[k] = Math.max(0, Math.min(31, Number(num.value) | 0)); this.setColor(cur()); });
      return h('div', { class: 'prop' }, h('label', null, l), inp, num);
    });
    d.append(
      ...sliders,
      h('div', { class: 'prop' }, h('label', null, 'HTML color'), htmlIn, picker),
      h('div', { class: 'prop' }, h('label', null, 'SNES value'), h('span', { class: 'mono' }, `$${hex(c, 4)}`), h('span', { class: 'hint mono' }, `@ $${hex(this.src(i), 6)}`)),
      h('p', { class: 'hint' }, 'Shift+click marks a range of the palette (for “Gradient”). A click into the level preview selects the color there.'),
    );
  }

  // header choice: FG/BG/sprite palette and back area color as previews (a level edit, undoable)
  private buildHeader(): void {
    const app = this.app;
    const box = this.headerBox;
    clear(box);
    if (this.custom) {
      box.append(h('p', { class: 'hint' }, 'With an own palette, the header\'s FG, BG and sprite palettes do not matter.'));
      return;
    }
    const hd = app.level.header;
    const tableCanvas = (base: number, k: number, colors: number) => {
      const c = h('canvas', { width: colors > 2 ? 6 : 1, height: colors > 2 ? 2 : 1, class: 'pt-hpal' });
      const ctx = c.getContext('2d')!;
      const img = ctx.createImageData(c.width, c.height);
      const px = new Uint32Array(img.data.buffer);
      for (let n = 0; n < px.length; n++) px[n] = snesColorToRGBA(app.rom.r16(base + k * colors * 2 + n * 2));
      ctx.putImageData(img, 0, 0);
      return c;
    };
    const group = (label: string, key: 'fgPalette' | 'bgPalette' | 'spritePalette' | 'backAreaColor', base: number, colors: number) =>
      h('div', { class: 'pt-hgroup' }, h('div', { class: 'pt-hlabel' }, label),
        h('div', { class: 'pt-hopts' }, Array.from({ length: 8 }, (_, k) => h('button', {
          class: `pt-hopt${hd[key] === k ? ' active' : ''}`, title: `${label} ${k}`,
          onclick: () => {
            if (app.level.header[key] === k) return;
            app.editLevel(() => { app.level.header = { ...app.level.header, [key]: k }; });
            app.emit('level-header');
          },
        }, tableCanvas(base, k, colors), h('span', null, String(k))))));
    box.append(
      h('div', { class: 'panel-title' }, 'Palettes of this level (header)'),
      group('FG palette', 'fgPalette', FG_PALS, 6),
      group('BG palette', 'bgPalette', BG_PALS, 6),
      group('Sprite palette', 'spritePalette', SPR_PALS, 6),
      group('Back area color', 'backAreaColor', BACK_AREA, 1),
    );
  }

  private rowIdx(): number[] {
    const r = this.sel & 0xf0;
    return Array.from({ length: 16 }, (_, c) => r + c);
  }

  private copyRow(): void {
    this.clip = this.rowIdx().map((i) => this.color(i));
    toast(`Palette ${hex(this.sel >> 4, 1)} copied`);
  }
  private pasteRow(): void {
    const clip = this.clip;
    if (!clip) { toast('Copy a palette first'); return; }
    // color 0 is transparent (except the back area color in row 0) and stays
    void this.write(this.rowIdx().map((i, c) => [i, clip[c]] as [number, number]).filter(([i]) => i & 15), `Palette ${hex(this.sel >> 4, 1)} pasted`);
  }
  private gradient(): void {
    const lo = Math.min(this.sel, this.selEnd), hi = Math.max(this.sel, this.selEnd);
    if (hi - lo < 2) { toast('First mark a range of at least 3 colors with Shift+click'); return; }
    const a = rgbOf(this.color(lo)), b = rgbOf(this.color(hi));
    const ch: [number, number][] = [];
    for (let i = lo + 1; i < hi; i++) {
      const t = (i - lo) / (hi - lo);
      const v = a.map((x, k) => Math.round(x + (b[k] - x) * t));
      ch.push([i, v[0] | (v[1] << 5) | (v[2] << 10)]);
    }
    void this.write(ch, 'Color gradient');
  }

  private async exportPal(): Promise<void> {
    const out = new Uint8Array(768);
    for (let i = 0; i < 256; i++) {
      const v = snesColorToRGBA(this.color(i));
      out[i * 3] = v & 255; out[i * 3 + 1] = (v >> 8) & 255; out[i * 3 + 2] = (v >> 16) & 255;
    }
    if (await downloadBytes(`level${hex(this.app.level.number, 3)}.pal`, out)) toast(`level${hex(this.app.level.number, 3)}.pal exported`);
  }
  private async importPal(): Promise<void> {
    const f = await pickFile('.pal');
    if (!f) return;
    const d = new Uint8Array(await f.arrayBuffer());
    if (d.length < 768) { toast('.pal file must have 768 bytes (256 RGB colors)', 'error'); return; }
    const ch: [number, number][] = [];
    for (let i = 0; i < 256; i++) ch.push([i, (d[i * 3] >> 3) | ((d[i * 3 + 1] >> 3) << 5) | ((d[i * 3 + 2] >> 3) << 10)]);
    const n = ch.filter(([i]) => this.src(i) >= 0).length;
    await this.write(ch, `${f.name} imported`);
    toast(`${n} colors applied${n < 256 ? ' (the game sets the rest; “Own palette” makes all editable)' : ''}`);
  }

  // pipette: the CGRAM entry with the clicked pixel's color (FG/BG rows first)
  previewClick(px: number, py: number): void {
    const im = this.app.images;
    const v = this.app.compositeImg[py * im.width + px];
    const pal = cgramToRGBA(this.app.render.cgram);
    const order = [2, 3, 4, 5, 6, 7, 0, 1, 8, 9, 10, 11, 12, 13, 14, 15];
    for (const row of order) for (let c = 1; c < 16; c++) {
      if (pal[row * 16 + c] === v) { this.select(row * 16 + c); return; }
    }
    if (pal[0] === v || (v >>> 0) === (im.backdrop >>> 0)) { this.select(0); return; }
    toast('Color not found in the palette (blended/transparent?)');
  }

  key(e: KeyboardEvent): boolean {
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key;
    if (ctrl && k.toLowerCase() === 'c') { this.copyRow(); return true; }
    if (ctrl && k.toLowerCase() === 'v') { this.pasteRow(); return true; }
    if (!ctrl && (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown')) {
      const d = k === 'ArrowLeft' ? -1 : k === 'ArrowRight' ? 1 : k === 'ArrowUp' ? -16 : 16;
      this.select((this.sel + d + 256) & 0xff);
      return true;
    }
    return false;
  }
}

