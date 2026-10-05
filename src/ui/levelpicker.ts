// A button naming a level; a click opens a list to choose another one by number or name.

import type { App } from './app.ts';
import { h, clear, emptyState } from './dom.ts';
import { hex3 } from '../core/names.ts';
import { closeMenus } from './menu.ts';

// allowed: the levels that can be chosen (others are not listed); the list starts with "nur benutzte":
// main levels, relocated ones and those an exit leads to
export function levelPicker(app: App, value: number, allowed: (n: number) => boolean, onPick: (n: number) => void): HTMLElement {
  const g = app.exitGraph();
  const btn = h('button', { class: 'level-pick', title: 'Anderes Level wählen' }, h('span', { class: 'mono' }, hex3(value)), ' ', h('span', { class: 'lname' }, g.name(value)), h('span', { class: 'caret' }, ' ▾'));
  btn.addEventListener('click', () => openPicker(app, btn, value, allowed, onPick));
  return btn;
}

let openPop: { anchor: HTMLElement; close: () => void } | null = null;

function openPicker(app: App, anchor: HTMLElement, value: number, allowed: (n: number) => boolean, onPick: (n: number) => void): void {
  closeMenus();
  const again = openPop?.anchor === anchor;
  openPop?.close();
  if (again) return;
  const g = app.exitGraph();
  const used = app.usedLevels();
  for (const e of g.exits) used.add(e.to);
  const filter = h('input', { class: 'filter', placeholder: 'Nr. (hex) oder Name …', spellcheck: false });
  const onlyUsed = h('input', { type: 'checkbox', checked: true });
  const list = h('div', { class: 'level-list' });
  const pop = h('div', { class: 'menu level-pop' }, filter, h('label', { class: 'row small' }, onlyUsed, ' nur benutzte'), list);
  let first = -1;
  const pick = (n: number) => { close(); onPick(n); };
  const build = () => {
    clear(list);
    first = -1;
    const f = filter.value.trim().toLowerCase();
    for (let i = 0; i < 0x200; i++) {
      if (!allowed(i) || (onlyUsed.checked && !used.has(i) && i !== value)) continue;
      const name = g.name(i);
      if (f && !hex3(i).toLowerCase().includes(f) && !name.toLowerCase().includes(f)) continue;
      const el = h('div', { class: `level-item${i === value ? ' current' : ''}${used.has(i) ? '' : ' unused'}`, onclick: () => pick(i) }, hex3(i), h('span', { class: 'lname' }, ' ' + name));
      list.append(el);
      if (first < 0) first = i;
      if (i === value) setTimeout(() => el.scrollIntoView({ block: 'nearest' }), 0);
    }
    if (first < 0) list.append(emptyState('Kein Level passt.'));
  };
  filter.addEventListener('input', build);
  onlyUsed.addEventListener('change', build);
  filter.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { close(); e.stopPropagation(); return; }
    if (e.key !== 'Enter') return;
    const v = filter.value.trim(), n = parseInt(v, 16);
    if (/^[0-9a-f]{1,3}$/i.test(v) && n < 0x200 && allowed(n)) pick(n);
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
