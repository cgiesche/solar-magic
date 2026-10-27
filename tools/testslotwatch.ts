// Test play's slot meter (src/core/slotwatch.ts): live slots of the sprite tables, and a slot search that
// found every slot it looked at taken – a sprite that failed to spawn. Learned from what the code does, not
// from the game's tables: small programs run on a bare machine (searches as the game and PIXI write them,
// and loops over the slots that are no search), then the game itself – a sprite memory with few slots and a
// row of sprites, and vanilla levels played without false alarms.
// node tools/testslotwatch.ts
import { readFileSync } from 'node:fs';
import { Snes } from '../src/core/snes.ts';
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { levelTranslevel } from '../src/core/level.ts';
import { RAM, SPR, marioX } from '../src/core/ram.ts';
import { SlotWatch, SLOT_TABLES, type SlotKind, type SlotFailure } from '../src/core/slotwatch.ts';
import { PlayLog } from '../src/core/playlog.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };

// ---------- small programs on a bare machine ----------
// code at $008000 (native mode, 8-bit registers), the tables filled before; NMI handler at $00C000 (writes
// RAM, as the game's does); runs until STP
const NATIVE = [0x18, 0xfb, 0xe2, 0x30]; // CLC, XCE, SEP #$30
function run(code: number[], fill: (w: Uint8Array) => void, nmiAfter = -1): { failed: string[]; replaced: boolean[]; watch: SlotWatch } {
  const rom = new Uint8Array(0x8000);
  rom.set([...NATIVE, ...code, 0xdb]);
  rom.set([0x8d, 0x00, 0x10, 0x9c, 0x01, 0x10, 0xad, 0x00, 0x10, 0x40], 0x4000); // STA $1000, STZ $1001, LDA $1000, RTI
  rom[0x7ffc] = 0x00; rom[0x7ffd] = 0x80; // reset
  rom[0x7fea] = 0x00; rom[0x7feb] = 0xc0; // native NMI
  const s = new Snes(rom);
  s.reset();
  fill(s.wram);
  const watch = new SlotWatch(s);
  s.hook = watch.hook;
  for (let i = 0; i < 10000 && !s.cpu.stopped; i++) {
    if (i === nmiAfter) s.cpu.nmiPending = true;
    s.cpu.step();
  }
  const f = watch.take();
  return { failed: f.map((x) => x.kind), replaced: f.map((x) => x.replaced), watch };
}
const full = (kind: SlotKind, except = -1) => (w: Uint8Array) => {
  const t = SLOT_TABLES[kind];
  for (let i = 0; i < t.slots; i++) if (i !== except) w[t.base + i] = 8;
};
const lo = (a: number) => a & 0xff, hi = (a: number) => a >> 8;
const N = SLOT_TABLES.sprite.base, E = SLOT_TABLES.extended.base, C = SLOT_TABLES.cluster.base;
// PIXI's: LDX #n-1 / - LDA table,x / BEQ found / DEX / BPL - / (none) STZ $00 / found:
const pixi = (base: number, n: number) => [0xa2, n - 1, 0xbd, lo(base), hi(base), 0xf0, 0x05, 0xca, 0x10, 0xf8, 0x64, 0x00];
{
  check(run(pixi(N, 12), full('sprite')).failed.join() === 'sprite', 'a search through all sprite slots, all taken: failed');
  check(run(pixi(N, 12), full('sprite', 3)).failed.length === 0, 'slot 3 free: the search finds it');
  check(run(pixi(E, 10), full('extended')).failed.join() === 'extended', 'extended sprites, all taken: failed');
  check(run(pixi(C, 20), full('cluster')).failed.join() === 'cluster', 'cluster sprites, all taken: failed');
  check(run(pixi(E, 10), full('extended')).replaced.join() === 'false', 'nothing written after it: did not spawn');
  // as the game's extended sprites do: none free, then the slot of a rotating index taken anyway (DEC $18FC /
  // BPL + / LDA #$07 / STA $18FC / + LDY $18FC / LDA #$04 / STA $170B,y)
  const take = [0xce, 0xfc, 0x18, 0x10, 0x05, 0xa9, 0x07, 0x8d, 0xfc, 0x18, 0xac, 0xfc, 0x18, 0xa9, 0x04, 0x99, lo(E), hi(E)];
  check(run([...pixi(E, 8).slice(0, 10), ...take].map((b, i) => (i === 6 ? 0x15 : b)), full('extended')).replaced.join() === 'true',
    'none free, then one taken anyway: another sprite replaced');
  // the game's level sprite loader: down to a bound in scratch RAM (LDA #$FF / STA $06 / LDX #9 / - LDA $14C8,x /
  // BEQ / DEX / CPX $06 / BNE - / LDX $02 / STZ $1938,x)
  const loader = [0xa9, 0xff, 0x85, 0x06, 0xa2, 0x09, 0xbd, lo(N), hi(N), 0xf0, 0x0a, 0xca, 0xe4, 0x06, 0xd0, 0xf6, 0xa6, 0x02, 0x9e, 0x38, 0x19];
  check(run(loader, full('sprite')).failed.join() === 'sprite', 'the game\'s level sprite loader (bound in scratch RAM), slots 9–0 taken: failed');
  check(run(loader, full('sprite', 0)).failed.length === 0, 'its last slot free: found');
  // the same search, the NMI coming in the middle of it
  check(run(pixi(N, 12), full('sprite'), 10).failed.join() === 'sprite', 'an NMI in the middle of a failing search: one failure');
  check(run(pixi(N, 12), full('sprite', 0), 10).failed.length === 0, 'an NMI in the middle of a search that finds slot 0: none');
  // a search of a few reserved slots (Mario's fireballs: extended slots 9 and 8) is no shortage of the table
  check(run([0xa2, 0x09, 0xbd, lo(E), hi(E), 0xf0, 0x07, 0xca, 0xe0, 0x07, 0xd0, 0xf6, 0x64, 0x00], full('extended')).failed.length === 0,
    'a search of two reserved slots, both taken: not counted');
  // no searches: finding a sprite by number (LDA $14C8,x / BEQ next / LDA $9E,x / CMP #$35 / BEQ found / next: DEX / BPL)
  // and the sprite interaction loop (LDA $14C8,x / CMP #$08 / BCC next ...)
  check(run([0xa2, 0x0b, 0xbd, lo(N), hi(N), 0xf0, 0x06, 0xb5, 0x9e, 0xc9, 0x35, 0xf0, 0x05, 0xca, 0x10, 0xf2, 0x64, 0x00], full('sprite')).failed.length === 0,
    'a loop finding a sprite by its number: no search');
  check(run([0xa2, 0x0b, 0xbd, lo(N), hi(N), 0xc9, 0x08, 0x90, 0x00, 0xca, 0x10, 0xf6, 0x64, 0x00], (w) => w.fill(2, N, N + 12)).failed.length === 0,
    'a loop comparing each status (interaction): no search');
  const r = run([], (w) => { full('sprite')(w); w[N + 5] = 0; w[E + 1] = 3; });
  check(r.watch.used('sprite') === 11 && r.watch.used('extended') === 1 && r.watch.used('cluster') === 0, 'live slots counted: 11 sprites, 1 extended, 0 cluster');
}

// ---------- the game ----------
const rom = new Rom(new Uint8Array(readFileSync('test/fixtures/smw.smc')));
const emu = new LevelEmulator(rom);
emu.boot();
// k frames walking right (running, jumping every 40 frames, Y pressed every few); the failures and Mario's X then
function play(k: number, fire = false): { failed: (SlotFailure & { x: number })[] } {
  const s = emu.snes, watch = new SlotWatch(s);
  s.hook = watch.hook;
  const failed: (SlotFailure & { x: number })[] = [];
  try {
    for (let f = 0; f < k; f++) {
      if (fire) s.wram[RAM.powerup] = 3;
      s.joy1 = 0x0100 | (f % 6 < 3 ? 0x4000 : 0) | (f % 40 < 10 ? 0x8000 : 0);
      s.runFrame();
      for (const f of watch.take()) failed.push({ ...f, x: marioX(s.wram) });
    }
  } finally { s.hook = null; }
  return { failed };
}
{
  // level 105 with sprite memory 0B (level sprites in slots 4–0) and eight Koopas in one column ahead
  const col = 0x30, sprites = [0x0b];
  for (let ty = 0x10; ty < 0x18; ty++) sprites.push(((ty & 15) << 4) | ((ty >> 4) & 1), ((col & 15) << 4) | (col >> 4), 0x04);
  sprites.push(0xff);
  emu.load(0x105, { sprites: new Uint8Array(sprites) });
  const { failed } = play(400);
  const live = Array.from({ length: 12 }, (_, i) => emu.snes.wram[SPR.status + i]).filter(Boolean).length;
  check(failed.some((f) => f.kind === 'sprite'), `eight Koopas in one column with sprite memory 0B: a failed spawn (${failed.length}; ${live} live)`);
  const x = failed.find((f) => f.kind === 'sprite')?.x ?? 0;
  check(x > (col - 20) * 16 && x < col * 16, `failed while Mario came near the column (X ${x.toString(16)})`);
}
const playLevel = (lv: number) => {
  const tl = levelTranslevel(rom, lv);
  emu.startGame(tl);
  emu.loadInGame(lv, tl);
  return play(1500, true).failed;
};
for (const lv of [0x105, 0x106, 0x103, 0x104, 0x10b, 0x101, 0x102, 0x1, 0x5, 0x15, 0x11f]) {
  const failed = playLevel(lv);
  check(failed.length === 0, `level ${lv.toString(16)} played as fire Mario: no failed spawn${failed.length ? ` (${failed.map((f) => f.kind).join(', ')})` : ''}`);
}
{
  // its dolphin generator spawns into slots 4–0 only: with five dolphins there, the next one doesn't come
  const failed = playLevel(0x2);
  check(failed.length > 0 && failed.every((f) => f.kind === 'sprite' && f.searched === 5 && f.free === 7),
    `level 2: the dolphin generator's 5 slots taken, 7 free elsewhere (${failed.map((f) => `${f.searched}/${f.free}`).join(', ')})`);
}

// ---------- the log: live slots per frame, failures as events with Mario's position ----------
{
  const log = new PlayLog(4);
  const used = { sprite: 3, extended: 0, cluster: 0 };
  log.frame(1, used, [], 0, 0x100, 0x150);
  const fail = (kind: SlotKind): SlotFailure => ({ kind, searched: 10, free: 2, replaced: false });
  log.frame(2, used, [fail('sprite')], 0, 0x120, 0x150);
  log.frame(3, used, [fail('sprite')], 0, 0x130, 0x150);
  log.frame(100, used, [fail('sprite'), fail('extended')], 0, 0x400, 0x80);
  log.frame(101, used, [], 0, 0x400, 0x80);
  check(log.events.length === 3 && log.events[0].frame === 2 && log.events[0].count === 2 && log.events[0].tx === 0x12 && log.events[0].ty === 0x16 && log.events[0].searched === 10,
    'failures of a kind close together are one event (first frame, count, Mario\'s tile)');
  check(log.events[1].kind === 'sprite' && log.events[1].frame === 100 && log.events[2].kind === 'extended', 'later ones and other kinds are events of their own');
  check(log.history.length === 4 && log.history[3].frame === 101 && log.history[0].frame === 2, 'the history keeps the last frames');
  log.cut();
  log.frame(102, used, [fail('sprite')], 0, 0x400, 0x80);
  check(log.events.length === 4 && log.events[3].frame === 102, 'after a savestate is loaded: a failure is an event of its own');
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('all ok');
