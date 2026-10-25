// The Packages dialog: the one place third-party content enters the ROM. "Upload package …" (or a file
// dropped on the dialog) shows the upload preview and installs the package (upload.ts); the Packages tab
// lists every installed package with what it brought (packages.ts); UberASM, Blocks, Sprites and Music
// configure what packages brought. Every change goes into the ROM at once; Ctrl+Z / Ctrl+Y in the dialog
// undo and redo it (ADR 0001).

import type { App } from './app.ts';
import { h, modal, clear, toast, choose } from './dom.ts';
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
import { musicPane } from './musicdialog.ts';
import { musicPlayer } from './musicplayer.ts';
import { errorText } from './projectpane.ts';

export type ResourceTab = PackagesTab;
export interface ResourceOptions {
  tile?: number; // Map16 tile preselected in the blocks tab
  onChange?: () => void; // after the ROM was changed from the dialog
}

const TAB_LABEL: Record<ResourceTab, string> = { packages: 'Packages', uberasm: 'UberASM', block: 'Blocks', sprite: 'Sprites', music: 'Music' };

export async function openResources(app: App, tab: ResourceTab = 'packages', opts: ResourceOptions = {}): Promise<void> {
  const body = h('div', { class: 'resources' }, h('p', { class: 'hint' }, 'Loading Asar …'));
  // undo/redo while the dialog is the topmost one (the editor's own keys wait while a dialog is open);
  // the tabs show the ROM afterwards
  let afterUndo = () => {};
  const keys = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    if (!(e.ctrlKey || e.metaKey) || ![...document.querySelectorAll('.modal-back')].pop()?.contains(body)) return;
    const k = e.key.toLowerCase();
    if (k !== 'z' && k !== 'y') return;
    e.preventDefault();
    if (k === 'y' || e.shiftKey) app.redo(); else app.undo();
    afterUndo();
  };
  window.addEventListener('keydown', keys);
  const dlg = modal('Packages', body, [{ label: 'Close', primary: true }], () => {
    window.removeEventListener('keydown', keys);
    if (musicPlayer.label?.startsWith('song:')) musicPlayer.stop();
  });

  try { await loadAsar(); } catch (e) {
    clear(body).appendChild(h('p', { class: 'hint error' }, `Asar could not be loaded: ${errorText(e)}`));
    return;
  }

  const tabBar = h('div', { class: 'tabs res-tabs' });
  const content = h('div', { class: 'res-content' });
  const changed = () => { patches.reload(); opts.onChange?.(); };
  const renderTabs = () => clear(tabBar).append(...(Object.keys(TAB_LABEL) as ResourceTab[]).map((k) =>
    h('button', { class: k === tab ? 'mode active' : 'mode', onclick: () => show(k) }, TAB_LABEL[k])));
  const p = { uberasm: uberPane(app, changed), block: blockPane(app, changed), sprite: pixiPane(app, changed) };
  const music = musicPane(app, changed);
  afterUndo = () => {
    for (const x of Object.values(p)) x.reload();
    music.reload();
    changed();
  };
  const patches = packagesPane(app, {
    panes: p,
    changed,
    show: (k) => show(k),
    leave: (then) => { dlg.close(true); then(); },
  });
  if (opts.tile !== undefined) p.block.setTile(opts.tile);

  function show(k: ResourceTab): void {
    tab = k;
    renderTabs();
    if (k === 'music') music.render();
    clear(content).appendChild(k === 'packages' ? patches.el : k === 'music' ? music.el : p[k].el);
  }

  // an upload: its preview, then the package installed and selected
  const upload = async (f: File) => {
    const files = new Uint8Array(await f.arrayBuffer());
    const pv = inspectUpload(f.name, files);
    if (pv.status === 'failed') { showUploadFailure(pv.name, pv.reason); return; }
    if (pv.status === 'replaced') { showReplaced(pv.name, pv.notes); return; }
    if (pv.status === 'level-import') {
      // not a package: imported into a level from the level editor
      const i = await choose(`Upload: ${pv.name}`, `“${pv.name}” is a Lunar Magic level file (.mwl): a level import, not a package. It changes a level, so it is imported in the level editor – Level → Import LM level file …`,
        [{ label: 'OK' }, { label: `Import into level ${hex(app.level.number, 3)} …`, primary: true }]);
      if (i === 1) { dlg.close(true); openLevelImportDialog(app, f.name, pv.files); }
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
  // a file dropped anywhere on the dialog is uploaded (not opened as a ROM by the editor's own handler)
  body.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); e.stopPropagation(); body.classList.add('drop-target'); } });
  body.addEventListener('dragleave', (e) => { if (!body.contains(e.relatedTarget as Node)) body.classList.remove('drop-target'); });
  body.addEventListener('drop', (e) => {
    body.classList.remove('drop-target');
    const f = e.dataTransfer?.files[0];
    if (!f) return;
    e.preventDefault();
    e.stopPropagation();
    void upload(f).catch((err) => toast(errorText(err), 'error'));
  });

  clear(body).append(
    h('div', { class: 'row res-top' },
      h('button', { class: 'primary', onclick: () => void pickAndUpload() }, 'Upload package …'),
      h('span', { class: 'hint' }, 'or drop a file here: .asm, .zip (e.g. from SMWCentral, or a whole UberASM Tool, GPS or PIXI folder) or an AddmusicK song – everything it contains is installed as one package.')),
    tabBar,
    content,
  );
  show(tab);
}
