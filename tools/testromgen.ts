// ROM generation: the Rom counts every change of its image (rom.gen) and knows the ranges each changed; a write
// of the bytes already there is no change. Emulators catch up by themselves with the next entry – no syncing by
// the caller – and boot again only when what the boot read changed; the fingerprint rehashes changed pages only.
import { readFileSync } from 'node:fs';
import { Rom, snesToPc } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { OverworldEmulator } from '../src/core/overworld.ts';
import { RomFingerprint } from '../src/core/romdeps.ts';
import { gfxSkipMask } from '../src/core/gfxpages.ts';
import { installEditorPatch, gfxEntry } from '../src/core/patches.ts';
import { lz2Decompress, lz2Compress } from '../src/core/lz2.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const file = new Uint8Array(readFileSync('test/fixtures/smw.smc'));
const fresh = () => new Rom(file.slice());

const BOOT_BYTE = 0x01ff; // read while booting (its page), changing it still boots
const TITLE_BYTE = 0x7fc0; // the internal name: not read while booting

// every write counts, reads don't
{
  const rom = fresh();
  const counts = (what: string, f: () => void) => { const g = rom.gen; f(); check(rom.gen > g, `${what} counts`); };
  counts('w8', () => rom.w8(0x00ffc0, 0x41));
  counts('w16', () => rom.w16(0x00ffc0, 0x4142));
  counts('w24', () => rom.w24(0x00ffc0, 0x414243));
  counts('writeBytes', () => rom.writeBytes(0x00ffc0, Uint8Array.of(1, 2)));
  counts('writeAt', () => rom.writeAt(TITLE_BYTE, Uint8Array.of(3)));
  counts('fillAt', () => rom.fillAt(TITLE_BYTE, 2));
  const snap = rom.snapshot();
  counts('restore', () => rom.restore(snap));
  counts('expand', () => rom.expand(0x100000));
  let addr = 0;
  counts('allocWrite', () => { addr = rom.allocWrite(Uint8Array.of(1, 2, 3)); });
  counts('freeAt', () => rom.freeAt(addr));
  counts('fixChecksum', () => rom.fixChecksum());
  const g = rom.gen;
  rom.r8(0x008000); rom.r16(0x008000); rom.bytes(0x008000, 4);
  check(rom.gen === g, 'reads don\'t count');
}

// writing the bytes already there is no change
{
  const rom = fresh();
  const same = (what: string, f: () => void) => { const g = rom.gen; f(); check(rom.gen === g, `${what} of the same bytes: no new generation`); };
  same('w8', () => rom.w8(0x00ffc0, rom.r8(0x00ffc0)));
  same('w16', () => rom.w16(0x00ffc0, rom.r16(0x00ffc0)));
  same('w24', () => rom.w24(0x00ffc0, rom.r24(0x00ffc0)));
  same('writeAt', () => rom.writeAt(0x10000, rom.data.slice(0x10000, 0x18000)));
  rom.fillAt(0x7ff00, 0x40);
  same('fillAt', () => rom.fillAt(0x7ff00, 0x40));
  rom.fixChecksum();
  same('fixChecksum', () => rom.fixChecksum());
}

// the ranges a write changed: only the bytes that differ (runs close together as one range)
{
  const rom = fresh(), g = rom.gen;
  const b = rom.data.slice(0x20000, 0x20100);
  b[0x10] ^= 1; b[0x12] ^= 1; b[0xf0] ^= 1;
  rom.writeAt(0x20000, b);
  check(JSON.stringify(rom.changesSince(g)) === JSON.stringify([[0x20010, 0x20013], [0x200f0, 0x200f1]]), 'changed ranges of one write');
  const g2 = rom.gen;
  rom.w8(0x0cf7df, rom.r8(0x0cf7df) ^ 1);
  check(JSON.stringify(rom.changesSince(g2)) === JSON.stringify([[snesToPc(0x0cf7df), snesToPc(0x0cf7df) + 1]]), 'since a generation: its later changes only');
  check(rom.changesSince(g)!.length === 3, 'since an older one: all of them');
  check(rom.changesSince(rom.gen)!.length === 0, 'since the current one: none');
  check(rom.changesSince(-1) === null, 'before the log: not known');
  const g3 = rom.gen, snap = rom.snapshot();
  rom.w8(0x008000, rom.r8(0x008000) ^ 1);
  rom.restore(snap);
  check(rom.gen > g3 && JSON.stringify(rom.changesSince(g3)) === JSON.stringify([[0, 1]]) && rom.data[0] === snap.data[0], 'restore: the restored bytes changed (twice)');
  const g4 = rom.gen, len = rom.size;
  rom.expand(len * 2);
  const ch = rom.changesSince(g4)!;
  check(ch.some(([a, e]) => a <= 0x7fd7 && e > 0x7fd7) && ch.some(([a, e]) => a <= len && e >= len * 2), 'expand: the new part and the size byte');
  for (let i = 0; i < 9000; i++) rom.w8(0x008000, i);
  check(rom.changesSince(g4) === null && rom.changesSince(rom.gen - 10)!.length === 1, 'an old generation the log forgot: not known; a recent one still');
}

// a load's temporary pointer patches (the level as edited, a start header …) are no change of the ROM: the
// probe worker isn't sent it again (dropping its queue and the level scan running) after a test play or render
{
  const rom = fresh(), emu = new LevelEmulator(rom);
  emu.load(0x105);
  const before = rom.data.slice(), g = rom.gen;
  const r = emu.load(0x105, { layer1: new Uint8Array([0, 0, 0, 0, 0, 0xff]), sprites: new Uint8Array([0, 0xff]), secondaryHeader: [0, 0, 0, 0], music: 1 });
  check(r.ok, 'load with overrides');
  check(rom.gen === g, 'temporary patches don\'t count as a change');
  check(rom.data.every((b, i) => b === before[i]), 'and are taken back');
}

// a byte the boot read changed: the next load boots again; any other change keeps the boot snapshot
{
  const rom = fresh(), emu = new LevelEmulator(rom);
  check(emu.load(0x105).ok, 'level loads');
  const booted = emu.baseState;
  rom.writeAt(TITLE_BYTE, Uint8Array.of(0x20));
  check(emu.load(0x105).ok && emu.baseState === booted, 'unrelated change: boot snapshot kept');
  rom.writeAt(BOOT_BYTE, Uint8Array.of(rom.data[BOOT_BYTE] ^ 0xff));
  check(emu.load(0x105).ok && emu.baseState !== booted && emu.baseState !== null, 'change of what the boot read: booted again');
}

// the new data array after expanding is what the next load runs on
{
  const rom = fresh(), emu = new LevelEmulator(rom);
  emu.load(0x105);
  const before = rom.data;
  rom.expand(0x200000);
  const r = emu.load(0x105);
  check(rom.data !== before && emu.snes.rom === rom.data && r.ok, 'expanded ROM: the emulator runs on the new data');
}

// two emulators on one ROM (one adopting the other's boot) both catch up
{
  const rom = fresh(), a = new LevelEmulator(rom);
  a.load(0x105);
  const b = new LevelEmulator(rom);
  b.adoptBoot(a);
  const booted = a.baseState;
  rom.writeAt(BOOT_BYTE, Uint8Array.of(rom.data[BOOT_BYTE] ^ 0xff));
  check(b.load(0x105).ok && b.baseState !== booted, 'adopted boot from before the change: booted again');
  check(a.load(0x105).ok && a.baseState !== booted, 'the other emulator boots again too');
}

// an adopted boot from an older ROM is checked even when this emulator saw no change itself
{
  const rom = fresh(), a = new LevelEmulator(rom);
  a.load(0x105);
  const booted = a.baseState;
  rom.writeAt(BOOT_BYTE, Uint8Array.of(rom.data[BOOT_BYTE] ^ 0xff));
  const b = new LevelEmulator(rom); // created after the change
  b.adoptBoot(a);
  check(b.load(0x105).ok && b.baseState !== booted, 'adopted stale boot: booted again');
}

// GFX file data doesn't count for results (skipMask), but the title screen uploads files that stay in
// VRAM for a level with the same ones: drawing in them again and again shows each time
{
  const rom = fresh();
  installEditorPatch(rom);
  const emu = new LevelEmulator(rom);
  emu.skipMask = () => gfxSkipMask(rom);
  const e = gfxEntry(rom, 0x14)!;
  const { data } = lz2Decompress(rom.data, snesToPc(e.addr));
  let prev = emu.load(0x105).vram.slice();
  for (let i = 0; i < 3; i++) {
    for (let k = 0; k < 24; k++) data[i * 24 + k] ^= 0xff;
    const packed = lz2Compress(data);
    rom.writeBytes(e.addr, packed);
    const v = emu.load(0x105).vram;
    check(v.some((b, j) => b !== prev[j]), `GFX14 drawn in (${i + 1}. time): shown in the level`);
    prev = v.slice();
  }
  check(!emu.bootReads!.pages[snesToPc(e.addr) >> 8], 'GFX data still no dependency of results');
}

// the overworld emulator's title snapshot follows the same rule
{
  const rom = fresh(), ow = new OverworldEmulator(rom);
  ow.load(0, false);
  const title = ow.titleState;
  rom.writeAt(TITLE_BYTE, Uint8Array.of(0x20));
  ow.load(0, false);
  check(ow.titleState === title, 'overworld: unrelated change keeps the title snapshot');
  rom.writeAt(BOOT_BYTE, Uint8Array.of(rom.data[BOOT_BYTE] ^ 0xff));
  ow.load(0, false);
  check(ow.titleState !== title && ow.titleState !== null, 'overworld: change of what the title read: reached again');
}

// the fingerprint follows the ROM without an emulator
{
  const rom = fresh(), fp = new RomFingerprint(rom);
  fp.sync();
  const g = fp.gen;
  fp.sync();
  check(fp.gen === g, 'fingerprint: same ROM, not recomputed');
  rom.writeAt(TITLE_BYTE, Uint8Array.of(0x20));
  fp.sync();
  check(fp.gen !== g && fp.rehashed === 1, 'fingerprint: recomputed after a write, only the changed page');
  const g2 = fp.gen;
  rom.writeAt(TITLE_BYTE, Uint8Array.of(0x20));
  fp.sync();
  check(fp.gen === g2, 'fingerprint: the same bytes written again, not recomputed');
  rom.expand(0x100000);
  fp.sync();
  check(fp.rehashed === 0x100000 >> 8, 'fingerprint: a new size, all pages');
}

if (bad) { console.log(`${bad} FAILED`); process.exit(1); }
console.log('all ok');
