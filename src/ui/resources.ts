// The patches dialog: one place for everything assembled into the ROM – Asar patches, UberASM, custom
// blocks and custom sprites, each in a tab. "Hinzufügen …" takes any download and shows it in its tab
// afterwards; the project tabs stage their changes until "Übernehmen", closing asks about pending ones.

import type { App } from './app.ts';
import { h, modal, clear, toast, choose } from './dom.ts';
import { loadAsar } from '../core/asar.ts';
import { patchesPane, pickPackage, type AddTarget } from './patchmanager.ts';
import { uberPane } from './uberdialog.ts';
import { blockPane } from './blockdialog.ts';
import { pixiPane } from './pixidialog.ts';
import { errorText, type Pane } from './projectpane.ts';

export type ResourceTab = AddTarget;
export interface ResourceOptions {
  tile?: number; // Map16 tile preselected in the blocks tab
  onChange?: () => void; // after the ROM was changed from the dialog
}

const TAB_LABEL: Record<ResourceTab, string> = { patches: 'Patches', uber: 'UberASM', blocks: 'Custom Blocks', sprites: 'Custom Sprites' };

export async function openResources(app: App, tab: ResourceTab = 'patches', opts: ResourceOptions = {}): Promise<void> {
  const body = h('div', { class: 'resources' }, h('p', { class: 'hint' }, 'Asar wird geladen …'));
  let panes: Record<'uber' | 'blocks' | 'sprites', Pane> | null = null;
  const pending = () => (panes ? Object.values(panes).filter((p) => p.dirty()) : []);

  // pending changes: apply them all, discard them, or stay
  let asking = false;
  const beforeClose = (): boolean => {
    const dirty = pending();
    if (!dirty.length) return true;
    if (asking) return false;
    asking = true;
    void choose('Nicht übernommene Änderungen', `${dirty.map((p) => p.title).join(', ')}: Änderungen sind noch nicht übernommen.`,
      [{ label: 'Zurück' }, { label: 'Verwerfen', danger: true }, { label: 'Übernehmen', primary: true }]).then((i) => {
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
  const dlg = modal('Patches', body, [{ label: 'Schließen', primary: true }], undefined, beforeClose);

  try { await loadAsar(); } catch (e) {
    clear(body).appendChild(h('p', { class: 'hint error' }, `Asar konnte nicht geladen werden: ${errorText(e)}`));
    return;
  }

  const tabBar = h('div', { class: 'tabs res-tabs' });
  const content = h('div', { class: 'res-content' });
  const changed = () => { patches.reload(); opts.onChange?.(); };
  const renderTabs = () => clear(tabBar).append(...(Object.keys(TAB_LABEL) as ResourceTab[]).map((k) =>
    h('button', { class: k === tab ? 'mode active' : 'mode', onclick: () => show(k), title: panes && k !== 'patches' && panes[k].dirty() ? 'Nicht übernommene Änderungen' : undefined },
      TAB_LABEL[k], panes && k !== 'patches' && panes[k].dirty() ? ' •' : '')));
  const patches = patchesPane(app, changed);
  const p = { uber: uberPane(app, renderTabs, changed), blocks: blockPane(app, renderTabs, changed), sprites: pixiPane(app, renderTabs, changed) };
  panes = p;
  if (opts.tile !== undefined) p.blocks.setTile(opts.tile);
  const keyOf = (pane: Pane) => (Object.keys(p) as (keyof typeof p)[]).find((k) => p[k] === pane) ?? 'patches';

  function show(k: ResourceTab): void {
    tab = k;
    renderTabs();
    clear(content).appendChild(k === 'patches' ? patches.el : p[k].el);
  }

  const add = async () => {
    let picked;
    try { picked = await pickPackage(app); } catch (e) { toast(errorText(e), 'error'); return; }
    if (!picked) return;
    const pk = picked;
    // the add dialogs work on the ROM's projects: staged changes of those first
    const dirty = pk.affects.flatMap((k) => (k !== 'patches' && p[k].dirty() ? [p[k]] : []));
    if (dirty.length) {
      const i = await choose('Nicht übernommene Änderungen', `„${pk.name}“ wird direkt in die ROM übernommen. ${dirty.map((x) => x.title).join(', ')}: Änderungen sind noch nicht übernommen – vorher …`,
        [{ label: 'Abbrechen' }, { label: 'Verwerfen', danger: true }, { label: 'Übernehmen', primary: true }]);
      if (i === null || i === 0) return;
      if (i === 1) for (const x of dirty) x.discard();
      else { const failed = dirty.find((x) => !x.apply()); if (failed) { show(keyOf(failed)); return; } }
    }
    pk.open({ uberContext: p.uber.context(), tile: p.blocks.tile() }, () => {
      for (const k of pk.affects) if (k !== 'patches') p[k].reload();
      if (pk.target) show(pk.target);
      changed();
    });
  };

  clear(body).append(
    h('div', { class: 'row res-top' },
      h('button', { class: 'primary', onclick: add }, 'Hinzufügen …'),
      h('span', { class: 'hint' }, '.asm oder .zip (z. B. von SMWCentral) – erkannt wird, ob Patch, UberASM-Code, Custom Block, Block-Paket, Custom Sprite oder Hintergrund.')),
    tabBar,
    content,
  );
  show(tab);
}
