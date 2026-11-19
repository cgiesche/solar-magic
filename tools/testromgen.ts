// ROM generation: the Rom counts every change of its image (rom.gen) and knows the ranges each changed; a write
// of the bytes already there is no change. Emulators catch up by themselves with the next entry – no syncing by
// the caller – and boot again only when what the boot read changed; the fingerprint rehashes changed pages only.
import { readFileSync } from 'node:fs';
import { Rom, snesToPc, pcToSnes } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { OverworldEmulator } from '../src/core/overworld.ts';
import { RomFingerprint, RomReads, bytePages, record, PAGE_SHIFT } from '../src/core/romdeps.ts';
import { levelDataRanges } from '../src/core/level.ts';
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
  const booted = emu.snapshot;
  rom.writeAt(TITLE_BYTE, Uint8Array.of(0x20));
  check(emu.load(0x105).ok && emu.snapshot === booted, 'unrelated change: boot snapshot kept');
  rom.writeAt(BOOT_BYTE, Uint8Array.of(rom.data[BOOT_BYTE] ^ 0xff));
  check(emu.load(0x105).ok && emu.snapshot !== booted && emu.snapshot !== null, 'change of what the boot read: booted again');
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
  b.adoptBoot(a.snapshot);
  const booted = a.snapshot;
  rom.writeAt(BOOT_BYTE, Uint8Array.of(rom.data[BOOT_BYTE] ^ 0xff));
  check(b.load(0x105).ok && b.snapshot !== booted, 'adopted boot from before the change: booted again');
  check(a.load(0x105).ok && a.snapshot !== booted, 'the other emulator boots again too');
}

// an adopted boot from an older ROM is checked even when this emulator saw no change itself
{
  const rom = fresh(), a = new LevelEmulator(rom);
  a.load(0x105);
  const booted = a.snapshot;
  rom.writeAt(BOOT_BYTE, Uint8Array.of(rom.data[BOOT_BYTE] ^ 0xff));
  const b = new LevelEmulator(rom); // created after the change
  b.adoptBoot(a.snapshot);
  check(b.load(0x105).ok && b.snapshot !== booted, 'adopted stale boot: booted again');
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
  check(!emu.snapshot!.reads.pages[snesToPc(e.addr) >> 8], 'GFX data still no dependency of results');
}

// what a level load read, GFX file data and the boot included (App.refresh draws the level anew only when one
// of those bytes changed): overworld data isn't among them, a GFX file the level uses is
{
  const rom = fresh();
  installEditorPatch(rom);
  const emu = new LevelEmulator(rom);
  emu.skipMask = () => gfxSkipMask(rom);
  const { reads } = emu.record('title screen', () => emu.load(0x105));
  let g = rom.gen;
  for (const [snes, n] of [[0x0cf7df, 0x800], [0x04a533, 0x40], [0x04c02b, 0x40], [0x04d85d, 0x10]]) {
    rom.writeAt(snesToPc(snes), rom.data.slice(snesToPc(snes), snesToPc(snes) + n).map((b) => b ^ 0x5a));
  }
  check(!reads.touches(rom.changesSince(g)!), 'level load: overworld data not read');
  const e = gfxEntry(rom, 0x14)!, o = snesToPc(e.addr);
  g = rom.gen;
  rom.writeAt(o + 8, Uint8Array.of(rom.data[o + 8] ^ 0xff));
  check(reads.touches(rom.changesSince(g)!), 'level load: a GFX file it uploads is read (though no dependency of results)');
  g = rom.gen;
  rom.writeAt(BOOT_BYTE, Uint8Array.of(rom.data[BOOT_BYTE] ^ 0xff));
  check(reads.touches(rom.changesSince(g)!), 'level load: what the boot read counts');
}

// the overworld emulator's title snapshot follows the same rule
{
  const rom = fresh(), ow = new OverworldEmulator(rom);
  ow.load(0, 0);
  const title = ow.titleState;
  rom.writeAt(TITLE_BYTE, Uint8Array.of(0x20));
  ow.load(0, 0);
  check(ow.titleState === title, 'overworld: unrelated change keeps the title snapshot');
  rom.writeAt(BOOT_BYTE, Uint8Array.of(rom.data[BOOT_BYTE] ^ 0xff));
  ow.load(0, 0);
  check(ow.titleState !== title && ow.titleState !== null, 'overworld: change of what the title read: reached again');
}

// the byte pages belong to a ROM state: computed once for it, whoever asks first; another ROM in the process (a
// test's, the probe worker's copy) has its own, also at the same generation number. A recorder takes its ROM's: no
// emulator has to set them up first.
{
  // (the first boot finds the per-sprite tables, spritetables.ts: their pages join the ROM's from then on)
  const rom = fresh(), before = bytePages(rom), a = new LevelEmulator(rom);
  a.load(0x105);
  const pages = bytePages(rom);
  check(pages !== before && before.every((v, i) => !v || pages[i]) && pages.some((v, i) => v && !before[i]), 'the first boot: the per-sprite tables\' pages added');
  const b = new LevelEmulator(rom), ow = new OverworldEmulator(rom);
  b.load(0x105); ow.load(0, 0);
  check(bytePages(rom) === pages, 'emulators and loads on the unchanged ROM: its byte pages not computed again');
  rom.writeAt(TITLE_BYTE, Uint8Array.of(0x20));
  const changed = bytePages(rom);
  check(changed !== pages && bytePages(rom) === changed, 'a change: computed once more');
  const other = fresh();
  installEditorPatch(other);
  // (both at the same generation number: it alone doesn't tell the ROM states apart)
  while (other.gen < rom.gen) other.writeAt(TITLE_BYTE, Uint8Array.of(other.gen & 1 ? 0x21 : 0x22));
  while (rom.gen < other.gen) rom.writeAt(TITLE_BYTE, Uint8Array.of(rom.gen & 1 ? 0x21 : 0x22));
  const vanilla = bytePages(rom), patched = bytePages(other);
  check(other.gen === rom.gen && patched !== vanilla && patched.some((v, i) => v !== vanilla[i]), 'another ROM at the same generation: its own byte pages');
  // a level's data is on byte pages with the editor patch only; read without any emulator or set-up call
  const [start] = levelDataRanges(other)[0], page = start >> PAGE_SHIFT;
  const read = (r: Rom) => record(r, () => r.r8(pcToSnes(start))).reads;
  const ro = read(other), rv = read(rom);
  check(patched[page] === 1 && ro.bytes.has(start) && !ro.pages[page], `the patched ROM records a read in a level's data (${start.toString(16)}) by byte`);
  check(vanilla[page] === 0 && rv.pages[page] === 1 && !rv.bytes.has(start), 'the vanilla ROM records the same read by page');
  // two emulators, one per ROM, loading in turns: each records against its own ROM's byte pages
  const e = new LevelEmulator(other);
  e.load(0x105);
  const own = (r: Rom, reads: RomReads) => {
    const bp = bytePages(r);
    return reads.bytePages === bp && [...reads.bytes].every((o) => bp[o >> PAGE_SHIFT] === 1) && reads.pages.every((v, p) => !v || !bp[p]);
  };
  const tv = a.record('picture', () => a.load(0x105)), tp = e.record('picture', () => e.load(0x105)), tv2 = a.record('picture', () => a.load(0x106));
  check(own(rom, tv.reads) && own(other, tp.reads) && own(rom, tv2.reads), 'level loads on two ROMs in turns: each recorded against its ROM\'s byte pages');
  const differ = [...tp.reads.bytes].some((o) => !vanilla[o >> PAGE_SHIFT] && tv.reads.pages[o >> PAGE_SHIFT]);
  check(differ, 'a page read by both loads is recorded by byte on the patched ROM, by page on the vanilla one');
  // a recorder kept across ROM edits records against the ROM state current at each read: a page that became a byte
  // page since (the editor patch installed: a level's data) is recorded by byte from then on, its reads before stay
  const k = fresh(), kept = new RomReads(k), [s0] = levelDataRanges(other)[0], p0 = s0 >> PAGE_SHIFT;
  kept.read(s0 + 1);
  installEditorPatch(k);
  const [s1] = levelDataRanges(k)[0], p1 = s1 >> PAGE_SHIFT;
  kept.read(s1);
  check(kept.pages[p0] === 1 && kept.bytes.has(s1) && (p1 === p0 || !kept.pages[p1]), `a recorder kept across the editor patch's install: the read before by page, the one after by byte (${s1.toString(16)})`);
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
