// The overworld's ROM limits as budgets (owbudget.ts, #347), on the editor's test ROM: the clean game's values of
// every budget, a budget following an edit (a destroy added, a link made, a custom sprite placed) and its undo, the
// layer 1 tile budget only once the path kinds are known, and the gauge's levels (amber from 80 %, red when full).
// node tools/testowbudget.ts
import { Rom } from '../src/core/rom.ts';
import { RomEditSession } from '../src/core/romedit.ts';
import { owBudgets, budgetLevel, budgetText, type Budget, type BudgetKey } from '../src/core/owbudget.ts';
import { l1Index, readL1, readL2 } from '../src/core/overworld.ts';
import { OverworldStroke } from '../src/core/owstroke.ts';
import { addDestroy } from '../src/core/oweventtiles.ts';
import { makeLink } from '../src/core/owlinks.ts';
import { writeCustomSprites, readCustomSprites } from '../src/core/owcustom.ts';
import { editorImage, pathKinds } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };

const image = await editorImage();
const kinds = pathKinds(new Rom(image.slice()));
const fresh = () => { const rom = new Rom(image.slice()); return { rom, s: new RomEditSession(rom) }; };
const of = (l: Budget[], k: BudgetKey) => l.find((b) => b.key === k);
const is = (l: Budget[], k: BudgetKey, used: number, max: number) => {
  const b = of(l, k);
  check(!!b && b.used === used && b.max === max, `${k}: ${b ? `${b.used} of ${b.max}` : 'none'} (expected ${used} of ${max})`);
};

// ---- the clean game ----
{
  const { rom } = fresh();
  const l = owBudgets(rom, 1, kinds);
  is(l, 'destroys', 0x10, 0x18); // the game's 16 destroyed level tiles, room for 0x18
  is(l, 'revealPairs', 0x16, 0x16); // the game's reveal list: every pair turns a tile of its own into another
  is(l, 'l1Tiles', 327, 0x200); // C1–1FF and the game's unused copies of 000 free
  is(l, 'stars', 27, 0x100); // the game's 27 stars and pipes
  is(l, 'exitPaths', 14, 0x80); // the game's 14 exit paths
  is(l, 'translevels', 0x5c, 0x5f); // translevels 5D–5F without level tile
  is(l, 'eventStorage', 1896, 0x3600);
  is(l, 'customSprites', 0, 0x18);
  check(l.every((b) => b.name && b.help), 'every budget is named and explained');
  check(!of(owBudgets(rom, 1), 'l1Tiles') && owBudgets(rom, 1).length === l.length - 1, 'while the path kinds are learned: no layer 1 tile budget, the others there');
  check(budgetText(of(l, 'destroys')!) === '16 of 24 used (0x18) – 8 left', `the numbers: "${budgetText(of(l, 'destroys')!)}"`);
}

// ---- following edits and undo ----
{
  const { rom, s } = fresh();
  // Iggy's castle's top (09,01 on the submaps) destroyed by a second event
  s.edit('destroy', () => addDestroy(rom, 0x12, l1Index(1, 9, 1)), { key: null });
  is(owBudgets(rom, 1), 'destroys', 0x11, 0x18);
  s.edit('link', () => makeLink(rom, 'star', { submap: 0, x: 4, y: 4 }, { submap: 0, x: 8, y: 8 }, true), { key: null });
  is(owBudgets(rom, 0), 'stars', 29, 0x100);
  s.edit('exit path', () => makeLink(rom, 'exit', { submap: 0, x: 4, y: 4, side: 1 }, { submap: 1, x: 8, y: 8, side: 0 }, false), { key: null });
  is(owBudgets(rom, 0), 'exitPaths', 15, 0x80);
  const lists = readCustomSprites(rom);
  lists[2] = [{ id: 1, x: 3, y: 3, z: 0, extra: [] }, { id: 1, x: 5, y: 3, z: 0, extra: [] }];
  s.edit('sprites', () => writeCustomSprites(rom, lists), { key: null });
  is(owBudgets(rom, 2), 'customSprites', 2, 0x18);
  is(owBudgets(rom, 1), 'customSprites', 0, 0x18);
  s.undo(); s.undo(); s.undo(); s.undo();
  const l = owBudgets(rom, 2);
  check(of(l, 'destroys')!.used === 0x10 && of(l, 'stars')!.used === 27 && of(l, 'exitPaths')!.used === 14 && of(l, 'customSprites')!.used === 0, 'undone: the clean game\'s values');
}

// ---- a pipe 5B painted takes a level of its own (#407), as a star does ----
{
  const { rom } = fresh(), maps = { l1: readL1(rom), l2: readL2(rom) };
  const st = new OverworldStroke(rom, 'l1', maps, (t) => kinds[t] === 'level', null, { kinds, shapes: null });
  st.paint(0, 0x0a, 0x03, 0x5b); // (the clean game's pipe 82 at main 0A,03, translevel 0)
  st.end().write!();
  const b = of(owBudgets(rom, 0, kinds), 'translevels')!;
  check(b.used === 0x5d && /pipe/.test(b.help), `a pipe painted at main 0A,03: levels on the overworld ${b.used} of ${b.max}, its help says so ("${b.help}")`);
}

// ---- levels ----
{
  check(budgetLevel({ used: 0, max: 0x18 }) === 'ok' && budgetLevel({ used: 19, max: 0x18 }) === 'ok', 'below 80 %: ok');
  check(budgetLevel({ used: 20, max: 25 }) === 'amber' && budgetLevel({ used: 0x17, max: 0x18 }) === 'amber', 'from 80 %: amber');
  check(budgetLevel({ used: 0x18, max: 0x18 }) === 'full' && budgetLevel({ used: 0x16, max: 0x16 }) === 'full', 'full: red');
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('all ok');
