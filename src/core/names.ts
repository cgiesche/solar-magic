// Human readable names (best effort, vanilla SMW).

const SPRITES = `Green Koopa, no shell|Red Koopa, no shell|Blue Koopa, no shell|Yellow Koopa, no shell|Green Koopa|Red Koopa|Blue Koopa|Yellow Koopa|Green Koopa, flying left|Green Koopa, bouncing|Red Koopa, flying vertical|Red Koopa, flying horizontal|Yellow Koopa with wings|Bob-omb|Keyhole|Goomba|Goomba, bouncing with wings|Buzzy Beetle|(unused)|Spiny|Spiny, falling|Fish, horizontal|Fish, vertical|Fish, from generator|Surface jumping fish|Message box text|Classic Piranha Plant|Bouncing football|Bullet Bill|Hopping flame|Lakitu|Magikoopa|Magikoopa's magic|Moving coin|Net Koopa, green vertical|Net Koopa, red vertical|Net Koopa, green horizontal|Net Koopa, red horizontal|Thwomp|Thwimp|Big Boo|Koopa Kid|Upside-down Piranha Plant|Sumo Bro. lightning|Yoshi egg|Baby green Yoshi|Spike Top|Portable springboard|Dry Bones, throws bones|Bony Beetle|Dry Bones, stays on ledge|Fireball|Boss fireball|Green Yoshi|(unused)|Boo|Eerie|Eerie, wave motion|Urchin, fixed|Urchin, wall detect|Urchin, wall follow|Rip Van Fish|P-Switch|Para-Goomba|Para-Bomb|Dolphin, horizontal|Dolphin 2, horizontal|Dolphin, vertical|Torpedo Ted|Directional coins|Diggin' Chuck|Swimming/jumping fish|Diggin' Chuck's rock|Growing/shrinking pipe end|Goal point question sphere|Pipe-dwelling Lakitu|Exploding block|Monty Mole, ground|Monty Mole, ledge|Jumping Piranha Plant|Jumping Piranha Plant, spits fire|Ninji|Moving ledge hole (ghost house)|Throw block sprite|Climbing net door|Checkerboard platform, horizontal|Flying rock platform, horizontal|Checkerboard platform, vertical|Flying rock platform, vertical|Turn block bridge, hor./vert.|Turn block bridge, horizontal|Brown platform floating in water|Checkerboard platform, falls|Orange platform floating in water|Orange platform, goes forever|Brown platform on chain|Flat switch palace switch|Floating skulls|Brown platform, line-guided|Checker/brown platform, line-guided|Rope mechanism, line-guided|Chainsaw, line-guided|Upside-down chainsaw, line-guided|Grinder, line-guided|Fuzzy, line-guided|(unused)|Coin game cloud|Springboard, left wall|Springboard, right wall|Invisible solid block|Dino Rhino|Dino Torch|Pokey|Super Koopa, red cape|Super Koopa, yellow cape|Super Koopa, feather|Mushroom|Fire flower|Star|Feather|1-Up mushroom|Growing vine|Firework|Goal tape|Princess Peach|P-Balloon|Flying red coin|Flying 1-Up|Key|Changing item|Bonus game|Flying ? block, left|Flying ? block|(unused)|Wiggler|Lakitu's cloud|(unused, winged cage)|Layer 3 smash|Bird (Yoshi's house)|Puff of smoke (Yoshi's house)|Fireplace smoke|Ghost house exit sign and door|Invisible warp hole blocks|Scale platforms|Large gas bubble|Chargin' Chuck|Splittin' Chuck|Bouncin' Chuck|Whistlin' Chuck|Clappin' Chuck|(unused Chuck)|Puntin' Chuck|Pitchin' Chuck|Volcano Lotus|Sumo Bro.|Hammer Bro.|Flying blocks for Hammer Bro.|Bubble with sprite|Ball 'n' Chain|Banzai Bill|Bowser scene activator|Bowser's bowling ball|MechaKoopa|Grey platform on chain|Floating spike ball|Fuzzy/Sparky, ground-guided|Hothead, ground-guided|Iggy's ball|Blargg|Reznor|Fishbone|Rex|Wooden spike, down/up|Wooden spike, up/down|Fishin' Boo|Boo block|Reflecting Boo stream|Creating/eating block|Falling spike|Bowser statue fireball|Grinder|Sinking fireball|Reflecting fireball|Carrot top lift, upper right|Carrot top lift, upper left|Info box|Timed lift|Grey moving castle block|Bowser statue|Sliding Koopa|Swooper|Mega Mole|Grey platform on lava|Flying grey turn blocks|Blurp|Porcu-Puffer|Grey falling platform|Big Boo boss|Dark room spotlight|Invisible mushroom|Light switch block|Bullet Bill shooter|Torpedo Ted launcher|Eerie generator|Para-Goomba generator|Para-Bomb generator|Para-Bomb & Para-Goomba generator|Dolphin generator, left|Dolphin generator, right|Jumping fish generator|Turn off generator 2|Super Koopa generator|Bubble generator|Bullet Bill generator|Bullet Bill generator, multi-directional|Bullet Bill generator, diagonal|Bowser statue fire generator|Turn off generators|Green Koopa shell|Red Koopa shell|Blue Koopa shell|Yellow Koopa shell|Group of 5 Eeries|Green Koopa shell (2)|3 rotating platforms|Boo ceiling|Boo ring, counter-clockwise|Boo ring, clockwise|Swooper ceiling|Appearing/disappearing Boos|Background candle flames`.split('|');

export function spriteName(n: number): string {
  return SPRITES[n] ?? `Sprite ${hex2(n)}`;
}

const STD_OBJECTS = `Extended object|Water (blue)|Invisible coin blocks|Invisible note blocks|Invisible POW coins|Coins|Walk-through dirt|Water (other color)|Note blocks|Turn blocks|Coin ? blocks|Throw blocks|Black piranha plants|Cement blocks|Brown blocks|Vertical pipes|Horizontal pipes|Bullet shooter|Slopes|Ledge edges|Ground ledge|Midway/goal point|Blue coins|Rope/clouds|Water surface (animated)|Water surface (static)|Lava surface (animated)|Net top edge|Donut bridge|Net bottom edge|Net vertical edge|Vertical pipe/bone/log|Horizontal pipe/bone/log|Long ground ledge`.split('|');

export function objectName(num: number, ext: number): string {
  if (num === 0) return ext === 2 ? 'Direct Map16 (Editor-Patch)' : `Extended object ${hex2(ext)}`;
  return STD_OBJECTS[num] ?? `Tileset object ${hex2(num)}`;
}

export const TILESETS = ['Normal 1', 'Castle 1', 'Rope 1', 'Underground 1', 'Switch Palace 1', 'Ghost House 1', 'Rope 2',
  'Normal 2', 'Rope 3', 'Underground 2', 'Switch Palace 2', 'Castle 2', 'Cloud/Forest', 'Ghost House 2', 'Underground 3', '(F)'];

export const LEVEL_MODES: Record<number, string> = {
  0x00: 'Horizontal level', 0x01: 'Horizontal Layer 2 level', 0x02: 'Horizontal Layer 2 level (interaction)',
  0x07: 'Vertical Layer 2 level', 0x08: 'Vertical Layer 2 level (interaction)', 0x09: 'Boss (Iggy/Larry, mode 7)',
  0x0a: 'Vertical level', 0x0b: 'Boss (Morton/Roy/Ludwig)', 0x0c: 'Horizontal level, dark BG', 0x0d: 'Vertical level, dark BG',
  0x0e: 'Horizontal level (Layer 3 BG)', 0x0f: 'Horizontal Layer 2 level (alt)', 0x10: 'Boss (Bowser)', 0x11: 'Dark room',
  0x1e: 'Horizontal translucent', 0x1f: 'Horizontal Layer 2 translucent',
};
export function levelModeName(m: number): string {
  return LEVEL_MODES[m] ?? `Mode ${hex2(m)} (unusual)`;
}

export const MUSIC = ['Overworld', 'Athletic', 'Underground', 'Water', 'Castle', 'Ghost House', 'Bonus/Sky', 'Boss'];
export const ENTRANCE_ACTIONS = ['Normal/vertical pipe up', 'Pipe going right', 'Pipe going left', 'Pipe going down',
  'Pipe going up', 'Slide/walk from left', 'Door/jump from below (water)', 'Normal (no Yoshi intro)'];
export const TIME_SETTINGS = ['0 (none)', '200', '300', '400'];
export const ITEM_MEMORY = ['0', '1', '2', '3'];
export const VERTICAL_SCROLL = ['Vertical scroll at will', 'No vertical scroll', 'Vertical scroll always', 'No scroll at all'];

export function hex2(n: number): string {
  return n.toString(16).toUpperCase().padStart(2, '0');
}
export function hex3(n: number): string {
  return n.toString(16).toUpperCase().padStart(3, '0');
}
export function hex(n: number, d: number): string {
  return n.toString(16).toUpperCase().padStart(d, '0');
}

// Standard objects whose settings byte uses one nibble as a type (sub-object) instead of a size,
// taken from the object routines in bank $0D. 'lo': type = low nibble, only the height is sizable;
// 'hi': type = high nibble, only the width is sizable.
const OBJ_VARIANTS: Record<number, { nibble: 'lo' | 'hi'; count: number }> = {
  0x0f: { nibble: 'lo', count: 6 }, // vertical pipes
  0x10: { nibble: 'hi', count: 4 }, // horizontal pipes
  0x12: { nibble: 'lo', count: 10 }, // slopes
  0x13: { nibble: 'lo', count: 15 }, // ledge edges, vines, dirt
  0x15: { nibble: 'lo', count: 2 }, // midway / goal point
  0x17: { nibble: 'hi', count: 2 }, // rope / clouds
  0x1e: { nibble: 'lo', count: 2 }, // net vertical edge (left/right)
};

export function objectVariants(num: number): { nibble: 'lo' | 'hi'; count: number } | null {
  return OBJ_VARIANTS[num] ?? null;
}

// type of a sub-object, -1 for objects without types
export function objectVariant(num: number, size: number): number {
  const v = OBJ_VARIANTS[num];
  return !v ? -1 : v.nibble === 'lo' ? size & 15 : size >> 4;
}

export function withObjectVariant(num: number, size: number, t: number): number {
  const v = OBJ_VARIANTS[num];
  if (!v) return size;
  return v.nibble === 'lo' ? (size & 0xf0) | (t & 15) : ((t & 15) << 4) | (size & 15);
}

// settings byte of an object resized by dw/dh tiles; the type nibble of sub-objects stays untouched
export function resizeObjectSize(num: number, size: number, dw: number, dh: number): number {
  if (num === 0x21) return Math.max(0, Math.min(255, size + dw)); // long ground ledge: whole byte is the width
  const v = OBJ_VARIANTS[num];
  const w = v?.nibble === 'lo' ? size & 15 : Math.max(0, Math.min(15, (size & 15) + dw));
  const hh = v?.nibble === 'hi' ? size >> 4 : Math.max(0, Math.min(15, (size >> 4) + dh));
  return (hh << 4) | w;
}
