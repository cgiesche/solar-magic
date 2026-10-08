// The patches dialog: one place for everything assembled into the ROM. "Packages" lists every added download
// with what it brought (see packages.ts); the tabs UberASM, Custom Blocks and Custom Sprites show the
// tool projects as a whole. "Add …" takes any download and shows it as a package afterwards; the
// project tabs stage their changes until "Apply", closing asks about pending ones.

import type { App } from './app.ts';
import { h, modal, clear, toast, choose } from './dom.ts';
import { loadAsar } from '../core/asar.ts';
import { pickUpload, recognize, type PackagesTab, type PickedUpload } from './patchmanager.ts';
import { packagesPane } from './packages.ts';
import { TOOL_KINDS, type ToolKind } from '../core/parts.ts';
import { trackPackage, findPackage } from './pkgtrack.ts';
import { uberPane } from './uberdialog.ts';
import { blockPane } from './blockdialog.ts';
import { pixiPane } from './pixidialog.ts';
import { musicPane } from './musicdialog.ts';
import { musicPlayer } from './musicplayer.ts';
import { errorText, type Pane } from './projectpane.ts';

export type ResourceTab = PackagesTab;
export interface ResourceOptions {
  tile?: number; // Map16 tile preselected in the blocks tab
  onChange?: () => void; // after the ROM was changed from the dialog
}

const TAB_LABEL: Record<ResourceTab, string> = { packages: 'Packages', uberasm: 'UberASM', block: 'Custom Blocks', sprite: 'Custom Sprites', music: 'Music' };
const staged = (k: ResourceTab): k is ToolKind => k !== 'packages' && k !== 'music';

export async function openResources(app: App, tab: ResourceTab = 'packages', opts: ResourceOptions = {}): Promise<void> {
  const body = h('div', { class: 'resources' }, h('p', { class: 'hint' }, 'Loading Asar …'));
  let panes: Record<ToolKind, Pane> | null = null;
  const pending = () => (panes ? Object.values(panes).filter((p) => p.dirty()) : []);

  // pending changes: apply them all, discard them, or stay
  let asking = false;
  const beforeClose = (): boolean => {
    const dirty = pending();
    if (!dirty.length) return true;
    if (asking) return false;
    asking = true;
    void choose('Unapplied changes', `${dirty.map((p) => p.title).join(', ')}: changes have not been applied yet.`,
      [{ label: 'Back' }, { label: 'Discard', danger: true }, { label: 'Apply', primary: true }]).then((i) => {
      asking = false;
      if (i === 1) dlg.close(true);
      else if (i === 2) {
        const failed = dirty.find((p) => !p.apply());
        if (!failed) dlg.close(true);
        else show(keyOf(failed));
      }
    });
    return false;
  };
  const dlg = modal('Patches', body, [{ label: 'Close', primary: true }], () => { if (musicPlayer.label?.startsWith('song:')) musicPlayer.stop(); }, beforeClose);

  try { await loadAsar(); } catch (e) {
    clear(body).appendChild(h('p', { class: 'hint error' }, `Asar could not be loaded: ${errorText(e)}`));
    return;
  }

  const tabBar = h('div', { class: 'tabs res-tabs' });
  const content = h('div', { class: 'res-content' });
  const changed = () => { patches.reload(); opts.onChange?.(); };
  const renderTabs = () => clear(tabBar).append(...(Object.keys(TAB_LABEL) as ResourceTab[]).map((k) =>
    h('button', { class: k === tab ? 'mode active' : 'mode', onclick: () => show(k), title: panes && staged(k) && panes[k].dirty() ? 'Unapplied changes' : undefined },
      TAB_LABEL[k], panes && staged(k) && panes[k].dirty() ? ' •' : '')));
  const p = { uberasm: uberPane(app, renderTabs, changed), block: blockPane(app, renderTabs, changed), sprite: pixiPane(app, renderTabs, changed) };
  const music = musicPane(app, changed);
  panes = p;
  // staged changes of these tabs applied or discarded before the ROM is changed directly; false: back
  const settle = async (keys: (keyof typeof p)[], what: string): Promise<boolean> => {
    const dirty = keys.flatMap((k) => (p[k].dirty() ? [p[k]] : []));
    if (!dirty.length) return true;
    const i = await choose('Unapplied changes', `${what} ${dirty.map((x) => x.title).join(', ')}: changes have not been applied yet – first …`,
      [{ label: 'Cancel' }, { label: 'Discard', danger: true }, { label: 'Apply', primary: true }]);
    if (i === null || i === 0) return false;
    if (i === 1) for (const x of dirty) x.discard();
    else { const failed = dirty.find((x) => !x.apply()); if (failed) { show(keyOf(failed)); return false; } }
    return true;
  };
  const patches = packagesPane(app, {
    panes: p,
    changed,
    show: (k) => show(k),
    settle,
    leave: (then) => void settle(TOOL_KINDS, 'The dialog will be closed.').then((ok) => { if (ok) { dlg.close(true); then(); } }),
    addPart: (name, files, rec) => {
      // later parts go into the package (its record, looked up again: it may have changed since)
      const cur = findPackage(app, rec.id) ?? rec;
      void run(recognize(app, name, files, false, trackPackage(app, cur.name, cur.fileName, null, cur)));
    },
  });
  if (opts.tile !== undefined) p.block.setTile(opts.tile);
  const keyOf = (pane: Pane) => (Object.keys(p) as (keyof typeof p)[]).find((k) => p[k] === pane) ?? 'packages';

  function show(k: ResourceTab): void {
    tab = k;
    renderTabs();
    if (k === 'music') music.render();
    clear(content).appendChild(k === 'packages' ? patches.el : k === 'music' ? music.el : p[k].el);
  }

  // opens the dialog adding a package, the tabs it changed reloaded afterwards
  const run = async (pk: PickedUpload) => {
    // the add dialogs work on the ROM's projects: staged changes of those first
    if (!(await settle(pk.affects.filter(staged), `“${pk.name}” goes directly into the ROM.`))) return;
    pk.open({ uberContext: p.uberasm.context(), tile: p.block.tile() }, () => {
      for (const k of pk.affects) if (staged(k)) p[k].reload(); else if (k === 'music') music.reload();
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
