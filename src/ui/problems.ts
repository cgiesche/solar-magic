// The problem list of the level view: a status bar button "⚠ N problems" that opens a list of
// everything the checks found (see core/problems.ts); an entry shows where the problem is.

import type { App } from './app.ts';
import { h, clear } from './dom.ts';
import { closeMenus } from './menu.ts';
import { exitProblems, levelProblems, scanProblems, sortProblems, type Problem, type ProblemPlace } from '../core/problems.ts';
import { incompleteSprites, spriteMemDialog, spriteMemText, SPRITE_MEM_HELP } from './spritemem.ts';

// everything known about the current level; reveal: shows sprites (selects them in sprite mode)
export function collectProblems(app: App, reveal: (uids: number[]) => void): Problem[] {
  if (!app.level || !app.images) return [];
  const out = [...levelProblems(app.level, app.vertical), ...exitProblems(app.rom, app.level, app.exitGraph(), (s) => app.enterableOn(s))];
  const sc = app.levelScan;
  if (sc && sc.level === app.level.number) out.push(...scanProblems(app.level, sc.result, sc.uids));
  const inc = incompleteSprites(app);
  if (inc.length) {
    out.push({ key: 'sprite-mem', severity: 'warn', text: `${spriteMemText(inc.length)}: not enough sprite memory`, title: SPRITE_MEM_HELP,
      where: { sprites: inc }, fix: { label: 'Fix…', run: () => spriteMemDialog(app, reveal) } });
  }
  return sortProblems(out);
}

const ICON: Record<Problem['severity'], string> = { error: '⛔', warn: '⚠', info: 'ℹ' };

// the status bar button; update() recounts (call it after changes and finished checks)
export function problemsButton(app: App, reveal: (uids: number[]) => void): HTMLButtonElement & { update: () => void } {
  let list: Problem[] = [];
  let pop: HTMLDivElement | null = null;
  const btn = h('button', { class: 'status-warn', hidden: true, title: 'Problems found in this level' }) as HTMLButtonElement & { update: () => void };
  const show = (p: ProblemPlace) => {
    if ('sprites' in p) reveal(p.sprites);
    else if ('screen' in p && p.exit) app.gotoExit(app.level.number, p.screen);
    else if ('screen' in p) { app.reveal = app.vertical ? { x: 128, y: p.screen * 256 + 128 } : { x: p.screen * 256 + 128, y: app.images.height - 112 }; app.emit('reveal'); }
    else { app.reveal = { x: p.tx * 16 + 8, y: p.ty * 16 + 8 }; app.emit('reveal'); }
  };
  const fill = () => {
    if (!pop) return;
    clear(pop);
    pop.append(h('div', { class: 'menu-heading' }, list.length ? 'Problems in this level' : 'No problems found'));
    for (const p of list) {
      const row = h('div', { class: `problem problem-${p.severity}`, title: p.title ?? '' },
        h('span', { class: 'problem-icon' }, ICON[p.severity]),
        h('button', { class: 'problem-text', disabled: !p.where, onclick: () => p.where && show(p.where) }, p.text),
        p.fix ? h('button', { class: 'problem-fix', onclick: () => { close(); p.fix!.run(); } }, p.fix.label) : null);
      pop.append(row);
    }
  };
  const outside = (e: MouseEvent) => { if (pop && !pop.contains(e.target as Node) && !btn.contains(e.target as Node)) close(); };
  const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  const close = () => {
    pop?.remove();
    pop = null;
    window.removeEventListener('mousedown', outside, true);
    window.removeEventListener('keydown', key, true);
  };
  btn.onclick = () => {
    if (pop) { close(); return; }
    closeMenus();
    pop = h('div', { class: 'menu problems-pop' });
    fill();
    document.body.append(pop);
    const r = btn.getBoundingClientRect();
    pop.style.right = `${Math.max(4, window.innerWidth - r.right)}px`;
    pop.style.bottom = `${window.innerHeight - r.top + 4}px`;
    window.addEventListener('mousedown', outside, true);
    window.addEventListener('keydown', key, true);
  };
  btn.update = () => {
    list = collectProblems(app, reveal);
    const worst = list.find((p) => p.severity !== 'info');
    const shown = list.filter((p) => p.severity !== 'info').length;
    btn.hidden = !list.length;
    btn.classList.toggle('status-info', !worst);
    btn.textContent = shown ? `⚠ ${shown} problem${shown > 1 ? 's' : ''}` : `ℹ ${list.length} note${list.length > 1 ? 's' : ''}`;
    fill();
  };
  return btn;
}
