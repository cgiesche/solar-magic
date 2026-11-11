// The "Overworld options …" dialog (ADR 0015): what concerns the whole overworld, out of the side panel. Two tabs:
// Options (the game's overworld options – Lunar Magic's "Extra Options" –, each switch one ROM edit) and Reveal list
// (Lunar Magic's "Edit Reveal Tile List": which tile a revealed tile becomes). Drawn again after every ROM change while
// open (its own edits, undo/redo – Ctrl+Z / Ctrl+Y work in it, as in the Packages dialog); one open at a time.

import type { App } from './app.ts';
import { h, modal, toast, checkbox, hexInput, dialogUndoKeys } from './dom.ts';
import { syncBowsieMaxTile } from '../core/bowsie.ts';
import { MAP_NAMES, readRevealList, writeRevealList } from '../core/overworld.ts';
import { OW_OPTIONS, owOption, owOptionValue, setOwOption, revealSpeed, setRevealSpeed, MAX_REVEAL_SPEED, DEFAULT_REVEAL_SPEED, submapLightning, setSubmapLightning, LIGHTNING_TITLE, lightningEditLabel } from '../core/owoptions.ts';
import { refusedToast } from './owrefusal.ts';
import { hex } from '../core/names.ts';

export type OwOptionsTab = 'options' | 'reveals';
const TAB_LABEL: Record<OwOptionsTab, string> = { options: 'Options', reveals: 'Reveal list' };

export interface OwOptionsContext {
  tileImage: (t: number) => HTMLCanvasElement; // a layer 1 tile drawn (16x16) as the overworld shows it
  selectedTile: () => number; // the layer 1 tile whose reveal list entry is marked (being revealed, or selected), -1: none
}

let shown: { show: (tab: OwOptionsTab, ctx: OwOptionsContext) => void } | null = null;

// opens the dialog on tab (the one open: switched to it)
export function openOwOptions(app: App, ctx: OwOptionsContext, tab: OwOptionsTab = 'options'): void {
  if (shown) { shown.show(tab, ctx); return; }
  const tabBar = h('div', { class: 'tabs seg ow-options-tabs' });
  const content = h('div', { class: 'ow-options-content' });
  const body = h('div', { class: 'ow-options' }, tabBar, content);
  const draw = () => {
    // (the field with the focus keeps it, the list its scroll: a value just entered)
    const fields = () => [...content.querySelectorAll<HTMLElement>('button, select, input')];
    const at = fields().indexOf(document.activeElement as HTMLElement), scroll = content.scrollTop;
    tabBar.replaceChildren(...(Object.keys(TAB_LABEL) as OwOptionsTab[]).map((k) =>
      h('button', { class: k === tab ? 'mode active' : 'mode', onclick: () => show(k) }, TAB_LABEL[k])));
    content.replaceChildren(tab === 'options' ? optionsPanel(app, draw) : revealList(app, ctx));
    content.scrollTop = scroll;
    if (at >= 0) fields()[at]?.focus();
  };
  const show = (k: OwOptionsTab, c = ctx) => { if (k !== tab) content.scrollTop = 0; tab = k; ctx = c; draw(); };
  // undo/redo while the dialog is the topmost one (drawn again by the ROM change)
  const offKeys = dialogUndoKeys(body, () => app.undo(), () => app.redo());
  const off = app.on('rom-change', draw);
  shown = { show };
  draw();
  modal('Overworld options', body, [{ label: 'Close', primary: true }], () => {
    offKeys();
    off();
    shown = null;
  });
}

// the game's overworld options (core/owoptions.ts): each switch one ROM edit
function optionsPanel(app: App, redraw: () => void): HTMLElement {
  const rom = app.rom;
  const rows: HTMLElement[] = [];
  for (const o of OW_OPTIONS) {
    if (o.sub && owOptionValue(rom, o.sub.of) !== o.sub.when) continue;
    const v = owOptionValue(rom, o.id);
    if (v === null) { rows.push(h('div', { class: 'row hint warn-text', title: o.title }, `⚠ ${o.label}: its code was changed by a patch`)); continue; }
    // (the path fade: BOWSIE re-inserted with or without MaxTile; refused when that fails)
    const c = checkbox(o.label, o.title, v, (on) => {
      try {
        const warnings = app.romEdit(`${o.label}: ${on ? 'on' : 'off'}`, () => { setOwOption(rom, o.id, on); return o.id === 'pathFade' ? syncBowsieMaxTile(rom) : []; });
        if (warnings.length) toast(warnings.join(' '));
      } catch (e) { refusedToast(rom, e); redraw(); }
    });
    if (o.needs && owOptionValue(rom, o.needs) === false) {
      c.querySelector('input')!.disabled = true;
      c.title += ` – no effect while "${owOption(o.needs).label}" is off`;
    }
    if (o.sub) c.classList.add('ow-option-sub');
    rows.push(c);
    const note = o.note?.(rom);
    if (note) rows.push(h('div', { class: 'hint ow-option-sub' }, note));
    const speed = o.id === 'pathFade' ? revealSpeed(rom) : null;
    if (speed !== null) {
      const inp = hexInput(speed, 2, (n) => app.romEdit('Path reveal speed', () => setRevealSpeed(rom, n)), MAX_REVEAL_SPEED, (n) => n >= 1 || 'at least 1');
      inp.title = `How fast each step of an event's path appears: added to a counter every frame, a step at 40 (${DEFAULT_REVEAL_SPEED.toString(16).toUpperCase()}: Lunar Magic's default; 40: a step every 3 frames)`;
      rows.push(h('div', { class: 'prop ow-option-sub' }, h('label', null, 'Path reveal speed'), inp));
    }
  }
  // the game's lightning (color 4·7), per submap: each one ROM edit of the same byte
  if (submapLightning(rom, 0) === null) rows.push(h('div', { class: 'row hint warn-text', title: LIGHTNING_TITLE }, '⚠ Lightning: its code was changed by a patch'));
  else {
    rows.push(h('div', { class: 'row hint' }, 'Lightning (color 4·7) on'));
    MAP_NAMES.forEach((name, m) => {
      const c = checkbox(name, LIGHTNING_TITLE, !!submapLightning(rom, m), (on) => app.romEdit(lightningEditLabel(name, on), () => setSubmapLightning(rom, m, on)));
      c.classList.add('ow-option-sub');
      rows.push(c);
    });
  }
  return h('div', { class: 'ow-info' }, h('div', { class: 'hint' }, 'The game\'s switches for the whole overworld, each one undo step'), ...rows);
}

// the reveal list: which tile a revealed tile becomes; the selected tile's entry marked, an entry a later one of the
// same tile hides warned of
function revealList(app: App, ctx: OwOptionsContext): HTMLElement {
  const rom = app.rom, list = readRevealList(rom), sel = ctx.selectedTile();
  const set = (k: number, p: { from?: number; to?: number }) =>
    app.romEdit('Reveal list', () => writeRevealList(rom, list.map((q, n) => (n === k ? { ...q, ...p } : q))));
  const last = (t: number) => { for (let k = list.length - 1; k >= 0; k--) if (list[k].from === t) return k; return -1; };
  return h('div', { class: 'ow-info' },
    h('div', { class: 'hint' }, 'What a tile becomes when an event reveals it (first the tile on the map, then the tile it becomes)'),
    h('div', { class: 'ow-reveal-rows' }, ...list.map((p, k) => h('div', {
      class: `row ow-reveal${k === last(sel) ? ' current' : ''}`,
      title: last(p.from) !== k ? `Tile ${hex(p.from, 2)} has a later entry: this one is not used` : `A tile ${hex(p.from, 2)} an event reveals becomes ${hex(p.to, 2)}`,
    }, ctx.tileImage(p.from), hexInput(p.from, 2, (v) => set(k, { from: v })), '→', ctx.tileImage(p.to), hexInput(p.to, 2, (v) => set(k, { to: v })),
    last(p.from) !== k ? h('span', { class: 'hint warn-text' }, '⚠') : null))));
}
