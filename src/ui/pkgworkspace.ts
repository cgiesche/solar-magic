// The Packages workspace (#484, formerly a dialog): the one place third-party content enters the ROM. "Upload
// package …" (or a file dropped on the workspace) shows the upload preview and installs the package (upload.ts); the
// navigator lists the installed packages and the kinds of parts, the main area a package with what it brought
// (packages.ts) or a kind – UberASM, Blocks, Sprites, Overworld sprites and Music configure what packages brought –
// and the side panel the chosen part with its settings (pkginspect.ts, #517). Every change goes into the ROM at
// once; Ctrl+Z / Ctrl+Y undo and redo it (ADR 0001).

import type { App } from './app.ts';
import { h, clear, toast, choose, IMMEDIATE_NOTE } from './dom.ts';
import { pickFile } from './platform.ts';
import { hex } from '../core/names.ts';
import { openLevelImportDialog } from './levelimport.ts';
import { loadAsar } from '../core/asar.ts';
import type { PackagesTab } from './patchmanager.ts';
import { packagesView, PART_KINDS, PART_LABEL, type PackagesView, type PartKind } from './packages.ts';
import { PartSelection } from './pkginspect.ts';
import { currentSongs } from './musicdialog.ts';
import { contextMenu } from './menu.ts';
import { icon } from './icons.ts';
import { packageSummary } from '../core/pkgreg.ts';
import type { UberProject } from '../core/uberproject.ts';
import { inspectUpload } from '../core/packages.ts';
import { openUploadPreview, showUploadFailure, showReplaced } from './upload.ts';
import { uberPane } from './uberdialog.ts';
import { blockPane } from './blockdialog.ts';
import { pixiPane } from './pixidialog.ts';
import { bowsiePane } from './bowsiedialog.ts';
import { musicPane } from './musicdialog.ts';
import { musicPlayer } from './musicplayer.ts';
import { errorText } from './projectpane.ts';

export type PackagesKind = PackagesTab; // (the navigator's kinds: Packages, UberASM, Blocks, …)
export interface PackagesOptions {
  tile?: number; // Map16 tile preselected in the blocks tab
  onChange?: () => void; // after the ROM was changed from the dialog
}

// the kinds with a configuration view of their own (always listed; the others only when a package brought any)
const PANE_KINDS: PartKind[] = ['uberasm', 'block', 'sprite', 'owsprite', 'music'];

// the workspace shown by openPackages (set by main.ts: it switches to the Packages workspace)
let host: ((tab: PackagesKind, opts: PackagesOptions) => void) | null = null;
export function setPackagesHost(fn: (tab: PackagesKind, opts: PackagesOptions) => void): void { host = fn; }

/** The Packages workspace at a tab (ROM → Packages, G 5, Map16's "Custom blocks …"). */
export async function openPackages(tab: PackagesKind = 'packages', opts: PackagesOptions = {}): Promise<void> {
  host?.(tab, opts);
}

// The Packages workspace (#484, #517): the navigator lists the installed packages, then the kinds of parts; the main
// area shows the chosen package or kind, the side panel the chosen part. "Upload package …" in the context bar, a
// file dropped anywhere on the workspace uploaded. Changes go into the ROM at once (ADR 0001); Ctrl+Z / Ctrl+Y as
// everywhere – afterUndo draws everything again.
export class PackagesWorkspace {
  readonly bar = h('div', { class: 'ctxbar' });
  readonly left = h('div', { class: 'left pkg-nav' });
  readonly root = h('div', { class: 'center pkg-main' });
  readonly side = h('div', { class: 'right pkg-side' });
  onLeave: (then: () => void) => void = (then) => then();
  private opts: PackagesOptions = {};
  private ready: Promise<void> | null = null;
  private show: (v: PackagesView | null) => void = () => {};
  private setTile: (t: number) => void = () => {};
  /** Everything drawn again after an undo or redo. */
  afterUndo: () => void = () => {};

  constructor(private app: App) {}

  /** Shown at tab ('packages': the package shown last); opts: the Blocks view's tile, what to call after a change. */
  async enter(tab: PackagesKind, opts: PackagesOptions = {}): Promise<void> {
    this.opts = opts;
    this.ready ??= this.build();
    await this.ready;
    if (opts.tile !== undefined) this.setTile(opts.tile);
    this.show(tab === 'packages' ? null : { kind: tab });
  }

  leave(): void {
    if (musicPlayer.label?.startsWith('song:')) musicPlayer.stop();
  }

  private async build(): Promise<void> {
    const app = this.app, body = this.root;
    body.replaceChildren(h('p', { class: 'hint' }, 'Loading Asar …'));
    try { await loadAsar(); } catch (e) {
      clear(body).appendChild(h('p', { class: 'hint error' }, `Asar could not be loaded: ${errorText(e)}`));
      this.ready = null; // (tried again the next time the workspace is shown)
      return;
    }
    const nav = h('div', { class: 'pkg-navlist' });
    const content = h('div', { class: 'pkg-area' });
    let view: PackagesView = { pkg: '' };
    let lastPkg = ''; // the package shown last
    let filter = '';
    const leave = (then: () => void) => this.onLeave(then);
    const sel = new PartSelection(this.side, () => draw());
    const part = { sel, showPackage: (id: string) => show({ pkg: id }) };
    const changed = () => { pkgs.reload(); draw(); this.opts.onChange?.(); };
    const p = {
      uberasm: uberPane(app, changed, part), block: blockPane(app, changed, part, (t) => leave(() => app.editTile(t))),
      sprite: pixiPane(app, changed, part), owsprite: bowsiePane(app, changed, part),
    };
    const music = musicPane(app, changed);
    const pkgs = packagesView(app, { panes: p, sel, changed, show: (v) => show(v), leave });
    this.afterUndo = () => {
      for (const x of Object.values(p)) x.reload();
      music.reload();
      changed();
    };
    this.setTile = (t) => p.block.setTile(t);

    // how many of a kind the ROM has (the configuration views: what their project lists, from a package or not)
    const count = (k: PartKind): number => {
      if (k === 'uberasm') { const l = (p.uberasm.project() as UberProject).list; return [l.level, l.overworld, l.gamemode].reduce((n, m) => n + [...m.values()].reduce((a, c) => a + c.length, 0), 0); }
      if (k === 'block' || k === 'sprite' || k === 'owsprite') return (p[k].project() as unknown as { list: unknown[] }).list.length;
      if (k === 'music') return currentSongs(app).filter((x) => x.kind === 'custom').length;
      return pkgs.list().reduce((n, it) => n + it.parts.filter((x) => x.kind === k).length, 0);
    };

    const drawNav = () => {
      const q = filter.trim().toLowerCase();
      const items = pkgs.list().filter((it) => !q || it.rec.name.toLowerCase().includes(q) || it.parts.some((x) => `${x.num} ${x.name}`.toLowerCase().includes(q)));
      const kinds = PART_KINDS.map((k) => [k, count(k)] as const).filter(([k, n]) => (n || PANE_KINDS.includes(k)) && (!q || PART_LABEL[k].toLowerCase().includes(q)));
      const loose = pkgs.loose();
      clear(nav).append(
        h('div', { class: 'panel-title' }, 'Installed', h('span', { class: 'hint' }, String(pkgs.list().length))),
        ...items.map((it) => h('button', {
          class: 'pkg-navitem pkg' + ('pkg' in view && view.pkg === it.rec.id ? ' active' : ''), title: it.rec.fileName, onclick: () => show({ pkg: it.rec.id }),
          // (#480: the package's removal also as a context menu; its other actions are on its page)
          oncontextmenu: (e: MouseEvent) => {
            e.preventDefault();
            show({ pkg: it.rec.id });
            contextMenu(e.clientX, e.clientY, [{ label: 'Remove …', title: 'Remove the package and what it brought (asks first)', onClick: () => void pkgs.remove(it.rec) }]);
          } },
          h('span', { class: 'pkg-navtext' }, h('span', { class: 'pkg-navname' }, it.rec.name), h('span', { class: 'hint' }, packageSummary(it.rec).join(' · '))),
          it.warn ? h('span', { class: 'pkg-warn', title: it.warn }, icon('warning')) : '')),
        pkgs.list().length ? (items.length ? '' : h('p', { class: 'hint' }, 'No package matches.')) : h('p', { class: 'hint' }, 'Nothing installed yet.'),
        h('div', { class: 'panel-title' }, 'By kind'),
        ...kinds.map(([k, n]) => h('button', { class: 'pkg-navitem' + ('kind' in view && view.kind === k ? ' active' : ''), onclick: () => show({ kind: k }) },
          h('span', { class: 'pkg-navtext' }, PART_LABEL[k]), h('span', { class: 'hint' }, String(n)))),
        // content of the tool projects no package brought (added before packages were recorded, or by hand)
        loose.length ? h('div', { class: 'pkg-orphans hint' }, h('div', null, 'Not from a package (added earlier or by hand):'),
          loose.map(([k, n]) => h('div', null, h('a', { href: '#', onclick: (e: Event) => { e.preventDefault(); show({ kind: k }); } }, `${PART_LABEL[k]}: ${n} file(s)`)))) : '');
    };

    // the view in the main area, the navigator and the inspector, as the ROM is now
    const draw = (): void => {
      const items = pkgs.list();
      if ('pkg' in view && !items.some((it) => it.rec.id === (view as { pkg: string }).pkg)) view = { pkg: items[0]?.rec.id ?? '' };
      if ('pkg' in view) lastPkg = view.pkg;
      const k = 'kind' in view ? view.kind : null;
      const pane = k === 'music' ? music : k && k in p ? p[k as keyof typeof p] : null;
      const el = pane ? pane.el : pkgs.el;
      if (content.firstChild !== el) clear(content).appendChild(el);
      if (pane === music) { sel.begin(); music.render(); sel.end(); } else if (pane) pane.render(); else pkgs.show(view);
      drawNav();
    };
    const show = (v: PackagesView | null): void => {
      view = v ?? { pkg: lastPkg };
      draw();
      body.scrollTop = 0;
    };
    this.show = show;

    // an upload: its preview, then the package installed and shown
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
      openUploadPreview(app, pv, (pkg) => {
        for (const x of Object.values(p)) x.reload();
        music.reload();
        pkgs.reload();
        show({ pkg: pkg.id });
        this.opts.onChange?.();
      });
    };
    const pickAndUpload = async () => {
      const f = await pickFile('.asm,.asar,.zip,.txt,.mwl');
      if (f) await upload(f).catch((e) => toast(errorText(e), 'error'));
    };
    // a file dropped anywhere on the workspace is uploaded (not opened as a ROM by the editor's own handler)
    const area = [this.left, this.root, this.side];
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
      h('span', { class: 'hint' }, IMMEDIATE_NOTE));
    const search = h('input', { type: 'search', class: 'pkg-filter', placeholder: 'Filter …', 'aria-label': 'Filter packages and kinds', oninput: () => { filter = search.value; drawNav(); } });
    this.left.replaceChildren(h('div', { class: 'panel pkg-navpanel' }, search, nav));
    clear(body).append(content);
    pkgs.reload();
  }
}
