// The World check (CONTEXT.md "World check"): whether the overworld can be played through, in the player's words –
// the problems of the paths (owreach.ts) and the checks that follow, each in a group, an error (Mario gets stuck, a
// level can't be reached) or a warning (may be fine, e.g. the hack's own code does it), at the event progress it is found
// at, with a fix where one exists. A problem's key is its kind and place: the same while the problem stays, so lists
// before and after an edit can be compared.

import type { Rom } from './rom.ts';
import { sameProgress, prefixLength, type EventProgress } from './eventset.ts';
import { readL1, writeL1, readDestroyList, revealEventCount, gameL1, l1XY, NO_EVENT, OW_EVENTS, type OverworldLoads } from './overworld.ts';
import { eventReveal } from './oweventtiles.ts';
import { readEvents, submapViewsJob, submapOf } from './owevents.ts';
import { budgetLevel, budgetText, owBudgets, fullestSubmap, type Budget } from './owbudget.ts';
import { progressSavesJob, progressMapsFromEvents, progressInput, progressSearches } from './owprogress.ts';
import { l1OwnLooksJob, lookProblems } from './owlook.ts';
import { tileText, type OwTile } from './owteleport.ts';
import { readLinks, removeLink, type OwLink } from './owlinks.ts';
import { ExitGraph } from './exitgraph.ts';
import type { ScreenExit } from './level.ts';
import type { Job } from './jobrunner.ts';
import { RAM } from './ram.ts';
import type { OwMode } from './owlayers.ts';
import { reach, reachProblems, stuckProblems, exitTileFix, type Reached, type ReachKind, type ReachProblem, type CheckSeverity } from './owreach.ts';
import { hex3 } from './names.ts';
import { stopsOn, type PathKind, type PathShapes } from './owpaths.ts';
import type { OwRefusalData } from './owrefusal.ts';
import { checkContext, eventsNeverRun, stranded, untiledLevelsEntered, eventOrderProblems, starsWithoutTranslevelProblems, misplacedLinkEnds, sharedOrEmptyLevelTiles } from './owchecks.ts';
import { moveEnd, endTile, type MisplacedEnd } from './owlinkends.ts';
import type { Rect } from './owevents.ts';

export type CheckGroup = 'paths' | 'progress' | 'links' | 'look' | 'budget';
// the groups in the panel's order (an empty one is not shown)
export const CHECK_GROUPS: readonly { id: CheckGroup; name: string; title: string }[] = [
  { id: 'paths', name: 'Paths', title: 'Where Mario walks: ways that end without a level or stop tile' },
  { id: 'progress', name: 'Progress', title: 'Levels and events: what the player can\'t get to, events that change nothing he gets to' },
  { id: 'links', name: 'Links', title: 'Stars, pipes and exit paths: where they take Mario' },
  { id: 'look', name: 'Look', title: 'How the map looks to the player' },
  { id: 'budget', name: 'Budget', title: 'The game\'s limits: how much of each table is used' },
];

export type { CheckSeverity };

// a fix of a problem, one ROM edit (applyFix): layer 1 tile `tile` (l1Index) of the map before events set to `to`; or a
// link's end at `tile` moved to the submap whose paths its tile is on (owlinkends.ts moveEnd)
export type WorldFix = TileFix | LinkEndFix | LinkRemoveFix;
export interface TileFix { label: string; title: string; tile: number; to: number }
export interface LinkEndFix { label: string; title: string; tile: number; end: MisplacedEnd }
// a link removed (owlinks.ts removeLink): one from or to a tile Mario can't use it on (#413)
export interface LinkRemoveFix { label: string; title: string; tile: number; link: OwLink }

export interface WorldProblem {
  key: string; // kind and place: the same while the problem stays
  group: CheckGroup;
  severity: CheckSeverity;
  text: string; // in the player's words
  brief: string; // in a few words, to go on in a sentence ("dead end at Main map 0C,09")
  title?: string; // longer explanation
  tile: number; // where it is (l1Index): shown and outlined
  progress: EventProgress; // the event progress it is found at (OW_EVENTS: every event passed; the set shown: eventset.ts)
  fix?: WorldFix;
  noFix?: OwRefusalData; // why a problem a fix exists for has none here (owrefusal.ts)
  budget?: Budget; // a budget amber or full (tile -1: Show goes to where the limit applies, budgetPlace)
  show?: { event: number; mode: OwMode }; // where Show goes instead of the progress found at: an event in a mode
}

// a search of owreach.ts at an event progress (a prefix, or the set shown)
export interface CheckedAt extends Reached { progress: EventProgress }

const GROUP_OF: Record<ReachKind, CheckGroup> = {
  'dead-end': 'paths', 'exit-nowhere': 'links', 'exit-off-path': 'paths', 'arrival-stuck': 'links', 'unreached-level': 'progress', 'event-reveals-nothing': 'progress',
};

// The World check's problems: those of the paths at the event progress shown (`now`) and with every event passed
// (`all`), with the problems of worldChecks (`checks`, found with every event passed: kept while the ROM is the
// same), errors first, then by group. everyProgress: the problems found at every event progress
// (stuckAtEveryProgress, the Look group's paths), once they are learned – a dead end or exit path tile leading
// nowhere at the progress shown then listed once, with the first progress it is found at: everyProgress's where that
// has its key, else the progress shown (those come from the emulated maps, everyProgress's from the maps built from
// the events: on a hack whose overworld code differs a real one may be missing there). place: a tile's name ("Main
// map 0C,09"); submap: the submap a tile is on (for the exit tile a fix puts there; by default its region)
export function worldProblems(rom: Rom, now: CheckedAt, all: CheckedAt, place: (tile: number) => string, checks: readonly WorldProblem[] = [], everyProgress: readonly WorldProblem[] | null = null,
  submap: (tile: number) => number = regionOf): WorldProblem[] {
  const fixes = fixContext(rom, now.inp.kinds, submap), every = new Set(everyProgress?.map((p) => p.key));
  const out = reachProblems(rom, now, all, place)
    .filter((p) => p.at !== 'now' || !every.has(p.key))
    .map((p) => reachProblem(p, p.at === 'now' ? now : all, fixes));
  out.push(...checks, ...everyProgress ?? []);
  const order = (p: WorldProblem) => (p.severity === 'error' ? 0 : 10) + CHECK_GROUPS.findIndex((g) => g.id === p.group);
  return out.sort((a, b) => order(a) - order(b));
}

// what the fixes of the paths' problems need: the map before events (`l1`), the stop tile a fix puts there
// (stopTile), the exit tiles on each submap of it, the most used first
interface FixContext { l1: ArrayLike<number>; stop: number; exitsOn: (tile: number) => number[] }
const regionOf = (tile: number): number => (tile >= 0x400 ? 1 : 0);
function fixContext(rom: Rom, kinds: readonly PathKind[], submap: (tile: number) => number): FixContext {
  const l1 = readL1(rom), bySubmap = new Map<number, Map<number, number>>();
  for (let i = 0; i < l1.length; i++) {
    if (kinds[l1[i]] !== 'exit') continue;
    const s = submap(i), n = bySubmap.get(s) ?? bySubmap.set(s, new Map()).get(s)!;
    n.set(l1[i], (n.get(l1[i]) ?? 0) + 1);
  }
  const exitsOn = (tile: number) => [...bySubmap.get(submap(tile)) ?? []].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([t]) => t);
  return { l1, stop: stopTile(l1, kinds), exitsOn };
}

// a problem of the paths (owreach.ts) found by search `at` (its progress), with its fix where the map before events
// has the tile (an event changing it would put its own back): a dead end a stop tile in place of the path tile Mario
// is stuck on; an exit path tile Mario comes out of across the path another exit tile, of the path's axis (owreach.ts
// exitTileFix: one on the submap where one fits)
function reachProblem(p: ReachProblem, at: CheckedAt, fx: FixContext): WorldProblem {
  const q: WorldProblem = { key: p.key, group: GROUP_OF[p.kind], severity: p.severity, text: p.text, brief: p.brief, title: p.title, tile: p.tile, progress: at.progress };
  const kinds = at.inp.kinds, t = at.inp.l1[p.tile];
  if (p.kind === 'exit-off-path' && p.way !== undefined && fx.l1[p.tile] === t) {
    const to = exitTileFix(at.inp, p.way, p.tile, fx.exitsOn(p.tile));
    if (to >= 0) {
      q.fix = { label: 'Use a fitting exit tile', tile: p.tile, to,
        title: `Tile ${hex3(to)} (an exit tile of the path's axis) in place of tile ${hex3(t)}, on the map before events: Mario comes out of the exit walking on along the path` };
    }
    return q;
  }
  if (p.kind !== 'dead-end' || stopsOn(kinds[t]) || kinds[t] === 'level') return q;
  if (fx.stop < 0) q.noFix = { kind: 'deadEndNoStopTile' };
  else if (fx.l1[p.tile] !== t) q.noFix = { kind: 'deadEndEventTile', cell: p.tile };
  else {
    q.fix = { label: 'Add a stop tile here', tile: p.tile, to: fx.stop,
      title: `Tile ${hex3(fx.stop)} (a stop tile) in place of the path tile Mario gets stuck on, on the map before events: he stops there and can walk back` };
  }
  return q;
}

// The dead ends, exit path tiles leading nowhere, exit path tiles Mario comes out of off the path and tiles a star, pipe
// or level's teleport puts him on standing where he can't move (owreach.ts stuckProblems) at every event progress 0 …
// OW_EVENTS (`at`: the searches there, owprogress.ts progressSearches), each once, found at the first
// progress it is at: one only a late event brings is listed whatever progress is shown. submap: as worldProblems'
export function stuckAtEveryProgress(rom: Rom, at: (progress: number) => CheckedAt, place: (tile: number) => string, submap: (tile: number) => number = regionOf): WorldProblem[] {
  const fixes = fixContext(rom, at(0).inp.kinds, submap), out = new Map<string, WorldProblem>();
  for (let p = 0; p <= OW_EVENTS; p++) {
    const s = at(p);
    for (const q of stuckProblems(s, place)) if (!out.has(q.key)) out.set(q.key, reachProblem(q, s, fixes));
  }
  for (const q of linkTileProblems(readLinks(rom), at, place)) out.set(q.key, q);
  return [...out.values()];
}

// The links from or to a tile Mario can't use them on (#413): a star/pipe link from a tile where A doesn't warp (#455:
// only a star or pipe, path kind 'warp' – A on a level tile enters the level, on a plain stop tile does nothing; the
// back end of a link both ways too), an exit path from or to a tile that is neither an exit path tile nor a stop tile
// (the game's cave starts one from a stop) – found at the first event progress from which it stays so up to every event
// passed (`at`: the maps at each progress 0 … OW_EVENTS): a tile an event reveals later is fine before, one painted,
// destroyed or changed by an event is not – an error; one on a tile Mario can use it on at no progress a warning (maybe
// painted over before events), none where the cell is empty at every progress: an entry nothing uses, Mario never
// there (the clean game has one, from Main map 14,02). The clean game's entry from Yoshi's Island 06,07 is on the level
// tile 056 at every progress: a warning. Fix: the link removed.
export function linkTileProblems(links: readonly OwLink[], at: (progress: number) => { inp: { l1: ArrayLike<number>; kinds: readonly PathKind[] } }, place: (tile: number) => string): WorldProblem[] {
  const out: WorldProblem[] = [], maps = Array.from({ length: OW_EVENTS + 1 }, (_, p) => at(p).inp);
  for (const l of links) {
    const fits = (inp: typeof maps[number], t: OwTile, start: boolean) => {
      const k = inp.kinds[inp.l1[endTile(t)]];
      return l.kind === 'exit' ? k === 'exit' || stopsOn(k) : !start || k === 'warp';
    };
    for (const e of [{ t: l.a, start: true }, { t: l.b, start: l.kind === 'exit' || l.both }]) {
      if (fits(maps[OW_EVENTS], e.t, e.start)) continue;
      let from = OW_EVENTS;
      while (from > 0 && !fits(maps[from - 1], e.t, e.start)) from--;
      const never = from === 0;
      if (never && maps.every((inp) => inp.kinds[inp.l1[endTile(e.t)]] === 'none')) continue;
      const tile = endTile(e.t), name = l.kind === 'exit' ? 'exit path' : 'star/pipe link', what = place(tile);
      const text = l.kind === 'exit'
        ? `The exit path ${e.t === l.a ? 'from' : 'to'} ${what} is not on an exit path tile: Mario never takes it there`
        : `The star/pipe link ${e.t === l.a ? 'from' : 'back from'} ${what} is not on a star or pipe tile: pressing A there doesn't warp`;
      out.push({
        key: `link-tile:${l.kind}:${l.entries.join(',')}:${tile}`, group: 'links', severity: never ? 'warn' : 'error',
        text: never ? `${text} at any event progress (an entry nothing uses)` : text, brief: `${name} on the wrong tile at ${what}`,
        title: never ? `The ${name} leads from a tile that is never one to take it from; maybe it was painted over before events.` : `The tile at ${what} changes (painted over or by an event) after the ${name} was usable there.`,
        tile, progress: from,
        fix: { label: 'Remove the link', title: `Remove the ${name} ${tileText(l.a)} ${l.both ? '↔' : '→'} ${tileText(l.b)} (one ROM edit)`, tile, link: l },
      });
      break;
    }
  }
  return out;
}

// whether a World check problem is found at every event progress at once (stuckAtEveryProgress, the Look group's
// paths): learned later than the others, said apart from them
export const isFoundAtEveryProgress = (p: WorldProblem): boolean => /^(dead-end|exit-nowhere|exit-off-path|arrival-stuck|path-late-look|path-no-look|link-tile):/.test(p.key);

// The checks of owchecks.ts with every event passed (`all`), the levels' exits in `graph`: events never run, links
// stranding Mario, levels without level tile an exit leads into, events out of play order, stars without translevel,
// link ends on a submap whose paths their tile is not on (with the submaps' views: views), level tiles sharing a level
// or entering none
export function worldChecks(rom: Rom, all: CheckedAt, place: (tile: number) => string, graph: ExitGraph, views: readonly Rect[]): WorldProblem[] {
  const c = checkContext(rom, all, place);
  return [...eventsNeverRun(c), ...stranded(c), ...untiledLevelsEntered(c, graph), ...eventOrderProblems(c), ...starsWithoutTranslevelProblems(c),
    ...misplacedLinkEnds(c, views), ...sharedOrEmptyLevelTiles(c)];
}

// What the World check learns in the probe worker (worldCheckJob): the problems of worldChecks and the budgets' (found
// with every event passed, the budgets with the custom sprites of the submap with the most), every budget, and the
// problems found at every event progress (stuckAtEveryProgress, owlook.ts lookProblems). Places named by the submaps'
// views
export interface WorldCheckLearned { checks: WorldProblem[]; budgets: Budget[]; every: WorldProblem[] }

// The World check's part that is the same at every event progress shown, as a job of the result learner (probe worker),
// so that the editor's main thread only searches at the progress shown: the saves (owprogress.ts progressSavesJob, kept
// by the loads, a step per event); the submaps' views and the tiles' own looks (a step per submap); the map with every
// event passed as emulated (as the overworld view's search has it); worldChecks and the budgets; then the searches at every progress over the maps built from
// the events – each a step. kinds, shapes: the path kinds and shapes; open: the open level with its exits as edited (as
// the editor's exits, ExitGraph) – all sent with the job
export function* worldCheckJob(rom: Rom, loads: OverworldLoads, kinds: readonly PathKind[], shapes: PathShapes, open?: { number: number; exits: ScreenExit[] }): Job<WorldCheckLearned> {
  const saves = yield* progressSavesJob(loads);
  yield;
  const views = yield* submapViewsJob(loads), ownLooks = yield* l1OwnLooksJob(rom, loads);
  yield;
  const every = loads.get(0, OW_EVENTS);
  const emulated = [{ l1: gameL1(every).slice(), tls: every.wram.slice(RAM.owTranslevels, RAM.owTranslevelsEnd), flags: saves[OW_EVENTS].levelFlags }];
  yield;
  // (a problem's tile named on its submap by submapOf: only the tile known, ambiguous in an overlap of views)
  const graph = new ExitGraph(rom, open), place = (i: number) => tileText({ submap: submapOf(views, i), ...l1XY(i) });
  const inp = progressInput(rom, emulated, kinds, shapes, graph)(0);
  const all: CheckedAt = { inp, r: reach(inp), progress: OW_EVENTS };
  const budgets = owBudgets(rom, fullestSubmap(rom), kinds), checks = [...worldChecks(rom, all, place, graph, views), ...budgetProblems(budgets)];
  yield;
  const maps = progressMapsFromEvents(rom, saves.map((s) => s.levelFlags));
  const search = progressSearches(progressInput(rom, maps, kinds, shapes, graph));
  return { checks, budgets, every: [...stuckAtEveryProgress(rom, search, place, (i) => submapOf(views, i)), ...lookProblems({ rom, maps, ownLooks, kinds, views, search, place })] };
}

// Where Show of a problem goes in the event list (#427, ADR 0014): exactly the events of the prefix it is found at
// checked (`checked`: their count) and its last event edited – a problem naming the event to show it in (`show`): that
// one; one found at the set shown (not a prefix): the checks stay (checked null), its `show` event edited, else the
// event edited now (`edited`) stays
export interface ShowTarget { checked: number | null; edit: number } // checked: the prefix's count, null: the checks stay
export function problemShow(p: Pick<WorldProblem, 'progress' | 'show'>, edited: number): ShowTarget {
  const n = prefixLength(p.progress);
  if (n >= 0) return { checked: n, edit: p.show ? p.show.event : n - 1 };
  return { checked: null, edit: p.show ? p.show.event : edited };
}
// Where Show of a budget goes (budgetPlace): one beside an event's actions with the events up to that one checked and
// it edited – the gauge of the event edited now (`edited`) is there already: the checks stay; else the checks and the
// event edited stay (checked null)
export function budgetShow(place: BudgetPlace, edited: number): ShowTarget {
  return place.event === undefined || place.event === edited ? { checked: null, edit: edited } : { checked: place.event + 1, edit: place.event };
}

// ---- budgets (owbudget.ts) ----

// A budget's problem: full an error, from 80 % a warning – the reveal list's at most a warning: its pairs are a fixed
// list, the clean game's every one used, and full it only stops a tile of a kind no pair turns into another from being
// revealed. The key is its budget (with the submap of the custom sprites) and level: amber turning full is new.
export function budgetProblems(budgets: readonly Budget[]): WorldProblem[] {
  const out: WorldProblem[] = [];
  for (const b of budgets) {
    const level = budgetLevel(b);
    if (level === 'ok') continue;
    const full = level === 'full', reveal = b.key === 'revealPairs';
    const left = b.max - b.used;
    out.push({
      key: `budget:${b.key}${b.submap !== undefined ? `:${b.submap}` : ''}:${level}`,
      group: 'budget',
      severity: full && !reveal ? 'error' : 'warn',
      text: full ? (reveal ? `${b.name} full: a new kind of tile to reveal needs a pair changed` : `${b.name} full: no room for another`)
        : `${b.name} almost full: ${left} left`,
      brief: `${b.name} ${full ? 'full' : 'almost full'}`,
      title: `${b.help}\n${budgetText(b)}${reveal && full ? '\nA warning: tiles of the kinds the list turns are still revealed' : ''}`,
      tile: -1,
      progress: OW_EVENTS,
      budget: b,
    });
  }
  return out;
}

// where a budget's limit applies – its gauge beside the action it stops: the mode, the submap (custom sprites), the
// event to choose for the gauges beside an event's reveal, destroys and steps: the one chosen (`chosen`, -1 none) where
// it shows the gauge, else the first using the table (none: event 0)
export interface BudgetPlace { mode: OwMode; submap?: number; event?: number }
export function budgetPlace(rom: Rom, b: Budget, chosen = -1): BudgetPlace {
  const first = (uses: (e: number) => boolean) => Math.max(0, Array.from({ length: OW_EVENTS }, (_, e) => e).findIndex(uses));
  // (an event past the reveal table shows "reveals none" in place of the reveal list's gauge)
  if (chosen >= 0 && (b.key === 'destroys' || b.key === 'eventStorage' || (b.key === 'revealPairs' && chosen < revealEventCount(rom)))) {
    return { mode: b.key === 'eventStorage' ? 'l2' : 'l1', event: chosen };
  }
  switch (b.key) {
    case 'l1Tiles': return { mode: 'l1' };
    case 'translevels': return { mode: 'l1' }; // (the layer 1 picker's "Levels")
    case 'stars': case 'exitPaths': return { mode: 'l1' }; // (the overworld links: their gauges under the properties)
    case 'customSprites': return { mode: 'sprites', submap: b.submap ?? 0 };
    case 'destroys': return { mode: 'l1', event: readDestroyList(rom).find((d) => d.event !== NO_EVENT)?.event ?? 0 };
    case 'revealPairs': return { mode: 'l1', event: first((e) => eventReveal(rom, e) >= 0) };
    case 'eventStorage': { const steps = readEvents(rom).steps; return { mode: 'l2', event: first((e) => !!steps[e]?.length) }; }
  }
}

// the stop tile a fix puts on the map: the one used most on the map before events (its look the map's), not a star or
// pipe (path kind 'warp': they stop Mario too, but look like a way on); none used: the first there is; -1: none
export function stopTile(l1: ArrayLike<number>, kinds: readonly PathKind[]): number {
  const isStop = (t: number) => kinds[t] === 'stop';
  const used = new Map<number, number>();
  for (let i = 0; i < l1.length; i++) if (isStop(l1[i])) used.set(l1[i], (used.get(l1[i]) ?? 0) + 1);
  const most = [...used].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  return most ? most[0] : kinds.findIndex((_, t) => isStop(t));
}

// the fix written (call it inside one ROM edit)
export function applyFix(rom: Rom, fix: WorldFix): void {
  if ('end' in fix) { moveEnd(rom, fix.end); return; }
  if ('link' in fix) { removeLink(rom, fix.link); return; }
  const l1 = readL1(rom);
  l1[fix.tile] = fix.to;
  writeL1(rom, l1);
}

export const errorCount = (ps: readonly WorldProblem[]): number => ps.filter((p) => p.severity === 'error').length;

// ---- what an edit changed ----

// the problems new and gone between two lists of the World check (by key)
export interface CheckDiff { added: WorldProblem[]; gone: WorldProblem[] }
export function diffProblems(before: readonly WorldProblem[], after: readonly WorldProblem[]): CheckDiff {
  const was = new Set(before.map((p) => p.key)), is = new Set(after.map((p) => p.key));
  return { added: after.filter((p) => !was.has(p.key)), gone: before.filter((p) => !is.has(p.key)) };
}

// the problems last checked: of a ROM generation, at an event progress
export interface CheckBaseline { gen: number; progress: EventProgress; problems: WorldProblem[] }
// The problems checked (`ps`, of ROM generation `gen` at event progress `progress`) against the baseline: what the ROM
// edits since changed (null: nothing to say – no baseline, no edit, or another event progress, whose problems no
// edit made), and the new baseline. Checked again without an edit (the places named anew) it only takes the new list
export function checkAgainst(last: CheckBaseline | null, gen: number, progress: EventProgress, ps: WorldProblem[]): { baseline: CheckBaseline; change: CheckDiff | null } {
  const baseline = { gen, progress, problems: ps };
  const change = last && last.gen !== gen && sameProgress(last.progress, progress) ? diffProblems(last.problems, ps) : null;
  return { baseline, change };
}

// What an edit changed, said in one sentence (a toast): the errors new and gone named – up to `max` in all, each list
// then "and N more" – the warnings counted ("New: dead end at Main map 0C,09 · Fixed: level 105 not reached and 2
// more · +2 warnings"); `show` the first new error; null when nothing changed
export function diffText(d: CheckDiff, max = 3): { text: string; show: WorldProblem | null } | null {
  if (!d.added.length && !d.gone.length) return null;
  const errors = (ps: WorldProblem[]) => ps.filter((p) => p.severity === 'error');
  const added = errors(d.added), gone = errors(d.gone);
  const warnings = (n: number, sign: string) => (n ? `${sign}${n} warning${n > 1 ? 's' : ''}` : '');
  let left = max;
  // a list named up to what is left of `max` (at least one), "and N more" for the others
  const names = (what: string, ps: WorldProblem[]) => {
    if (!ps.length) return '';
    const n = Math.max(1, left), more = ps.length - Math.min(n, ps.length);
    left -= n;
    return `${what}: ${ps.slice(0, n).map((p) => p.brief).join('; ')}${more ? ` and ${more} more` : ''}`;
  };
  const parts = [
    names('New', added),
    names('Fixed', gone),
    warnings(d.added.length - added.length, '+'),
    warnings(d.gone.length - gone.length, '−'),
  ].filter((s) => s);
  return { text: parts.join(' · '), show: added[0] ?? null };
}
