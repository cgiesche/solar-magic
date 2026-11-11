// The bottom panel (#479): tabs Problems | Log. Collapsed it shows the latest message; expanded the problems of the
// workspace shown – the level's problems, the overworld's World check (each workspace hands its list in with
// setProblems) – or the whole log with times (toasts vanish after a few seconds, the log keeps them). The status bar's
// problem counter opens the Problems tab, L toggles the panel; it opens by itself on a new error (the workspace says
// so with showProblems) and an error logged opens the Log.
import { h, logEntries, onLog, clearLog, type LogEntry } from './dom.ts';
import { boolPref, jsonPref } from './prefs.ts';
import { icon } from './icons.ts';

const logOpen = boolPref('log-open', false);
type BottomTab = 'problems' | 'log';
const tabPref = jsonPref<BottomTab>('bottom-tab', 'log', (v): v is BottomTab => v === 'problems' || v === 'log');
const KIND_LABEL = { info: 'Message', error: 'Error', warn: 'Warning', output: 'Tool output', event: 'Event' } as const;

// version and commit of the build (set by the Docker and desktop builds), shown at the right of the bar
const COMMIT = import.meta.env.VITE_COMMIT || '';
const VERSION = import.meta.env.VITE_VERSION || '';
const BUILD_LABEL = VERSION || (COMMIT ? COMMIT.slice(0, 7) : 'dev');
const BUILD_TITLE = [VERSION && `Version ${VERSION}`, COMMIT && `built from commit ${COMMIT}`].filter(Boolean).join(', ') || 'Development build';

const pad = (n: number) => String(n).padStart(2, '0');
const timeStr = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

export type ProblemCount = { errors: number; warnings: number; checking?: boolean };

// the panel of the editor (one): the workspaces' problem lists find it here
let panel: LogBar | null = null;
export function bottomPanel(): LogBar | null { return panel; }

export class LogBar {
  readonly root: HTMLElement;
  private list = h('div', { class: 'log-list' });
  private problemsHost = h('div', { class: 'problems-host' });
  private latest = h('span', { class: 'log-latest' });
  private toggleBtn = h('button', { class: 'log-toggle icon-btn', title: 'Expand/collapse the panel (L)', 'aria-label': 'Expand or collapse the panel' });
  private problemsTab = h('button', { title: 'The problems found in the workspace shown' });
  private logTab = h('button', { title: 'Every message with its time' }, 'Log');
  private actions: HTMLElement;
  private rows = new Map<LogEntry, HTMLElement>();
  private open = false;
  private tab: BottomTab = tabPref.get();
  private problems: { el: HTMLElement; count: () => ProblemCount | null } | null = null;

  constructor() {
    panel = this;
    const copyBtn = h('button', { title: 'Copy log as text to the clipboard' }, 'Copy');
    copyBtn.onclick = () => this.copy(copyBtn);
    const clearBtn = h('button', { class: 'danger', title: 'Remove all entries', onclick: () => clearLog() }, 'Clear');
    this.actions = h('span', { class: 'log-actions' }, copyBtn, clearBtn);
    this.problemsTab.onclick = (e) => { e.stopPropagation(); this.show('problems'); };
    this.logTab.onclick = (e) => { e.stopPropagation(); this.show('log'); };
    const head = h('div', { class: 'log-head' }, this.toggleBtn,
      h('div', { class: 'tabbar bottom-tabs', role: 'tablist' }, this.problemsTab, this.logTab),
      this.latest, this.actions, h('span', { class: 'log-build', title: BUILD_TITLE }, BUILD_LABEL));
    // clicking the bar elsewhere opens or closes it, the buttons keep their own action
    head.addEventListener('click', (e) => { if (!(e.target as HTMLElement).closest('.log-actions, .log-build, .bottom-tabs')) this.toggle(); });
    this.root = h('div', { class: 'logbar' }, head, this.problemsHost, this.list);
    for (const e of logEntries) this.list.append(this.row(e));
    onLog((e, repeat) => this.add(e, repeat));
    this.setOpen(logOpen.get());
    this.updateLatest();
    this.refreshProblems();
  }

  toggle(): void { this.setOpen(!this.open); }

  /** The workspace's problem list (null: it has none); count: its errors and warnings for the tab. */
  setProblems(el: HTMLElement | null, count: () => ProblemCount | null = () => null): void {
    this.problems = el ? { el, count } : null;
    if (this.problemsHost.firstChild !== el) this.problemsHost.replaceChildren(...(el ? [el] : [h('p', { class: 'hint problems-none' }, 'This workspace has no checks.')]));
    this.refreshProblems();
  }

  /** The problem tab's count drawn again (the workspace checked again). */
  refreshProblems(): void {
    const c = this.problems?.count() ?? null;
    const label = [h('span', { class: 'icon-label' }, 'Problems')];
    if (c?.checking) label.push(h('span', { class: 'pill pill-info' }, '…'));
    if (c?.errors) label.push(h('span', { class: 'pill pill-error' }, icon('error'), ` ${c.errors}`));
    if (c?.warnings) label.push(h('span', { class: 'pill pill-warn' }, icon('warning'), ` ${c.warnings}`));
    this.problemsTab.replaceChildren(...label);
  }

  /** Opened at the Problems tab (the status bar's counter, a new error). */
  showProblems(): void { this.show('problems'); }
  get problemsShown(): boolean { return this.open && this.tab === 'problems'; }
  /** The status bar's counter: the Problems tab opened, or the panel closed when it is shown. */
  toggleProblems(): void { if (this.problemsShown) this.setOpen(false); else this.showProblems(); }

  private show(tab: BottomTab): void {
    this.tab = tab;
    tabPref.set(tab);
    this.setOpen(true);
  }

  private setOpen(open: boolean): void {
    this.open = open;
    this.root.classList.toggle('open', open);
    this.root.classList.toggle('tab-problems', this.tab === 'problems');
    this.root.classList.toggle('tab-log', this.tab === 'log');
    this.problemsTab.classList.toggle('active', open && this.tab === 'problems');
    this.logTab.classList.toggle('active', open && this.tab === 'log');
    this.toggleBtn.replaceChildren(icon(open ? 'chevron-down' : 'chevron-right'));
    logOpen.set(open);
    if (open && this.tab === 'log') this.list.scrollTop = this.list.scrollHeight;
    this.updateLatest();
  }

  private row(e: LogEntry): HTMLElement {
    const r = h('div', { class: `log-row ${e.kind}`, title: KIND_LABEL[e.kind] },
      h('span', { class: 'log-time' }, timeStr(e.time)),
      h('span', { class: 'log-msg' }, e.msg),
      e.count > 1 ? h('span', { class: 'log-count' }, `×${e.count}`) : null);
    this.rows.set(e, r);
    return r;
  }

  private add(e: LogEntry | null, repeat: boolean): void {
    if (!e) {
      this.list.replaceChildren();
      this.rows.clear();
      this.updateLatest();
      return;
    }
    const old = this.rows.get(e);
    if (repeat && old) {
      this.rows.delete(e);
      old.replaceWith(this.row(e));
    } else {
      this.list.append(this.row(e));
      // keep the DOM in step with the capped history
      while (this.list.childElementCount > logEntries.length) {
        const first = this.list.firstElementChild!;
        for (const [k, v] of this.rows) if (v === first) this.rows.delete(k);
        first.remove();
      }
    }
    // an error opens the log, so it is seen even when the toast is gone (not over the problems shown)
    if (e.kind === 'error' && !this.open) this.show('log');
    this.list.scrollTop = this.list.scrollHeight;
    this.updateLatest();
  }

  private updateLatest(): void {
    const e = logEntries[logEntries.length - 1];
    this.latest.replaceChildren(...(e
      ? [h('span', { class: 'log-time' }, timeStr(e.time)), h('span', { class: `log-msg ${e.kind}` }, e.msg), e.count > 1 ? h('span', { class: 'log-count' }, `×${e.count}`) : '']
      : [h('span', { class: 'hint' }, 'No messages yet')]));
    this.latest.style.visibility = this.open && this.tab === 'log' ? 'hidden' : '';
  }

  private copy(btn: HTMLButtonElement): void {
    const text = logEntries.map((e) => `${timeStr(e.time)}  [${KIND_LABEL[e.kind]}]  ${e.msg}${e.count > 1 ? `  ×${e.count}` : ''}`).join('\n');
    const done = (label: string) => { btn.textContent = label; setTimeout(() => (btn.textContent = 'Copy'), 1500); };
    navigator.clipboard.writeText(text).then(() => done('Copied ✓'), () => done('Failed'));
  }
}

