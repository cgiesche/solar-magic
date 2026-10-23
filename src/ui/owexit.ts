// Exits to the overworld (Lunar Magic 3.00's secondary entrances, level.ts OverworldExit) in the exit panel and the
// secondary entrances dialog: the action, another base event chosen by the level exit that runs it, and the
// teleport location picked on the overworld map – the editor finds or assigns its index (owteleport.ts).

import type { App } from './app.ts';
import { h, modal, select, checkbox, toast } from './dom.ts';
import { hex2, hex3 } from '../core/names.ts';
import { OW_ACTIONS, owActionName, type OverworldExit } from '../core/level.ts';
import { OverworldEmulator, MAP_NAMES, OW_EVENTS, eventNames, readL1, readL2, translevels, translevelToLevel, l1Index } from '../core/overworld.ts';
import { readTeleport, readTeleports, locationText, tileText, overworldExitText, type OwTile } from '../core/owteleport.ts';
import { drawOwMap, putImage } from './overworld.ts';

type Rows = [string, HTMLElement][];
type Edit = (label: string, f: (x: OverworldExit) => void) => void;

// "→ Overworld (normal exit, teleport to Main map 0C,09)"
export const overworldLabel = (app: App, o: OverworldExit): string => `→ Overworld (${overworldExitText(app.rom, o)})`;

// the rows of an exit to the overworld: what passing it does, where Mario goes; `set` applies an edit of it,
// `refresh` shows one made here (a teleport location picked, a pick cancelled)
export function overworldFields(app: App, idx: number, o: OverworldExit, set: Edit, refresh = () => {}): Rows {
  const actions = OW_ACTIONS.some(([v]) => v === o.action) ? OW_ACTIONS : [...OW_ACTIONS, [o.action, owActionName(o.action)] as [number, string]];
  const names = eventNames(app.rom);
  const events = Array.from({ length: OW_EVENTS }, (_, e): [number, string] => [e, `${hex2(e)} – ${names.get(e) ?? '(no level exit)'}`]);
  const to = o.teleport ? readTeleport(app.rom, o.location).to : null;
  // (cancelled: the panel shows the entrance as it is again)
  const pick = async () => {
    const tile = await pickOverworldTile(app, to);
    if (tile) teleportTo(app, idx, tile);
    app.emit('change');
    refresh();
  };
  return [
    ['Overworld', select(actions, o.action, (v) => set('Overworld action', (x) => (x.action = v)))],
    ['Base event', h('div', { class: 'radio-col' },
      checkbox('Another base event', 'The event of passing the level is this one (+ 1 for the secret exit) instead of the one of the overworld tile Mario entered the level from',
        !!o.ownEvent, (on) => set('Base event', (x) => (x.ownEvent = on ? 1 : 0))),
      ...(o.ownEvent ? [select(events, o.event, (v) => set('Base event', (x) => (x.event = v)))] : []))],
    ['Teleport', h('div', { class: 'radio-col' },
      checkbox('Teleport to a place on the overworld', 'Mario comes out at a tile of the overworld instead of the one he entered the level from (where he can walk on: the tile\'s paths)',
        !!o.teleport, (on) => { if (on) void pick(); else set('Teleport', (x) => (x.teleport = 0)); }),
      ...(o.teleport ? [h('div', { class: 'row' }, h('span', null, `${locationText(app.rom, o.location)} (location ${hex2(o.location)})`),
        h('button', { title: 'Click the tile on the overworld map', onclick: () => void pick() }, 'Pick on the map…'))] : []))],
  ];
}

// entrance idx teleports to `tile` (one ROM edit)
function teleportTo(app: App, idx: number, tile: OwTile): void {
  try { app.entrances.teleport(idx, tile); } catch (err) { toast(err instanceof Error ? err.message : String(err), 'error'); }
}

// a tile of an overworld map, clicked; the tiles teleports lead to are marked with their location index, `cur`
// framed. The map as in the ROM
export function pickOverworldTile(app: App, cur: OwTile | null): Promise<OwTile | null> {
  return new Promise((resolve) => {
    const rom = app.rom, emu = new OverworldEmulator(rom), l1 = readL1(rom), l2 = readL2(rom), tls = translevels(l1);
    const images = new Map<number, HTMLCanvasElement>();
    let map = cur?.submap ?? 0, hover: { x: number; y: number } | null = null, done = false;
    const canvas = h('canvas', { width: 512, height: 512, class: 'ow-pick' });
    const status = h('div', { class: 'hint' }, 'Click a tile: Mario comes out there.');
    const image = (m: number) => {
      let c = images.get(m);
      if (!c) { c = document.createElement('canvas'); putImage(c, drawOwMap(rom, emu.load(m, false), m > 0 ? 1 : 0, l1, l2)); images.set(m, c); }
      return c;
    };
    const paint = () => {
      const ctx = canvas.getContext('2d')!;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(image(map), 0, 0);
      const region = map > 0 ? 1 : 0;
      ctx.font = 'bold 8px monospace';
      for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
        const tl = tls[l1Index(region, x, y)];
        if (!tl) continue;
        ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(x * 16, y * 16 + 10, 16, 7);
        ctx.fillStyle = '#fff'; ctx.fillText(hex3(translevelToLevel(tl)), x * 16 + 1, y * 16 + 16);
      }
      readTeleports(rom).forEach((t, i) => {
        if (!t.to || t.to.submap !== map) return;
        ctx.fillStyle = 'rgba(40,120,255,0.75)'; ctx.fillRect(t.to.x * 16, t.to.y * 16, 16, 9);
        ctx.fillStyle = '#fff'; ctx.fillText(hex2(i), t.to.x * 16 + 2, t.to.y * 16 + 7);
      });
      const frame = (t: { x: number; y: number }, color: string) => { ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.strokeRect(t.x * 16 + 0.5, t.y * 16 + 0.5, 15, 15); };
      if (cur && cur.submap === map) frame(cur, '#4cc2ff');
      if (hover) frame(hover, '#ffff00');
    };
    const cell = (e: MouseEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: Math.max(0, Math.min(31, Math.floor((e.clientX - r.left) / r.width * 32))), y: Math.max(0, Math.min(31, Math.floor((e.clientY - r.top) / r.height * 32))) };
    };
    canvas.addEventListener('mousemove', (e) => {
      hover = cell(e);
      const t = teleportAt(map, hover.x, hover.y);
      status.textContent = `${tileText({ submap: map, ...hover })}${t >= 0 ? ` · location ${hex2(t)}` : ''}`;
      paint();
    });
    canvas.addEventListener('mouseleave', () => { hover = null; paint(); });
    canvas.addEventListener('click', (e) => { done = true; resolve({ submap: map, ...cell(e) }); dlg.close(true); });
    const teleportAt = (m: number, x: number, y: number) => readTeleports(rom).findIndex((t) => t.to?.submap === m && t.to.x === x && t.to.y === y);
    const dlg = modal('Teleport to …', h('div', { class: 'ow-pick-body' },
      h('label', { class: 'row' }, 'Map ', select(MAP_NAMES.map((n, i) => [i, n] as [number, string]), map, (v) => { map = v; paint(); })),
      canvas, status,
      h('div', { class: 'hint' }, 'Blue: places teleports already lead to (their location index); a star\'s or pipe\'s is shared. Another tile gets a location of its own.')),
    [{ label: 'Cancel' }], () => { if (!done) resolve(null); });
    paint();
  });
}
