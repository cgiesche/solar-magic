// The overworld maps of the clean game as the game shows them (emulated, at an event progress), drawn as the editor
// draws them (drawOwMap): OUT/ow<map>.png for the main map and each submap, layer 2 under layer 1.
// Usage: OUT=dir node tools/ow.ts [progress]
import { Rom } from '../src/core/rom.ts';
import { OverworldEmulator, MAP_NAMES, drawOwMap, gameL2 } from '../src/core/overworld.ts';
import { writePng, outDir } from './png.ts';
import { cleanImage } from './fixture.ts';

const rom = new Rom(cleanImage()), emu = new OverworldEmulator(rom), progress = Number(process.argv[2] ?? 0), out = outDir();
MAP_NAMES.forEach((name, map) => {
  const r = emu.load(map, progress);
  console.log(`${name}: ${r.ok ? 'loaded' : 'not loaded'}`);
  if (!out || !r.ok) return;
  // (layer 2 as the game shows it, from VRAM, put at its region's place of the maps' 0x2000 entries)
  const region = map > 0 ? 1 : 0, l2 = new Uint16Array(0x2000);
  l2.set(gameL2(r), region * 0x1000);
  writePng(`${out}/ow${map}.png`, 512, 512, drawOwMap(rom, r, region, null, l2));
});
