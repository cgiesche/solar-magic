// Map16 tab (placeholder until the new editor is in place: opens the old dialog).

import type { App } from '../app.ts';
import type { GfxWorkspace, WsPanel } from '../gfxworkspace.ts';
import { h } from '../dom.ts';
import { openMap16Editor } from '../map16editor.ts';

export class Map16Tab implements WsPanel {
  root: HTMLElement;
  private tile = 0;
  private app: App;
  constructor(app: App, _ws: GfxWorkspace) {
    this.app = app;
    this.root = h('div', { class: 'ws-placeholder' }, h('button', { onclick: () => openMap16Editor(this.app, this.tile) }, 'Map16-Editor öffnen'));
  }
  show(): void {}
  select(tile: number, _bg = false): void { this.tile = tile; }
}
