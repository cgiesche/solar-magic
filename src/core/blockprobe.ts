// What a Map16 tile does when Mario hits it from below, found out by running the game's own
// code instead of relying on known tile numbers: an empty test level is loaded once, then for
// each probe the tile is poked into the level map above Mario, who jumps against it (once small,
// once big). Some blocks give different items depending on their column within the screen
// (vanilla: a table indexed by tile X & 15), so a tile with an effect is hit in all 16 columns.
// Spawned sprites, coins, lives, damage and the tile left behind make up the result, so hacked
// ROMs and custom blocks are described correctly as well.
// Sprites (flying ? blocks and the like) are probed the same way: the sprite is spawned through
// the game's own table setup, Mario jumps against it from below and onto it from above, and a run
// without Mario is subtracted. Many sprites start differently depending on their position (vanilla:
// the Super Koopa 73 drops a feather only at even X, flying ? blocks give items by X & 3), so the
// sprite is first spawned at all 16 X and Y positions within a 16 px step, and every position whose
// sprite tables differ after the init makes an own variant that is probed (and drawn) by itself.
// Whether a tile can be entered (pipes, doors) is found out the same way: Mario stands on, below,
// beside or in front of it and holds a direction; entering shows as a change of his animation
// state or the game mode that a run without the button doesn't show.
// Some tiles behave differently per tileset (vanilla: the boss door tile 9C can only be entered in
// castle tilesets), so the probe level gets the tileset of the edited level and results are kept
// per tileset.
// Results are kept in a ResultCache (see romdeps.ts) with the ROM pages they read, including those
// read by booting and by preparing the probe level, so they survive ROM changes elsewhere.

import { LevelEmulator, MAP_BASE } from './levelemu.ts';
import { Rom } from './rom.ts';
import type { SnesState } from './snes.ts';
import { ResultCache, RomFingerprint, type RomDeps, type RomReads } from './romdeps.ts';
import { spriteName, hex3 } from './names.ts';

const PROBE_LEVEL = 0x105; // horizontal level, loaded with PROBE_HEADER, without objects and sprites
const PROBE_HEADER = [0x33, 0x40, 0x08, 0x80, 0x27]; // primary header; the tileset is replaced
const PROBE_FRAMES = 24;
const SPRITE_SLOT = 11; // slot of a probed sprite (items it spawns take lower free slots)
// sprite tables compared between positions (everything but position, subpixel and off-screen flags)
const SPRITE_TABLES = [0x9e, 0xaa, 0xb6, 0xc2, 0x14c8, 0x1504, 0x1510, 0x151c, 0x1528, 0x1534, 0x1540, 0x154c, 0x1558, 0x1564,
  0x1570, 0x157c, 0x1594, 0x15ac, 0x15c4, 0x15d0, 0x15dc, 0x15f6, 0x1602, 0x160e, 0x1626, 0x1632, 0x163e, 0x164a, 0x1656,
  0x1662, 0x166e, 0x167a, 0x1686, 0x187b, 0x190f, 0x1fd6, 0x1fe2];
const SPRITE_ROW = 6; // probed sprites go to rows 6-21 (Mario fits below them, the level has $1B rows)
const PROBE_CAM_Y_MAX = 0x1b * 16 - 224;
const MAX_VARIANTS = 16; // more X × Y combinations: Y is ignored
const ENTER_FRAMES = 24;
// joypad bits ($4218) and Mario's offset to the tile for each enter direction
const PAD = { up: 0x0800, down: 0x0400, left: 0x0200, right: 0x0100 };
const ENTER_DX = [-8, -4, 0, 4, 8]; // pipes only let Mario in within a few pixels of their middle

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
  stomp?: HitResult; // sprites: small Mario jumping onto it
  summary: string | null; // null: no effect when hit from below (sprites: or jumped on)
}

export interface ColumnProbe {
  pos: PosProbe[]; // by tile column X & 15 (the same object 16 times when there is no effect)
  summary: string | null; // all positions; null: no effect when hit from below
  solid: boolean;
}

export interface BlockProbe extends ColumnProbe {
  tile: number;
  enter: string; // directions to hold to enter it (pipes, doors) as arrows ↓↑←→, '' = none
}
// positions (low nibbles of the tile X and Y) a sprite behaves differently at
export interface SpriteVariants {
  xs: number[]; // X class by X & 15
  ys: number[]; // Y class by Y & 15
  nx: number; // number of X classes
  reps: { x: number; y: number }[]; // a position for each variant (xs class + nx * ys class)
}
export interface SpriteProbe {
  num: number;
  variants: SpriteVariants;
  pos: PosProbe[]; // by variant
  summary: string | null; // all variants; null: no effect
  solid: boolean;
}

export function variantOf(v: SpriteVariants, x: number, y: number): number {
  return v.xs[x & 15] + v.nx * v.ys[y & 15];
}

// result for a sprite at tile (x, y)
export function spriteProbeAt(p: SpriteProbe, x: number, y: number): PosProbe {
  return p.pos[variantOf(p.variants, x, y)];
}

// result for a block or sprite at tile column x
export function probeAt(p: ColumnProbe, x: number): PosProbe {
  return p.pos[x & 15];
}

// sprites spawned, small Mario's first
export function spritesOf(r: PosProbe): number[] {
  return [...new Set([...r.small.sprites, ...r.big.sprites, ...r.stomp?.sprites ?? []])];
}

// probe level state of one tileset
interface TilesetProbes {
  ready: SnesState | null;
  reads: RomReads | null; // ROM read by booting, preparing the level and searching the floor
  deps: RomDeps | null; // of marks, to notice when ready is outdated
  by: number; // block row in the probe level; the block goes to screen 1, column 0-15
  floorTile: number; // a tile Mario can stand on (found by trying), -1 = not searched yet, -2 = none found
}

export class BlockProber {
  rom: Rom;
  emu: LevelEmulator;
  tileset = 0; // tileset the probes run in (use())
  results: ResultCache;
  private sets = new Map<number, TilesetProbes>();
  private cur!: TilesetProbes;

  // boot: title screen snapshot of another emulator on the same ROM and the pages read to get
  // there (saves booting again); results: where probe results are kept
  constructor(rom: Rom, boot?: { state: SnesState | null; reads: RomReads | null }, results?: ResultCache) {
    this.rom = rom;
    this.emu = new LevelEmulator(rom);
    if (boot?.state) { this.emu.baseState = boot.state; this.emu.bootReads = boot.reads; }
    this.results = results ?? new ResultCache(new RomFingerprint(this.emu));
    this.use(0);
  }

  // probe (and look up cached results) in tileset ts from now on
  use(ts: number): void {
    let t = this.sets.get(ts);
    if (!t) this.sets.set(ts, (t = { ready: null, reads: null, deps: null, by: 0, floorTile: -1 }));
    this.tileset = ts;
    this.cur = t;
  }

  // the ROM changed (patches, acts-like, blocks): probe levels that read changed pages are prepared
  // again; results are checked when used
  reset(): void {
    this.emu.syncRom();
    for (const t of this.sets.values()) {
      if (t.deps && !this.results.fp.valid(t.deps)) Object.assign(t, { ready: null, reads: null, deps: null, by: 0, floorTile: -1 });
    }
  }

  private get by(): number { return this.cur.by; }

  // runs a probe with the pages read counted from the probe level's; stores the result under key
  private computed<T>(key: string, fn: () => T): T {
    if (!this.cur.ready) this.prepare();
    const { result, reads } = this.emu.tracked(fn, this.cur.reads);
    this.results.set(key, result, this.results.fp.deps(reads));
    return result;
  }

  cached(tile: number): BlockProbe | undefined {
    return this.results.get(`b${this.tileset}:${tile}`);
  }

  probe(tile: number): BlockProbe {
    return this.cached(tile) ?? this.computed(`b${this.tileset}:${tile}`, () => {
      const c = columns((col, big) => this.hit(tile, big, col), tile);
      return { tile, ...c, enter: this.enterDirs(tile, c.solid) };
    });
  }

  cachedSprite(num: number): SpriteProbe | undefined {
    return this.results.get(`s${this.tileset}:${num}`);
  }

  probeSprite(num: number): SpriteProbe {
    return this.cachedSprite(num) ?? this.computed(`s${this.tileset}:${num}`, (): SpriteProbe => {
      const variants = this.spriteVariants(num);
      const pos = variants.reps.map(({ x, y }): PosProbe => {
        const base0 = this.hitSprite(num, 0, x, y, 'none');
        const small = this.spriteEffect(num, 0, x, y, 'below', base0), big = this.spriteEffect(num, 1, x, y, 'below');
        const stomp = this.spriteEffect(num, 0, x, y, 'stomp', base0);
        return { small, big, stomp, summary: summarizeSprite(small, big, stomp) };
      });
      return { num, variants, pos, summary: byVariant(variants, pos), solid: pos.some((q) => q.small.solid || q.big.solid) };
    });
  }

  // Positions within a 16 px step whose sprite tables differ after the init (X at a fixed Y, Y at
  // a fixed X; combined when there are not too many)
  private spriteVariants(num: number): SpriteVariants {
    const state = (x: number, y: number) => {
      const w = this.spawn(num, 0, x, y);
      this.placeMario(w[0xe4 + SPRITE_SLOT] + (w[0x14e0 + SPRITE_SLOT] << 8) - 64, w[0xd8 + SPRITE_SLOT] | (w[0x14d4 + SPRITE_SLOT] << 8), 0, 0);
      try { for (let f = 0; f < 2; f++) this.emu.snes.runFrame(); } catch { return 'x'; }
      return SPRITE_TABLES.map((t) => w[t + SPRITE_SLOT]).join(',');
    };
    const classes = (a: string[]) => { const u = [...new Set(a)]; return { c: a.map((v) => u.indexOf(v)), n: u.length }; };
    const cx = classes(Array.from({ length: 16 }, (_, x) => state(x, 0)));
    let cy = classes(Array.from({ length: 16 }, (_, y) => state(0, y)));
    if (cx.n * cy.n > MAX_VARIANTS) cy = { c: new Array(16).fill(0), n: 1 };
    const reps: { x: number; y: number }[] = [];
    for (let j = 0; j < cy.n; j++) for (let i = 0; i < cx.n; i++) reps.push({ x: cx.c.indexOf(i), y: cy.c.indexOf(j) });
    return { xs: cx.c, ys: cy.c, nx: cx.n, reps };
  }

  // what jumping against / onto the sprite adds to what it does without Mario
  private spriteEffect(num: number, big: number, x: number, y: number, how: 'below' | 'stomp', base = this.hitSprite(num, big, x, y, 'none')): HitResult {
    const r = this.hitSprite(num, big, x, y, how);
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
    const { reads } = this.emu.tracked(() => this.prepareLevel());
    Object.assign(this.cur, { reads, deps: this.results.fp.deps(reads) });
  }

  private prepareLevel(): void {
    const e = this.emu;
    e.syncRom();
    // a fixed header (vanilla level 105's): the probes don't depend on the level's saved state
    const header = Uint8Array.from([...PROBE_HEADER, 0]);
    header[4] = (header[4] & 0xf0) | this.tileset;
    header[5] = 0xff; // no objects
    e.load(PROBE_LEVEL, { layer1: header, sprites: new Uint8Array([0, 0xff]) });
    const s = e.snes, w = s.wram;
    let g = 0;
    while (w[0x100] !== 0x14 && g++ < 200) s.runFrame();
    for (let i = 0; i < 4; i++) s.runFrame();
    const camY = w[0x1c] | (w[0x1d] << 8);
    this.cur.by = Math.min(0x18, (camY >> 4) + 6);
    this.cur.ready = s.saveState();
  }

  // fresh probe state with the camera centered on tile column bx (so nothing spawns off-screen);
  // with by also on that row
  private start(bx: number, big: number, by = -1): Uint8Array {
    if (!this.cur.ready) this.prepare();
    const s = this.emu.snes, w = s.wram;
    s.loadState(this.cur.ready!);
    const cam = bx * 16 - 0x70;
    w[0x1a] = w[0x1462] = cam & 0xff; w[0x1b] = w[0x1463] = cam >> 8;
    if (by >= 0) {
      const cy = Math.max(0, Math.min(PROBE_CAM_Y_MAX, by * 16 - 0x70));
      w[0x1c] = w[0x1464] = cy & 0xff; w[0x1d] = w[0x1465] = cy >> 8;
    }
    w[0x19] = big;
    return w;
  }

  // fresh state with sprite num in the probe slot at tile X & 15 = x, Y & 15 = y (rows chosen so
  // that Mario fits below it inside the level)
  private spawn(num: number, big: number, x: number, y: number): Uint8Array {
    const bx = 16 + x, by = SPRITE_ROW + ((y - SPRITE_ROW) & 15);
    const w = this.start(bx, big, by);
    this.emu.spawnSprite(SPRITE_SLOT, num, bx * 16, by * 16);
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

  private put(x: number, y: number, tile: number): void {
    const w = this.emu.snes.wram, off = MAP_BASE + (x >> 4) * 0x1b0 + y * 16 + (x & 15);
    w[off] = tile & 0xff;
    w[off + 0x10000] = tile >> 8;
  }

  // runs frames holding pad; true when Mario's animation state ($71) or the game mode changed
  private runHeld(pad: number, frames: number): boolean {
    const s = this.emu.snes, w = s.wram;
    let hit = false;
    try {
      for (let f = 0; f < frames && !hit; f++) {
        s.joy1 = pad;
        s.runFrame();
        hit = w[0x71] !== 0 || w[0x100] !== 0x14;
      }
    } catch { /* counts as nothing */ }
    s.joy1 = 0;
    return hit;
  }

  // setup() places tile and Mario; entered when holding pad changes something that waiting doesn't
  private enters(setup: () => void, pad: number, frames = ENTER_FRAMES): boolean {
    setup();
    if (!this.runHeld(pad, frames)) return false;
    setup();
    return !this.runHeld(0, frames);
  }

  // Directions to hold to enter the tile: standing on it (↓), jumping against it from below (↑),
  // walking against it on a floor made of itself (← →); tiles Mario can pass: standing in front
  // of it on a solid floor (↑, doors).
  private enterDirs(tile: number, solid: boolean): string {
    const bx = 16, by = () => this.by;
    const at = (dx: number, dy: number, vy: number, floor = -1) => () => {
      this.start(bx, 0);
      if (floor >= 0) for (let x = bx - 4; x <= bx + 4; x++) this.put(x, by() + 1, floor);
      this.put(bx, by(), tile);
      this.placeMario(bx * 16 + dx, by() * 16, dy, vy);
    };
    let out = '';
    if (solid) {
      if (ENTER_DX.some((dx) => this.enters(at(dx, -40, 0), PAD.down))) out += '↓';
      if (ENTER_DX.some((dx) => this.enters(at(dx, 20, -0x40), PAD.up))) out += '↑';
      if (this.enters(at(20, -16, 0, tile), PAD.left)) out += '←';
      if (this.enters(at(-20, -16, 0, tile), PAD.right)) out += '→';
    } else {
      const floor = this.floor();
      if (floor >= 0 && this.enters(at(0, -16, 0, floor), PAD.up, ENTER_FRAMES + 8)) out += '↑';
    }
    return out;
  }

  // the first tile a dropped Mario comes to rest on without anything happening
  private floor(): number {
    const c = this.cur;
    if (c.floorTile !== -1) return c.floorTile;
    // later probes use the result: its pages count for the probe level
    const { reads } = this.emu.tracked(() => this.findFloor(), null);
    if (c.reads) {
      c.reads.add(reads);
      c.deps = this.results.fp.deps(c.reads);
    }
    return c.floorTile;
  }

  private findFloor(): void {
    const c = this.cur;
    c.floorTile = -2;
    for (let i = 0; i < 0x200; i++) {
      const t = (i + 0x100) & 0x1ff, bx = 16;
      const w = this.start(bx, 0);
      for (let x = bx - 4; x <= bx + 4; x++) this.put(x, this.by, t);
      this.placeMario(bx * 16, this.by * 16, -40, 0); // feet 8 px above
      if (this.runHeld(0, 16)) continue;
      const off = MAP_BASE + (bx >> 4) * 0x1b0 + this.by * 16 + (bx & 15);
      if ((w[0x77] & 4) && w[0x19] === 0 && (w[off] | (w[off + 0x10000] << 8)) === t) { c.floorTile = t; break; }
    }
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

  // Sprite num spawned at tile X & 15 = x, Y & 15 = y, then Mario jumps against it from below or
  // falls onto it from above; 'none': he stays below it (baseline).
  private hitSprite(num: number, big: number, x: number, y: number, how: 'none' | 'below' | 'stomp'): HitResult {
    const w = this.spawn(num, big, x, y), s = this.emu.snes, slot = SPRITE_SLOT;
    const px = w[0xe4 + slot] | (w[0x14e0 + slot] << 8), py = w[0xd8 + slot] | (w[0x14d4 + slot] << 8);
    this.placeMario(px, py, 64, 0);
    try { for (let f = 0; f < 2; f++) s.runFrame(); } catch { /* observed below */ }
    // the sprite may move sideways: aim at where it is a few frames later
    const sx = w[0xe4 + slot] | (w[0x14e0 + slot] << 8), sy = w[0xd8 + slot] | (w[0x14d4 + slot] << 8);
    const vx = (w[0xb6 + slot] << 24) >> 24;
    const ax = sx + Math.round((vx / 16) * (how === 'stomp' ? 6 : 4));
    if (how === 'below') this.placeMario(ax, sy, 24, -0x60);
    else if (how === 'stomp') this.placeMario(ax, sy, -28, 0x30);
    else this.placeMario(ax, sy, 64, 0);
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

function summarizeSprite(small: HitResult, big: HitResult, stomp: HitResult): string | null {
  const below = summarize(-1, small, big), on = describe(-1, stomp);
  const p = [below && `von unten: ${below}`, on && `draufspringen: ${on}`].filter(Boolean);
  return p.length ? p.join(' · ') : null;
}

// one text for all variants, grouped by the positions they apply to ("X gerade: …")
function byVariant(v: SpriteVariants, pos: PosProbe[]): string | null {
  if (pos.every((q) => q.summary === pos[0].summary)) return pos[0].summary;
  const groups = new Map<string, number[]>();
  pos.forEach((q, i) => { const k = q.summary ?? '–'; groups.set(k, [...(groups.get(k) ?? []), i]); });
  const where = (l: number[]) => {
    const xs = new Set(l.map((i) => i % v.nx)), ys = new Set(l.map((i) => Math.floor(i / v.nx)));
    const ny = v.reps.length / v.nx;
    const p: string[] = [];
    if (xs.size < v.nx) p.push(residues('X', v.xs.flatMap((c, i) => (xs.has(c) ? [i] : []))));
    if (ys.size < ny) p.push(residues('Y', v.ys.flatMap((c, i) => (ys.has(c) ? [i] : []))));
    return p.join(', ');
  };
  return 'je nach Position: ' + [...groups].map(([k, l]) => `${where(l)}: ${k}`).join(' | ');
}

// set of tile position low nibbles as the fewest low bits that tell it ("X gerade", "X & 3: 1,2",
// "Y & F ≠ F")
function residues(axis: string, l: number[]): string {
  for (const m of [1, 3, 7, 15]) {
    const s = new Set(l.map((r) => r & m));
    if (l.length !== s.size * (16 / (m + 1))) continue;
    if (m === 1) return `${axis} ${s.has(0) ? 'gerade' : 'ungerade'}`;
    const all = Array.from({ length: m + 1 }, (_, i) => i), not = all.filter((r) => !s.has(r));
    return not.length < s.size ? `${axis} & ${hex1(m)} ≠ ${not.map(hex1).join(',')}` : `${axis} & ${hex1(m)}: ${[...s].sort((a, b) => a - b).map(hex1).join(',')}`;
  }
  return '';
}

function summarize(tile: number, small: HitResult, big: HitResult): string | null {
  const a = describe(tile, small), b = describe(tile, big);
  if (!a && !b) return null;
  if (a === b) return a;
  return `klein: ${a || '–'} · groß: ${b || '–'}`;
}

// one line for tooltips and the status bar; with x: the result at that tile column
export function probeText(p: ColumnProbe | BlockProbe, x?: number): string {
  const s = x === undefined ? p.summary : probeAt(p, x).summary;
  return (s ?? (p.solid ? 'von unten: fest, ohne Effekt' : 'von unten: durchlässig')) + enterSuffix(p);
}

export function enterText(enter: string): string {
  return enter ? `betretbar (${enter})` : '';
}

// ", betretbar (↓)" for tiles that can be entered, '' otherwise
export function enterSuffix(p: ColumnProbe | BlockProbe): string {
  return 'enter' in p && p.enter ? ', ' + enterText(p.enter) : '';
}
