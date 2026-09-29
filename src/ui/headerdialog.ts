// Level header / secondary header editor.

import type { App } from './app.ts';
import { h, select, hexInput, modal } from './dom.ts';
import { TILESETS, levelModeName, MUSIC, TIME_SETTINGS, VERTICAL_SCROLL, ENTRANCE_ACTIONS, hex2, hex } from '../core/names.ts';
import { hasLayer2Objects, type PrimaryHeader, type SecondaryHeader, L2_PTRS } from '../core/level.ts';

function range(n: number, fmt: (i: number) => string = (i) => String(i)): [number, string][] {
  return Array.from({ length: n }, (_, i) => [i, fmt(i)]);
}

export function openHeaderDialog(app: App): void {
  const lv = app.level;
  const hd: PrimaryHeader = { ...lv.header };
  const sd: SecondaryHeader = { ...lv.secondary };
  let spriteHeader = lv.spriteHeader;
  let l2ptr = lv.layer2Pointer;

  const f = (label: string, el: HTMLElement, hint?: string) => h('div', { class: 'prop' }, h('label', null, label), el, hint ? h('span', { class: 'hint' }, hint) : null);
  const sel = <K extends keyof PrimaryHeader>(k: K, opts: [number, string][]) => select(opts, hd[k] as number, (v) => { (hd[k] as number) = v; });
  const sel2 = <K extends keyof SecondaryHeader>(k: K, opts: [number, string][]) => select(opts, sd[k] as number, (v) => { (sd[k] as number) = v; });

  const modes: [number, string][] = range(0x20, (i) => `${hex2(i)} – ${levelModeName(i)}`);
  // BG tilemaps used by vanilla levels
  const bgs = new Map<number, number[]>();
  for (let i = 0; i < 512; i++) {
    const p = app.rom.r24(L2_PTRS + i * 3);
    if (p >> 16 !== 0xff) continue;
    if (!bgs.has(p)) bgs.set(p, []);
    bgs.get(p)!.push(i);
  }
  const bgOpts: [number, string][] = [...bgs.entries()].map(([p, ls]) => [p, `$${hex(p & 0xffff, 4)} (z.B. Level ${ls.slice(0, 3).map((l) => hex(l, 3)).join(', ')})`]);
  if (!bgs.has(l2ptr) && l2ptr >> 16 === 0xff) bgOpts.push([l2ptr, `$${hex(l2ptr & 0xffff, 4)}`]);

  const body = h('div', { class: 'header-dialog' },
    h('h3', null, 'Primärer Header'),
    h('div', { class: 'grid2' },
      f('Level-Modus', sel('mode', modes)),
      f('Screens', select(range(32, (i) => String(i + 1)).map(([v, l]) => [v + 1, l] as [number, string]), hd.screens, (v) => (hd.screens = v))),
      f('FG/BG-Tileset', sel('tileset', range(16, (i) => `${hex2(i)} – ${TILESETS[i]}`))),
      f('FG-Palette', sel('fgPalette', range(8))),
      f('BG-Palette', sel('bgPalette', range(8))),
      f('Hintergrundfarbe', sel('backAreaColor', range(8))),
      f('Sprite-Palette', sel('spritePalette', range(8))),
      f('Sprite-Grafik', sel('spriteGfx', range(16, (i) => hex2(i)))),
      f('Musik', sel('music', range(8, (i) => `${i} – ${MUSIC[i]} (Song ${hex2(app.rom.r8(0x0584db + i))})`))),
      f('Zeit', sel('time', range(4, (i) => TIME_SETTINGS[i]))),
      f('Item-Memory', sel('itemMemory', range(4))),
      f('Vertikales Scrollen', sel('verticalScroll', range(4, (i) => VERTICAL_SCROLL[i]))),
      f('Layer-3-Priorität', sel('layer3Priority', [[0, 'Aus'], [1, 'An']])),
    ),
    h('h3', null, 'Sekundärer Header / Haupteingang'),
    h('div', { class: 'grid2' },
      f('Eingang X-Position', sel2('entranceX', range(8))),
      f('Eingang Y-Position', sel2('entranceY', range(16))),
      f('Eingang Screen', sel2('entranceScreen', range(32, hex2))),
      f('Eingangs-Aktion', sel2('entranceAction', range(8, (i) => `${i} – ${ENTRANCE_ACTIONS[i]}`))),
      f('Midway-Screen', sel2('midwayScreen', range(16, hex2))),
      f('Layer-2-Scrolling', sel2('layer2Scroll', range(16, hex2))),
      f('Layer 3', sel2('layer3', [[0, 'Keins'], [1, 'Flut (Tide)'], [2, 'Flut, variabel'], [3, 'Mondlicht/Sonstiges']])),
      f('FG Start-Y', sel2('fgInitY', range(4))),
      f('BG Start-Y', sel2('bgInitY', range(4))),
      f('Vertikale Positionierung', sel2('verticalPositioning', range(4))),
      f('Kein Yoshi-Intro', sel2('noYoshiIntro', [[0, 'Nein'], [1, 'Ja']])),
    ),
    h('h3', null, 'Sprites & Hintergrund'),
    h('div', { class: 'grid2' },
      f('Sprite-Speicher', hexInput(spriteHeader & 0x3f, 2, (v) => (spriteHeader = (spriteHeader & 0xc0) | v), 0x3f), '$1692-Index'),
      f('Sprite-Buoyancy', select([[0, 'Aus'], [0x80, 'An'], [0xc0, 'An + deaktiviert (Unterwasser)'], [0x40, 'Bit 6']], spriteHeader & 0xc0, (v) => (spriteHeader = (spriteHeader & 0x3f) | v))),
      lv.layer2Objects || hasLayer2Objects(hd.mode) ? f('Layer 2', h('span', null, lv.layer2Objects ? 'Layer-2-Objekte (Modus L2)' : 'Achtung: Modus erwartet Layer-2-Objekte')) :
        f('BG-Tilemap', select(bgOpts, l2ptr, (v) => (l2ptr = v))),
    ),
  );
  modal(`Level ${hex(lv.number, 3)} – Header`, body, [
    { label: 'Abbrechen' },
    {
      label: 'Übernehmen', primary: true, onClick: () => {
        app.checkpoint();
        const modeChangedL2 = hasLayer2Objects(hd.mode) !== hasLayer2Objects(lv.header.mode);
        lv.header = hd;
        lv.secondary = sd;
        lv.spriteHeader = spriteHeader;
        lv.layer2Pointer = l2ptr;
        if (modeChangedL2) {
          if (hasLayer2Objects(hd.mode) && !lv.layer2Objects) { lv.layer2Objects = []; lv.layer2Header = new Uint8Array(5); }
          if (!hasLayer2Objects(hd.mode) && lv.layer2Objects) {
            lv.layer2Objects = null;
            if (lv.layer2Pointer >> 16 !== 0xff) lv.layer2Pointer = app.rom.r24(L2_PTRS + 0x105 * 3);
          }
        }
        if (app.mode === 'l2' && !lv.layer2Objects) app.mode = 'l1';
        app.changed();
        app.emit('level-header');
      },
    },
  ]);
}
