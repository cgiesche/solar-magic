// The "Ansicht" menu of the level view, shared by the level editor and the graphics workspace.

import type { App } from './app.ts';
import { menuButton, type MenuItem } from './menu.ts';

// paint: redraws the level view (overlay toggles that need no new composite)
export function viewMenu(app: App, paint: () => void, full = true): HTMLElement {
  const show = (k: keyof App['show'], label: string, title?: string, shortcut?: string): MenuItem => ({
    label, title, shortcut, checked: () => app.show[k],
    onToggle: (v) => {
      app.show[k] = v;
      if (k === 'anim') { app.refresh(); app.emit('show-anim'); }
      else if (k === 'layer1' || k === 'layer2' || k === 'layer3' || k === 'ghost') app.recomposite(); else paint();
    },
  });
  // view-only game state (re-runs the level load)
  const gameState = (k: keyof App['switches'], label: string, title: string): MenuItem => ({
    label, title, checked: () => app.switches[k], onToggle: (v) => { app.switches[k] = v; app.refresh(); },
  });
  const anim = show('anim', 'Animation', 'Animierte Tiles, Paletten und Sprites abspielen (wie im Spiel, auch eigene Animationen; Sprites bewegen sich auf ihrem Platz)');
  const state: MenuItem[] = [
    { heading: 'Spielzustand' },
    gameState('palaces', '!-Blöcke gedrückt', 'Ansicht: alle Switch-Paläste gedrückt'),
    gameState('onOff', 'ON/OFF auf OFF', 'Ansicht: ON/OFF-Schalter auf OFF'),
  ];
  return menuButton({ label: 'Ansicht', items: full ? [
    { heading: 'Ebenen' },
    show('layer1', 'Layer 1'), show('layer2', 'Layer 2 / BG'), show('layer3', 'Layer 3', 'Layer 3 (Flut, Layer-3-Bilder) – Vorschau, Scrollen angenähert'),
    show('sprites', 'Sprites'), show('exits', 'Exits'),
    { heading: 'Hilfen' },
    show('screens', 'Screen-Grenzen'), show('grid', 'Raster', undefined, 'G'),
    show('ghost', 'Inaktive Ebene durchscheinend', 'Nicht bearbeitete Objektebene halbtransparent (nur Level mit Layer-2-Objekten)'),
    show('items', 'Block-Inhalte', 'Inhalt von Blöcken (per Emulation ermittelt) halbtransparent über den Blöcken, Pfeile an betretbaren Blöcken (Pipes, Türen)'),
    anim,
    ...state,
  ] : [{ heading: 'Level-Vorschau' }, anim, ...state] });
}
