// FastROM (fastrom.ts, ADR 0007): the editor's ROM is FastROM – header, $420D, the game in bank $80 in its
// main loop, NMI and IRQ; while the levels are played as in the VRAM test, few instructions run in the slow
// banks (reported, with where they were entered from); a patch may overwrite a rewritten JSL; the clean
// game's fingerprint sees the sites as clean; free space is addressed in $80+; the emulator times it (ROM accesses
// in the fast banks with $420D = 1 cost 6 master cycles instead of 8).
import { Rom, pcToSnes } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { PAD } from '../src/core/ram.ts';
import { PlaySession } from '../src/core/playsession.ts';
import { loadAsar } from '../src/core/asar.ts';
import { applyPatch } from '../src/core/patchapply.ts';
import { cleanGameBytes } from '../src/core/cleangame.ts';
import { fastRom, installFastRom } from '../src/core/fastrom.ts';
import { JUMP_SITES, TABLE_SITES } from '../src/core/fastromsites.ts';
import { Snes } from '../src/core/snes.ts';
import { editorImage, cleanImage } from './fixture.ts';

await loadAsar();
let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hex = (v: number, n = 6) => '$' + v.toString(16).toUpperCase().padStart(n, '0');
const clean = new Rom(cleanImage()).data, image = await editorImage();

// 1. the header, the patch's mark, the sites
{
  const rom = new Rom(image.slice());
  check(rom.data[0x7fd5] === 0x30, `header map mode $30 (FastROM) ${hex(rom.data[0x7fd5], 2)}`);
  check(!!fastRom(rom), 'the FastROM patch is detected');
  const set = (o: number) => (rom.data[o] & 0x80) !== 0 && (rom.data[o] & 0x7f) === clean[o];
  const sites: [number, number][] = [...JUMP_SITES.map((o): [number, number] => [o, 4]), ...TABLE_SITES.map((o): [number, number] => [o, 3])];
  const done = sites.filter(([o]) => set(o)).length, kept = sites.filter(([o]) => !set(o));
  const taken = ([o, n]: [number, number]) => { for (let i = o - n + 1; i <= o; i++) if (rom.data[i] !== clean[i]) return true; return false; };
  console.log(`     ${done} of ${sites.length} sites in the fast banks, ${kept.length} left to an editor patch's hook`);
  check(kept.every(taken), 'a site is left alone only where an editor patch changed its bytes');
  const again = new Rom(rom.data.slice());
  installFastRom(again, clean);
  check(again.data.every((b, i) => b === rom.data[i]), 'installing again changes nothing');
}

// 2. playing: $420D, the program bank in the main loop, NMI and IRQ; the share of instructions in the slow banks
{
  const rom = new Rom(image.slice());
  const emu = new LevelEmulator(rom);
  const s = emu.snes, cpu = s.cpu;
  const banks = { main: new Set<number>(), nmi: new Set<number>(), irq: new Set<number>() };
  const at = { main: 0x806b, nmi: 0x816a, irq: 0x8374 }; // the game's wait loop, NMI, IRQ
  let fast = 0, slow = 0;
  const entries = new Map<string, number>(); // where the slow banks were entered from → instructions
  let entry = '';
  const exec = cpu.exec.bind(cpu);
  cpu.exec = (op: number) => {
    const pc = cpu.opPc, bank = pc >> 16;
    if ((pc & 0xffff) >= 0x8000 && (bank & 0x7f) < 0x40) {
      for (const k of ['main', 'nmi', 'irq'] as const) if ((pc & 0x7fffff) === at[k]) banks[k].add(bank);
      if (bank >= 0x80) fast++;
      else {
        slow++;
        // (vectors point into bank 0: the stubs' JML runs slow)
        const k = (pc & 0xffff) >= 0xba4e && (pc & 0xffff) < 0xba5a ? 'the vector stubs at $00BA4E' : entry;
        entries.set(k, (entries.get(k) ?? 0) + 1);
      }
    }
    const lastBank = bank;
    exec(op);
    if (cpu.pbr < 0x40 && (lastBank >= 0x80 || (lastBank & 0x7e) === 0x7e || lastBank === 0xfe)) entry = `${hex(pc)} ${['JSL', 'JML', 'RTL', 'RTI', 'JML []'][[0x22, 0x5c, 0x6b, 0x40, 0xdc].indexOf(op)] ?? hex(op, 2)} → ${hex((cpu.pbr << 16) | cpu.pc)}`;
  };
  emu.boot();
  check(s.memsel === 1, `$420D = 1 after boot (${s.memsel})`);
  const input = (f: number) => PAD.y | PAD.right | (f % 70 < 34 ? PAD.b : 0) | (f % 200 > 150 ? PAD.left : 0) | (f % 300 > 240 ? PAD.up : 0);
  const levels = [...Array(0x25).keys(), ...Array.from({ length: 0x3b }, (_, i) => 0x101 + i)];
  for (const n of levels) {
    const p = PlaySession.start(emu, n);
    if (!p.render?.ok) continue;
    for (let f = 0; f < 200; f++) p.frame(input(f));
  }
  for (const k of ['main', 'nmi', 'irq'] as const) check(banks[k].size > 0 && [...banks[k]].every((b) => b >= 0x80), `${k} runs in the fast banks: ${[...banks[k]].map((b) => hex(b, 2)).join(' ')}`);
  const share = slow / (fast + slow);
  console.log(`     ${(share * 100).toFixed(2)} % of the game's instructions in the slow banks ($00–$3F); entered from:`);
  for (const [k, n] of [...entries].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`       ${(n / (fast + slow) * 100).toFixed(3).padStart(6)} %  ${k}`);
  check(share < 0.01, `fewer than 1 % in the slow banks`);
}

// 2b. the emulator times FastROM: an access in $80–$BF:8000–FFFF or $C0–$FF with $420D bit 0 set costs 6 master
// cycles, ROM elsewhere 8 – also in those banks while $420D is 0 (the other speeds: testmemtiming.ts)
{
  // LDA $8000 a hundred times, then LDA $0000 (a WRAM byte through the data bank) a hundred times
  const code = new Uint8Array(0x80000);
  for (let i = 0; i < 100; i++) code.set([0xad, 0x00, 0x80], i * 3);
  for (let i = 0; i < 100; i++) code.set([0xad, 0x00, 0x00], 300 + i * 3);
  // master cycles per instruction for 100 instructions from offset at, code and data in bank
  const time = (bank: number, memsel: number, at: number, s = new Snes(code)) => {
    s.write(0x420d, memsel);
    s.cpu.pbr = s.cpu.dbr = bank;
    s.cpu.pc = 0x8000 + at;
    const c0 = s.cpu.cycles;
    for (let i = 0; i < 100; i++) s.cpu.step();
    return (s.cpu.cycles - c0) / 100;
  };
  check(time(0x00, 1, 0) === 32, `ROM in bank $00, $420D = 1: 4 slow accesses an LDA $8000, 32 (${time(0x00, 1, 0)})`);
  check(time(0x80, 0, 0) === 32, `ROM in bank $80, $420D = 0: 32 (${time(0x80, 0, 0)})`);
  check(time(0x80, 1, 0) === 24, `ROM in bank $80, $420D = 1: 4 fast accesses, 24 (${time(0x80, 1, 0)})`);
  check(time(0xc0, 1, 0) === 24, `bank $C0, $420D = 1: 24 (${time(0xc0, 1, 0)})`);
  check(time(0x80, 1, 300) === 26, `LDA $0000 in bank $80: 3 fast fetches, WRAM slow: 26 (${time(0x80, 1, 300)})`);
  const s = new Snes(code);
  s.write(0x420d, 1);
  const t = new Snes(code);
  t.loadState(s.saveState());
  check(t.memsel === 1 && time(0x80, 1, 0, t) === 24, 'a savestate keeps $420D');
}

// 3. a patch overwriting a rewritten JSL operand: no rejection, no warning
{
  const rom = new Rom(image.slice());
  const o = JUMP_SITES.find((o) => (rom.data[o] & 0x80) && rom.data[o - 3] === 0x22)!;
  const at = pcToSnes(o - 3) & 0x7fffff, target = clean[o - 2] | (clean[o - 1] << 8) | (clean[o] << 16);
  const r = applyPatch(rom, { name: 'slow', main: 'main.asm', files: new Map([['main.asm', `lorom\norg ${hex(at)}\n  JSL ${hex(target)}\n`]]) });
  check(r.ok && !r.warnings.length, `a patch writing the clean JSL at ${hex(at)} applies without warning ${[...r.errors, ...r.warnings].join(' | ')}`);
  check(rom.data[o] === clean[o], 'its bank byte is the patch\'s');
}

// 4. the clean game's fingerprint: blocks with sites are clean, their bytes the clean game's
{
  const rom = new Rom(image.slice());
  const byte = cleanGameBytes(rom)!;
  const sites = [...JUMP_SITES, ...TABLE_SITES].filter((o) => (rom.data[o] & 0x80) !== 0);
  const known = sites.filter((o) => byte(o) !== null);
  check(known.length > sites.length * 0.5, `${known.length} of ${sites.length} rewritten sites in blocks the editor changed nothing else in`);
  check(known.every((o) => byte(o) === clean[o]), 'their clean bytes are the slow banks');
  const o = known[0];
  rom.writeAt(o, Uint8Array.of(0x12));
  check(cleanGameBytes(rom)!(o) === null, 'a site a patch overwrote: its block is no longer clean');
}

// 5. free space in $80+: the editor's and a package's
{
  const rom = new Rom(image.slice());
  check(rom.allocWrite(new Uint8Array(16)) >= 0x900000, 'the editor\'s free space is addressed in $80+');
  const r = applyPatch(rom, { name: 'free', main: 'main.asm', files: new Map([['main.asm', 'lorom\nfreecode\nCode:\n  RTL\n']]) });
  check(r.ok && (r.labels?.Code ?? 0) >= 0x900000, `a package's free code is addressed in $80+ (${hex(r.labels?.Code ?? 0)})`);
}

// 6. the patch on the clean game alone: what it rewrites
{
  const rom = new Rom(clean.slice());
  installFastRom(rom, clean);
  const all = [...JUMP_SITES, ...TABLE_SITES];
  check(all.every((o) => rom.data[o] === (clean[o] | 0x80)), 'on the clean game every site is rewritten');
  check(rom.data.subarray(0, clean.length).every((b, i) => b === clean[i] || all.includes(i) || i === 0x7fd5 || (i >= 0x3a4e && i < 0x3a5a) || (i >= 0x7fea && i < 0x7ff0) || i === 0x7ffc || i === 0x7ffd || i === 0x7fd7), 'and nothing else of the clean game but the header, vectors and stubs');
}

console.log(bad ? `${bad} failed` : 'all ok');
if (bad) process.exitCode = 1;
