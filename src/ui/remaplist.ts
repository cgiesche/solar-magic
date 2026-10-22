// The remap list editor (core/remap.ts): an offset for every 8x8 tile and a list in Lunar Magic's
// syntax; bad pairs are marked where they are in the text while typing, with the reason below. Used by
// the Map16 tab's remap panel, the Animations tab's remap dialog and the remaps of uses (Map16 tile numbers,
// a list only).

import { h } from './dom.ts';
import { parseRemap, type Remap, type RemapProblem, type RemapWhat } from '../core/remap.ts';

export interface RemapEditor {
  root: HTMLElement;
  // the remap as typed (problems: the list's and the offset's; a bad pair changes nothing)
  parsed(): { remap: Remap; problems: RemapProblem[]; offsetBad: boolean };
  valid(): boolean; // neither the list nor the offset has a problem
  setText(text: string): void;
  append(line: string): void;
  setOffset(v: number): void;
}

const MAP16_EXAMPLES: [string, string][] = [
  ['100,25', 'tile 100 becomes 25'],
  ['100-101,25', 'tiles 100 and 101 become 25'],
  ['100-101,+25', 'add 25 (or -25)'],
  ['100-101,M125', 'move to start at 125'],
  ['R100-111,M25', 'a rectangle (16 tiles a row) to 25'],
  ['P5-6,7', 'palettes 5 and 6 become 7'],
  ['100-101,P7', 'these 8x8 tiles get palette 7'],
  ['G100-101,+25', 'acts-like 100–101 of the tiles: add 25 (or M125)'],
  ['R200-211,S25', 'Map16 tiles 200–211 act like 25–36 (a rectangle)'],
  ['100,25,25,100', 'swap: sources are the tiles before the remap'],
];
const TILE_EXAMPLES = MAP16_EXAMPLES.filter(([e]) => !/[PGS]/.test(e));
const NUMBER_EXAMPLES: [string, string][] = [
  ['200,345', 'Map16 tile 200 becomes 345'],
  ['200-2FF,+300', 'add 300 (or -300)'],
  ['200-20F,M500', 'move to start at 500'],
  ['R200-231,M500', 'a rectangle (16 tiles a row) to 500'],
  ['200,201,201,200', 'swap: sources are the tiles before the remap'],
];

// "80", "+80", "-80" (hex); "" is 0; null when it is none of these
export function parseOffset(s: string): number | null {
  const m = /^\s*([+-]?)\s*([0-9a-f]*)\s*$/i.exec(s);
  if (!m || (m[1] && !m[2])) return null;
  const v = m[2] ? parseInt(m[2], 16) : 0;
  return m[1] === '-' ? -v : v;
}

export function remapEditor(what: RemapWhat, onChange: () => void): RemapEditor {
  const offset = h('input', { type: 'text', class: 'mono rl-offset', placeholder: '0', spellcheck: 'false', autocomplete: 'off',
    title: 'Added to every 8x8 tile number the list leaves alone (hex, e.g. 80 or -80)' });
  const area = h('textarea', { class: 'mono rl-text', rows: 6, spellcheck: 'false', autocomplete: 'off',
    placeholder: what === 'numbers' ? 'source,destination pairs, e.g.\n200-2FF,+300\nR200-231,M500' : 'source,destination pairs, e.g.\n100-17F,+100\nR100-111,M25' });
  const back = h('div', { class: 'mono rl-back' });
  const list = h('div', { class: 'rl-problems' });
  const ex = what === 'map16' ? MAP16_EXAMPLES : what === 'numbers' ? NUMBER_EXAMPLES : TILE_EXAMPLES;
  const examples = h('details', { class: 'rl-examples' }, h('summary', null, 'Syntax (Lunar Magic\'s, values hex)'),
    h('table', null, ex.map(([e, t]) => h('tr', null,
      h('td', null, h('a', { href: '#', class: 'mono', title: 'Add to the list', onclick: (ev: Event) => { ev.preventDefault(); ed.append(e); } }, e)),
      h('td', { class: 'hint' }, t)))));
  let cur = { remap: parseRemap('').remap, problems: [] as RemapProblem[], offsetBad: false };
  const update = () => {
    const off = parseOffset(offset.value);
    const p = parseRemap(area.value, { what, offset: off ?? 0 });
    cur = { ...p, offsetBad: off === null };
    offset.classList.toggle('invalid', off === null);
    // the marks: the text with the bad tokens in <mark>, behind the (transparent) text
    const text = area.value, parts: (string | HTMLElement)[] = [];
    let at = 0;
    for (const q of [...p.problems].sort((a, b) => a.from - b.from)) {
      if (q.from < at) continue;
      parts.push(text.slice(at, q.from), h('mark', { title: q.message }, text.slice(q.from, q.to)));
      at = q.to;
    }
    parts.push(text.slice(at), '\n');
    back.replaceChildren(...parts);
    back.scrollTop = area.scrollTop;
    list.replaceChildren(
      off === null ? h('div', { class: 'rl-problem' }, 'Offset: a hex number, e.g. 80 or -80') : '',
      ...p.problems.map((q) => h('div', { class: 'rl-problem', onclick: () => { area.focus(); area.setSelectionRange(q.from, q.to); } },
        h('b', null, `Line ${q.line + 1}`), ` “${area.value.slice(q.from, q.to)}”: ${q.message}`)));
    onChange();
  };
  offset.addEventListener('input', update);
  area.addEventListener('input', update);
  area.addEventListener('scroll', () => { back.scrollTop = area.scrollTop; });
  // keys typed here are the list's, not the tab's shortcuts
  for (const el of [offset, area]) el.addEventListener('keydown', (e) => e.stopPropagation());
  const ed: RemapEditor = {
    root: h('div', { class: 'rl' },
      what === 'numbers' ? '' : h('div', { class: 'row' }, h('label', { class: 'hint' }, 'Offset'), offset, h('span', { class: 'hint' }, 'for all 8x8 tiles')),
      what === 'numbers' ? '' : h('div', { class: 'hint' }, 'or a list (goes before the offset):'),
      h('div', { class: 'rl-edit' }, back, area),
      list, examples),
    parsed: () => cur,
    valid: () => !cur.problems.length && !cur.offsetBad,
    setText: (t) => { area.value = t; update(); },
    append: (line) => { const v = area.value.replace(/\s+$/, ''); area.value = v ? `${v}\n${line}` : line; update(); },
    setOffset: (v) => { offset.value = v ? (v < 0 ? '-' : '') + Math.abs(v).toString(16).toUpperCase() : ''; update(); },
  };
  return ed;
}
