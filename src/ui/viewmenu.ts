// The "View" menu of the level view, shared by the level editor and the graphics workspace.

import type { App } from './app.ts';
import { menuButton, type MenuItem } from './menu.ts';

// paint: redraws the level view (overlay toggles that need no new composite)
export function viewMenu(app: App, paint: () => void, full = true): HTMLElement {
  const show = (k: keyof App['show'], label: string, title?: string, shortcut?: string): MenuItem => ({
    label, title, shortcut, checked: () => app.show[k],
    onToggle: (v) => {
      app.show[k] = v;
      if (k === 'scrollBands' && v) app.show.gameView = true;
      if (k === 'anim') app.refresh();
      else if (k === 'layer1' || k === 'layer2' || k === 'layer3' || k === 'ghost') app.recomposite(); else paint();
    },
  });
  // view-only game state (re-runs the level load)
  const gameState = (k: keyof App['switches'], label: string, title: string): MenuItem => ({
    label, title, checked: () => app.switches[k], onToggle: (v) => { app.switches[k] = v; app.refresh(); },
  });
  const anim = show('anim', 'Animation', 'Play animated tiles and palettes (as in the game, custom animations too)');
  const state: MenuItem[] = [
    { heading: 'Game state' },
    gameState('palaces', '!-blocks pressed', 'View: all switch palaces pressed'),
    gameState('onOff', 'ON/OFF set to OFF', 'View: ON/OFF switch set to OFF'),
  ];
  return menuButton({ label: 'View', items: full ? [
    { heading: 'Layers' },
    show('layer1', 'Layer 1'), show('layer2', 'Layer 2 / BG'), show('layer3', 'Layer 3', 'Layer 3 (tides, layer 3 images) – preview, scrolling approximated'),
    show('sprites', 'Sprites'), show('exits', 'Exits'),
    { heading: 'Overlays' },
    show('screens', 'Screen boundaries'), show('grid', 'Grid', undefined, 'G'),
    show('ghost', 'Inactive layer translucent', 'Object layer not being edited shown semi-transparent (only levels with layer 2 objects)'),
    show('items', 'Block contents', 'Contents of blocks (found by emulation) semi-transparent over the blocks, arrows at enterable blocks (pipes, doors)'),
    show('collision', 'Collision', 'How Mario collides with layer 1 (found by emulation): solid sides white, platforms dashed, slopes diagonal; red hurts, blue water, green climbable', 'C'),
    show('arcs', 'Jump arcs at the mouse', 'Where Mario gets jumping from the tile under the mouse (emulated): from standing, walking, running and at P-speed, to both sides; Shift+J pins them to the tile', 'J'),
    show('gameView', 'Game view frame', 'What the player sees: a 256x224 screen over the level; drag it by its edge or label (snaps to 8x8), or Shift+V puts Mario on the tile under the mouse and the frame where the game puts the camera then. The level is darkened where the camera never goes (found by the level scan)', 'V'),
    show('scrollBands', 'Scroll bands', 'In the game view frame: where Mario is while the camera scrolls right, left, up and down, and after L/R looked ahead (found by emulation)'),
    anim,
    ...state,
  ] : [{ heading: 'Level preview' }, anim, ...state] });
}
