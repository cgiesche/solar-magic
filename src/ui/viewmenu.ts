// The "View" menu of the level view, shared by the level editor and the graphics workspace.

import type { App } from './app.ts';
import { menuButton, type MenuItem } from './menu.ts';
import { hex2 } from '../core/names.ts';
import { COND_FLAGS, flagRam } from '../core/cdm16.ts';
import { triggerMenu } from './triggerpanel.ts';
import { projectId } from '../core/projectid.ts';
import { loadDeaths, clearDeaths, clearAllDeaths, anyDeaths } from './deathmarks.ts';

// paint: redraws the level view (overlay toggles that need no new composite)
export function viewMenu(app: App, paint: () => void, full = true): HTMLElement {
  const show = (k: keyof App['show'], label: string, title?: string, shortcut?: string): MenuItem => ({
    label, title, shortcut, checked: () => app.show[k],
    onToggle: (v) => {
      app.show[k] = v;
      if (k === 'scrollBands' && v) app.show.gameView = true;
      if (k === 'gameView' || k === 'scrollBands') app.updateGameViewCamera();
      if (k === 'anim') app.refresh();
      else if (k === 'layer1' || k === 'layer2' || k === 'layer3' || k === 'ghost') app.recomposite(); else paint();
    },
  });
  // view-only game state (re-runs the level load)
  const gameState = (k: keyof App['switches'], label: string, title: string): MenuItem => ({
    label, title, checked: () => app.switches[k], onToggle: (v) => { app.switches[k] = v; app.refresh(); },
  });
  const anim = show('anim', 'Animation', 'Play animated tiles and palettes (as in the game, custom animations too)');
  // the conditional Direct Map16 flags the level uses, each on or off (cdm16.ts; Lunar Magic: all at once)
  const flags = (): MenuItem[] => {
    const used = app.levelFlags();
    if (!used.size) return [{ label: 'Conditional Direct Map16: none in this level', onClick: () => {}, disabled: () => true }];
    const n = (c: number) => `${c} object${c > 1 ? 's' : ''}`;
    return [
      { heading: 'Conditional Direct Map16' },
      ...[...used].map(([f, c]): MenuItem => ({
        label: `Flag ${hex2(f)} on · ${n(c)}`, title: `View and test play: flag ${hex2(f)} on (${flagRam(f)}) – the level loads with it`,
        checked: () => app.cdm16.has(f), onToggle: (v) => app.setFlags([f], v),
      })),
      { label: 'All flags on', title: 'View and test play: every flag on', onClick: () => app.setFlags(Array.from({ length: COND_FLAGS }, (_, i) => i), true) },
      { label: 'All flags off', title: 'View and test play: every flag off', onClick: () => app.setFlags([...app.cdm16], false) },
    ];
  };
  const state = (): MenuItem[] => [
    { heading: 'Game state' },
    gameState('palaces', '!-blocks pressed', 'View: all switch palaces pressed'),
    gameState('onOff', 'ON/OFF set to OFF', 'View: ON/OFF switch set to OFF'),
    ...flags(),
    ...triggerMenu(app),
  ];
  return menuButton({ label: 'View', items: () => full ? [
    { heading: 'Layers' },
    show('layer1', 'Layer 1'), show('layer2', 'Layer 2 / BG'), show('layer3', 'Layer 3', 'Layer 3 (tides, layer 3 images) – preview, scrolling approximated'),
    show('sprites', 'Sprites'), show('exits', 'Exits'),
    { heading: 'Overlays' },
    show('screens', 'Screen boundaries'), show('grid', 'Grid', undefined, 'G'),
    show('ghost', 'Inactive layer translucent', 'Object layer not being edited shown semi-transparent (only levels with layer 2 objects); while editing the BG or layer 3, layer 1 and the sprites too'),
    show('items', 'Block contents', 'Contents of blocks (found by emulation) semi-transparent over the blocks, arrows at enterable blocks (pipes, doors)'),
    show('invisible', 'Invisible tiles', 'Layer 1 tiles (and layer 2 objects\' tiles) that draw nothing but are not air – invisible blocks, P-switch coins and doors, 1-Up points, invisible custom blocks – tinted with dashed edges'),
    show('deaths', 'Death markers', 'Where Mario died in recent test plays of this level (kept in the browser): a red cross at his tile, a dashed red box at what killed him – a sprite or a block –, a number where he died more often; faded: before the level was last changed. The mouse over a cross says what killed him'),
    { label: 'Clear death markers', title: 'Forget where Mario died in this level', disabled: () => !loadDeaths(projectId(app.rom), app.level.number).length,
      onClick: () => { clearDeaths(projectId(app.rom), app.level.number); paint(); } },
    { label: 'Clear death markers in all levels', title: 'Forget where Mario died in every level of this ROM', disabled: () => !anyDeaths(projectId(app.rom)),
      onClick: () => { clearAllDeaths(projectId(app.rom)); paint(); } },
    show('preview', 'Placement preview', 'What a right click would place, shown translucent at the mouse: the element chosen in “Insert” or a copy of the selection'),
    show('collision', 'Collision', 'How Mario collides with layer 1 (found by emulation): solid sides white, platforms dashed, slopes diagonal; red hurts (spikes on the sides that hurt), skull kills, blue water, green net climbable', 'C'),
    show('arcs', 'Jump arcs at the mouse', 'Where Mario gets jumping from the tile under the mouse (emulated): from standing, walking, running and at P-speed, to both sides; Shift+J pins them to the tile', 'J'),
    show('gameView', 'Game view frame', 'What the player sees: a 256x224 screen over the level; drag it by its edge or label (snaps to 8x8), or Shift+V puts Mario with his feet in the tile under the mouse and the frame where the game puts the camera then. The level is darkened where the camera never goes (found by the level scan)', 'V'),
    show('scrollBands', 'Scroll bands', 'In the game view frame: where Mario is while the camera scrolls right, left, up and down, and after L/R looked ahead, under the level\'s scroll settings (found by emulation)'),
    anim,
    ...state(),
  ] : [{ heading: 'Level preview' }, anim, ...state()] });
}
