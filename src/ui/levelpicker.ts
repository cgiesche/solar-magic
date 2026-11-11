// A button naming a level; a click opens a list to choose another one by number or name.

import type { App } from './app.ts';
import { h, clear, emptyState } from './dom.ts';
import { hex3 } from '../core/names.ts';
import { closeMenus } from './menu.ts';
import { icon } from './icons.ts';

// any of the 0x200 levels (or of opts.levels, each with its opts.note); the list starts with "only used": main
// levels, relocated ones and those an exit leads to
export interface PickerOptions { levels?: number[]; note?: (n: number) => string }
export function levelPicker(app: App, value: number, onPick: (n: number) => void, opts: PickerOptions = {}): HTMLElement {
  const g = app.entrances.graph();
  const btn = h('button', { class: 'level-pick', title: 'Choose another level' }, h('span', { class: 'mono' }, hex3(value)), ' ', h('span', { class: 'lname' }, g.name(value)), h('span', { class: 'caret' }, ' ', icon('chevron-down')));
  btn.addEventListener('click', () => openPicker(app, btn, value, onPick, opts));
  return btn;
}

let openPop: { anchor: HTMLElement; close: () => void } | null = null;

function openPicker(app: App, anchor: HTMLElement, value: number, onPick: (n: number) => void, opts: PickerOptions): void {
  closeMenus();
  const again = openPop?.anchor === anchor;
  openPop?.close();
  if (again) return;
  const g = app.entrances.graph();
  const used = app.usedLevels();
  for (const e of g.exits) used.add(e.to);
  const filter = h('input', { class: 'filter', placeholder: 'No. (hex) or name …', spellcheck: false });
  const onlyUsed = h('input', { type: 'checkbox', checked: true });
  const list = h('div', { class: 'level-list' });
  const pop = h('div', { class: 'menu level-pop' }, filter, h('label', { class: 'row small' }, onlyUsed, ' only used'), list);
  let first = -1;
  const pick = (n: number) => { close(); onPick(n); };
  const build = () => {
    clear(list);
    first = -1;
    const f = filter.value.trim().toLowerCase();
    for (const i of opts.levels ?? Array.from({ length: 0x200 }, (_, k) => k)) {
      if (onlyUsed.checked && !used.has(i) && i !== value) continue;
      const name = g.name(i);
      if (f && !hex3(i).toLowerCase().includes(f) && !name.toLowerCase().includes(f)) continue;
      const el = h('div', { class: `level-item${i === value ? ' current' : ''}${used.has(i) ? '' : ' unused'}`, onclick: () => pick(i) }, hex3(i), h('span', { class: 'lname' }, ' ' + name), opts.note?.(i) ? h('span', { class: 'hint' }, ` · ${opts.note(i)}`) : null);
      list.append(el);
      if (first < 0) first = i;
      if (i === value) setTimeout(() => el.scrollIntoView({ block: 'nearest' }), 0);
    }
    if (first < 0) list.append(emptyState('No level matches.'));
  };
  filter.addEventListener('input', build);
  onlyUsed.addEventListener('change', build);
  filter.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { close(); e.stopPropagation(); return; }
    if (e.key !== 'Enter') return;
    const v = filter.value.trim(), n = parseInt(v, 16);
    if (/^[0-9a-f]{1,3}$/i.test(v) && (opts.levels ? opts.levels.includes(n) : n < 0x200)) pick(n);
    else if (first >= 0) pick(first);
  });
  build();
  const r = anchor.getBoundingClientRect();
  pop.style.cssText = `position: fixed; left: ${Math.max(4, Math.min(r.left, window.innerWidth - 324))}px; top: ${r.bottom + 3}px`;
  document.body.append(pop);
  if (pop.getBoundingClientRect().bottom > window.innerHeight - 4) pop.style.top = `${Math.max(4, r.top - 3 - pop.offsetHeight)}px`;
  filter.focus();
  const outside = (ev: MouseEvent) => { if (!pop.contains(ev.target as Node) && ev.target !== anchor && !anchor.contains(ev.target as Node)) close(); };
  window.addEventListener('mousedown', outside, true);
  openPop = { anchor, close };
  function close() {
    pop.remove();
    window.removeEventListener('mousedown', outside, true);
    if (openPop?.anchor === anchor) openPop = null;
  }
}
