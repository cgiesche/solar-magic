// Level undo/redo (core/levelhistory.ts): a cancelled edit leaves the history as it was (redo too), a
// committed one is an undo step and drops redo, the oldest step goes beyond the limit, beginning while
// an edit is open commits that one.
import { LevelHistory } from '../src/core/levelhistory.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };

interface Lv { n: number }
const clone = (l: Lv): Lv => ({ ...l });

// committed: undo gives the level before, redo the one after
{
  const h = new LevelHistory<Lv>(clone);
  let lv: Lv = { n: 1 };
  h.begin(lv); lv.n = 2; h.commit();
  check(h.undoSize === 1 && h.redoSize === 0, 'commit: one undo step');
  lv = h.undo(lv)!;
  check(lv.n === 1 && h.redoSize === 1, 'undo: the level before');
  lv = h.redo(lv)!;
  check(lv.n === 2 && h.undoSize === 1 && h.redoSize === 0, 'redo: the level after');
  check(h.undo({ n: 9 }) !== null && h.undo({ n: 9 }) === null, 'nothing more to undo: null');
}

// cancelled: nothing recorded, redo stays (a click without dragging after an undo)
{
  const h = new LevelHistory<Lv>(clone);
  let lv: Lv = { n: 1 };
  h.begin(lv); lv.n = 2; h.commit();
  lv = h.undo(lv)!;
  h.begin(lv);
  const was = h.cancel();
  check(h.undoSize === 0 && h.redoSize === 1 && !h.editing, 'cancel: no undo step, redo kept');
  check(was?.n === 1 && was !== lv, 'cancel: hands back the level as it was (a copy)');
  lv = h.redo(lv)!;
  check(lv.n === 2, 'redo still works after a cancelled edit');
}

// a commit drops redo
{
  const h = new LevelHistory<Lv>(clone);
  let lv: Lv = { n: 1 };
  h.begin(lv); lv.n = 2; h.commit();
  lv = h.undo(lv)!;
  h.begin(lv); lv.n = 3; h.commit();
  check(h.redoSize === 0 && h.undoSize === 1, 'a new edit drops redo');
}

// the limit: the oldest step goes
{
  const h = new LevelHistory<Lv>(clone, 3);
  const lv: Lv = { n: 0 };
  for (let i = 1; i <= 5; i++) { h.begin(lv); lv.n = i; h.commit(); }
  check(h.undoSize === 3, 'limit: 3 steps kept');
  let l: Lv = lv;
  for (let i = 0; i < 3; i++) l = h.undo(l)!;
  check(l.n === 2 && h.undo(l) === null, 'limit: the oldest ones are gone');
}

// beginning while an edit is open commits it; undo/redo commit an open edit first
{
  const h = new LevelHistory<Lv>(clone);
  const lv: Lv = { n: 1 };
  h.begin(lv); lv.n = 2;
  check(h.begin(lv) && h.undoSize === 1, 'begin while open: the open edit is committed');
  lv.n = 3;
  const prev = h.undo(lv);
  check(prev?.n === 2 && h.undoSize === 1 && !h.editing, 'undo while open: the open edit is committed first');
  check(!h.begin({ n: 0 }), 'begin with none open: nothing committed');
}

console.log(bad ? `${bad} failures` : 'all ok');
if (bad) process.exitCode = 1;
