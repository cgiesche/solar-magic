// The Packages workspace (#484, formerly a dialog): the one place third-party content enters the ROM. "Upload
// package …" (or a file dropped on the workspace) shows the upload preview and installs the package (upload.ts); the Packages tab
// lists every installed package with what it brought (packages.ts); UberASM, Blocks, Sprites, Overworld sprites and Music
// configure what packages brought. Every change goes into the ROM at once; Ctrl+Z / Ctrl+Y undo and redo it
// (ADR 0001).

import type { App } from './app.ts';
import { h, clear, toast, choose } from './dom.ts';
import { pickFile } from './platform.ts';
import { hex } from '../core/names.ts';
import { openLevelImportDialog } from './levelimport.ts';
import { loadAsar } from '../core/asar.ts';
import type { PackagesTab } from './patchmanager.ts';
import { packagesPane } from './packages.ts';
import { inspectUpload } from '../core/packages.ts';
import { openUploadPreview, showUploadFailure, showReplaced } from './upload.ts';
import { uberPane } from './uberdialog.ts';
import { blockPane } from './blockdialog.ts';
import { pixiPane } from './pixidialog.ts';
import { bowsiePane } from './bowsiedialog.ts';
import { musicPane } from './musicdialog.ts';
import { musicPlayer } from './musicplayer.ts';
import { errorText } from './projectpane.ts';

export type ResourceTab = PackagesTab;
export interface ResourceOptions {
  tile?: number; // Map16 tile preselected in the blocks tab
  onChange?: () => void; // after the ROM was changed from the dialog
}

const TAB_LABEL: Record<ResourceTab, string> = { packages: 'Packages', uberasm: 'UberASM', block: 'Blocks', sprite: 'Sprites', owsprite: 'Overworld sprites', music: 'Music' };

// the workspace shown by openResources (set by main.ts: it switches to the Packages workspace)
let host: ((tab: ResourceTab, opts: ResourceOptions) => void) | null = null;
export function setResourcesHost(fn: (tab: ResourceTab, opts: ResourceOptions) => void): void { host = fn; }

/** The Packages workspace at a tab (ROM → Packages, G 5, Map16's "Custom blocks …"). */
export async function openResources(_app: App, tab: ResourceTab = 'packages', opts: ResourceOptions = {}): Promise<void> {
  host?.(tab, opts);
}

// The Packages workspace (#484): the navigator lists the kinds (Packages, UberASM, Blocks, Sprites, Overworld sprites,
// Music), the main area what the chosen one holds; "Upload package …" in the context bar, a file dropped anywhere on
// the workspace uploaded. Changes go into the ROM at once (ADR 0001); Ctrl+Z / Ctrl+Y as everywhere – afterUndo draws
// the panes again.
export class PackagesWorkspace {
  readonly bar = h('div', { class: 'ctxbar' });
  readonly left = h('div', { class: 'left pkg-nav' });
  readonly root = h('div', { class: 'center pkg-main' });
  readonly side = h('div', { class: 'right pkg-side' });
  onLeave: (then: () => void) => void = (then) => then();
  private tab: ResourceTab = 'packages';
  private opts: ResourceOptions = {};
  private ready: Promise<void> | null = null;
  private show: (k: ResourceTab) => void = () => {};
  private setTile: (t: number) => void = () => {};
  /** The panes drawn again after an undo or redo. */
  afterUndo: () => void = () => {};

  constructor(private app: App) {}

  /** Shown at tab; opts: the Blocks tab's tile, what to call after a change. */
  async enter(tab: ResourceTab, opts: ResourceOptions = {}): Promise<void> {
    this.tab = tab;
    this.opts = opts;
    this.ready ??= this.build();
    await this.ready;
    if (opts.tile !== undefined) this.setTile(opts.tile);
    this.show(tab);
  }

  leave(): void {
    if (musicPlayer.label?.startsWith('song:')) musicPlayer.stop();
  }

  private async build(): Promise<void> {
    const app = this.app, body = this.root;
    body.replaceChildren(h('p', { class: 'hint' }, 'Loading Asar …'));
    try { await loadAsar(); } catch (e) {
      clear(body).appendChild(h('p', { class: 'hint error' }, `Asar could not be loaded: ${errorText(e)}`));
      return;
    }
    const nav = h('div', { class: 'tabbar pkg-kinds', role: 'tablist', 'aria-orientation': 'vertical' });
    const content = h('div', { class: 'res-content' });
    const changed = () => { patches.reload(); this.opts.onChange?.(); };
    const renderTabs = () => clear(nav).append(...(Object.keys(TAB_LABEL) as ResourceTab[]).map((k) =>
      h('button', { class: k === this.tab ? 'active' : '', onclick: () => show(k) }, TAB_LABEL[k])));
    const p = { uberasm: uberPane(app, changed), block: blockPane(app, changed), sprite: pixiPane(app, changed), owsprite: bowsiePane(app, changed) };
    const music = musicPane(app, changed);
    this.afterUndo = () => {
      for (const x of Object.values(p)) x.reload();
      music.reload();
      changed();
    };
    const patches = packagesPane(app, {
      panes: p,
      changed,
      show: (k) => show(k),
      leave: (then) => this.onLeave(then),
    });
    this.setTile = (t) => p.block.setTile(t);
    const show = (k: ResourceTab): void => {
      this.tab = k;
      renderTabs();
      if (k === 'music') music.render();
      clear(content).appendChild(k === 'packages' ? patches.el : k === 'music' ? music.el : p[k].el);
    };
    this.show = show;

    // an upload: its preview, then the package installed and selected
    const upload = async (f: File) => {
      const files = new Uint8Array(await f.arrayBuffer());
      const pv = inspectUpload(f.name, files);
      if (pv.status === 'failed') { showUploadFailure(pv.name, pv.reason); return; }
      if (pv.status === 'replaced') { showReplaced(pv.name, pv.notes); return; }
      if (pv.status === 'level-import') {
        // not a package: imported into a level from the level editor
        const i = await choose(`Upload: ${pv.name}`, `“${pv.name}” is a Lunar Magic level file (.mwl): a level import, not a package. It changes a level, so it is imported in the level editor – Level → Import LM level file …`,
          [{ label: 'Not now' }, { label: `Import into level ${hex(app.level.number, 3)} …`, primary: true }]);
        if (i === 1) this.onLeave(() => openLevelImportDialog(app, f.name, pv.files));
        return;
      }
      openUploadPreview(app, pv, () => {
        for (const x of Object.values(p)) x.reload();
        music.reload();
        show('packages');
        changed();
      });
    };
    const pickAndUpload = async () => {
      const f = await pickFile('.asm,.asar,.zip,.txt,.mwl');
      if (f) await upload(f).catch((e) => toast(errorText(e), 'error'));
    };
    // a file dropped anywhere on the workspace is uploaded (not opened as a ROM by the editor's own handler)
    const area = [this.left, this.root];
    for (const el of area) {
      el.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); e.stopPropagation(); body.classList.add('drop-target'); } });
      el.addEventListener('dragleave', (e) => { if (!area.some((a) => a.contains(e.relatedTarget as Node))) body.classList.remove('drop-target'); });
      el.addEventListener('drop', (e) => {
        body.classList.remove('drop-target');
        const f = e.dataTransfer?.files[0];
        if (!f) return;
        e.preventDefault();
        e.stopPropagation();
        void upload(f).catch((err) => toast(errorText(err), 'error'));
      });
    }

    this.bar.replaceChildren(
      h('button', { class: 'primary', onclick: () => void pickAndUpload() }, 'Upload package …'),
      h('span', { class: 'hint', title: '.asm, .zip (e.g. from SMWCentral, or a whole UberASM Tool, GPS or PIXI folder), an AddmusicK song or sound effects (in folders 1DF9/1DFC) – everything it contains is installed as one package' },
        'or drop a file anywhere here'),
      h('span', { class: 'spacer' }),
      h('span', { class: 'hint' }, 'Changes apply immediately · Ctrl+Z undoes'));
    this.left.replaceChildren(h('div', { class: 'panel' }, h('div', { class: 'panel-title' }, 'Packages'), nav));
    clear(body).append(h('div', { class: 'resources' }, content));
  }
}
