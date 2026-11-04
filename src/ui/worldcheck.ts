// The World check panel (core/worldcheck.ts): the status bar button (the number of errors) opens a panel above the
// overworld's paint panel listing the problems – errors and warnings apart, each in its group (Paths, Progress, Links,
// Look, Budget; empty ones not shown) – each with Show (the map at the event progress it is found at, the tile shown
// and outlined) and Fix where one exists (one ROM edit). Under them every budget (core/owbudget.ts) as a gauge with
// Show (where its limit applies); one full is an error, from 80 % a warning (budgetProblems). Checked again after every
// ROM edit and undo, and when what the search needs is learned (owreachview.ts); what an edit changed is said in a
// toast (new errors named, with Show). The problems found at every event progress – dead ends, exit path tiles leading
// nowhere and the paths without a look (core/owlook.ts) – come once the maps at every event progress are learned (until then the ways
// ending nowhere at the progress shown are listed): what an edit changed there is said when they come (with the rest
// when it is there by then).

import type { OverworldView } from './overworld.ts';
import type { OwMode } from '../core/owlayers.ts';
import { h, toast, emptyState } from './dom.ts';
import { refusalWords, refusedToast } from './owrefusal.ts';
import { l1XY, OW_EVENTS } from '../core/overworld.ts';
import { tileText } from '../core/owteleport.ts';
import { hex2 } from '../core/names.ts';
import { worldProblems, worldChecks, applyFix, errorCount, checkAgainst, diffText, budgetProblems, budgetPlace, progressSearches, stuckAtEveryProgress, isFoundAtEveryProgress, CHECK_GROUPS, type CheckBaseline, type WorldProblem, type CheckSeverity } from '../core/worldcheck.ts';
import { lookProblems } from '../core/owlook.ts';
import { progressInput } from '../core/owexitedges.ts';
import { owBudgets, fullestSubmap, type Budget } from '../core/owbudget.ts';
import { budgetGauge } from './budgetgauge.ts';

const ICON: Record<CheckSeverity, string> = { error: '⛔', warn: '⚠' };
const SECTIONS: { severity: CheckSeverity; name: string; title: string }[] = [
  { severity: 'error', name: 'Errors', title: 'Mario gets stuck or can\'t get somewhere: the world can\'t be played through' },
  { severity: 'warn', name: 'Warnings', title: 'May be fine – e.g. the hack\'s own code does it' },
];

export class WorldCheck {
  private view: OverworldView;
  readonly button = h('button', { class: 'status-warn world-check-btn', title: 'World check: is the world beatable? (opens the list)' });
  readonly root = h('div', { class: 'panel world-check', hidden: true });
  // (the tiles' places named once the submaps' views are known: searched again then)
  private found: { from: object; views: boolean; every: WorldProblem[] | null; problems: WorldProblem[] } | null = null;
  // (the checks with every event passed and the budgets: kept while the ROM is the same)
  private checks: { key: string; problems: WorldProblem[]; budgets: Budget[] } | null = null;
  // (the problems found at every event progress: kept while the ROM and what they are found from are the same)
  private atEvery: { gen: number; from: unknown[]; problems: WorldProblem[] } | null = null;
  // the problems last checked: what an edit changed is said against them (those found at every event progress apart:
  // they come later)
  private baseline: CheckBaseline | null = null;
  private everyBaseline: CheckBaseline | null = null;

  constructor(view: OverworldView) {
    this.view = view;
    this.button.onclick = () => this.toggle();
  }

  // something the problems found at every event progress need came
  private learned = () => {
    if (this.view.root.isConnected) this.update();
  };

  get open(): boolean { return !this.root.hidden; }
  toggle(open = !this.open): void {
    this.root.hidden = !open;
    this.update();
  }

  // the problems at the event progress shown, null while what the search needs is learned
  problems(): WorldProblem[] | null {
    const v = this.view, st = v.reach.state();
    if (!st) return null;
    const views = !!v.views, place = (i: number) => tileText({ submap: v.submapAt(i), ...l1XY(i) }), every = this.atEveryProgress(place);
    if (this.found?.from === st && this.found.views === views && this.found.every === every) return this.found.problems;
    const rom = v.app.rom, all = { ...st.all, progress: OW_EVENTS };
    // (the checks with every event passed: the same at every event progress, searched again after a ROM edit)
    const key = `${rom.gen}:${views}`;
    if (this.checks?.key !== key) {
      // (the custom sprites: of the submap with the most)
      const budgets = owBudgets(rom, fullestSubmap(rom), st.now.inp.kinds);
      this.checks = { key, budgets, problems: [...worldChecks(rom, all, place, v.app.entrances.graph()), ...budgetProblems(budgets)] };
    }
    const problems = worldProblems(rom, { ...st.now, progress: v.progress }, all, place, this.checks.problems, every);
    this.found = { from: st, views, every, problems };
    return problems;
  }

  // The problems found at every event progress – dead ends and exit path tiles leading nowhere (stuckAtEveryProgress), the paths without a
  // look (owlook.ts) –, from the maps at every event progress (one search per progress, shared) and the tiles' looks
  // (learned in the probe worker), the path kinds and shapes and the submaps' views; null while one of those is learned
  private atEveryProgress(place: (tile: number) => string): WorldProblem[] | null {
    const v = this.view, app = v.app, rom = app.rom;
    const kinds = v.pathKinds(), shapes = app.pathShapes(this.learned), views = v.views;
    const maps = app.overworldProgressMaps(this.learned), own = app.overworldOwnLooks(this.learned);
    if (!kinds || !shapes || !views || !maps || !own) return null;
    const from = [kinds, shapes, views, maps, own];
    if (this.atEvery?.gen === rom.gen && this.atEvery.from.every((x, k) => x === from[k])) return this.atEvery.problems;
    const search = progressSearches(progressInput(rom, maps, kinds, shapes, app.entrances.graph()));
    const problems = [...stuckAtEveryProgress(rom, search, place), ...lookProblems({ rom, maps, ownLooks: own, kinds, views, search, place })];
    this.atEvery = { gen: rom.gen, from, problems };
    return problems;
  }

  // the button and (when open) the panel checked again
  update(): void {
    const ps = this.problems(), errors = ps ? errorCount(ps) : 0, warnings = ps ? ps.length - errors : 0;
    if (ps) this.tell(ps, this.found?.every ?? null);
    const b = this.button;
    b.classList.toggle('status-info', !errors);
    b.classList.toggle('status-error', errors > 0);
    b.textContent = !ps ? 'World check …' : errors ? `⛔ ${errors} error${errors > 1 ? 's' : ''}` : `World check ✓${warnings ? ` · ${warnings} ⚠` : ''}`;
    b.title = !ps ? 'World check: being searched (the path tiles, the maps or the saves are being learned)'
      : `World check: ${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'} – click to ${this.open ? 'close' : 'open'} the list`;
    if (this.open) this.fill(ps);
  }

  // what the ROM edits since the problems last checked changed, in a toast (at most one per check, none when nothing
  // changed; checkAgainst): those found at every event progress (`every`, null while learned) against those last
  // checked, once they come – at any event progress shown (the dead ends at the progress shown meanwhile not said:
  // they are said with them)
  private tell(ps: WorldProblem[], every: WorldProblem[] | null): void {
    const v = this.view, gen = v.app.rom.gen;
    const main = checkAgainst(this.baseline, gen, v.progress, ps.filter((p) => !isFoundAtEveryProgress(p)));
    this.baseline = main.baseline;
    let change = main.change;
    if (every) {
      const l = checkAgainst(this.everyBaseline, gen, 0, every);
      this.everyBaseline = l.baseline;
      if (l.change) change = change ? { added: [...change.added, ...l.change.added], gone: [...change.gone, ...l.change.gone] } : l.change;
    }
    const said = change && diffText(change);
    if (!said) return;
    const show = said.show && canShow(said.show) ? said.show : null;
    toast(`World check: ${said.text}`, show ? 'error' : 'info', show ? { label: 'Show', run: () => this.show(show) } : undefined);
  }
  // the problems checked from now on are the baseline (the overworld shown again: edits made elsewhere not said)
  reset(): void {
    this.baseline = null;
    this.everyBaseline = null;
  }

  private fill(ps: WorldProblem[] | null): void {
    const scroll = this.root.scrollTop;
    const head = h('div', { class: 'panel-title' }, 'World check',
      h('button', { class: 'msg-close', title: 'Close', onclick: () => this.toggle(false) }, '×'));
    if (!ps) { this.root.replaceChildren(head, emptyState('Searching… (the path tiles, the maps or the saves are being learned)')); return; }
    const body: HTMLElement[] = [];
    if (!ps.length) body.push(emptyState('No problems found: Mario gets everywhere, every way ends at a level or stop tile.'));
    for (const s of SECTIONS) {
      const of = ps.filter((p) => p.severity === s.severity);
      if (!of.length) continue;
      body.push(h('div', { class: `wc-section problem-${s.severity}`, title: s.title }, `${s.name} (${of.length})`));
      for (const g of CHECK_GROUPS) {
        const ofGroup = of.filter((p) => p.group === g.id);
        if (!ofGroup.length) continue;
        body.push(h('div', { class: 'gt-list-head', title: g.title }, g.name));
        for (const p of ofGroup) body.push(this.row(p));
      }
    }
    body.push(...this.budgetList());
    this.root.replaceChildren(head, h('div', { class: 'wc-list' }, ...body));
    this.root.scrollTop = scroll;
  }

  private row(p: WorldProblem): HTMLElement {
    if (p.budget) {
      return h('div', { class: `problem problem-${p.severity}`, title: p.title ?? '' },
        h('span', { class: 'problem-icon' }, ICON[p.severity]),
        h('span', { class: 'wc-text' }, p.text),
        budgetGauge(p.budget),
        this.budgetShow(p.budget));
    }
    const map = p.progress === OW_EVENTS ? 'with every event passed' : p.progress ? `after event ${hex2(p.progress - 1)}` : 'before events';
    const noFix = p.noFix && refusalWords(this.view.app.rom, p.noFix), why = noFix ? `${noFix.reason}${noFix.instead ? ` – ${noFix.instead}` : ''}` : '';
    return h('div', { class: `problem problem-${p.severity}`, title: `${p.title ? `${p.title}\n` : ''}Found on the map ${map}${why ? `\nNo fix: ${why}` : ''}` },
      h('span', { class: 'problem-icon' }, ICON[p.severity]),
      h('span', { class: 'wc-text' }, p.text),
      h('button', { class: 'problem-fix', disabled: p.tile < 0, onclick: () => this.show(p),
        title: p.tile < 0 ? 'Not on the map' : p.show ? `Show the tile, in event ${hex2(p.show.event)}'s ${MODE_WORDS[p.show.mode] ?? p.show.mode}` : `Show the tile, on the map ${map}` }, 'Show'),
      p.fix ? h('button', { class: 'problem-fix', title: p.fix.title, onclick: () => this.fix(p) }, p.fix.label) : null);
  }

  // every budget, the numbers of the gauges beside the actions (the custom sprites': the submap with the most)
  private budgetList(): HTMLElement[] {
    const budgets = this.checks?.budgets ?? [], g = CHECK_GROUPS.find((x) => x.id === 'budget')!;
    if (!budgets.length) return [];
    return [h('div', { class: 'wc-section', title: g.title }, `All budgets (${g.name})`),
      ...budgets.map((b) => h('div', { class: 'problem wc-budget', title: `${b.help}${b.submap !== undefined ? ' – the submap with the most is listed' : ''}` },
        h('span', { class: 'wc-text' }, b.name), budgetGauge(b), this.budgetShow(b)))];
  }
  private budgetShow(b: Budget): HTMLElement {
    return h('button', { class: 'problem-fix', title: 'Show where the limit applies: the gauge beside the action it stops', onclick: () => this.showBudget(b) }, 'Show');
  }

  // the map at the event progress the problem is found at, its tile shown and outlined; a budget: where it applies
  private show(p: WorldProblem): void {
    if (p.budget) { this.showBudget(p.budget); return; }
    const v = this.view, event = p.show ? p.show.event : p.progress - 1;
    if (event !== v.event) v.setEvent(event);
    if (p.show) v.setMode(p.show.mode);
    v.showTile(p.tile);
  }
  // the mode (and submap) of the budget's gauge; one beside an event's actions: an event chosen (budgetPlace)
  private showBudget(b: Budget): void {
    const v = this.view, place = budgetPlace(v.app.rom, b, v.event);
    if (place.submap !== undefined) v.setMap(place.submap);
    v.setMode(place.mode);
    if (place.event !== undefined) v.setEvent(place.event);
  }

  private fix(p: WorldProblem): void {
    const f = p.fix!;
    try {
      this.view.app.romEdit(`World check: ${f.label.toLowerCase()} (${tileText({ submap: this.view.submapAt(f.tile), ...l1XY(f.tile) })})`, () => applyFix(this.view.app.rom, f));
      this.view.showTile(p.tile);
    } catch (e) { refusedToast(this.view.app.rom, e, 'Not fixed: '); }
  }
}

// a mode Show goes to, in words
const MODE_WORDS: Partial<Record<OwMode, string>> = { l1: 'layer 1', l2: 'layer 2' };

// a problem Show goes to: a tile, or where a budget's limit applies
const canShow = (p: WorldProblem): boolean => p.tile >= 0 || !!p.budget;
