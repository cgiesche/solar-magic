// GFX tab (placeholder until the new editor is in place: opens the old dialog).

import type { App } from '../app.ts';
import type { GfxWorkspace, WsPanel } from '../gfxworkspace.ts';
import { h } from '../dom.ts';
import { openGfxEditor } from '../gfxeditor.ts';

export class GfxTab implements WsPanel {
  root: HTMLElement;
  constructor(app: App, _ws: GfxWorkspace) {
    this.root = h('div', { class: 'ws-placeholder' }, h('button', { onclick: () => openGfxEditor(app) }, 'Grafik-Editor öffnen'));
  }
  show(): void {}
  select(_file: number, _tile?: number): void {}
}
