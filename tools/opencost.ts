// What the probe worker (probehost.ts) does after a vanilla ROM is opened on a level (default 105), as the editor asks
// for it: the level's block probes asked (the items overlay's tiles), the most the panels prefetch (blocks 000-1FF
// and all sprites: as with the Map16 and Sprites tabs shown, run last; at the open nothing shows them), the object kinds (the level's objects first) and the sprite images (the level's sprites first); prints when
// each piece is ready (#393). --alone: no asked probes, no prefetch; --nosprites: no sprite images; --uses: the levels'
// uses too.
//   node tools/opencost.ts 105 [--alone] [--nosprites] [--uses]
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { loadLevel } from '../src/core/level.ts';
import { levelBgPointer } from '../src/core/levelheader.ts';
import { layerGeom } from '../src/core/render.ts';
import { map16Tile } from '../src/core/ram.ts';
import { usedLevels } from '../src/core/levelusage.ts';
import { ProbeHost } from '../src/core/probehost.ts';
import { SPRITE_PROBE_END } from '../src/core/blockprobe.ts';
import { spriteJobs, spriteInput, levelSprites, levelObjects } from '../src/core/learnspecs.ts';
import type { ProbeJob } from '../src/core/probeprotocol.ts';
import { editorImage } from './fixture.ts';

const N = parseInt(process.argv[2] ?? '105', 16), withUses = process.argv.includes('--uses'), alone = process.argv.includes('--alone');
const rom = new Rom(await editorImage());
const lv = loadLevel(rom, N), ts = lv.header.tileset;
const emu = new LevelEmulator(rom); emu.boot();
const r = emu.load(N, {});
const tiles = new Set<number>();
const g = layerGeom(rom, 1, lv.header.mode, lv.header.screens);
try { for (let y = 0; y < g.height; y++) for (let x = 0; x < g.width; x++) { const a = g.addr(x, y); if (a >= 0) tiles.add(map16Tile(r.wram, a)); } } catch { for (let a = 0; a < 0x3800; a++) tiles.add(map16Tile(r.wram, a)); }
const placed = levelSprites(lv);
const objects = levelObjects(lv);
console.log(`level ${N.toString(16)} tileset ${ts}: ${tiles.size} distinct tiles, sprites placed ${placed.map((n) => n.toString(16)).join(' ')}, objects ${objects.map((n) => n.toString(16)).join(' ')}`);

const host = new ProbeHost();
host.setRom(1, rom.data.slice());
const t0 = performance.now(), at = () => ((performance.now() - t0) / 1000).toFixed(1) + ' s';
if (!alone) host.handle({ type: 'ask', jobs: [...tiles].map((tile): ProbeJob => ({ kind: 'block', ts, tile })) });
const pre: ProbeJob[] = [];
for (let tile = 0; tile < 0x200; tile++) pre.push({ kind: 'block', ts, tile });
for (let num = 0; num < SPRITE_PROBE_END; num++) pre.push({ kind: 'sprite', ts, num });
if (!alone) host.handle({ type: 'prefetch', jobs: pre });
host.handle({ type: 'kinds', ts, level: { number: N, header: lv.header }, layer2Pointer: levelBgPointer(rom, lv), first: objects });
const nums = Array.from({ length: 0xe7 }, (_, i) => i);
const all = spriteJobs(lv, nums, spriteInput(rom, lv, [], () => 0)).all;
if (!process.argv.includes('--nosprites')) host.handle({ type: 'learn', lane: 'sprites', key: all.key, input: JSON.stringify(all.input), job: all.job, replace: true });
if (withUses) host.handle({ type: 'learn', lane: 'uses', key: 'uses', job: { kind: 'uses', levels: usedLevels(rom) }, replace: false });

// (when each sprite's image was first shown: the placed sprites the set has no image of, as invisible ones, never are)
let asked = tiles.size, firstSprite = '';
const shownAt = new Map<number, string>();
while (host.pending) {
  const d = host.next();
  if (!d) continue;
  if (d.type === 'probe' && d.job.kind === 'block' && tiles.has(d.job.tile) && --asked === 0) console.log(at(), 'asked block probes of the level done');
  if (d.type === 'kindsShown') console.log(at(), `kinds of the level's ${objects.length} objects known (resizing possible)`);
  if (d.type === 'kinds') console.log(at(), "object kinds of the tileset known");
  if ((d.type === 'learning' || d.type === 'learned') && d.lane === 'sprites') {
    const items = (d.type === 'learned' ? d.result ?? [] : d.shown) as [number, unknown][];
    for (const [n] of items) {
      if (!firstSprite) { firstSprite = at(); console.log(at(), 'first sprite image'); }
      if (!shownAt.has(n)) shownAt.set(n, at());
    }
    if (d.type === 'learned') {
      const own = placed.filter((n) => shownAt.has(n)), none = placed.filter((n) => !shownAt.has(n));
      const last = own.map((n) => shownAt.get(n)!).sort((a, b) => parseFloat(a) - parseFloat(b)).pop();
      console.log(`${last ?? '-'} all of the level's sprites shown (${own.length}; without an image: ${none.map((n) => n.toString(16)).join(' ') || 'none'})`);
      console.log(at(), 'all sprite images learned');
    }
  }
  if (d.type === 'learned' && d.lane === 'uses') console.log(at(), 'uses learned');
  if (d.type === 'probe' && d.job.kind === 'sprite' && d.job.num === SPRITE_PROBE_END - 1) console.log(at(), 'prefetch done');
}
console.log(at(), 'all done');
