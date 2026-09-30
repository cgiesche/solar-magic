// What a Map16 tile does when Mario hits it from below, found out by running the game's own
// code instead of relying on known tile numbers: an empty test level is loaded once, then for
// each probe the tile is poked into the level map above Mario, who jumps against it (once small,
// once big). Some blocks give different items depending on their column within the screen
// (vanilla: a table indexed by tile X & 15), so a tile with an effect is hit in all 16 columns.
// Spawned sprites, coins, lives, damage and the tile left behind make up the result, so hacked
// ROMs and custom blocks are described correctly as well.
// Sprites (flying ? blocks and the like) are probed the same way: the sprite is spawned through
// the game's own table setup, Mario jumps against it, and a run without the jump is subtracted.

import { LevelEmulator, MAP_BASE, overlaySnes } from './levelemu.ts';
import { Rom } from './rom.ts';
import { L1_PTRS } from './level.ts';
import type { SnesState } from './snes.ts';
import { spriteName, hex3 } from './names.ts';

const PROBE_LEVEL = 0x105; // horizontal level; only its header is used, objects and sprites are removed
const PROBE_FRAMES = 24;
const SPRITE_SLOT = 11; // slot of a probed sprite (items it spawns take lower free slots)
const INIT_TABLES = 0x07f7d2; // game routine that sets up a new sprite's tables (tweakers), X = slot
const OV_STUB = 0xc000; // overlay offset of a JSL stub used to call game routines

export interface HitResult {
  sprites: number[]; // sprite numbers that appeared
  coins: number;
  lives: number;
  hurt: boolean; // lost the powerup or died
  onOff: boolean; // ON/OFF switch state toggled
  after: number; // tile at the block position afterwards (-1 for sprites)
  solid: boolean; // Mario was blocked by it
}

export interface PosProbe {
  small: HitResult;
  big: HitResult;
  summary: string | null; // null: no effect when hit from below
}

export interface ColumnProbe {
  pos: PosProbe[]; // by tile column X & 15 (the same object 16 times when there is no effect)
  summary: string | null; // all positions; null: no effect when hit from below
  solid: boolean;
}

export interface BlockProbe extends ColumnProbe { tile: number }
export interface SpriteProbe extends ColumnProbe { num: number }

// result for a block or sprite at tile column x
export function probeAt(p: ColumnProbe, x: number): PosProbe {
  return p.pos[x & 15];
}

// sprites spawned, small Mario's first
export function spritesOf(r: PosProbe): number[] {
  return [...new Set([...r.small.sprites, ...r.big.sprites])];
}

export class BlockProber {
  rom: Rom;
  emu: LevelEmulator;
  ready: SnesState | null = null;
  by = 0; // block row in the probe level; the block goes to screen 1, column 0-15
  cache = new Map<number, BlockProbe>();
  spriteCache = new Map<number, SpriteProbe>();

  // bootState: title screen snapshot of another emulator on the same ROM (saves booting again)
  constructor(rom: Rom, bootState?: SnesState | null) {
    this.rom = rom;
    this.emu = new LevelEmulator(rom);
    if (bootState) this.emu.baseState = bootState;
  }

  // the ROM changed (patches, acts-like, blocks): drop everything
  reset(): void {
    this.emu.syncRom();
    this.ready = null;
    this.cache.clear();
    this.spriteCache.clear();
  }

  cached(tile: number): BlockProbe | undefined {
    return this.cache.get(tile);
  }

  probe(tile: number): BlockProbe {
    let p = this.cache.get(tile);
    if (!p) {
      p = { tile, ...columns((col, big) => this.hit(tile, big, col), tile) };
      this.cache.set(tile, p);
    }
    return p;
  }

  cachedSprite(num: number): SpriteProbe | undefined {
    return this.spriteCache.get(num);
  }

  probeSprite(num: number): SpriteProbe {
    let p = this.spriteCache.get(num);
    if (!p) {
      p = { num, ...columns((col, big) => this.spriteEffect(num, big, col), -1) };
      this.spriteCache.set(num, p);
    }
    return p;
  }

  // what jumping against the sprite adds to what it does anyway
  private spriteEffect(num: number, big: number, col: number): HitResult {
    const base = this.hitSprite(num, big, col, false), r = this.hitSprite(num, big, col, true);
    return {
      sprites: r.sprites.filter((n) => !base.sprites.includes(n)),
      coins: Math.max(0, r.coins - base.coins),
      lives: Math.max(0, r.lives - base.lives),
      hurt: false, // most sprites hurt when touched; only items count
      onOff: r.onOff && !base.onOff,
      after: -1,
      solid: r.solid,
    };
  }

  // snapshot of the empty probe level running in gameplay
  private prepare(): void {
    const e = this.emu, rom = this.rom;
    e.syncRom();
    const hdr = rom.r24(L1_PTRS + PROBE_LEVEL * 3);
    const header = new Uint8Array(6);
    for (let i = 0; i < 5; i++) header[i] = rom.r8(hdr + i);
    header[5] = 0xff; // no objects
    e.load(PROBE_LEVEL, { layer1: header, sprites: new Uint8Array([0, 0xff]) });
    const s = e.snes, w = s.wram;
    let g = 0;
    while (w[0x100] !== 0x14 && g++ < 200) s.runFrame();
    for (let i = 0; i < 4; i++) s.runFrame();
    const camY = w[0x1c] | (w[0x1d] << 8);
    this.by = Math.min(0x18, (camY >> 4) + 6);
    this.ready = s.saveState();
  }

  // fresh probe state with the camera centered on tile column bx (so nothing spawns off-screen)
  private start(bx: number, big: number): Uint8Array {
    if (!this.ready) this.prepare();
    const s = this.emu.snes, w = s.wram;
    s.loadState(this.ready!);
    const cam = bx * 16 - 0x70;
    w[0x1a] = w[0x1462] = cam & 0xff; w[0x1b] = w[0x1463] = cam >> 8;
    w[0x19] = big;
    return w;
  }

  // Mario dy pixels below pixel position (x, y) with Y speed vy (negative: up), in the air
  private placeMario(x: number, y: number, dy: number, vy: number): void {
    const w = this.emu.snes.wram, my = y + dy;
    w[0x94] = w[0xd1] = x & 0xff; w[0x95] = w[0xd2] = (x >> 8) & 0xff;
    w[0x96] = w[0xd3] = my & 0xff; w[0x97] = w[0xd4] = my >> 8;
    w[0x7b] = 0; w[0x7d] = vy & 0xff; w[0x72] = 0x0b;
  }

  // runs the probe frames; ignore: sprite slot excluded from the observation (the probed sprite)
  private observe(big: number, off: number, ignore = -1): HitResult {
    const s = this.emu.snes, w = s.wram;
    const coins = w[0xdbf], lives = w[0xdbe], onOff = w[0x14af];
    const seen = new Set<number>();
    let solid = false, hurt = false;
    try {
      for (let f = 0; f < PROBE_FRAMES; f++) {
        s.runFrame();
        if (w[0x77] & 8) solid = true;
        if (w[0x71] === 9 || w[0x19] < big) hurt = true;
        for (let i = 0; i < 12; i++) if (i !== ignore && w[0x14c8 + i]) seen.add(w[0x9e + i]);
      }
    } catch { /* keep what was observed */ }
    return {
      sprites: [...seen],
      coins: (w[0xdbf] - coins + 100) % 100,
      lives: (w[0xdbe] - lives) & 0xff,
      hurt,
      onOff: w[0x14af] !== onOff,
      after: off < 0 ? -1 : w[off] | (w[off + 0x10000] << 8),
      solid,
    };
  }

  private hit(tile: number, big: number, col: number): HitResult {
    const bx = 16 + col, by = this.by;
    const w = this.start(bx, big);
    const off = MAP_BASE + (bx >> 4) * 0x1b0 + by * 16 + (bx & 15);
    w[off] = tile & 0xff;
    w[off + 0x10000] = tile >> 8;
    this.placeMario(bx * 16, by * 16, 20, -0x40);
    return this.observe(big, off);
  }

  // runs a game routine (JSL addr, RTL) with X = x in 8-bit mode, then restores the CPU registers
  private call(addr: number, x: number): void {
    const cpu = this.emu.snes.cpu;
    const saved = { a: cpu.a, x: cpu.x, y: cpu.y, s: cpu.s, d: cpu.d, dbr: cpu.dbr, pbr: cpu.pbr, pc: cpu.pc, p: cpu.p, e: cpu.e, waiting: cpu.waiting };
    const stub = overlaySnes(OV_STUB);
    this.emu.overlay.set([0x22, addr & 0xff, (addr >> 8) & 0xff, addr >> 16], OV_STUB);
    cpu.pbr = stub >> 16; cpu.pc = stub & 0xffff;
    cpu.e = false; cpu.p |= 0x30; cpu.d = 0; cpu.x = x; cpu.waiting = false;
    const end = (stub + 4) & 0xffff;
    try {
      for (let n = 0; n < 200000 && !(cpu.pbr === stub >> 16 && cpu.pc === end); n++) cpu.step();
    } finally {
      Object.assign(cpu, saved);
    }
  }

  // Sprite num spawned at tile column 16 + col (init runs like for a sprite from level data), then
  // Mario jumps against it from below; without jump he stays below it (baseline).
  private hitSprite(num: number, big: number, col: number, jump: boolean): HitResult {
    const bx = 16 + col, by = this.by;
    const w = this.start(bx, big), s = this.emu.snes;
    const slot = SPRITE_SLOT, x = bx * 16, y = by * 16;
    w[0x9e + slot] = num;
    w[0x14c8 + slot] = 1; // init
    w[0xe4 + slot] = x & 0xff; w[0x14e0 + slot] = x >> 8;
    w[0xd8 + slot] = y & 0xff; w[0x14d4 + slot] = y >> 8;
    w[0x161a + slot] = 0xff; // not from level data
    this.call(INIT_TABLES, slot);
    this.placeMario(x, y, 64, 0);
    try { for (let f = 0; f < 2; f++) s.runFrame(); } catch { /* observed below */ }
    // the sprite may move sideways: aim at where it is a few frames later
    const sx = w[0xe4 + slot] | (w[0x14e0 + slot] << 8), sy = w[0xd8 + slot] | (w[0x14d4 + slot] << 8);
    const vx = (w[0xb6 + slot] << 24) >> 24;
    const ax = sx + Math.round((vx / 16) * 4);
    if (jump) this.placeMario(ax, sy, 24, -0x60); else this.placeMario(ax, sy, 64, 0);
    return this.observe(big, -1, slot);
  }
}

// hit(col, big) in column 0; the other 15 columns only when column 0 shows an effect
function columns(hit: (col: number, big: number) => HitResult, tile: number): ColumnProbe {
  const at = (col: number): PosProbe => {
    const small = hit(col, 0), big = hit(col, 1);
    return { small, big, summary: summarize(tile, small, big) };
  };
  const p0 = at(0);
  const pos = p0.summary === null ? new Array<PosProbe>(16).fill(p0) : [p0, ...Array.from({ length: 15 }, (_, i) => at(i + 1))];
  return { pos, summary: byColumn(pos), solid: pos.some((q) => q.small.solid || q.big.solid) };
}

function describe(tile: number, r: HitResult): string {
  const p: string[] = r.sprites.map(spriteName);
  if (r.coins) p.push(`+${r.coins} Münze${r.coins > 1 ? 'n' : ''}`);
  if (r.lives) p.push(`+${r.lives} Leben`);
  if (r.onOff) p.push('ON/OFF');
  if (r.hurt) p.push('verletzt');
  if (r.after < 0) return p.join(', '); // sprite
  if (!p.length) return r.after === tile ? '' : `wird zu ${hex3(r.after)}`;
  // a tile that stays after giving something can be hit again (multi-coin blocks and the like)
  if (r.after === tile) p.push('mehrfach');
  else if (r.after !== 0x25) p.push(`danach ${hex3(r.after)}`);
  return p.join(', ');
}

// one text for all columns; runs of equal columns are grouped ("0-3, 8: …")
function byColumn(pos: PosProbe[]): string | null {
  if (pos.every((q) => q.summary === pos[0].summary)) return pos[0].summary;
  const groups = new Map<string, number[]>();
  pos.forEach((q, i) => { const k = q.summary ?? '–'; groups.set(k, [...(groups.get(k) ?? []), i]); });
  const cols = (l: number[]) => {
    const out: string[] = [];
    for (let i = 0; i < l.length; i++) {
      let j = i;
      while (j + 1 < l.length && l[j + 1] === l[j] + 1) j++;
      out.push(j > i ? `${hex1(l[i])}-${hex1(l[j])}` : hex1(l[i]));
      i = j;
    }
    return out.join(',');
  };
  return 'je nach Spalte (X & F): ' + [...groups].map(([k, l]) => `${cols(l)}: ${k}`).join(' | ');
}
const hex1 = (n: number) => n.toString(16).toUpperCase();

function summarize(tile: number, small: HitResult, big: HitResult): string | null {
  const a = describe(tile, small), b = describe(tile, big);
  if (!a && !b) return null;
  if (a === b) return a;
  return `klein: ${a || '–'} · groß: ${b || '–'}`;
}

// one line for tooltips and the status bar; with x: the result at that tile column
export function probeText(p: ColumnProbe, x?: number): string {
  const s = x === undefined ? p.summary : probeAt(p, x).summary;
  return s ?? (p.solid ? 'von unten: fest, ohne Effekt' : 'von unten: durchlässig');
}
