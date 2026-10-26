// The hint to save a prefab on repeated paste (pastehint.ts, #115): the same arrangement of Direct Map16
// objects pasted the third time in the session (however split, wherever placed), when a prefab would save
// bytes by the cost function; not for other objects, not once dismissed.
import { newUid, type LevelObject } from '../src/core/level.ts';
import { DM16_EXT } from '../src/core/patches.ts';
import { PREFAB_EXT, PREFAB_MAX, TRANSPARENT } from '../src/core/prefabs.ts';
import { prefabCost, objectBytes } from '../src/core/prefabcost.ts';
import { PasteCounter, dm16Prefab } from '../src/core/pastehint.ts';

let fail = 0;
const check = (ok: boolean, what: string) => { if (!ok) { fail++; console.log('FAIL', what); } };

const dm = (x: number, y: number, tile: number, w = 1, h = 1, c?: { flag: number; always: boolean }): LevelObject =>
  ({ uid: newUid(), num: 0, ext: DM16_EXT, x, y, size: ((h - 1) << 4) | (w - 1), tile, ...(c ? { cond: { ...c } } : {}) });
// a 3×3 block of 9 tiles as 9 objects at x, y: pays off at once
const block = (x: number, y: number) => Array.from({ length: 9 }, (_, i) => dm(x + (i % 3), y + Math.floor(i / 3), 0x100 + i));
// a run of one tile: one object, 6 bytes against 4 – pays off only after many placements
const run = (x: number, y: number) => [dm(x, y, 0x130, 16)];

// the arrangement as a prefab: the tiles the objects leave (the later one over the earlier), transparent between
const p = dm16Prefab([dm(5, 5, 0x130, 2, 1), dm(6, 5, 0x131), dm(5, 7, 0x132, 1, 1, { flag: 4, always: false })])!;
check(p.w === 2 && p.h === 3, `bounding box (${p.w}×${p.h})`);
check(JSON.stringify(p.tiles) === JSON.stringify([0x130, 0x131, TRANSPARENT, TRANSPARENT, 0x132, TRANSPARENT]), `tiles ${JSON.stringify(p.tiles)}`);
check(p.conds?.[4]?.flag === 4 && !p.conds?.[0], 'conditions kept');
check(dm16Prefab([dm(0, 0, 0x130, 2)])!.conds === undefined, 'no conditions: none stored');
check(dm16Prefab([...block(0, 0), { uid: newUid(), num: 5, ext: 0, x: 0, y: 0, size: 0 }]) === null, 'with a standard object: none');
check(dm16Prefab([{ uid: newUid(), num: 0, ext: PREFAB_EXT, x: 0, y: 0, size: 0, prefab: 1 }]) === null, 'a prefab object: none');
check(dm16Prefab([]) === null, 'nothing: none');
check(dm16Prefab([dm(0, 0, 0x130), dm(PREFAB_MAX, 0, 0x130)]) === null, 'wider than a prefab can be: none');

// the third paste of the same arrangement shows the hint, wherever placed and however split
{
  const pc = new PasteCounter();
  check(pc.paste(block(0, 0)) === null, 'first paste: no hint');
  check(pc.paste(block(0x20, 3)) === null, 'second paste: no hint');
  const split = [dm(0x40, 1, 0x100), dm(0x41, 1, 0x101), dm(0x42, 1, 0x102), ...block(0x40, 1).slice(3)];
  const hint = pc.paste(split);
  check(hint !== null && hint.count === 3, 'third paste (split otherwise): hint');
  const bytes = block(0, 0).reduce((n, o) => n + objectBytes(o), 0) * 2 + split.reduce((n, o) => n + objectBytes(o), 0);
  const c = prefabCost(dm16Prefab(split)!);
  check(hint?.saved === bytes - c.once - 3 * c.perPlacement, `saved bytes: the three pastes against the prefab (${hint?.saved})`);
  check(hint !== null && hint.saved > 0, 'saves bytes');
  check(pc.paste(block(0, 0x10))?.count === 4, 'fourth paste: hint again, counted on');
  // dismissed: never again for this arrangement
  pc.dismiss(hint!.key);
  check(pc.paste(block(0, 0)) === null, 'dismissed arrangement: no hint');
  check(pc.paste(block(0, 0)) === null, 'dismissed arrangement: still no hint');
  // another arrangement counts on its own
  const other = (x: number) => block(x, 0).map((o) => ({ ...o, tile: o.tile! + 0x10 }));
  pc.paste(other(0)); pc.paste(other(4));
  check(pc.paste(other(8))?.count === 3, 'another arrangement: its own count');
}

// only when a prefab would save bytes
{
  const pc = new PasteCounter();
  check([1, 2, 3, 4].every((x) => pc.paste(run(x, 0)) === null), 'a run of one tile: no hint (a prefab takes more)');
  const k = prefabCost(dm16Prefab(run(0, 0))!).breakEven!;
  let hint = null;
  for (let i = 5; i <= k && !hint; i++) hint = pc.paste(run(i, 0));
  check(hint !== null && hint.count === k && hint.saved > 0, `a run of one tile: hint at its break-even ${k} (${hint?.count})`);
}

// not for other objects
{
  const pc = new PasteCounter();
  const mixed = () => [...block(0, 0), { uid: newUid(), num: 5, ext: 0, x: 0, y: 0, size: 0 }];
  check([0, 1, 2, 3].every(() => pc.paste(mixed()) === null), 'with a standard object: no hint');
}

console.log(fail ? `${fail} failures` : 'paste hint ok');
if (fail) process.exitCode = 1;
