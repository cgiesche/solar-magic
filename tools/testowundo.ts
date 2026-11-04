// The overworld's loads and what is derived from them kept by content (#386, overworld.ts OverworldLoads,
// keptresults.ts KeptResults contents; jobrunner.ts memoryResults likewise): undoing a layer 1 stroke, and redoing it, finds the saves at every event progress made
// on that ROM state without emulating a map again. The submaps' views and the tiles' own looks don't depend on the
// tilemaps they read (owTilemapRanges): a decorative layer 1 tile or a layer 2 entry painted keeps them; a layer 1
// tile's Map16 changed learns the looks again.
// node tools/testowundo.ts
import { Rom } from '../src/core/rom.ts';
import { OverworldEmulator, OverworldLoads, readL1, writeL1, readL2, writeL2, owTileWords, setOwTileWords } from '../src/core/overworld.ts';
import { progressSaves } from '../src/core/owprogress.ts';
import { submapViews } from '../src/core/owevents.ts';
import { l1OwnLooks } from '../src/core/owlook.ts';
import { editorImage, pathKinds } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const json = (x: unknown) => JSON.stringify(x);

const rom = new Rom((await editorImage()).slice()), kinds = pathKinds(rom);
const emu = new OverworldEmulator(rom), loads = new OverworldLoads(emu, 16);
// the maps emulated (OverworldEmulator.loadRecorded: a load not kept)
let loaded = 0;
const loadRecorded = emu.loadRecorded.bind(emu);
emu.loadRecorded = (map, progress, special) => { loaded++; return loadRecorded(map, progress, special); };
const counted = <T>(fn: () => T): { result: T; loads: number; ms: number } => {
  const n = loaded, t0 = performance.now(), result = fn();
  return { result, loads: loaded - n, ms: performance.now() - t0 };
};

// ---- the views and the looks keep over tilemap edits ----
const views = submapViews(loads), looks = l1OwnLooks(rom, loads);
const l1 = readL1(rom);
let cell = -1;
for (let i = 0; i < 0x400; i++) if (kinds[l1[i]] === 'none' && kinds[l1[i + 1]] === 'none' && l1[i] !== l1[i + 1]) { cell = i; break; }
const stroke = l1.slice();
stroke[cell] = l1[cell + 1];
writeL1(rom, stroke);
{
  const v = counted(() => submapViews(loads)), l = counted(() => l1OwnLooks(rom, loads));
  check(v.loads === 0 && json(v.result) === json(views), `a decorative layer 1 tile painted (${cell.toString(16)}): the submaps' views kept (${v.loads} maps emulated)`);
  check(l.loads === 0 && json(l.result) === json(looks), `the tiles' own looks kept (${l.loads} maps emulated)`);
}
const l2 = readL2(rom), l2edit = l2.slice();
l2edit[100] ^= 1;
writeL2(rom, l2edit);
{
  const v = counted(() => submapViews(loads)), l = counted(() => l1OwnLooks(rom, loads));
  check(v.loads === 0 && l.loads === 0, `a layer 2 entry painted: the views and the looks kept (${v.loads}, ${l.loads} maps emulated)`);
}
writeL2(rom, l2);
writeL1(rom, l1);

// ---- undo and redo find the saves ----
const saves = counted(() => progressSaves(loads));
writeL1(rom, stroke);
const edited = counted(() => progressSaves(loads));
check(edited.loads > 0, `a layer 1 stroke: the saves learned again (${edited.loads} maps emulated, ${edited.ms.toFixed(0)} ms)`);
writeL1(rom, l1);
const undone = counted(() => progressSaves(loads));
check(undone.loads === 0 && json(undone.result) === json(saves.result), `undone: the saves as before the stroke, kept (${undone.loads} maps emulated, ${undone.ms.toFixed(0)} ms)`);
writeL1(rom, stroke);
const redone = counted(() => progressSaves(loads));
check(redone.loads === 0 && json(redone.result) === json(edited.result), `redone: the saves of the stroke, kept (${redone.loads} maps emulated, ${redone.ms.toFixed(0)} ms)`);
// a third ROM state, then the first again: up to DERIVED_CONTENTS kept
const other = l1.slice();
other[cell] = l1[cell + 2] ?? l1[cell + 1];
writeL1(rom, other);
progressSaves(loads);
writeL1(rom, l1);
check(counted(() => progressSaves(loads)).loads === 0, 'three ROM states: the first one\'s saves still kept');
// the loads themselves: the map shown kept for the ROM state undone to
loads.get(0, 0);
writeL1(rom, stroke);
const map = loads.get(0, 0);
writeL1(rom, l1);
const back = counted(() => loads.get(0, 0));
check(back.loads === 0, 'a load kept for the ROM state undone to');
writeL1(rom, stroke);
check(counted(() => loads.get(0, 0)).result === map, 'and the redone one\'s too');

// ---- a layer 1 tile's look changed: learned again ----
writeL1(rom, l1);
const t = l1[cell], words = owTileWords(rom, t);
setOwTileWords(rom, t, words.map((w) => w ^ 0x3ff));
check(counted(() => l1OwnLooks(rom, loads)).loads > 0, `tile ${t.toString(16)}'s Map16 changed: the looks learned again`);

if (bad) { console.log(`${bad} FAILED`); process.exit(1); }
console.log('all ok');
