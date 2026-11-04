// The World check (CONTEXT.md "World check"): whether the overworld can be played through, in the player's words –
// the problems of the paths (owreach.ts) and the checks that follow, each in a group, an error (Mario gets stuck, a
// level can't be reached) or a warning (may be fine, e.g. the hack's own code does it), at the event progress it is found
// at, with a fix where one exists. A problem's key is its kind and place: the same while the problem stays, so lists
// before and after an edit can be compared.

import type { Rom } from './rom.ts';
import { readL1, writeL1, readDestroyList, revealEventCount, NO_EVENT, OW_EVENTS } from './overworld.ts';
import { eventReveal } from './oweventtiles.ts';
import { readEvents } from './owevents.ts';
import { budgetLevel, budgetText, type Budget } from './owbudget.ts';
import type { OwMode } from './owlayers.ts';
import { reachProblems, WARP_TILES, ANY_WAY_TILE, type Reached, type ReachKind, type CheckSeverity } from './owreach.ts';
import { hex3 } from './names.ts';
import type { PathKind } from './owpaths.ts';
import type { OwRefusalData } from './owrefusal.ts';
import type { ExitGraph } from './exitgraph.ts';
import { checkContext, eventsNeverRun, stranded, untiledLevelsEntered, eventOrderProblems } from './owchecks.ts';

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

// a fix of a problem: layer 1 tile `tile` (l1Index) of the map before events set to `to` – one ROM edit (applyFix)
export interface WorldFix { label: string; title: string; tile: number; to: number }

export interface WorldProblem {
  key: string; // kind and place: the same while the problem stays
  group: CheckGroup;
  severity: CheckSeverity;
  text: string; // in the player's words
  brief: string; // in a few words, to go on in a sentence ("dead end at Main map 0C,09")
  title?: string; // longer explanation
  tile: number; // where it is (l1Index): shown and outlined
  progress: number; // the event progress it is found at (OW_EVENTS: every event passed)
  fix?: WorldFix;
  noFix?: OwRefusalData; // why a problem a fix exists for has none here (owrefusal.ts)
  budget?: Budget; // a budget amber or full (tile -1: Show goes to where the limit applies, budgetPlace)
  show?: { event: number; mode: OwMode }; // where Show goes instead of the progress found at: an event in a mode
}

// a search of owreach.ts at an event progress
export interface CheckedAt extends Reached { progress: number }

const GROUP_OF: Record<ReachKind, CheckGroup> = {
  'dead-end': 'paths', 'exit-nowhere': 'links', 'unreached-level': 'progress', 'event-reveals-nothing': 'progress',
};

// The World check's problems: those of the paths at the event progress shown (`now`) and with every event passed
// (`all`), with the problems of worldChecks (`checks`, found with every event passed: kept while the ROM is the same),
// errors first, then by group. place: a tile's name ("Main map 0C,09")
export function worldProblems(rom: Rom, now: CheckedAt, all: CheckedAt, place: (tile: number) => string, checks: readonly WorldProblem[] = []): WorldProblem[] {
  const l1 = readL1(rom), kinds = now.inp.kinds, stop = stopTile(l1, kinds);
  const out = reachProblems(rom, now, all, place).map((p): WorldProblem => {
    const progress = p.at === 'now' ? now.progress : all.progress;
    const q: WorldProblem = { key: p.key, group: GROUP_OF[p.kind], severity: p.severity, text: p.text, brief: p.brief, title: p.title, tile: p.tile, progress };
    // a dead end: a stop tile in place of the path tile Mario is stuck on, where the map before events has the tile
    // he is stuck on (an event changing it would put its own back)
    const t = now.inp.l1[p.tile];
    if (p.kind !== 'dead-end' || kinds[t] === 'stop' || kinds[t] === 'level') return q;
    if (stop < 0) q.noFix = { kind: 'deadEndNoStopTile' };
    else if (l1[p.tile] !== t) q.noFix = { kind: 'deadEndEventTile', cell: p.tile };
    else {
      q.fix = { label: 'Add a stop tile here', tile: p.tile, to: stop,
        title: `Tile ${hex3(stop)} (a stop tile) in place of the path tile Mario gets stuck on, on the map before events: he stops there and can walk back` };
    }
    return q;
  });
  out.push(...checks);
  const order = (p: WorldProblem) => (p.severity === 'error' ? 0 : 10) + CHECK_GROUPS.findIndex((g) => g.id === p.group);
  return out.sort((a, b) => order(a) - order(b));
}

// The checks of owchecks.ts with every event passed (`all`), the levels' exits in `graph`: events never run, links
// stranding Mario, levels without level tile an exit leads into, events out of play order
export function worldChecks(rom: Rom, all: CheckedAt, place: (tile: number) => string, graph: ExitGraph): WorldProblem[] {
  const c = checkContext(rom, all, place);
  return [...eventsNeverRun(c), ...stranded(c), ...untiledLevelsEntered(c, graph), ...eventOrderProblems(c)];
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
    case 'translevels': return { mode: 'levels' };
    case 'stars': case 'exitPaths': return { mode: 'links' };
    case 'customSprites': return { mode: 'sprites', submap: b.submap ?? 0 };
    case 'destroys': return { mode: 'l1', event: readDestroyList(rom).find((d) => d.event !== NO_EVENT)?.event ?? 0 };
    case 'revealPairs': return { mode: 'l1', event: first((e) => eventReveal(rom, e) >= 0) };
    case 'eventStorage': { const steps = readEvents(rom).steps; return { mode: 'l2', event: first((e) => !!steps[e]?.length) }; }
  }
}

// (the star and pipe tiles stop Mario too, but look like a way on; tile 82 is a stop tile he walks off any way)
const STAR_PIPE = WARP_TILES.filter((t) => t !== ANY_WAY_TILE);
// the stop tile a fix puts on the map: the one used most on the map before events (its look the map's), not a star or
// pipe; none used: the first there is; -1: none
export function stopTile(l1: ArrayLike<number>, kinds: readonly PathKind[]): number {
  const isStop = (t: number) => kinds[t] === 'stop' && !STAR_PIPE.includes(t & 0xff);
  const used = new Map<number, number>();
  for (let i = 0; i < l1.length; i++) if (isStop(l1[i])) used.set(l1[i], (used.get(l1[i]) ?? 0) + 1);
  const most = [...used].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  return most ? most[0] : kinds.findIndex((_, t) => isStop(t));
}

// the fix written (call it inside one ROM edit)
export function applyFix(rom: Rom, fix: WorldFix): void {
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
export interface CheckBaseline { gen: number; progress: number; problems: WorldProblem[] }
// The problems checked (`ps`, of ROM generation `gen` at event progress `progress`) against the baseline: what the ROM
// edits since changed (null: nothing to say – no baseline, no edit, or another event progress, whose problems no
// edit made), and the new baseline. Checked again without an edit (the places named anew) it only takes the new list
export function checkAgainst(last: CheckBaseline | null, gen: number, progress: number, ps: WorldProblem[]): { baseline: CheckBaseline; change: CheckDiff | null } {
  const baseline = { gen, progress, problems: ps };
  const change = last && last.gen !== gen && last.progress === progress ? diffProblems(last.problems, ps) : null;
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
