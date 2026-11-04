// The World check panel (core/worldcheck.ts): the status bar button (the number of errors) opens a panel above the
// overworld's paint panel listing the problems – errors and warnings apart, each in its group (Paths, Progress, Links,
// Look, Budget; empty ones not shown) – each with Show (the map at the event progress it is found at, the tile shown
// and outlined) and Fix where one exists (one ROM edit). Checked again after every ROM edit and undo, and when what
// the search needs is learned (owreachview.ts); what an edit changed is said in a toast (new errors named, with Show).

import type { OverworldView } from './overworld.ts';
import { h, toast, emptyState } from './dom.ts';
import { l1XY, OW_EVENTS } from '../core/overworld.ts';
import { tileText } from '../core/owteleport.ts';
import { hex2 } from '../core/names.ts';
import { worldProblems, worldChecks, applyFix, errorCount, checkAgainst, diffText, CHECK_GROUPS, type CheckBaseline, type WorldProblem, type CheckSeverity } from '../core/worldcheck.ts';

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
  private found: { from: object; views: boolean; problems: WorldProblem[] } | null = null;
  private checks: { key: string; problems: WorldProblem[] } | null = null;
  // the problems last checked: what an edit changed is said against them
  private baseline: CheckBaseline | null = null;

  constructor(view: OverworldView) {
    this.view = view;
    this.button.onclick = () => this.toggle();
  }

  get open(): boolean { return !this.root.hidden; }
  toggle(open = !this.open): void {
    this.root.hidden = !open;
    this.update();
  }

  // the problems at the event progress shown, null while what the search needs is learned
  problems(): WorldProblem[] | null {
    const v = this.view, st = v.reach.state();
    if (!st) return null;
    const views = !!v.views;
    if (this.found?.from === st && this.found.views === views) return this.found.problems;
    const place = (i: number) => tileText({ submap: v.submapAt(i), ...l1XY(i) }), rom = v.app.rom, all = { ...st.all, progress: OW_EVENTS };
    // (the checks with every event passed: the same at every event progress, searched again after a ROM edit)
    const key = `${rom.gen}:${views}`;
    if (this.checks?.key !== key) this.checks = { key, problems: worldChecks(rom, all, place, v.app.entrances.graph()) };
    const problems = worldProblems(rom, { ...st.now, progress: v.progress }, all, place, this.checks.problems);
    this.found = { from: st, views, problems };
    return problems;
  }

  // the button and (when open) the panel checked again
  update(): void {
    const ps = this.problems(), errors = ps ? errorCount(ps) : 0, warnings = ps ? ps.length - errors : 0;
    if (ps) this.tell(ps);
    const b = this.button;
    b.classList.toggle('status-info', !errors);
    b.classList.toggle('status-error', errors > 0);
    b.textContent = !ps ? 'World check …' : errors ? `⛔ ${errors} error${errors > 1 ? 's' : ''}` : `World check ✓${warnings ? ` · ${warnings} ⚠` : ''}`;
    b.title = !ps ? 'World check: being searched (the path tiles, the maps or the saves are being learned)'
      : `World check: ${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'} – click to ${this.open ? 'close' : 'open'} the list`;
    if (this.open) this.fill(ps);
  }

  // what the ROM edits since the problems last checked changed, in a toast (at most one per check, none when nothing
  // changed; checkAgainst)
  private tell(ps: WorldProblem[]): void {
    const v = this.view, { baseline, change } = checkAgainst(this.baseline, v.app.rom.gen, v.progress, ps);
    this.baseline = baseline;
    const said = change && diffText(change);
    if (!said) return;
    const show = said.show && said.show.tile >= 0 ? said.show : null;
    toast(`World check: ${said.text}`, show ? 'error' : 'info', show ? { label: 'Show', run: () => this.show(show) } : undefined);
  }
  // the problems checked from now on are the baseline (the overworld shown again: edits made elsewhere not said)
  reset(): void {
    this.baseline = null;
  }

  private fill(ps: WorldProblem[] | null): void {
    const scroll = this.root.scrollTop;
    const head = h('div', { class: 'panel-title' }, 'World check',
      h('button', { class: 'msg-close', title: 'Close', onclick: () => this.toggle(false) }, '×'));
    if (!ps) { this.root.replaceChildren(head, emptyState('Searching… (the path tiles, the maps or the saves are being learned)')); return; }
    if (!ps.length) { this.root.replaceChildren(head, emptyState('No problems found: Mario gets everywhere, every way ends at a level or stop tile.')); return; }
    const body: HTMLElement[] = [];
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
    this.root.replaceChildren(head, h('div', { class: 'wc-list' }, ...body));
    this.root.scrollTop = scroll;
  }

  private row(p: WorldProblem): HTMLElement {
    const map = p.progress === OW_EVENTS ? 'with every event passed' : p.progress ? `after event ${hex2(p.progress - 1)}` : 'before events';
    return h('div', { class: `problem problem-${p.severity}`, title: `${p.title ? `${p.title}\n` : ''}Found on the map ${map}${p.noFix ? `\nNo fix: ${p.noFix}` : ''}` },
      h('span', { class: 'problem-icon' }, ICON[p.severity]),
      h('span', { class: 'wc-text' }, p.text),
      h('button', { class: 'problem-fix', disabled: p.tile < 0, title: p.tile < 0 ? 'Not on the map' : `Show the tile, on the map ${map}`, onclick: () => this.show(p) }, 'Show'),
      p.fix ? h('button', { class: 'problem-fix', title: p.fix.title, onclick: () => this.fix(p) }, p.fix.label) : null);
  }

  // the map at the event progress the problem is found at, its tile shown and outlined
  private show(p: WorldProblem): void {
    const v = this.view;
    if (p.progress !== v.progress) v.setEvent(p.progress - 1);
    v.showTile(p.tile);
  }

  private fix(p: WorldProblem): void {
    const f = p.fix!;
    try {
      this.view.app.romEdit(`World check: ${f.label.toLowerCase()} (${tileText({ submap: this.view.submapAt(f.tile), ...l1XY(f.tile) })})`, () => applyFix(this.view.app.rom, f));
      this.view.showTile(p.tile);
    } catch (e) { toast(`Not fixed: ${e instanceof Error ? e.message : e}`, 'error'); }
  }
}
