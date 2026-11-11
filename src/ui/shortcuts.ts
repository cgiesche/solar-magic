// The keyboard scheme (#482): one table of every key and mouse gesture. The help dialog lists it, the command palette
// (#483) shows a command's key from it. Global keys work in every workspace; a workspace's keys only there, with the
// same rules everywhere – numbers pick the tool rail's modes from the top, letters its tools, G then a key goes to a
// place (G 1 … G 5 the workspaces, G P / G M / G G / G A the Graphics views), Esc only cancels (never leaves a
// workspace), Ctrl+click adds to the selection, Alt+click takes the element underneath, F12 goes to a definition.

export type WorkspaceId = 'level' | 'ow' | 'gfx' | 'game' | 'pkg';
export type GfxViewId = 'pal' | 'map16' | 'gfx' | 'anim';
/** The places of G then a key (#482): the one table the key handler, its hint, the command palette and the help read. */
export const GO_PLACES: { key: string; label: string; workspace: WorkspaceId; view?: GfxViewId }[] = [
  { key: '1', label: 'Level', workspace: 'level' },
  { key: '2', label: 'Overworld', workspace: 'ow' },
  { key: '3', label: 'Graphics', workspace: 'gfx' },
  { key: '4', label: 'Game', workspace: 'game' },
  { key: '5', label: 'Packages', workspace: 'pkg' },
  { key: 'P', label: 'Palettes', workspace: 'gfx', view: 'pal' },
  { key: 'G', label: 'Graphics', workspace: 'gfx', view: 'gfx' },
  { key: 'M', label: 'Map16 tiles', workspace: 'gfx', view: 'map16' },
  { key: 'A', label: 'Animations', workspace: 'gfx', view: 'anim' },
];
const goKeys = (views: boolean) => GO_PLACES.filter((g) => !!g.view === views);

export type ShortcutScope = 'General' | 'Level' | 'Overworld' | 'Graphics' | 'Pixel editor' | 'Map16 tiles' | 'Test play' | 'Mouse';
export type Shortcut = { scope: ShortcutScope; keys: string; what: string; id?: string };

export const SHORTCUTS: Shortcut[] = [
  // general
  { scope: 'General', keys: goKeys(false).map((g) => `G ${g.key}`).join(' / '), what: `Workspace ${goKeys(false).map((g) => g.label).join(' / ')}` },
  { scope: 'General', keys: goKeys(true).map((g) => `G ${g.key}`).join(' / '), what: `Graphics: ${goKeys(true).map((g) => g.label).join(' / ')}` },
  { scope: 'General', keys: 'Ctrl+K · Ctrl+F · Ctrl+Space', what: 'Search everywhere and run commands', id: 'search' },
  { scope: 'General', keys: 'Ctrl+Z / Ctrl+Y (Ctrl+Shift+Z)', what: 'Undo / Redo – also in dialogs that apply at once', id: 'undo' },
  { scope: 'General', keys: 'Ctrl+S', what: 'Save the level', id: 'save' },
  { scope: 'General', keys: 'T · Shift+T', what: 'Test play · the level from the mouse position', id: 'test' },
  { scope: 'General', keys: 'Esc', what: 'Cancel: a drag, then the selection, then the picked item – never leaves a workspace' },
  { scope: 'General', keys: 'Menu key · Shift+F10', what: 'Context menu of the focused control or of what is under the mouse' },
  { scope: 'General', keys: 'F12', what: 'Go to definition of what is under the mouse (an animated tile or color, a Map16 tile, a palette)' },
  { scope: 'General', keys: 'F2', what: 'Rename (an object or prefab in the picker, Map16 tiles)' },
  { scope: 'General', keys: "Ctrl+'", what: 'Grid on/off', id: 'grid' },
  { scope: 'General', keys: 'L', what: 'Bottom panel (Problems | Log) open/closed', id: 'panel' },
  { scope: 'General', keys: 'Alt+← / Alt+→ · mouse back/forward', what: 'Back / forward through the places opened' },
  { scope: 'General', keys: '? / F1', what: 'This overview', id: 'help' },
  { scope: 'General', keys: 'Menus: ↑ ↓ ← → / Enter / Esc', what: 'Choose an entry, the neighboring menu / run it / close' },
  // mouse, the same everywhere
  { scope: 'Mouse', keys: 'Click', what: 'Select; on a brush surface (BG, layer 3, overworld, game) pick up tiles' },
  { scope: 'Mouse', keys: 'Ctrl+click', what: 'Add to the selection' },
  { scope: 'Mouse', keys: 'Alt+click', what: 'The element underneath (overworld: the tile\'s info)' },
  { scope: 'Mouse', keys: 'Right click / Shift+click', what: 'Place the picked item / paint (ADR 0011)' },
  { scope: 'Mouse', keys: 'Middle button drag · Ctrl+wheel', what: 'Pan · zoom' },
  // level
  { scope: 'Level', keys: '1 … 6', what: 'Mode Layer 1 / Layer 2 / Sprites / Entrances/Exits / BG / Layer 3 (the tool rail)' },
  { scope: 'Level', keys: 'Drag · a handle', what: 'Move the selection or drag a selection box · resize (the opposite edges stay)' },
  { scope: 'Level', keys: 'H', what: 'Level header …', id: 'header' },
  { scope: 'Level', keys: 'I / Insert', what: 'Insert by number … (at the mouse)', id: 'insert' },
  { scope: 'Level', keys: 'M', what: 'The tile under the mouse in Map16 tiles' },
  { scope: 'Level', keys: 'C · J · Shift+J', what: 'Collision on/off · jump arcs at the mouse on/off · pin them' },
  { scope: 'Level', keys: 'V · Shift+V', what: 'Game view frame on/off · placed by Mario at the mouse' },
  { scope: 'Level', keys: 'Arrow keys · Alt+arrows · Alt+Shift+arrows', what: 'Move the selection · resize at the right/bottom · at the left/top' },
  { scope: 'Level', keys: '+ / - · * / /', what: 'Width · height' },
  { scope: 'Level', keys: 'PgUp / PgDn', what: 'Bring to front / send to back' },
  { scope: 'Level', keys: 'Ctrl+C / Ctrl+V / Ctrl+D / Ctrl+A · Del', what: 'Copy / paste at the mouse / duplicate / select all · delete' },
  { scope: 'Level', keys: 'Drag M / Z / S', what: 'Move the main entrance / midway point / secondary entrance' },
  // overworld
  { scope: 'Overworld', keys: '1 / 2 / 3', what: 'Mode Layer 1 (paths, levels & links) / Layer 2 (terrain) / Sprites (the tool rail)' },
  { scope: 'Overworld', keys: 'B / R', what: 'Layer 1: tile brush / route brush “Path (auto)”' },
  { scope: 'Overworld', keys: 'M', what: 'The selected tile in Map16 tiles' },
  { scope: 'Overworld', keys: ', / .', what: 'Edit the event one row up / down' },
  { scope: 'Overworld', keys: 'Space', what: 'Check / uncheck the edited event' },
  { scope: 'Overworld', keys: 'Q (held)', what: 'The other layer hidden while painting' },
  { scope: 'Overworld', keys: 'Del', what: 'Remove the selected level tile, link or sprite' },
  // graphics
  { scope: 'Graphics', keys: 'Ctrl+C / Ctrl+V', what: 'Copy / paste a palette row, Map16 tiles or pixels' },
  { scope: 'Graphics', keys: 'Palettes: arrow keys · Shift+click', what: 'Another color · mark a range (for “Gradient”)' },
  { scope: 'Map16 tiles', keys: 'Shift+H / Shift+V · 1–8 · Q', what: 'Flip the marked quarters · their palette · next quarter' },
  { scope: 'Map16 tiles', keys: 'Double click', what: 'Edit the quarter in Graphics' },
  { scope: 'Pixel editor', keys: 'S / B / E / F / I', what: 'Select / pen / eraser / fill / eyedropper (the tool rail)' },
  { scope: 'Pixel editor', keys: 'Shift+H / Shift+V / Shift+R', what: 'Flip horizontally / vertically / rotate' },
  { scope: 'Pixel editor', keys: '0–9 · X', what: 'Left color · swap the left and right color' },
  { scope: 'Pixel editor', keys: 'Enter / Esc', what: 'Put the floating selection down / cancel it' },
  // test play
  { scope: 'Test play', keys: 'Arrows · X · Z / Y · S · A', what: 'Move · jump (B) · run, fire (Y) · spin jump (A) · the X button' },
  { scope: 'Test play', keys: 'Enter · Shift · Q / W', what: 'Start · Select · L / R' },
  { scope: 'Test play', keys: 'P · M · Backspace (held)', what: 'Pause · sound · rewind' },
  { scope: 'Test play', keys: 'F5 / F8', what: 'Save state / restart from the savestate' },
];

/** The table grouped by scope, in its order. */
export function shortcutSections(): [ShortcutScope, Shortcut[]][] {
  const out = new Map<ShortcutScope, Shortcut[]>();
  for (const s of SHORTCUTS) out.set(s.scope, [...(out.get(s.scope) ?? []), s]);
  return [...out];
}
