// The problem list of the level view: a status bar button "⚠ N problems" that opens a list of
// everything the checks found (see core/problems.ts); an entry shows where the problem is.

import type { App } from './app.ts';
import { h, clear } from './dom.ts';
import { closeMenus } from './menu.ts';
import { exitProblems, levelProblems, scanProblems, sortProblems, type Problem, type ProblemPlace, type Severity } from '../core/problems.ts';
import { incompleteSprites, leftOutSprites, spriteMemDialog, spriteMemText, missingText, SPRITE_MEM_HELP, MISSING_HELP } from './spritemem.ts';
import { messageLevels, messageProblems, type MessageLevel } from '../core/messageuse.ts';
import { loadLevel } from '../core/level.ts';
import { levelMessages, spriteOpens } from './messagepanel.ts';
import { MESSAGE_ROUTINE_CHECKING, messageRoutineUnknown } from '../core/messagedraw.ts';
import { icon, iconLabel, type IconName } from './icons.ts';

// the sprites of the other levels showing the open level's messages, read again after a ROM change
let sharing: { key: string; levels: MessageLevel[] } | null = null;
function sharingLevels(app: App, tl: number): MessageLevel[] {
  const key = `${app.rom.gen}:${tl}:${app.level.number}`;
  if (sharing?.key !== key) {
    const levels = messageLevels(app.entrances.graph(), tl).filter((n) => n !== app.level.number).flatMap((n) => {
      try { return [{ number: n, sprites: loadLevel(app.rom, n).sprites }]; } catch { return []; }
    });
    sharing = { key, levels };
  }
  return sharing.levels;
}

// everything known about the current level; reveal: shows sprites (selects them in sprite mode)
export function collectProblems(app: App, reveal: (uids: number[]) => void): Problem[] {
  if (!app.level || !app.images) return [];
  const out = [...levelProblems(app.level, app.vertical), ...exitProblems(app.rom, app.level, app.entrances.graph(), (s) => app.enterableOn(s))];
  const sc = app.levelScan;
  if (sc && sc.level === app.level.number) out.push(...scanProblems(app.level, sc.result, sc.uids));
  // (a package drawing the message boxes: the editor's messages are not what players see, nothing to check; whether
  // one does is checked first)
  const tl = levelMessages(app), routine = app.messageRoutine();
  if (!routine) out.push({ key: 'msg-routine-checking', severity: 'info', text: MESSAGE_ROUTINE_CHECKING, title: 'The message checks follow once that is known.' });
  // (unknown: checked as the game's, said so)
  if (routine?.game === null) out.push({ key: 'msg-routine-unknown', severity: 'info', text: messageRoutineUnknown(routine), title: 'The message checks take the editor\'s messages as what players see.' });
  if (routine && routine.game !== false) out.push(...messageProblems(app.rom, tl, app.level, sharingLevels(app, tl), (s) => spriteOpens(app, s)));
  const inc = incompleteSprites(app);
  if (inc.length) {
    out.push({ key: 'sprite-mem', severity: 'warn', text: `${spriteMemText(inc.length)}: not enough sprite memory`, title: SPRITE_MEM_HELP,
      where: { sprites: inc }, fix: { label: 'Fix…', run: () => spriteMemDialog(app, reveal) } });
  }
  const miss = leftOutSprites(app);
  if (miss.length) {
    out.push({ key: 'sprite-missing', severity: 'warn', text: `${missingText(miss.length)}: no sprite slot free`, title: MISSING_HELP,
      where: { sprites: miss }, fix: { label: 'Fix…', run: () => spriteMemDialog(app, reveal) } });
  }
  return sortProblems(out);
}

const ICON: Record<Severity, IconName> = { error: 'error', warn: 'warning', info: 'info' };

// the status bar button of the level; update() recounts (call it after changes and finished checks)
export function problemsButton(app: App, reveal: (uids: number[]) => void): HTMLButtonElement & { update: () => void } {
  const show = (p: ProblemPlace) => {
    if ('sprites' in p) reveal(p.sprites);
    else if ('screen' in p && p.exit) app.gotoExit(app.level.number, p.screen);
    else if ('screen' in p) { app.reveal = app.vertical ? { x: 128, y: p.screen * 256 + 128 } : { x: p.screen * 256 + 128, y: app.images.height - 112 }; app.emit('reveal'); }
    else { app.reveal = { x: p.tx * 16 + 8, y: p.ty * 16 + 8 }; app.emit('reveal'); }
  };
  return problemListButton<Problem>({
    title: 'Problems found in this level', heading: 'Problems in this level', collect: () => collectProblems(app, reveal),
    canOpen: (p) => !!p.where || !!p.message,
    open: (p) => { if (p.where) show(p.where); if (p.message) app.openMessages(p.message.translevel, p.message.msg); },
  });
}

// what a problem list shows of a problem
export interface ListedProblem { key: string; severity: Severity; text: string; title?: string; fix?: { label: string; run: () => void } }
// A status bar button "⚠ N problems" opening the list of what `collect` finds (an entry `open`s where the problem is);
// update() recounts
export function problemListButton<P extends ListedProblem>(o: {
  title: string; heading: string; collect: () => P[]; canOpen: (p: P) => boolean; open: (p: P) => void;
}): HTMLButtonElement & { update: () => void } {
  let list: P[] = [];
  let pop: HTMLDivElement | null = null;
  const btn = h('button', { class: 'status-warn', hidden: true, title: o.title }) as HTMLButtonElement & { update: () => void };
  const fill = () => {
    if (!pop) return;
    clear(pop);
    pop.append(h('div', { class: 'menu-heading' }, list.length ? o.heading : 'No problems found'));
    for (const p of list) {
      const row = h('div', { class: `problem problem-${p.severity}`, title: p.title ?? '' },
        h('span', { class: 'problem-icon' }, icon(ICON[p.severity])),
        h('button', { class: 'problem-text', disabled: !o.canOpen(p), onclick: () => o.open(p) }, p.text),
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
    list = o.collect();
    const worst = list.find((p) => p.severity !== 'info');
    const shown = list.filter((p) => p.severity !== 'info').length;
    btn.hidden = !list.length;
    btn.classList.toggle('status-info', !worst);
    btn.replaceChildren(...(shown ? iconLabel('warning', `${shown} problem${shown > 1 ? 's' : ''}`) : iconLabel('info', `${list.length} note${list.length > 1 ? 's' : ''}`)));
    fill();
  };
  return btn;
}
