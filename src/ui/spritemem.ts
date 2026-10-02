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

export const SPRITE_MEM_HELP = 'Der Sprite-Speicher legt fest, wie viele Grafik-Teile (Tiles) jeder Sprite gleichzeitig zeigen darf. ' +
  'Reicht der Platz nicht, überschreibt ein Sprite Teile eines anderen – im Spiel fehlen dann Stücke der Grafik, obwohl man darauf stehen kann (z. B. bei Kettenplattformen).';

export function spriteMemText(n: number): string {
  return n === 1 ? '1 Sprite wird unvollständig gezeigt' : `${n} Sprites werden unvollständig gezeigt`;
}

// explains the problem; offers the suggested value, to select the sprites or to keep it
export async function spriteMemDialog(app: App, reveal: (uids: number[]) => void): Promise<void> {
  const uids = incompleteSprites(app);
  if (!uids.length) return;
  const sug = app.spriteMem!.suggestion;
  const body = h('div', { style: 'max-width:460px' },
    h('p', null, `${spriteMemText(uids.length)}: der Sprite-Speicher ${hex2(app.level.spriteHeader & 0x3f)} des Levels hat zu wenig Platz für sie.`),
    h('p', { class: 'hint' }, SPRITE_MEM_HELP),
    sug !== null
      ? h('p', null, `Mit Sprite-Speicher ${hex2(sug)} werden alle Sprites vollständig gezeigt, ohne dass weniger gleichzeitig erscheinen.`)
      : h('p', { class: 'warn-text' }, 'Kein anderer Wert zeigt alle vollständig. Abhilfe: die betroffenen Sprites weiter auseinander setzen.'),
  );
  const opts = [...(sug !== null ? [{ label: `Auf ${hex2(sug)} stellen`, primary: true }] : []), { label: 'Betroffene zeigen' }, { label: 'So lassen' }];
  const i = await choose('Sprites unvollständig', body, opts);
  if (i === null) return;
  const k = sug !== null ? i : i + 1;
  if (k === 0) app.setSpriteMemory(sug!);
  else if (k === 1) reveal(uids);
}
