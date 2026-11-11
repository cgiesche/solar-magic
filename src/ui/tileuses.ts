// Where Map16 tiles are used, rewritten (core/tilemove.ts): the levels as the editor sees them (the open one
// as edited), what a plan rewrites, and Lunar Magic's "Remap Direct Map16" (its Edit menu) and "Remap
// Background Tiles" (its BG dialog) as one dialog – for the current level or all levels, the affected levels
// listed before anything changes.

import type { App } from './app.ts';
import { h, modal, toast } from './dom.ts';
import { hex } from '../core/names.ts';
import { loadLevel } from '../core/level.ts';
import { usedLevels } from '../core/levelusage.ts';
import { planRemap, applyRemap, type Layer, type LevelSource, type TileMap, type UsesPlan } from '../core/tilemove.ts';
import { remapEditor } from './remaplist.ts';
import { usedInList } from './usedin.ts';

// game BGs from the levels' loads (null: the load failed), kept while a dialog is open
export type LoadedBgs = Map<number, Uint16Array | null>;

// The levels (default: all) with the open one as edited; a game BG from the level's load (kept in `loaded`) where the
// usage index does not already know it lacks the map's tiles. Another level's load runs in the probe worker: until it
// is known its game BG counts as none, `pending` holds the level and `changed` is called with it once it is known.
export function levelSource(app: App, map: TileMap, levels = usedLevels(app.rom), loaded: LoadedBgs = new Map(), changed: (n: number) => void = () => {}):
  LevelSource & { pending: Set<number> } {
  const known = new Map(app.levelTiles().levels.map((l) => [l.level, l]));
  const pending = new Set<number>();
  return {
    levels,
    pending,
    level: (n) => (n === app.level.number ? app.level : loadLevel(app.rom, n)),
    gameBg: (n) => {
      const t = known.get(n);
      if (t && n !== app.level.number && !t.bg.some((b) => map.has(b.tile))) return null;
      if (loaded.has(n)) return loaded.get(n)!;
      const bg = app.loadedBg(n, (b) => { loaded.set(n, b); changed(n); });
      if (bg === undefined) { pending.add(n); return null; }
      loaded.set(n, bg);
      return bg;
    },
  };
}

// A plan made from a level source (with `changed`) once the game BGs it needs are all known: made again when those its
// last making waited for have come
export function whenLoaded<T>(make: (changed: (n: number) => void) => { value: T; pending: Set<number> }): Promise<T> {
  return new Promise((resolve) => {
    let waiting = new Set<number>();
    const came = (n: number) => { if (waiting.delete(n) && !waiting.size) again(); };
    const again = () => {
      const r = make(came);
      waiting = new Set(r.pending);
      if (!waiting.size) resolve(r.value);
    };
    again();
  });
}

// what a plan rewrites: the levels (clicking one opens it), prefabs, blocks
export function planList(app: App, plan: UsesPlan, none: string): HTMLElement {
  const items = plan.levels.map((c) => ({
    level: c.level,
    text: [c.objects ? `${c.objects} Direct Map16 object${c.objects > 1 ? 's' : ''}` : '', c.bg ? `${c.bg} BG tile${c.bg > 1 ? 's' : ''}` : ''].filter(Boolean).join(', '),
  }));
  return h('div', null,
    usedInList(app, 'Rewritten in levels', items, 0, none),
    plan.prefabs.length ? h('div', { class: 'hint' }, `Prefab${plan.prefabs.length > 1 ? 's' : ''} ${plan.prefabs.map((n) => hex(n, 2)).join(', ')}`) : '',
    plan.blocks.length ? h('div', { class: 'hint' }, `Custom block${plan.blocks.length > 1 ? 's' : ''} on ${plan.blocks.map((t) => hex(t, 3)).join(', ')} (list.txt, assembled again)`) : '');
}

const NAMES: Record<Layer, { title: string; what: string }> = {
  fg: { title: 'Remap Direct Map16', what: 'Direct Map16 objects' },
  bg: { title: 'Remap Background Tiles', what: 'BG tilemaps' },
};

// Lunar Magic's remap of the uses: the list's Map16 tiles become others where levels use them; the tiles
// themselves stay. `line`: the list to start with; `all`: all levels at first.
export function openRemapUses(app: App, layer: Layer, fill: { line?: string; all?: boolean } = {}): void {
  const n = app.level.number;
  let all = fill.all ?? false;
  const list = h('div', { class: 'ru-list' }), scopes = h('div', { class: 'row' });
  // (the apply reuses the preview's levels: their game BGs were loaded then, not during the ROM edit)
  let plan: { uses: UsesPlan; src: LevelSource } | null = null, open = true;
  const loaded: LoadedBgs = new Map();
  // the levels whose game BGs the plan shown waits for: drawn again once they have all come
  let waiting = new Set<number>();
  const came = (k: number) => { if (waiting.delete(k) && !waiting.size && open) draw(); };
  const draw = () => {
    const scope = (v: boolean, label: string) => h('label', { class: 'toggle' },
      h('input', { type: 'radio', name: 'ru-scope', checked: all === v, onchange: () => { all = v; draw(); } }), label);
    scopes.replaceChildren(scope(false, `This level (${hex(n, 3)})`), scope(true, 'All levels'));
    const { remap } = ed.parsed();
    const src = levelSource(app, remap.tiles, all ? undefined : [n], loaded, came);
    plan = ed.valid() && remap.tiles.size ? { uses: planRemap(app.rom, layer, remap.tiles, src), src } : null;
    waiting = plan ? src.pending : new Set();
    const k = waiting.size;
    list.replaceChildren(!ed.valid() ? h('div', { class: 'hint' }, 'Fix the marked lines first.')
      : !plan ? h('div', { class: 'hint' }, `Which Map16 tiles become which: ${NAMES[layer].what} using them are rewritten.`)
        : h('div', null,
          k ? h('div', { class: 'hint' }, `Loading the game BG${k > 1 ? 's' : ''} of ${k} level${k > 1 ? 's' : ''} …`) : '',
          planList(app, plan.uses, `No ${NAMES[layer].what.replace(/s$/, '')} ${all ? 'in any level' : 'here'} uses these tiles.`)));
  };
  const ed = remapEditor('numbers', draw);
  if (fill.line) ed.setText(fill.line);
  const body = h('div', { class: 'ru' },
    h('p', { class: 'hint', style: 'max-width:520px' }, layer === 'fg'
      ? 'Rewrites which Map16 tile Direct Map16 objects place (a whole object by its tile), e.g. after a .map16 was imported to another page than the levels expect. The tiles themselves stay; to move tiles with their uses, use Move in the Map16 tab.'
      : 'Rewrites the tiles of the levels\' BG tilemaps. Each tile keeps its own page, so a BG may mix pages. A game BG is stored by the editor once rewritten.'),
    scopes, ed.root, list);
  draw();
  modal(`${NAMES[layer].title}`, body, [
    { label: 'Apply', primary: true, onClick: () => {
      const { remap } = ed.parsed();
      if (waiting.size) { toast('The levels\' game BGs are still being loaded', 'error'); return false; }
      if (!plan?.uses.levels.length) { toast(ed.valid() ? 'Nothing changes' : 'Fix the marked lines first', 'error'); return false; }
      const { uses, src } = plan;
      try {
        const done = app.romEdit(`${NAMES[layer].title}: ${uses.levels.length} level${uses.levels.length > 1 ? 's' : ''}`, () => applyRemap(app.rom, layer, remap.tiles, src));
        toast(`${done.levels.length} level${done.levels.length > 1 ? 's' : ''} rewritten – Ctrl+Z undoes it`);
      } catch (e) { toast(String(e instanceof Error ? e.message : e), 'error'); return false; }
    } },
    { label: 'Cancel' },
  ], () => { open = false; app.dropLoadedBgs(); });
}
