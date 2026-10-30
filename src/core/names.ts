// Human readable names (best effort, vanilla SMW); objects in objectnames.ts.

const SPRITES = `Green Koopa, naked|Red Koopa, naked|Blue Koopa, naked|Yellow Koopa, naked|Green Koopa|Red Koopa|Blue Koopa|Yellow Koopa|Green Koopa, flying left|Green Koopa, bouncing|Red Koopa, flying vertical|Red Koopa, flying horizontal|Yellow Koopa with wings|Bob-omb|Keyhole|Goomba|Goomba, bouncing with wings|Buzzy Beetle|(unused)|Spiny|Spiny, falling|Fish, horizontal|Fish, vertical|Fish, from generator|Surface jumping fish|Message box text|Classic Piranha Plant|Bouncing football|Bullet Bill|Hopping flame|Lakitu|Magikoopa|Magikoopa's magic|Moving coin|Net Koopa, green vertical|Net Koopa, red vertical|Net Koopa, green horizontal|Net Koopa, red horizontal|Thwomp|Thwimp|Big Boo|Koopa Kid|Upside-down Piranha Plant|Sumo Bro. lightning|Yoshi egg|Baby green Yoshi|Spike Top|Portable springboard|Dry Bones, throws bones|Bony Beetle|Dry Bones, stays on ledge|Fireball|Boss fireball|Green Yoshi|(unused)|Boo|Eerie|Eerie, wave motion|Urchin, fixed|Urchin, wall detect|Urchin, wall follow|Rip Van Fish|P-Switch|Para-Goomba|Para-Bomb|Dolphin, horizontal|Dolphin 2, horizontal|Dolphin, vertical|Torpedo Ted|Directional coins|Diggin' Chuck|Swimming/jumping fish|Diggin' Chuck's rock|Growing/shrinking pipe end|Goal point question sphere|Pipe-dwelling Lakitu|Exploding block|Monty Mole, ground|Monty Mole, ledge|Jumping Piranha Plant|Jumping Piranha Plant, spits fire|Ninji|Moving ledge hole (ghost house)|Throw block sprite|Climbing net door|Checkerboard platform, horizontal|Flying rock platform, horizontal|Checkerboard platform, vertical|Flying rock platform, vertical|Turn block bridge, hor./vert.|Turn block bridge, horizontal|Brown platform floating in water|Checkerboard platform, falls|Orange platform floating in water|Orange platform, goes forever|Brown platform on chain|Flat switch palace switch|Floating skulls|Brown platform, line-guided|Checker/brown platform, line-guided|Rope mechanism, line-guided|Chainsaw, line-guided|Upside-down chainsaw, line-guided|Grinder, line-guided|Fuzzy, line-guided|(unused)|Coin game cloud|Springboard, left wall|Springboard, right wall|Invisible solid block|Dino Rhino|Dino Torch|Pokey|Super Koopa, red cape|Super Koopa, yellow cape|Super Koopa, feather|Mushroom|Fire flower|Star|Feather|1-Up mushroom|Growing vine|Firework|Goal tape|Princess Peach|P-Balloon|Flying red coin|Flying 1-Up|Key|Changing item|Bonus game|Flying ? block, left|Flying ? block|(unused)|Wiggler|Lakitu's cloud|(unused, winged cage)|Layer 3 smash|Bird (Yoshi's house)|Puff of smoke (Yoshi's house)|Fireplace smoke|Ghost house exit sign and door|Invisible warp hole blocks|Scale platforms|Large gas bubble|Chargin' Chuck|Splittin' Chuck|Bouncin' Chuck|Whistlin' Chuck|Clappin' Chuck|(unused Chuck)|Puntin' Chuck|Pitchin' Chuck|Volcano Lotus|Sumo Bro.|Hammer Bro.|Flying blocks for Hammer Bro.|Bubble with sprite|Ball 'n' Chain|Banzai Bill|Bowser scene activator|Bowser's bowling ball|MechaKoopa|Grey platform on chain|Floating spike ball|Fuzzy/Sparky, ground-guided|Hothead, ground-guided|Iggy's ball|Blargg|Reznor|Fishbone|Rex|Wooden spike, down/up|Wooden spike, up/down|Fishin' Boo|Boo block|Reflecting Boo stream|Creating/eating block|Falling spike|Bowser statue fireball|Grinder|Sinking fireball|Reflecting fireball|Carrot top lift, upper right|Carrot top lift, upper left|Info box|Timed lift|Grey moving castle block|Bowser statue|Sliding Koopa|Swooper|Mega Mole|Grey platform on lava|Flying grey turn blocks|Blurp|Porcu-Puffer|Grey falling platform|Big Boo boss|Dark room spotlight|Invisible mushroom|Light switch block|Bullet Bill shooter|Torpedo Ted launcher|Eerie generator|Para-Goomba generator|Para-Bomb generator|Para-Bomb & Para-Goomba generator|Dolphin generator, left|Dolphin generator, right|Jumping fish generator|Turn off generator 2|Super Koopa generator|Bubble generator|Bullet Bill generator|Bullet Bill generator, multi-directional|Bullet Bill generator, diagonal|Bowser statue fire generator|Turn off generators|Green Koopa shell|Red Koopa shell|Blue Koopa shell|Yellow Koopa shell|Group of 5 Eeries|Green Koopa shell (2)|3 rotating platforms|Boo ceiling|Boo ring, counter-clockwise|Boo ring, clockwise|Swooper ceiling|Appearing/disappearing Boos|Background candle flames`.split('|');

export function spriteName(n: number): string {
  return SPRITES[n] ?? `Sprite ${hex2(n)}`;
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

// the songs of the 8 level header music settings in the original game (AddmusicK maps them to its
// originals of these names; e.g. Iggy's Castle has 3, the Yellow Switch Palace 7)
export const MUSIC = ['Here We Go', 'Underground', 'Athletic', 'Castle', 'Ghost House', 'Water', 'Boss', 'Switch Palace'];
export const ENTRANCE_ACTIONS = ['Normal / pipe up', 'Pipe right', 'Pipe left', 'Pipe down',
  'Pipe up', 'Slide/walk in from the left', 'Shoot from slanted pipe', 'Normal (no Yoshi intro)'];
export const TIME_SETTINGS = ['0 (none)', '200', '300', '400'];
export const ITEM_MEMORY = ['0', '1', '2', '3'];
// Lunar Magic's names of the layer 2 scroll rates (3.40, its "Change Layer 1/2 Settings" dialog): 0-8,
// then the auto-scrolls $10-$1B (up and down vertically, left and right horizontally)
const L2_RATES = ['None', 'Constant', 'Medium', 'Slow', 'Medium 2', 'Medium 3', 'Medium 4', 'Slow 2', 'Fast'];
const L2_AUTO = ['Slow', 'Medium', 'Fast', 'Fast 2', 'Fast 3', 'Fast 4'];
export function layer2RateName(v: number, horizontal: boolean): string {
  if (v < 0x10) return L2_RATES[v] ?? `Not used (${hex2(v)})`;
  const i = v - 0x10, dirs = horizontal ? ['Left', 'Right'] : ['Up', 'Down'];
  return i < 12 ? `Auto-Scroll ${dirs[i < 6 ? 0 : 1]} ${L2_AUTO[i % 6]}` : `Not used (${hex2(v)})`;
}
// the header's vertical scroll ($1412, $00F7F4): 1 follows Mario on the ground too, 2 only while he flies, climbs,
// swims … (testcamerareach.ts); 3 neither way (no horizontal scrolling either)
export const VERTICAL_SCROLL = ['No vertical scroll', 'Vertical scroll always', 'Vertical scroll while flying, climbing, swimming …', 'No scroll at all'];

export function hex2(n: number): string {
  return n.toString(16).toUpperCase().padStart(2, '0');
}
export function hex3(n: number): string {
  return n.toString(16).toUpperCase().padStart(3, '0');
}
export function hex(n: number, d: number): string {
  return n.toString(16).toUpperCase().padStart(d, '0');
}
