// Central search (Ctrl+F or Ctrl+Space), like "Search Everywhere" in IntelliJ or the quick open of VS Code: one input over
// everything the providers offer, the results grouped by provider. A row of groups above the list narrows the
// search to one of them (Tab / Shift+Tab switch); choosing a result runs its pick(). For now the providers are
// the tabs of the picker (Picker.searchProviders).

import { h, clear, emptyState } from './dom.ts';

export interface SearchResult {
  label: string; // number or short key, monospace
  name: string;
  detail?: string; // shown muted after the name, e.g. what a block does
  title?: string; // tooltip
  thumb?: () => Node | null; // drawn when the row is shown
  pick: () => void;
}

export interface SearchProvider {
  id: string;
  label: string;
  // results matching every term of the query (lower case, at least one); the order is the provider's
  search: (terms: string[]) => SearchResult[];
}

// the terms of a query: words in lower case
export function searchTerms(q: string): string[] {
  return q.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

// true when every term occurs in the text (lower case)
export function matchesAll(text: string, terms: string[]): boolean {
  return terms.every((t) => text.includes(t));
}

const PER_GROUP = 8; // results per group when searching all of them
const MAX = 300; // results shown for one group

let last = ''; // the query is kept for the next time, selected
let current: { close: () => void } | null = null;

export function openSearch(providers: SearchProvider[]): void {
  if (current) { current.close(); return; }
  let group = ''; // '' all groups, else a provider id
  let rows: { el: HTMLElement; pick: () => void }[] = [];
  let active = 0;
  const input = h('input', { class: 'filter search-input', placeholder: 'Search objects, prefabs, Map16, sprites …', spellcheck: false, autocomplete: 'off', value: last });
  const groups = h('div', { class: 'tabs seg search-groups' });
  const list = h('div', { class: 'search-list' });
  const box = h('div', { class: 'search-box' }, h('div', { class: 'row' }, input), groups, list,
    h('div', { class: 'hint search-foot' }, '↑ ↓ choose · Enter take · Tab / Shift+Tab group · Esc close'));
  const back = h('div', { class: 'search-back' }, box);

  const setActive = (i: number) => {
    if (!rows.length) return;
    rows[active]?.el.classList.remove('active');
    active = (i + rows.length) % rows.length;
    rows[active].el.classList.add('active');
    rows[active].el.scrollIntoView({ block: 'nearest' });
  };
  const take = (pick: () => void) => { close(); pick(); };
  const setGroup = (g: string) => { group = g; build(); input.focus(); };

  // thumbnails are drawn when their row scrolls into view
  let observer: IntersectionObserver | null = null;
  function build(): void {
    observer?.disconnect();
    const thumbs = new Map<Element, () => Node | null>();
    const obs = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const n = thumbs.get(e.target)?.();
        if (n) e.target.append(n);
        thumbs.delete(e.target);
        obs.unobserve(e.target);
      }
    }, { root: list, rootMargin: '200px 0px' });
    observer = obs;
    clear(groups);
    for (const [id, label] of [['', 'All'], ...providers.map((p) => [p.id, p.label])]) {
      groups.append(h('button', { class: group === id ? 'active' : '', onmousedown: (e: Event) => e.preventDefault(), onclick: () => setGroup(id) }, label));
    }
    clear(list);
    rows = [];
    active = 0;
    const terms = searchTerms(input.value);
    if (!terms.length) { list.append(emptyState('Type a number or a name.')); return; }
    // results whose number or name is the query come first, then those with every term in the number or name,
    // then those found by the rest (detail, behavior, …); a group is ranked by its best result
    const q = terms.join(' ');
    const rank = (r: SearchResult) => {
      const label = r.label.toLowerCase(), name = r.name.toLowerCase();
      return label === q || name === q ? 0 : matchesAll(`${label} ${name}`, terms) ? 1 : 2;
    };
    const groupsFound = providers.filter((p) => !group || p.id === group).map((p) => {
      const found = p.search(terms).map((r) => ({ r, rank: rank(r) })).sort((a, b) => a.rank - b.rank); // (stable)
      return { p, found: found.map((x) => x.r), best: found[0]?.rank ?? 3 };
    }).filter((g) => g.found.length);
    groupsFound.sort((a, b) => a.best - b.best);
    for (const { p, found } of groupsFound) {
      const max = group ? MAX : PER_GROUP;
      if (!group) list.append(h('div', { class: 'picker-head' }, p.label, h('span', { class: 'hint' }, ` ${found.length}`)));
      for (const r of found.slice(0, max)) {
        const thumb = h('span', { class: 'picker-thumb-s' });
        if (r.thumb) { thumbs.set(thumb, r.thumb); obs.observe(thumb); }
        const el = h('div', { class: 'picker-row', title: r.title ?? '' }, thumb, h('span', { class: 'num' }, r.label), h('span', { class: 'grow' }, r.name, r.detail ? h('span', { class: 'hint' }, `  ${r.detail}`) : ''));
        const i = rows.length;
        el.addEventListener('mousemove', () => { if (active !== i) setActive(i); });
        el.addEventListener('click', () => take(r.pick));
        rows.push({ el, pick: r.pick });
        list.append(el);
      }
      if (found.length > max) {
        const more = h('div', { class: 'picker-row search-more' }, group ? `… ${found.length - max} more – type more to narrow it down` : `… ${found.length - max} more in ${p.label}`);
        if (!group) {
          const pick = () => setGroup(p.id);
          more.addEventListener('click', pick);
          const i = rows.length;
          more.addEventListener('mousemove', () => { if (active !== i) setActive(i); });
          rows.push({ el: more, pick });
        }
        list.append(more);
      }
    }
    if (!rows.length) list.append(emptyState(group ? `Nothing found in ${providers.find((p) => p.id === group)?.label}.` : 'Nothing found.'));
    setActive(0);
  }

  input.addEventListener('input', () => { last = input.value; build(); });
  input.addEventListener('keydown', (e) => {
    const k = e.key;
    if (k === 'Escape') close();
    else if (k === 'ArrowDown') setActive(active + 1);
    else if (k === 'ArrowUp') setActive(active - 1);
    else if (k === 'PageDown') setActive(Math.min(rows.length - 1, active + 10));
    else if (k === 'PageUp') setActive(Math.max(0, active - 10));
    else if (k === 'Enter') { const r = rows[active]; if (!r) return; if (r.el.classList.contains('search-more')) r.pick(); else take(r.pick); }
    else if (k === 'Tab') {
      const ids = ['', ...providers.map((p) => p.id)];
      setGroup(ids[(ids.indexOf(group) + (e.shiftKey ? ids.length - 1 : 1)) % ids.length]);
    } else if ((e.ctrlKey || e.metaKey) && (k.toLowerCase() === 'f' || e.code === 'Space')) close();
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  document.body.append(back);
  build();
  input.focus();
  input.select();
  current = { close };
  function close(): void {
    observer?.disconnect();
    back.remove();
    current = null;
  }
}
