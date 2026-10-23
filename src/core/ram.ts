// The game's RAM as the editor's emulation reads and writes it: the addresses (offsets into
// Snes.wram, i.e. $7E0000 + offset; $10000 and up is bank $7F) of the vanilla layout, by name,
// and accessors for values spread over several bytes. Code that looks into the game's RAM goes
// through here, so another layout replaces this file, not its users: SA-1 Pack (Vitor Vilela)
// moves the direct page and $0100-$1FFF, gives the sprite tables 22 slots elsewhere and puts the
// level data into banks $40/$41.

// game modes ($0100)
export const GM = {
  title: 0x07, // title screen (waits for a button)
  overworldLoad: 0x0b, // fading into the overworld
  overworldReturn: 0x0c, // loading the overworld after a level
  overworld: 0x0e,
  levelLoad: 0x11, // loading a level ("Mario Start!")
  level: 0x14,
} as const;

export const RAM = {
  gameMode: 0x0100,
  frameCounter: 0x14, // advances once per game frame (not in lag frames)
  introLevel: 0x0109, // level the game starts with instead of the overworld (0 = none)

  // camera: layer 1 position (16-bit) and its copy for the next frame, layer 3 position
  layer1X: 0x1a, layer1Y: 0x1c,
  layer1XNext: 0x1462, layer1YNext: 0x1464,
  layer2X: 0x1e, layer2Y: 0x20,
  layer3X: 0x22, layer3Y: 0x24,
  scrollH: 0x1411, scrollV: 0x1412, // the camera follows Mario horizontally / vertically
  scrollUp: 0x1404, // the camera may scroll up (Mario flying, climbing …)
  screenMode: 0x5b, // vertical level / layer 2 interaction bits

  // Mario
  powerup: 0x19,
  marioAnim: 0x71, // animation (9 = dying, 6 = a vertical pipe)
  marioAnimTimer: 0x1496, // how long the animation goes on (dying: until the death music)
  pipeTimer: 0x88, pipeAction: 0x89, // a pipe animation's timer; its kind (below 4: going in, else coming out)
  levelDataPtr: 0x65, spriteDataPtr: 0xce, // 24-bit: the level's layer 1 data and sprite data being loaded
  marioInAir: 0x72,
  marioClimbing: 0x74,
  marioInWater: 0x75,
  marioDir: 0x76, // 0 left, 1 right
  waterLevel: 0x85, // Mario swims everywhere
  slippery: 0x86, // a slippery level (the game's $80)
  marioBlocked: 0x77, // bits: 1 right, 2 left, 4 floor, 8 ceiling
  marioSpeedX: 0x7b, marioSpeedY: 0x7d,
  marioX: 0x94, marioY: 0x96, // 16-bit
  marioXFrame: 0xd1, marioYFrame: 0xd3, // 16-bit, at the start of the frame
  spritesLocked: 0x9d,
  pMeter: 0x13e4,
  hurtTimer: 0x1497, // invulnerable while not 0

  // player status
  lives: 0x0dbe,
  coins: 0x0dbf,
  currentPlayer: 0x0dd6, // 0 Mario, 4 Luigi
  timer: 0x0f31, // 3 digits
  coinsToAdd: 0x13cc,
  livesToAdd: 0x18e4,

  // level
  translevel: 0x13bf,
  onOff: 0x14af,
  blueP: 0x14ad, silverP: 0x14ae, // the P-switches' timers (running while not 0)
  starTimer: 0x1490, // Mario has a star while not 0
  dragonCoins: 0x1420, // Dragon Coins collected in the level
  layer3Tide: 0x1403, // 1 rising and falling, 2 fixed
  layer3Setting: 0x1be3,
  sublevelCount: 0x141a,
  introShown: 0x141d, // the level's no-Yoshi intro has played (the level itself loads next)
  levelFlags: 0x1ea2, // per translevel: bits 0-3 the directions Mario may walk from its tiles (right, left, down, up), 4 save prompt and 5 no entry if passed (Lunar Magic's), 6 the midway point was touched, 7 passed
  midwayTouched: 0x13ce, // the midway tape was touched in this level (dying then marks the translevel's $1EA2 bit 6)
  midwayUsed: 0x13cf, // the level was loaded at its midway point
  midwayScreen: 0x13cd, // the level's midway screen: its tape sets the checkpoint unless it is 0
  entranceAction: 0x192a, // what Mario does when he enters (pipe, door, …)
  levelMusic: 0x0dda, // song of the level; the game doesn't restart it when the next level has the same
  screenExitLo: 0x19b8, screenExitHi: 0x19d8, // per screen
  useSecondaryExit: 0x1b93,
  backdrop: 0x0701, // 16-bit color
  map16Pointers: 0x0fbe, // 16-bit per FG Map16 tile: bank $0D address of its 8x8 tiles
  bgMapLo: 0xb900, bgMapHi: 0xbd00, // layer 2 background tilemap, low and high bytes

  // OAM buffer ($0200-$049F: 128 entries of 4 bytes, then the high table)
  oam: 0x0200, oamEnd: 0x04a0,
  currentSprite: 0x15e9, // slot the sprite code runs for

  // other sprite kinds
  bounceSprites: 0x1699, // 4 slots: number
  scoreSprites: 0x16e1, // number

  // overworld
  owEvents: 0x1f02, // 15 bytes of event bits
  submap: 0x1f11, // per player (2)
  owPlayerX: 0x1f17, owPlayerY: 0x1f19, // 16-bit pixel position, per player 4 bytes apart
  owPlayerTileX: 0x1f1f, owPlayerTileY: 0x1f21, // 16-bit
  owPlayerStride: 4,
  switchPalaces: 0x1f27, // 4
  owLayer1: 0xc800, owLayer1End: 0xd000, // overworld layer 1 tilemap (with events applied)
  owTranslevels: 0xd000, owTranslevelsEnd: 0xd800, // translevel per overworld tile
  owTileFlags: 0xd800, owTileFlagsEnd: 0xe000, // per overworld tile: its translevel's initial flags ($04D678)
  levelExit: 0x0dd5, // how the level was left: 1 the normal exit, 2 the secret exit, $80 the player's turn ends (died)
  levelBeaten: 0x1de9, // set with a passed level (the overworld then runs its event)
  owEvent: 0x1dea, // the event the overworld runs for the level passed (the translevel's base event, $05D608; + 1 for the secret exit)
  owWarp: 0x1b9c, // the overworld loads at the star/pipe table's destination $1DF6 (owteleport.ts)
  owWarpIndex: 0x1df6,
  owTile: 0x13c1, // the layer 1 tile Mario stands on
  savePrompt: 0x13ca, // set when the overworld is to show the save prompt
  fileLevelFlags: 0x1f49, // the save file's copy of levelFlags, filled with the initial flags when a new file is made
  playerIndex: 0x0db3, // 0 Mario, 1 Luigi
  brightness: 0x0dae, mosaicDir: 0x0daf, mosaic: 0x0db0, // the screen's fade (the next game mode's start)
  twoPlayers: 0x0db2, // a 2-player game
  playerLives: 0x0db4, // per player (-1: out)
} as const;

// level data: Map16 tile numbers, low bytes at MAP_BASE, high bytes in bank $7F
export const MAP_BASE = 0xc800;
export const MAP_SIZE = 0x3800;
export const MAP_HI = 0x10000; // from a low byte to its high byte
// the level heights patch's RAM (levelheight.ts, SNES address, bytes): a screen's bytes in the level data
// while a level with a size loads (16-bit, 0: the game's $1B0), the subscreen of the objects that follow,
// then what playing the level needs (the Y high bytes inside the level, …)
export const LEVEL_HEIGHT_RAM: [number, number] = [0x7f3666, 18];
// in it, for the editor's other code: a position's limit and row bits when a tile is changed (16-bit
// each; the game's $0200 and $01F0)
export const LEVEL_MAX_Y = LEVEL_HEIGHT_RAM[0] + 4, LEVEL_ROW_MASK = LEVEL_HEIGHT_RAM[0] + 6;
// and the level being loaded or played (16-bit, from the game's setup)
export const LEVEL_LOADED = LEVEL_HEIGHT_RAM[0] + 10;
// the layer 3 graphics patch's RAM (layer3gfx.ts): 1 while the layer 3 graphics in VRAM are a level's own
export const LAYER3_GFX_RAM: [number, number] = [0x7f3678, 1];
// the level heights patch's too: the flags of the screen exit Mario left by (0000wush, Lunar Magic's)
export const EXIT_FLAGS_RAM: [number, number] = [0x7f3679, 1];
// the editor patch's (patches.ts): the high bytes of the ExGFX numbers in the graphics slots being uploaded
// (8), then the one for the next upload of BG2/BG3
export const EXGFX_HI_RAM: [number, number] = [0x7f367a, 9];
// Lunar Magic's conditional Direct Map16 flags (cdm16.ts), which community code sets: 128 bits, low to high
export const CDM16_FLAGS: [number, number] = [0x7fc060, 16];
// Lunar Magic's ExAnimation RAM (extrigger.ts), which community code sets and reads: the manual frames (16 bytes),
// the slots' frame counters (level 32, then global 32), the one-shot triggers (32 bits), the custom ones (16 bits)
export const EXTRIGGER_RAM = { manual: 0x7fc070, counters: 0x7fc080, oneShot: 0x7fc0f8, custom: 0x7fc0fc } as const;
// Lunar Magic's RAM for a horizontal level's height, which community code reads too: the height in
// pixels (also a screen's bytes in the level data), and the screens' Map16 addresses in bank 0's RAM
// (the game's mode tables point there): 3-byte pointers to the low and the high bytes, then the
// addresses' low and high bytes
export const LEVEL_HEIGHT = 0x13d7;
export const SCREEN_PTRS: [number, number] = [0x0bf6, 0x100];

// normal sprites: per-slot tables (address + slot)
export const SPRITE_SLOTS = 12;
export const SPR = {
  num: 0x9e,
  speedY: 0xaa, speedX: 0xb6,
  yLo: 0xd8, xLo: 0xe4, yHi: 0x14d4, xHi: 0x14e0,
  status: 0x14c8,
  blocked: 0x1588, // bits: 1 right, 2 left
  offScreenH: 0x15a0, offScreenV: 0x186c,
  loadIndex: 0x161a, // index in the level's sprite data ($FF = not from there)
  // PIXI's tables (bank $7F): custom sprite number, extra bits, extra bytes
  customNum: 0x1ab9e, extraBits: 0x1ab10, extraBytes: [0x1ab40, 0x1ab4c, 0x1ab58, 0x1ab64],
} as const;

// all tables of a sprite's state but its position, subpixels and off-screen flags
export const SPR_STATE = [0x9e, 0xaa, 0xb6, 0xc2, 0x14c8, 0x1504, 0x1510, 0x151c, 0x1528, 0x1534, 0x1540, 0x154c, 0x1558, 0x1564,
  0x1570, 0x157c, 0x1594, 0x15ac, 0x15c4, 0x15d0, 0x15dc, 0x15f6, 0x1602, 0x160e, 0x1626, 0x1632, 0x163e, 0x164a, 0x1656,
  0x1662, 0x166e, 0x167a, 0x1686, 0x187b, 0x190f, 0x1fd6, 0x1fe2];

// 16-bit values: low byte at lo, high byte at hi (default: the next byte)
export const get16 = (w: Uint8Array, lo: number, hi = lo + 1) => w[lo] | (w[hi] << 8);
export const getS16 = (w: Uint8Array, lo: number, hi = lo + 1) => (get16(w, lo, hi) << 16) >> 16;
export function set16(w: Uint8Array, lo: number, v: number, hi = lo + 1): void {
  w[lo] = v & 0xff; w[hi] = (v >> 8) & 0xff;
}

export const map16Tile = (w: Uint8Array, a: number) => get16(w, a, a + MAP_HI);
export const bgTile = (w: Uint8Array, o: number) => get16(w, RAM.bgMapLo + o, RAM.bgMapHi + o);
export const map16Pointer = (w: Uint8Array, t: number) => get16(w, RAM.map16Pointers + t * 2);

export const spriteX = (w: Uint8Array, i: number) => get16(w, SPR.xLo + i, SPR.xHi + i);
export const spriteY = (w: Uint8Array, i: number) => get16(w, SPR.yLo + i, SPR.yHi + i);
export function setSpritePos(w: Uint8Array, i: number, x: number, y: number): void {
  set16(w, SPR.xLo + i, x, SPR.xHi + i); set16(w, SPR.yLo + i, y, SPR.yHi + i);
}

export const cameraX = (w: Uint8Array) => get16(w, RAM.layer1X);
export const cameraY = (w: Uint8Array) => get16(w, RAM.layer1Y);
// the camera, for this frame and the next
export function setCameraX(w: Uint8Array, x: number): void { set16(w, RAM.layer1X, x); set16(w, RAM.layer1XNext, x); }
export function setCameraY(w: Uint8Array, y: number): void { set16(w, RAM.layer1Y, y); set16(w, RAM.layer1YNext, y); }

export const marioX = (w: Uint8Array) => get16(w, RAM.marioX);
export const marioY = (w: Uint8Array) => get16(w, RAM.marioY);
// Mario's position, also as the one at the start of the frame
export function setMarioPos(w: Uint8Array, x: number, y: number): void {
  set16(w, RAM.marioX, x); set16(w, RAM.marioXFrame, x);
  set16(w, RAM.marioY, y); set16(w, RAM.marioYFrame, y);
}
