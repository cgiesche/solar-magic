// Test play's savestate (Snes.saveState / loadState with the sound unit and a PPU attached): a round trip
// gives back the exact emulated frame – memory, registers, scroll, color math, the sound unit and what
// is on screen – and the emulation goes on from it exactly as from the moment of saving. The slot (savestate.ts)
// is kept for the same level on the same, unchanged ROM only.
// node tools/testsavestate.ts
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { levelTranslevel } from '../src/core/level.ts';
import { PPU } from '../src/core/ppu.ts';
import { Apu, loadApu } from '../src/core/apu.ts';
import { SaveSlot } from '../src/core/savestate.ts';
import type { Snes } from '../src/core/snes.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.prototype.every.call(a, (v: number, i: number) => v === b[i]);

// right, with a jump every 40 frames
const input = (f: number) => 0x0100 | (f % 40 < 10 ? 0x8000 : 0);
// k frames of input; WRAM after them and the sound they made
function play(s: Snes, k: number): { wram: Uint8Array; audio: Int16Array } {
  const out: number[] = [];
  for (let f = 0; f < k; f++) {
    s.joy1 = input(f);
    s.runFrame();
    if (s.audio) for (const v of s.audio) out.push(v);
  }
  s.joy1 = 0;
  return { wram: s.wram.slice(), audio: Int16Array.from(out) };
}

await loadApu();
const rom = new Rom(new Uint8Array(readFileSync('test/fixtures/smw.smc')));
{
  const emu = new LevelEmulator(rom);
  emu.snes.apu = new Apu();
  emu.boot();
  const tl = levelTranslevel(rom, 0x105);
  emu.startGame(tl);
  const r = emu.loadInGame(0x105, tl);
  const s = emu.snes, ppu = new PPU(s);
  s.ppu = ppu;
  play(s, 60);

  const at = {
    wram: s.wram.slice(), vram: s.vram.slice(), cgram: s.cgram.slice(), oam: s.oam.slice(), frame: ppu.frame.slice(), apu: s.apu!.save(),
    cpu: { a: s.cpu.a, x: s.cpu.x, y: s.cpu.y, s: s.cpu.s, d: s.cpu.d, dbr: s.cpu.dbr, pbr: s.cpu.pbr, pc: s.cpu.pc, p: s.cpu.p, e: s.cpu.e },
    fixedColor: s.fixedColor, hofs: [...ppu.hofs], vofs: [...ppu.vofs], latch: ppu.latch, hlatch: ppu.hlatch, busy: s.busyLines,
  };
  const st = s.saveState();
  // what the frames right after the save do (the input changes the game's state as well)
  const first = play(s, 240);
  check(!same(s.wram, at.wram) && !same(ppu.frame, at.frame), 'the game ran on after saving (WRAM, frame changed)');
  // changed by hand too: a round trip must set them back whatever they are
  s.fixedColor ^= 0x1234; ppu.hofs[0] ^= 0x55; ppu.vofs[1] ^= 0x33; ppu.latch ^= 0xff; ppu.hlatch ^= 0x0f;
  s.loadState(st);
  check(r.ok, 'level 105 loaded in a game in progress');
  check(same(s.wram, at.wram) && same(s.vram, at.vram) && same(s.cgram, at.cgram) && same(s.oam, at.oam), 'loaded: WRAM, VRAM, CGRAM, OAM as at the save');
  check(Object.entries(at.cpu).every(([k, v]) => (s.cpu as unknown as Record<string, unknown>)[k] === v), 'loaded: the CPU registers as at the save');
  check(same(s.apu!.save(), at.apu), 'loaded: the sound unit\'s state as at the save');
  check(same(ppu.frame, at.frame), 'loaded: the frame on screen as at the save');
  check(s.fixedColor === at.fixedColor && same(ppu.hofs, at.hofs) && same(ppu.vofs, at.vofs) && ppu.latch === at.latch && ppu.hlatch === at.hlatch && s.busyLines === at.busy,
    'loaded: color math fixed color, scroll registers and their latches, CPU load as at the save');

  // determinism: the same frames from the loaded state as right after the save
  const again = play(s, 240);
  check(same(first.wram, again.wram), 'from the loaded state: the same WRAM after 240 frames of the same input');
  check(first.audio.length > 0 && same(first.audio, again.audio), `from the loaded state: the same sound (${first.audio.length} samples)`);

  // without a PPU (the editor's probes): a state saved with one loads, and one saved without one too
  s.ppu = null;
  s.loadState(st);
  const bare = s.saveState();
  play(s, 10);
  s.loadState(bare);
  check(same(s.wram, at.wram), 'without a PPU: saved and loaded');
  s.ppu = ppu;
  s.loadState(bare);
  check(same(s.wram, at.wram), 'a state saved without a PPU loads with one attached');
}

// ---------- the slot: same level, same unchanged ROM ----------
{
  const slot = new SaveSlot();
  const st = { x: 1 };
  check(slot.get(rom, 0x105, false) === null, 'empty slot: nothing to load');
  slot.save(rom, 0x105, st);
  check(slot.get(rom, 0x105, false) === st, 'saved: loads for the same level on the same ROM');
  check(slot.get(rom, 0x106, false) === null && slot.get(rom, 0x105, false) === st, 'another level: not loaded, but kept');
  check(slot.get(rom, 0x105, true) === null && slot.get(rom, 0x105, false) === st, 'the level edited, not yet saved: not loaded');
  const other = new Rom(rom.data.slice());
  check(slot.get(other, 0x105, false) === null, 'another ROM: not loaded');
  slot.save(rom, 0x105, st);
  rom.w8(0x0ffff0, rom.r8(0x0ffff0) ^ 1);
  check(slot.get(rom, 0x105, false) === null, 'the ROM changed after saving: stale');
  rom.w8(0x0ffff0, rom.r8(0x0ffff0) ^ 1);
  check(slot.get(rom, 0x105, false) === null, 'a stale savestate is discarded (not back when the change is undone)');
  slot.save(rom, 0x105, st);
  slot.save(rom, 0x106, { x: 2 });
  check(slot.get(rom, 0x105, false) === null && (slot.get(rom, 0x106, false) as { x: number }).x === 2, 'one slot: saving replaces it');
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('all ok');
