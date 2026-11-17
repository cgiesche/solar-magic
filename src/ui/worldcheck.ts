// The World check panel (core/worldcheck.ts): the status bar button (the number of errors) opens a panel above the
// overworld's paint panel listing the problems – errors and warnings apart, each in its group (Paths, Progress, Links,
// Look, Budget; empty ones not shown) – each with Show (the map at the event progress it is found at, the tile shown
// and outlined) and Fix where one exists (one ROM edit). Under them every budget (core/owbudget.ts) as a gauge with
// Show (where its limit applies); one full is an error, from 80 % a warning (budgetProblems). Checked again after every
// ROM edit and undo, and when what the search needs is learned (owreachview.ts); what an edit changed is said in a
// toast (new errors named, with Show). Only the search at the progress shown runs here: the checks with every event
// passed, the budgets and the problems found at every event progress – dead ends, exit path tiles leading nowhere and
// the paths without a look (core/owlook.ts) – are learned in the probe worker (core/worldcheck.ts worldCheckJob, once
// the saves at every event progress are learned); nothing is listed until they come.

import type { OverworldView } from './overworld.ts';
import type { OwMode } from '../core/owlayers.ts';
import { h, toast, emptyState } from './dom.ts';
import { refusalWords, refusedToast } from './owrefusal.ts';
import { l1XY, OW_EVENTS } from '../core/overworld.ts';
import { tileText } from '../core/owteleport.ts';
import { hex2 } from '../core/names.ts';
import { progressWords } from '../core/eventset.ts';
import { worldProblems, applyFix, errorCount, checkAgainst, diffText, budgetPlace, problemShow, budgetShow, isFoundAtEveryProgress, checkShownChanged, CHECK_GROUPS, type CheckBaseline, type CheckShown, type WorldProblem, type CheckSeverity, type WorldCheckLearned } from '../core/worldcheck.ts';
import type { Budget } from '../core/owbudget.ts';
import { budgetGauge } from './budgetgauge.ts';
import { icon, iconLabel, type IconName } from './icons.ts';
import { bottomPanel, type ProblemCount } from './logbar.ts';

const ICON: Record<CheckSeverity, IconName> = { error: 'error', warn: 'warning' };
const SECTIONS: { severity: CheckSeverity; name: string; title: string }[] = [
  { severity: 'error', name: 'Errors', title: 'Mario gets stuck or can\'t get somewhere: the world can\'t be played through' },
  { severity: 'warn', name: 'Warnings', title: 'May be fine – e.g. the hack\'s own code does it' },
];

export class WorldCheck {
  private view: OverworldView;
  readonly button = h('button', { class: 'status-warn world-check-btn', title: 'World check: is the world beatable? (opens the list)' });
  readonly root = h('div', { class: 'world-check', role: 'list', 'aria-label': 'World check' }); // (shown in the bottom panel's Problems tab, #479)
  // (the tiles' places named once the submaps' views are known: searched again then)
  private found: { from: object; views: boolean; learned: WorldCheckLearned; problems: WorldProblem[] } | null = null;
  // (what the probe worker learned, for the ROM generation and the levels' exits – the open one's as edited)
  private learnedAt: { gen: number; graph: object; learned: WorldCheckLearned } | null = null;
  // the problems last checked: what an edit changed is said against them (those found at every event progress apart:
  // compared at any event progress shown)
  private baseline: CheckBaseline | null = null;
  private everyBaseline: CheckBaseline | null = null;
  // what the button and the list were last drawn from: not drawn again while it is the same (checkShownChanged)
  private shown: CheckShown | null = null;

  constructor(view: OverworldView) {
    this.view = view;
    this.button.onclick = () => this.toggle();
  }

  // what the probe worker learns came, or something it needs
  private learned = () => {
    if (this.view.root.isConnected) this.update();
  };

  get open(): boolean { return this.root.isConnected && !!bottomPanel()?.problemsShown; }
  toggle(open = !this.open): void {
    const p = bottomPanel();
    if (open) p?.showProblems(); else if (this.open) p?.toggleProblems();
    this.update();
  }
  /** The errors and warnings for the bottom panel's tab (checking: still searched). */
  count(): ProblemCount {
    const ps = this.found?.problems ?? null;
    if (!ps) return { errors: 0, warnings: 0, checking: true };
    const errors = errorCount(ps);
    return { errors, warnings: ps.length - errors };
  }

  // the problems at the event progress shown, null while what the search needs or what the probe worker learns is
  // learned
  problems(): WorldProblem[] | null {
    const v = this.view, st = v.reach.state(), learned = this.workerPart();
    if (!st || !learned) return null;
    const views = !!v.views;
    if (this.found?.from === st && this.found.views === views && this.found.learned === learned) return this.found.problems;
    // (a problem's tile on its submap by submapAt: only the tile known, ambiguous in an overlap of views)
    const place = (i: number) => tileText({ submap: v.submapAt(i), ...l1XY(i) });
    const problems = worldProblems(v.app.rom, { ...st.now, progress: v.progress }, { ...st.all, progress: OW_EVENTS }, place, learned.checks, learned.every, (i) => v.submapAt(i));
    this.found = { from: st, views, learned, problems };
    return problems;
  }

  // what the probe worker learns of the ROM as it is (core/worldcheck.ts worldCheckJob), from the path kinds and shapes, the hardcoded paths
  // and the open level's exits as edited; null while it or they are learned
  private workerPart(): WorldCheckLearned | null {
    const v = this.view, gen = v.app.rom.gen, graph = v.app.entrances.graph();
    if (this.learnedAt?.gen === gen && this.learnedAt.graph === graph) return this.learnedAt.learned;
    const kinds = v.pathKinds(), shapes = v.app.pathShapes(this.learned), hard = kinds && v.app.hardWalks(kinds, this.learned);
    const learned = kinds && shapes && hard && v.app.overworldWorldCheck(kinds, shapes, hard, this.learned);
    if (!learned) return null;
    this.learnedAt = { gen, graph, learned };
    return learned;
  }

  // the button and the panel checked again; drawn again when the problems are others (searched again: another array) or
  // the list was opened or closed since (#503: asked for with every redraw of the map)
  update(): void {
    const ps = this.problems(), errors = ps ? errorCount(ps) : 0, warnings = ps ? ps.length - errors : 0;
    if (ps) this.tell(ps); // (may open the list)
    const open = this.open;
    if (!checkShownChanged(this.shown, ps, open)) return;
    this.shown = { problems: ps, open };
    const b = this.button;
    b.classList.toggle('status-info', !errors);
    b.classList.toggle('status-error', errors > 0);
    b.replaceChildren(...(!ps ? ['World check …'] : errors ? iconLabel('error', `${errors} error${errors > 1 ? 's' : ''}`)
      : warnings ? iconLabel('warning', `World check: ${warnings} warning${warnings > 1 ? 's' : ''}`) : iconLabel('check', 'World check')));
    b.title = !ps ? 'World check: being searched (the path tiles, the maps or the saves are being learned)'
      : `World check: ${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'} – click to ${this.open ? 'close' : 'open'} the list`;
    this.fill(ps);
    if (this.root.isConnected) bottomPanel()?.refreshProblems();
  }

  // what the ROM edits since the problems last checked changed, in a toast (at most one per check, none when nothing
  // changed; checkAgainst): those found at every event progress against those last checked at any event progress
  // shown, the others at the same progress
  private tell(ps: WorldProblem[]): void {
    const v = this.view, gen = v.app.rom.gen;
    const main = checkAgainst(this.baseline, gen, v.progress, ps.filter((p) => !isFoundAtEveryProgress(p)));
    const every = checkAgainst(this.everyBaseline, gen, 0, ps.filter(isFoundAtEveryProgress));
    this.baseline = main.baseline;
    this.everyBaseline = every.baseline;
    const change = main.change && every.change ? { added: [...main.change.added, ...every.change.added], gone: [...main.change.gone, ...every.change.gone] } : main.change ?? every.change;
    const said = change && diffText(change);
    // (a new error opens the Problems panel, #479's decision)
    if (change?.added.some((p) => p.severity === 'error') && this.root.isConnected) bottomPanel()?.showProblems();
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
    const head = h('div', { class: 'panel-title' }, 'World check');
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
        h('span', { class: 'problem-icon' }, icon(ICON[p.severity])),
        h('span', { class: 'wc-text' }, p.text),
        budgetGauge(p.budget),
        this.budgetShow(p.budget));
    }
    const map = progressWords(p.progress);
    const noFix = p.noFix && refusalWords(this.view.app.rom, p.noFix), why = noFix ? `${noFix.reason}${noFix.instead ? ` – ${noFix.instead}` : ''}` : '';
    return h('div', { class: `problem problem-${p.severity}`, title: `${p.title ? `${p.title}\n` : ''}Found on the map ${map}${why ? `\nNo fix: ${why}` : ''}` },
      h('span', { class: 'problem-icon' }, icon(ICON[p.severity])),
      h('span', { class: 'wc-text' }, p.text),
      h('button', { class: 'problem-fix', disabled: p.tile < 0, onclick: () => this.show(p),
        title: p.tile < 0 ? 'Not on the map' : p.show ? `Show the tile, in event ${hex2(p.show.event)}'s ${MODE_WORDS[p.show.mode] ?? p.show.mode}` : `Show the tile, on the map ${map}` }, 'Show'),
      p.fix ? h('button', { class: 'problem-fix', title: p.fix.title, onclick: () => this.fix(p) }, p.fix.label) : null);
  }

  // every budget, the numbers of the gauges beside the actions (the custom sprites': the submap with the most)
  private budgetList(): HTMLElement[] {
    const budgets = this.found?.learned.budgets ?? [], g = CHECK_GROUPS.find((x) => x.id === 'budget')!;
    if (!budgets.length) return [];
    return [h('div', { class: 'wc-section', title: g.title }, `All budgets (${g.name})`),
      ...budgets.map((b) => h('div', { class: 'problem wc-budget', title: `${b.help}${b.submap !== undefined ? ' – the submap with the most is listed' : ''}` },
        h('span', { class: 'wc-text' }, b.name), budgetGauge(b), this.budgetShow(b)))];
  }
  private budgetShow(b: Budget): HTMLElement {
    return h('button', { class: 'problem-fix', title: 'Show where the limit applies: the gauge beside the action it stops', onclick: () => this.showBudget(b) }, 'Show');
  }

  // Show (#427): exactly the events of the prefix the problem is found at checked, its last event edited (a problem
  // naming another event to show it in: that one), its tile shown and outlined; one found at the set shown (not a
  // prefix): the checks stay, its event edited; a budget: where it applies
  private show(p: WorldProblem): void {
    if (p.budget) { this.showBudget(p.budget); return; }
    const v = this.view, to = problemShow(p, v.event);
    if (to.checked !== null) v.showPrefix(to.checked, to.edit); else v.setEvent(to.edit);
    if (p.show) v.setMode(p.show.mode);
    else if (p.group === 'links') v.setMode('l1'); // (the overworld links are layer 1's, #413)
    v.showTile(p.tile);
  }
  // the mode (and submap) of the budget's gauge; one beside an event's actions (budgetPlace): the events up to that one
  // checked, it edited (#427)
  private showBudget(b: Budget): void {
    const v = this.view, place = budgetPlace(v.app.rom, b, v.event);
    if (place.submap !== undefined) v.setMap(place.submap);
    v.setMode(place.mode);
    const to = budgetShow(place, v.event);
    if (to.checked !== null) v.showPrefix(to.checked, to.edit);
  }

  private fix(p: WorldProblem): void {
    const f = p.fix!;
    try {
      // (a link end named as stored; a tile on its submap by submapAt)
      const at = 'end' in f ? f.end.link[f.end.end] : 'link' in f ? f.link.a : { submap: this.view.submapAt(f.tile), ...l1XY(f.tile) };
      this.view.app.romEdit(`World check: ${f.label.toLowerCase()} (${tileText(at)})`, () => applyFix(this.view.app.rom, f));
      this.view.showTile(p.tile);
    } catch (e) { refusedToast(this.view.app.rom, e, 'Not fixed: '); }
  }
}

// a mode Show goes to, in words
const MODE_WORDS: Partial<Record<OwMode, string>> = { l1: 'layer 1', l2: 'layer 2' };

// a problem Show goes to: a tile, or where a budget's limit applies
const canShow = (p: WorldProblem): boolean => p.tile >= 0 || !!p.budget;
