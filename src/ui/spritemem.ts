// Hints for the sprite memory check (App.spriteMem): sprites the game draws incompletely because
// the level's sprite memory gives their slot too few OAM tiles, and sprites it leaves out because
// no slot is free for them when they load.

import type { App } from './app.ts';
import { h, choose } from './dom.ts';
import { hex2 } from '../core/names.ts';
import { SPRITE_MEMORY } from '../core/level.ts';

// the check, while it matches the level
function current(app: App) {
  const m = app.spriteMem;
  return m && m.level === app.level.number && m.mem === (app.level.spriteHeader & SPRITE_MEMORY) ? m : null;
}

// uids of the level's sprites drawn incompletely (only while the check matches the level)
export function incompleteSprites(app: App): number[] {
  const m = current(app);
  return m ? app.level.sprites.filter((s) => m.conflicts.has(s.uid)).map((s) => s.uid) : [];
}

// uids of the level's sprites that don't appear (only while the check matches the level)
export function leftOutSprites(app: App): number[] {
  const m = current(app);
  return m ? app.level.sprites.filter((s) => m.missing.has(s.uid)).map((s) => s.uid) : [];
}

export const SPRITE_MEM_HELP = 'Sprite memory sets how many graphics tiles each sprite may show at the same time. ' +
  'If there is not enough room, a sprite overwrites tiles of another – in the game, pieces of its graphics are then missing although you can still stand on it (e.g. chained platforms).';

export const MISSING_HELP = 'Sprite memory also sets how many sprites can be in the level at once, and some values keep a slot for one large sprite only ' +
  '(04: one Banzai Bill at a time). A sprite that finds no free slot when it comes into view is left out – the game skips it. ' +
  'The check counts the sprites of a screen as all there at once.';

export function spriteMemText(n: number): string {
  return n === 1 ? '1 sprite is shown incompletely' : `${n} sprites are shown incompletely`;
}

export function missingText(n: number): string {
  return n === 1 ? '1 sprite doesn\'t appear' : `${n} sprites don't appear`;
}

// explains the problem; offers the suggested value, to select the sprites or to keep it
export async function spriteMemDialog(app: App, reveal: (uids: number[]) => void): Promise<void> {
  const inc = incompleteSprites(app), miss = leftOutSprites(app);
  if (!inc.length && !miss.length) return;
  const sug = app.spriteMem!.suggestion, mem = hex2(app.level.spriteHeader & SPRITE_MEMORY);
  const body = h('div', { style: 'max-width:460px' },
    inc.length ? h('p', null, `${spriteMemText(inc.length)}: the level's sprite memory ${mem} does not have enough room for them.`) : '',
    inc.length ? h('p', { class: 'hint' }, SPRITE_MEM_HELP) : '',
    miss.length ? h('p', null, `${missingText(miss.length)}: with the level's sprite memory ${mem} no slot is free for them when they come into view.`) : '',
    miss.length ? h('p', { class: 'hint' }, MISSING_HELP) : '',
    sug !== null
      ? h('p', null, `With sprite memory ${hex2(sug)}, all sprites appear and are shown completely, without fewer appearing at once.`)
      : h('p', { class: 'warn-text' }, 'No other value shows all of them. Fix: place the affected sprites further apart.'),
  );
  const opts = [...(sug !== null ? [{ label: `Set to ${hex2(sug)}`, primary: true }] : []), { label: 'Show affected' }, { label: 'Keep as is' }];
  const i = await choose(!miss.length ? 'Incomplete sprites' : !inc.length ? 'Missing sprites' : 'Incomplete and missing sprites', body, opts);
  if (i === null) return;
  const k = sug !== null ? i : i + 1;
  if (k === 0) app.setSpriteMemory(sug!);
  else if (k === 1) reveal([...inc, ...miss]);
}
