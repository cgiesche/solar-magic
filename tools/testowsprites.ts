// The overworld's start positions, sprite slots and Koopa Kid places (owsprites.ts). Checked on the model – the clean
// game's read and written back unchanged – and by emulation: a new game starts at the set positions (Mario and
// Luigi), a slot moved or given another sprite is there when the overworld loads, and its image (learned from the
// game's OAM) is drawn where it is.
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { OverworldEmulator } from '../src/core/overworld.ts';
import {
  readStart, writeStart, readOwSprites, readOwSprite, writeOwSprite, koopaKidPos, setKoopaKidPos, owSpriteImages, OW_SPRITE_SLOTS, KOOPA_KIDS,
} from '../src/core/owsprites.ts';
import { RAM, get16 } from '../src/core/ram.ts';
import { editorImage, romDiff } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number) => v.toString(16).toUpperCase();

const rom = new Rom(await editorImage());

// ---- the clean game's ----
{
  const mario = readStart(rom, 0), luigi = readStart(rom, 1), sprites = readOwSprites(rom);
  check(JSON.stringify(mario) === JSON.stringify({ submap: 1, x: 6, y: 7 }) && JSON.stringify(luigi) === JSON.stringify(mario), `start: Mario and Luigi on Yoshi's Island 06,07 (${JSON.stringify(mario)})`);
  check(sprites.length === OW_SPRITE_SLOTS && sprites.filter((s) => s.num).length === 8 && sprites[2].num === 6 && sprites[2].x === 0x170 && sprites[2].y === 0x20,
    `13 slots, 8 used: ${sprites.map((s) => `${hx(s.num)}@${hx(s.x)},${hx(s.y)}`).join(' ')}`);
  const r = new Rom(rom.data.slice());
  writeStart(r, 0, mario); writeStart(r, 1, luigi);
  sprites.forEach((s, k) => writeOwSprite(r, k, s));
  for (let k = 0; k < KOOPA_KIDS; k++) setKoopaKidPos(r, k, koopaKidPos(rom, k));
  check(romDiff(rom.data, r.data) === 0, 'written back unchanged');
}

// ---- a new game ----
{
  const r = new Rom(rom.data.slice());
  writeStart(r, 0, { submap: 0, x: 0x0c, y: 0x09 });
  writeStart(r, 1, { submap: 2, x: 5, y: 0x14 });
  const e = new LevelEmulator(r);
  e.startGame(0);
  const w = e.snes.wram, at = (o: number) => `${w[RAM.submap + o / 4]}:${hx(get16(w, RAM.owPlayerX + o))},${hx(get16(w, RAM.owPlayerY + o))} ${hx(get16(w, RAM.owPlayerTileX + o))},${hx(get16(w, RAM.owPlayerTileY + o))}`;
  check(at(0) === '0:C8,98 C,9' && at(4) === '2:58,148 5,14', `a new game: Mario ${at(0)}, Luigi ${at(4)}`);
}

// ---- sprites where set ----
{
  const r = new Rom(rom.data.slice()), emu = new OverworldEmulator(r);
  const before = owSpriteImages(new OverworldEmulator(rom), 0, 0);
  const shown = before.map((v, k) => (v.image ? k : -1)).filter((k) => k >= 0);
  check(shown.length >= 3, `the main map shows slots ${shown.join(', ')}`);
  // the Boos (slot 10) moved and slot 9 (Cheep Cheep) made Boos too
  const boo = readOwSprite(rom, 10);
  writeOwSprite(r, 10, { ...boo, x: boo.x + 0x40, y: boo.y - 0x18 });
  writeOwSprite(r, 9, { num: boo.num, x: 0x100, y: 0x100 });
  const w = emu.load(0, 0).wram;
  const slot = (k: number) => ({ num: w[RAM.owSpriteNum + 3 + k], x: w[0x0e35 + 3 + k] | (w[0x0e65 + 3 + k] << 8), y: w[0x0e45 + 3 + k] | (w[0x0e75 + 3 + k] << 8) });
  check(JSON.stringify(slot(10)) === JSON.stringify({ ...boo, x: boo.x + 0x40, y: boo.y - 0x18 }) && JSON.stringify(slot(9)) === JSON.stringify({ num: boo.num, x: 0x100, y: 0x100 }),
    `loaded where set: slot 10 ${JSON.stringify(slot(10))}, slot 9 ${JSON.stringify(slot(9))}`);
  const after = owSpriteImages(emu, 0, 0);
  const near = (k: number, x: number, y: number) => { const i = after[k].image; return !!i && Math.abs(i.ox + i.w / 2 - x) < 24 && Math.abs(i.oy + i.h / 2 - y) < 24; };
  const b0 = before[10].image!, moved = after[10].image;
  check(!!moved && moved.ox - b0.ox === 0x40 && moved.oy - b0.oy === -0x18, `slot 10 drawn moved by 40,-18 (${moved && `${hx(moved.ox)},${hx(moved.oy)}`} from ${hx(b0.ox)},${hx(b0.oy)})`);
  check(near(9, 0x100, 0x100), `slot 9 drawn as Boos at 100,100 (${after[9].image && `${hx(after[9].image.ox)},${hx(after[9].image.oy)} ${after[9].image.w}x${after[9].image.h}`})`);
}

if (bad) { console.log(`${bad} FAILED`); process.exit(1); }
console.log('all ok');
