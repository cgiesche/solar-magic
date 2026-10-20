// ROM generation: the Rom counts every change of its image (rom.gen); emulators catch up by themselves
// with the next entry – no syncing by the caller – and boot again only when what the boot read changed.
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
  counts('writeAt', () => rom.writeAt(TITLE_BYTE, Uint8Array.of(1)));
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
  check(fp.gen !== g, 'fingerprint: recomputed after a write');
}

if (bad) { console.log(`${bad} FAILED`); process.exit(1); }
console.log('all ok');
