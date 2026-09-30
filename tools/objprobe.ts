// Probes standard objects by emulation: which nibble of the settings byte is a size, which a type.
// usage: node tools/objprobe.ts all | node tools/objprobe.ts <tileset>:<obj>,<obj>…  (shape ids per nibble value 0..F)
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator, OV_L1, MAP_BASE } from '../src/core/levelemu.ts';
import { loadLevel, encodePrimaryHeader, serializeObjects, newUid, type LevelObject } from '../src/core/level.ts';
import { layerGeom } from '../src/core/render.ts';

const rom = new Rom(new Uint8Array(readFileSync('Super Mario World (U) [!].smc')));
const emu = new LevelEmulator(rom);
emu.boot();
const base = loadLevel(rom, 0x105);
const g = layerGeom(rom, 0, 0, 32);
const inv = new Map<number, [number, number]>();
for (let y = 0; y < g.height; y++) for (let x = 0; x < g.width; x++) inv.set(g.addr(x, y) - MAP_BASE, [x, y]);
interface Shape { w: number; h: number; sig: string }
function probe(ts: number, specs: { num: number; size: number }[]): (Shape | null)[] {
  const res: (Shape | null)[] = [];
  for (const s of specs) {
    const objs: LevelObject[] = [{ uid: newUid(), num: s.num, ext: 0, size: s.size, x: 40, y: 5 }];
    const owners: number[] = [-1, -1, -1, -1, -1];
    const body = serializeObjects(objs, [], false, owners);
    const l1 = new Uint8Array(5 + body.length);
    l1.set(encodePrimaryHeader({ ...base.header, screens: 32, mode: 0, tileset: ts }));
    l1.set(body, 5);
    const byteOwner = new Int32Array(0x10000).fill(-1);
    owners.forEach((o, i) => (byteOwner[OV_L1 + i] = o));
    const r = emu.load(0x105, { layer1: l1, sprites: new Uint8Array([0, 0xff]), byteOwner });
    const set = r.touched.get(0);
    if (!r.ok || !set || !set.size) { res.push(null); continue; }
    const t: [number, number, number][] = [];
    for (const off of set) { const p = inv.get(off); if (p) t.push([p[0], p[1], r.wram[MAP_BASE + off] | (r.wram[0x10000 + MAP_BASE + off] << 8)]); }
    const x0 = Math.min(...t.map((v) => v[0])), y0 = Math.min(...t.map((v) => v[1]));
    const x1 = Math.max(...t.map((v) => v[0])), y1 = Math.max(...t.map((v) => v[1]));
    res.push({ w: x1 - x0 + 1, h: y1 - y0 + 1, sig: t.map((v) => `${v[0] - x0},${v[1] - y0},${v[2]}`).sort().join(' ') });
  }
  return res;
}
if (process.argv[2] === 'all') {
  for (const ts of [0, 1, 2, 3, 4]) {
    for (let n = ts ? 0x22 : 1; n < 0x40; n++) {
      const cls: string[] = [];
      for (const nib of ['lo', 'hi']) {
        const sh = probe(ts, Array.from({ length: 16 }, (_, v) => ({ num: n, size: nib === 'lo' ? 0x20 | v : (v << 4) | 2 })));
        const vs = sh.slice(1);
        if (vs.some((x) => !x)) { cls.push('?'); continue; }
        const area = vs.map((x) => x!.w * x!.h);
        const sigs = vs.map((x) => x!.sig);
        if (area.every((a, i) => i === 0 || a > area[i - 1])) cls.push('size');
        else if (new Set(sigs).size === 1) cls.push('none');
        else {
          const all = sh.map((x) => x!.sig);
          let cnt = 0; const seen = new Set<string>();
          for (const q of all) { if (seen.has(q)) break; seen.add(q); cnt++; }
          const dims = new Set(sh.map((x) => `${x!.w}x${x!.h}`)).size;
          cls.push(`TYPE(${cnt},dims${dims})`);
        }
      }
      if (cls[0] !== 'size' || cls[1] !== 'size') console.log(ts, n.toString(16), 'lo=' + cls[0], 'hi=' + cls[1]);
    }
  }
  process.exit(0);
}
const [ts, list] = process.argv[2].split(':');
for (const n of list.split(',').map((s) => parseInt(s, 16))) {
  for (const nib of ['lo', 'hi']) {
    const specs = Array.from({ length: 16 }, (_, v) => ({ num: n, size: nib === 'lo' ? 0x20 | v : (v << 4) | 2 }));
    const sh = probe(Number(ts), specs);
    const ids: string[] = [];
    const out = sh.map((s) => { if (!s) return '--'; let i = ids.indexOf(s.sig); if (i < 0) { ids.push(s.sig); i = ids.length - 1; } return `${i.toString(36)}:${s.w}x${s.h}`; });
    console.log(`${n.toString(16)} ${nib}: ${out.join(' ')}`);
  }
}
