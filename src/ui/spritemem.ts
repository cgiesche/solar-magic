// Hints for the sprite memory check (App.spriteMem): sprites the game draws incompletely because
// the level's sprite memory gives their slot too few OAM tiles.

import type { App } from './app.ts';
import { h, choose } from './dom.ts';
import { hex2 } from '../core/names.ts';

// uids of the level's sprites drawn incompletely (only while the check matches the level)
export function incompleteSprites(app: App): number[] {
  const m = app.spriteMem;
  if (!m || m.level !== app.level.number || m.mem !== (app.level.spriteHeader & 0x3f)) return [];
  return app.level.sprites.filter((s) => m.conflicts.has(s.uid)).map((s) => s.uid);
}

export const SPRITE_MEM_HELP = 'Sprite memory sets how many graphics tiles each sprite may show at the same time. ' +
  'If there is not enough room, a sprite overwrites tiles of another – in the game, pieces of its graphics are then missing although you can still stand on it (e.g. chained platforms).';

export function spriteMemText(n: number): string {
  return n === 1 ? '1 sprite is shown incompletely' : `${n} sprites are shown incompletely`;
}

// explains the problem; offers the suggested value, to select the sprites or to keep it
export async function spriteMemDialog(app: App, reveal: (uids: number[]) => void): Promise<void> {
  const uids = incompleteSprites(app);
  if (!uids.length) return;
  const sug = app.spriteMem!.suggestion;
  const body = h('div', { style: 'max-width:460px' },
    h('p', null, `${spriteMemText(uids.length)}: the level's sprite memory ${hex2(app.level.spriteHeader & 0x3f)} does not have enough room for them.`),
    h('p', { class: 'hint' }, SPRITE_MEM_HELP),
    sug !== null
      ? h('p', null, `With sprite memory ${hex2(sug)}, all sprites are shown completely, without fewer appearing at once.`)
      : h('p', { class: 'warn-text' }, 'No other value shows all of them completely. Fix: place the affected sprites further apart.'),
  );
  const opts = [...(sug !== null ? [{ label: `Set to ${hex2(sug)}`, primary: true }] : []), { label: 'Show affected' }, { label: 'Keep as is' }];
  const i = await choose('Incomplete sprites', body, opts);
  if (i === null) return;
  const k = sug !== null ? i : i + 1;
  if (k === 0) app.setSpriteMemory(sug!);
  else if (k === 1) reveal(uids);
}
