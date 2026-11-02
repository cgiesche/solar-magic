// The level view's settings (the view settings of CONTEXT.md): how the level is shown – zoom, the layers and overlays shown,
// the game view frame – and the view-only game state the level is loaded with (switches, conditional Direct Map16
// flags, animation triggers), which test play takes over. Not part of the level; kept while editing and between levels.

import type { CameraAt } from './camerareach.ts';
import { emptyTriggerView, type TriggerView } from './extrigger.ts';

// what the level view shows (layers, overlays)
export interface Shown {
  layer1: boolean; layer2: boolean; layer3: boolean; sprites: boolean; grid: boolean; screens: boolean; exits: boolean; ghost: boolean; anim: boolean;
  items: boolean; invisible: boolean; deaths: boolean; collision: boolean; preview: boolean; arcs: boolean; gameView: boolean; scrollBands: boolean;
}
// the view-only game state of switches
export interface ViewSwitches { palaces: boolean; onOff: boolean }

export class ViewSettings {
  // the level view's zoom (screen pixels per level pixel, at a screen scale of 100 %)
  zoom = 2;
  // what the level view shows
  show: Shown = { layer1: true, layer2: true, layer3: true, sprites: true, grid: false, screens: true, exits: true, ghost: true, anim: true, items: true, invisible: true, deaths: true, collision: false, preview: false, arcs: false, gameView: false, scrollBands: false };
  // the game view frame's top left corner in level pixels (levelview.ts)
  gameView: { x: number; y: number } | null = null;
  // the frame placed by Mario (Shift+V): his place (inside the level) and the camera the game puts there in the
  // level as edited (key: its result cache key; camera undefined while it is played, null when it could not be);
  // until the frame is dragged; asked for only while the frame is shown
  gameViewMario: { x: number; y: number; key: string | null; camera?: CameraAt | null } | null = null;
  // view-only game state applied before the emulated level load
  switches: ViewSwitches = { palaces: false, onOff: false };
  // the conditional Direct Map16 flags on (cdm16.ts), in the view and in test play
  cdm16 = new Set<number>();
  // the ExAnimation triggers the view switches (extrigger.ts), set after the level's load; test play too
  exTriggers: TriggerView = emptyTriggerView();
}
