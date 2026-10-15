// "Used in levels …" (levelusage.ts): the levels using a Map16 tile, GFX file or sprite, each with what it
// uses there; clicking one opens the level at the first place (the level view, or the graphics
// workspace's preview).

import type { App } from './app.ts';
import { h } from './dom.ts';
import { hex } from '../core/names.ts';
import { levelNameOf } from './panels.ts';

export interface UsedIn { level: number; text: string; at?: { x: number; y: number } } // at: level tile

// title: what is listed; pending: levels still being looked through; none: the text when nothing uses it
export function usedInList(app: App, title: string, items: UsedIn[], pending: number, none: string): HTMLElement {
  const box = h('div', { class: 'used-in' },
    h('div', { class: 'panel-title' }, title, h('span', { class: 'hint' }, items.length ? `${items.length} level${items.length > 1 ? 's' : ''}` : '')));
  if (pending) box.append(h('div', { class: 'hint' }, `Looking through ${pending} more level${pending > 1 ? 's' : ''} …`));
  if (!items.length) { if (!pending) box.append(h('div', { class: 'hint' }, none)); return box; }
  box.append(h('div', { class: 'used-in-list' }, items.map((u) => {
    const name = levelNameOf(app, u.level);
    return h('a', {
      href: '#', class: `used-in-item${u.level === app.level.number ? ' current' : ''}`,
      title: `Open level ${hex(u.level, 3)}${u.at ? ' at the first place' : ''}`,
      onclick: (e: Event) => { e.preventDefault(); app.showUse(u.level, u.at); },
    }, h('b', { class: 'mono' }, hex(u.level, 3)), name ? h('span', { class: 'used-in-name' }, name) : '', h('span', { class: 'hint' }, u.text));
  })));
  return box;
}
