// The patches dialog: one place for everything assembled into the ROM. "Packages" lists every added download
// with what it brought (see packages.ts); the tabs UberASM, Custom Blocks and Custom Sprites show the
// tool projects as a whole. "Add …" takes any download and shows it as a package afterwards. Every
// change goes into the ROM at once; Ctrl+Z / Ctrl+Y in the dialog undo and redo it (ADR 0001).

import type { App } from './app.ts';
import { h, modal, clear, toast } from './dom.ts';
import { loadAsar } from '../core/asar.ts';
import { pickUpload, recognize, type PackagesTab, type PickedUpload } from './patchmanager.ts';
import { packagesPane } from './packages.ts';
import type { ToolKind } from '../core/parts.ts';
import { trackPackage, findPackage } from './pkgtrack.ts';
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

const TAB_LABEL: Record<ResourceTab, string> = { packages: 'Packages', uberasm: 'UberASM', block: 'Custom Blocks', sprite: 'Custom Sprites', music: 'Music' };
const isTool = (k: ResourceTab): k is ToolKind => k !== 'packages' && k !== 'music';

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
  const dlg = modal('Patches', body, [{ label: 'Close', primary: true }], () => {
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
    addPart: (name, files, rec) => {
      // later parts go into the package (its record, looked up again: it may have changed since)
      const cur = findPackage(app, rec.id) ?? rec;
      void run(recognize(app, name, files, false, trackPackage(app, cur.name, cur.fileName, null, cur)));
    },
  });
  if (opts.tile !== undefined) p.block.setTile(opts.tile);

  function show(k: ResourceTab): void {
    tab = k;
    renderTabs();
    if (k === 'music') music.render();
    clear(content).appendChild(k === 'packages' ? patches.el : k === 'music' ? music.el : p[k].el);
  }

  // opens the dialog adding a package, the tabs it changed reloaded afterwards
  const run = async (pk: PickedUpload) => {
    pk.open({ uberContext: p.uberasm.context(), tile: p.block.tile() }, () => {
      for (const k of pk.affects) if (isTool(k)) p[k].reload(); else if (k === 'music') music.reload();
      if (pk.target) show('packages');
      changed();
    });
  };
  const add = async (manual = false) => {
    let picked;
    try { picked = await pickUpload(app, manual); } catch (e) { toast(errorText(e), 'error'); return; }
    if (picked) await run(picked);
  };

  clear(body).append(
    h('div', { class: 'row res-top' },
      h('button', { class: 'primary', onclick: () => add() }, 'Add …'),
      h('button', { onclick: () => add(true), title: 'Assign a package’s folders and files to folders of the UberASM project yourself – for packages that are more than one resource' }, 'Assign manually …'),
      h('span', { class: 'hint' }, '.asm or .zip (e.g. from SMWCentral) – recognized as patch, UberASM code, custom block, block package, custom sprite, graphics (Lunar Magic: background, Map16 tiles) or music (AddmusicK).')),
    tabBar,
    content,
  );
  show(tab);
}
