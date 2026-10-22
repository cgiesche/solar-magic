// The object palette's thumbnails (thumbs.ts): every 16x16 block of a thumbnail is one of the Map16 tiles
// it lists as the level shows them, also where objects of a batch break the level load together.
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { loadLevel, L2_PTRS } from '../src/core/level.ts';
import { ObjKindProbe, withObjectVariant } from '../src/core/objkinds.ts';
import { TileCache, map16Source, drawMap16 } from '../src/core/render.ts';
import { renderObjectThumbs, objectThumbsJob, objKey, type ObjSpec } from '../src/ui/thumbs.ts';
import { editorImage } from './fixture.ts';

let fail = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fail++; };
const hex = (n: number) => n.toString(16).toUpperCase();

const rom = new Rom(await editorImage());
const emu = new LevelEmulator(rom); emu.boot();

// 105 (tileset 7): the standard objects as the palette lists them; two of object 33's types in one batch
// stall the load
{
  const lv = loadLevel(rom, 0x105);
  const { kinds } = new ObjKindProbe(emu, lv, rom.r24(L2_PTRS + 0x105 * 3)).result();
  const specs: ObjSpec[] = [];
  for (let n = 1; n < 0x40; n++) {
    const k = kinds.get(n);
    if (!k?.type) { specs.push({ num: n, ext: 0, size: 0x11 }); continue; }
    for (let t = 0; t < k.count; t++) specs.push({ num: n, ext: 0, size: withObjectVariant(k, 0x11, t) });
  }
  const thumbs = renderObjectThumbs(rom, emu, lv, specs, (s) => objKey(s, kinds.get(s.num) ?? null));
  const r = emu.load(0x105);
  const tc = new TileCache(r.vram, r.cgram, (r.ppuRegs[0x0b] & 0x0f) << 13), src = map16Source(rom, r);
  const look = (t: number) => { const px = new Uint32Array(256); drawMap16(px, 16, 16, tc, src.fg(t), 0, 0); return px.join(); };
  const bad: string[] = [];
  for (const th of thumbs) {
    const allowed = new Set([new Uint32Array(256).join(), ...th.m16.map(look)]);
    for (let by = 0; by < th.h; by += 16) for (let bx = 0; bx < th.w; bx += 16) {
      const px = new Uint32Array(256);
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px[y * 16 + x] = th.px[(by + y) * th.w + bx + x];
      if (!allowed.has(px.join())) { bad.push(th.key); by = th.h; break; }
    }
  }
  check(bad.length === 0, `105: every thumbnail shows its own tiles ${bad.slice(0, 12).join(' ')}`);
  const has = new Set(thumbs.map((t) => t.key));
  const missing = specs.filter((s) => s.num >= 0x1f && s.num <= 0x32 && !has.has(objKey(s, kinds.get(s.num) ?? null))).map((s) => hex(s.num));
  check(missing.length === 0, `105: objects 1F-32 (in the batch with object 33) have thumbnails ${missing.join(' ')}`);

  // learned in the background: a step per batch of 32, the same thumbnails
  const job = objectThumbsJob(rom, emu, lv, specs, (s) => objKey(s, kinds.get(s.num) ?? null));
  let steps = 0, r2 = job.next();
  for (; !r2.done; r2 = job.next()) steps++;
  check(steps === Math.ceil(specs.length / 32) && JSON.stringify(r2.value.map((t) => t.key)) === JSON.stringify(thumbs.map((t) => t.key)), `105: in ${steps} steps, the same thumbnails`);
}

console.log(fail ? `${fail} FAILED` : 'all ok');
process.exit(fail ? 1 : 0);
