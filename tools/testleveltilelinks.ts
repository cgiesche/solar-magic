// From a level tile to its level and back (#79): what a selected level tile shows of its exits – the tiles each
// exit's event changes (owevents.ts exitChanges) and the locations its exits to the overworld teleport to
// (owlinks.ts levelTeleports). Checked by emulation: every layer 1 and layer 2 tile the game changes when a level's
// exit event passes (the overworld loaded at the event progress before and after it) is among those shown.
import { Rom } from '../src/core/rom.ts';
import { OverworldEmulator, gameL1, gameL2, readTranslevels, readL1, translevelToLevel, l1XY } from '../src/core/overworld.ts';
import { exitChanges, readEvents, eventRunners } from '../src/core/owevents.ts';
import { levelTeleports } from '../src/core/owlinks.ts';
import { locationFor } from '../src/core/owteleport.ts';
import { ExitGraph } from '../src/core/exitgraph.ts';
import { readSecondaryEntrance, writeSecondaryEntrance, newOverworldExit, OW_SECRET, type ScreenExit } from '../src/core/level.ts';
import { editorImage, levelTiles } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number, n = 2) => v.toString(16).toUpperCase().padStart(n, '0');

const rom = new Rom(await editorImage());
const emu = new OverworldEmulator(rom), d = readEvents(rom), runners = eventRunners(rom);
const l1 = readL1(rom), tls = readTranslevels(rom);
const isLevelTile = levelTiles(rom);
const levels = [...new Set(tls.filter((t, i) => t && isLevelTile(l1[i])))].sort((a, b) => a - b);

// ---- every level exit's changes cover what the game changes ----
{
  const missed: string[] = [];
  let events = 0, shown = 0;
  for (const tl of levels) {
    for (const c of exitChanges(rom, tl, d, runners)) {
      events++;
      shown += c.l1.length + c.l2.length;
      const l1Shown = new Set(c.l1), l2Shown = new Set(c.l2);
      for (const region of [0, 1]) {
        const map = region ? 1 : 0, before = emu.load(map, c.event), after = emu.load(map, c.event + 1);
        if (!region) {
          const a = gameL1(before), b = gameL1(after);
          for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && !l1Shown.has(i)) { const p = l1XY(i); missed.push(`${hx(translevelToLevel(tl), 3)} exit ${c.exit}: L1 ${i >= 0x400 ? 1 : 0}:${hx(p.x)},${hx(p.y)}`); }
        }
        const a = gameL2(before), b = gameL2(after);
        for (let k = 0; k < a.length; k++) if (a[k] !== b[k] && !l2Shown.has(region * 0x1000 + k)) missed.push(`${hx(translevelToLevel(tl), 3)} exit ${c.exit}: L2 ${region}:${hx(k, 3)}`);
      }
    }
  }
  check(events > 50 && !missed.length, `${events} level exit events, ${shown} tiles shown: every tile the game changes is among them ${missed.slice(0, 12).join(', ')}${missed.length > 12 ? ` … (${missed.length})` : ''}`);
  const yi1 = exitChanges(rom, 0x29, d, runners);
  check(yi1.length === 1 && yi1[0].exit === 0 && yi1[0].l2.length > 0, `Yoshi's Island 1 (105): its normal exit, ${yi1[0]?.l2.length} layer 2 tiles`);
}

// ---- the locations its exits teleport to ----
{
  const r = new Rom(rom.data.slice());
  const free = new ExitGraph(r).freeEntrance()!;
  const tile = { submap: 0, x: 0x0c, y: 0x09 };
  const loc = locationFor(r, tile)!;
  writeSecondaryEntrance(r, free, { ...readSecondaryEntrance(r, free), destLevel: 0x105, overworld: { ...newOverworldExit(), action: OW_SECRET, teleport: 1, location: loc } });
  // an exit of 105's screen 0 through it
  const exits: ScreenExit[] = [{ uid: 1, screen: 0, dest: free & 0xff, secondary: true, flags: 0x04 | 0x02 | (free >> 8) }];
  const g = new ExitGraph(r, { number: 0x105, exits });
  const t = levelTeleports(r, g, 0x29), other = levelTeleports(r, g, 0x2a);
  check(t.length === 1 && t[0].location === loc && t[0].entrance === free && t[0].action === OW_SECRET && JSON.stringify(t[0].to) === JSON.stringify(tile) && !other.length,
    `105's exit to the overworld teleports to location ${hx(loc)} (main map 0C,09): ${JSON.stringify(t)}; 106: ${other.length}`);
}

if (bad) { console.log(`${bad} FAILED`); process.exit(1); }
console.log('all ok');
