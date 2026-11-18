// The main area of the Packages workspace for a package or a kind of part (#517): a package's page shows what it
// brought as one card per kind – its patch, where its UberASM code runs, its blocks and sprites, its graphics,
// songs and sound effects – and under Files everything that was in the upload (to read, download, or import as
// graphics later); a kind without a configuration view of its own (patches, graphics, Map16 tiles, sound effects)
// is the same rows of all packages in one table. A row chosen shows in the inspector (pkginspect.ts) with its
// settings and the ways on. The package is removed here with all of that.

import type { App } from './app.ts';
import { h, clear, toast, choose, logTool, type Child } from './dom.ts';
import { downloadBytes } from './platform.ts';
import type { PatchEntry } from '../core/patchreg.ts';
import type { ApplyResult } from '../core/patchapply.ts';
import { listPackages, packageSummary, packageRemoval, uninstallPackage, packagePatches, type Package } from '../core/pkgreg.ts';
import { toolContent, looseFiles, type ToolProjects } from '../core/pkgsections.ts';
import { reapplyPackagePatch, editPackagePatchFile, packageFiles } from '../core/packages.ts';
import { loadMusicProject, songHex, sfxKey } from '../core/music.ts';
import { playButton, playSong, currentSongs } from './musicdialog.ts';
import { isGfxData } from '../core/gfxfiles.ts';
import { hex } from '../core/names.ts';
import { ALL, type UberContext } from '../core/uberasm.ts';
import { KIND_LABEL as SPRITE_KIND, spriteName, spriteAsm, type PixiProject } from '../core/pixi.ts';
import { bowsieSpriteInfo, type BowsieProject } from '../core/bowsie.ts';
import { removeCall, type UberProject } from '../core/uberproject.ts';
import type { BlockProject } from '../core/blocks.ts';
import { blankTile } from '../core/render.ts';
import { storedUpload, toUpload, settingsForm, patchDone } from './patchmanager.ts';
import { errorText, type Pane } from './projectpane.ts';
import { definesButton, editButton, isTextFile } from './defineedit.ts';
import { openDocs, packageDocs } from './docview.ts';
import { gfxName } from './gfx/map16tab.ts';
import { TOOL_KINDS, type ToolKind } from '../core/parts.ts';
import { icon } from './icons.ts';
import type { Inspected, PartSelection } from './pkginspect.ts';

/** The kinds of parts the workspace lists. */
export type PartKind = 'patch' | ToolKind | 'music' | 'sfx' | 'gfx' | 'map16';
export const PART_KINDS: PartKind[] = ['patch', 'uberasm', 'block', 'sprite', 'owsprite', 'music', 'sfx', 'gfx', 'map16'];
export const PART_LABEL: Record<PartKind, string> = {
  patch: 'Patches', uberasm: 'UberASM', block: 'Blocks', sprite: 'Sprites', owsprite: 'Overworld sprites',
  music: 'Music', sfx: 'Sound effects', gfx: 'Graphics', map16: 'Map16 tiles',
};
/** What the main area shows: a package, or a kind of part. */
export type PackagesView = { pkg: string } | { kind: PartKind };

const CTX_LABEL: Record<UberContext, string> = { level: 'Level', gamemode: 'Game mode', overworld: 'Overworld map' };

export interface PackagesHost {
  panes: Record<ToolKind, Pane>;
  sel: PartSelection;
  changed(): void; // the ROM changed from here
  show(v: PackagesView): void;
  leave(then: () => void): void; // leaves the workspace, then `then`
}

// one part of a package as a row; rest: a file of a tool project no entry shows (a library, settings)
interface Part {
  key: string; kind: PartKind;
  lead?: HTMLElement; num: string; name: string; sub: string;
  missing?: boolean; rest?: boolean;
  remove?: { title: string; run(): void };
  inspect(): Inspected;
}
/** An installed package with its parts; warn: something left to do with it. */
export interface PackageItem { rec: Package; parts: Part[]; warn: string }

// a .png 128 pixels wide (16 tiles, what the import takes; not the screenshots of the docs), or a .bin
// that is a graphics file (4bpp/3bpp, plain or LZ2)
function isGfxFile(path: string, data: Uint8Array): boolean {
  if (/\.png$/i.test(path)) return data.length > 24 && ((data[16] << 24) | (data[17] << 16) | (data[18] << 8) | data[19]) === 128;
  if (!/\.bin$/i.test(path)) return false;
  return /(^|\/)(ex)?gfx[^/]*$/i.test(path) || isGfxData(data);
}
const base = (p: string) => p.split('/').pop()!;
const mono = (s: string) => h('span', { class: 'mono' }, s);
const ranges = (ts: number[]) => ts.slice().sort((a, b) => a - b).reduce<[number, number][]>((rs, t) => {
  const l = rs[rs.length - 1];
  if (l && l[1] === t - 1) l[1] = t; else rs.push([t, t]);
  return rs;
}, []).map(([a, b]) => (a === b ? hex(a, 3) : `${hex(a, 3)}–${hex(b, 3)}`)).join(', ');

export function packagesView(app: App, host: PackagesHost): {
  el: HTMLElement;
  /** The installed packages read again; the id of one that was not there before. */
  reload(): string | undefined;
  list(): PackageItem[];
  show(v: PackagesView): void;
  remove(rec: Package): Promise<void>;
  /** Files of the tool projects no package brought, per kind. */
  loose(): [ToolKind, number][];
} {
  const el = h('div', { class: 'pkg-page' });
  let items: PackageItem[] = [];
  let view: PackagesView = { pkg: '' };
  let tab: 'contents' | 'files' = 'contents';
  let fileFilter = '';
  let known: Set<string> | null = null; // ids listed before

  const touch = (k: ToolKind) => host.panes[k].touch();
  const toMap16 = (tile: number) => ({ label: 'Open in the Map16 editor', run: () => host.leave(() => app.editTile(tile)) });

  // ---------- what the packages brought ----------

  function partsOf(rec: Package): PackageItem {
    const parts: Part[] = [];
    const add = (kind: PartKind, id: string, p: Omit<Part, 'key' | 'kind'>) => parts.push({ key: `${rec.id}/${kind}/${id}`, kind, ...p });
    // a tool project's files no entry shows: chosen for their settings and source
    const rest = (k: ToolKind, files: Map<string, Uint8Array>, names: string[]) => {
      for (const f of names) add(k, `file/${f}`, { num: '', name: f, sub: '', rest: true, missing: !files.has(f),
        inspect: () => ({ kind: `${PART_LABEL[k]} file`, title: mono(f), files, file: f, onChange: () => touch(k) }) });
    };
    for (const p of packagePatches(app.rom, rec)) add('patch', p.id, { num: '', name: p.name, sub: p.version ? `v${p.version}` : '',
      inspect: () => ({ kind: 'Patch', title: p.name, body: [patchSettings(p, rec)] }) });

    if (rec.uberasm.files.length || rec.uberasm.calls.length) {
      const proj = host.panes.uberasm.project() as UberProject;
      const c = toolContent(rec, 'uberasm', proj);
      for (const [ctx, num, file] of c.entries) {
        const where = num === ALL ? `all ${CTX_LABEL[ctx].toLowerCase()}s` : `${CTX_LABEL[ctx]} ${hex(num, ctx === 'level' ? 3 : 2)}`;
        add('uberasm', `${ctx}/${num}/${file}`, { num: '', name: file, sub: where, missing: !proj.files.has(file),
          remove: { title: 'Remove assignment (the file stays)', run: () => { removeCall(proj, ctx, num, file); touch('uberasm'); } },
          inspect: () => ({ kind: 'UberASM code', title: mono(file), files: proj.files, file, onChange: () => touch('uberasm'), facts: [['Runs in', where]],
            links: [{ label: 'Assign under UberASM', title: 'Where the package’s code runs', run: () => host.show({ kind: 'uberasm' }) }] }) });
      }
      rest('uberasm', proj.files, c.rest);
    }
    if (rec.block.tiles.length || rec.block.files.length) {
      const proj = host.panes.block.project() as BlockProject;
      const c = toolContent(rec, 'block', proj);
      for (const b of c.entries) add('block', String(b.tile), { num: hex(b.tile, 3), name: b.file.replace(/^blocks\//, ''), sub: b.acts !== undefined ? `acts like ${hex(b.acts, 3)}` : '', missing: !proj.files.has(b.file),
        inspect: () => ({ kind: 'Block', title: [mono(hex(b.tile, 3)), ' ', b.file.replace(/^blocks\//, '')], files: proj.files, file: b.file, onChange: () => touch('block'),
          facts: [['Tile', hex(b.tile, 3)], ['Acts like', b.acts !== undefined ? hex(b.acts, 3) : 'the tile’s own']],
          links: [toMap16(b.tile), { label: 'Assign under Blocks', run: () => host.show({ kind: 'block' }) }],
          hint: 'To place: Picker → Map16, or a Direct Map16 object with the tile.' }) });
      rest('block', proj.files, c.rest);
    }
    if (rec.sprite.list.length || rec.sprite.files.length) {
      const proj = host.panes.sprite.project() as PixiProject;
      const c = toolContent(rec, 'sprite', proj);
      for (const e of c.entries) add('sprite', `${e.kind}/${e.num}`, { num: hex(e.num, 2), name: spriteName(proj, e), sub: SPRITE_KIND[e.kind], missing: !proj.files.has(e.file),
        inspect: () => ({ kind: SPRITE_KIND[e.kind], title: [mono(hex(e.num, 2)), ' ', spriteName(proj, e)], files: proj.files, file: spriteAsm(proj, e), onChange: () => touch('sprite'),
          facts: [['Number', hex(e.num, 2)], ['File', e.file]],
          links: [{ label: 'Assign under Sprites', run: () => host.show({ kind: 'sprite' }) }],
          hint: 'To insert: sprite mode, custom sprite with the number.' }) });
      rest('sprite', proj.files, c.rest);
    }
    if (rec.owsprite.list.length || rec.owsprite.files.length) {
      const proj = host.panes.owsprite.project() as BowsieProject;
      const c = toolContent(rec, 'owsprite', proj);
      for (const e of c.entries) {
        const info = bowsieSpriteInfo(proj, e);
        add('owsprite', String(e.num), { num: hex(e.num, 2), name: info.name, sub: '', missing: !proj.files.has(e.file),
          inspect: () => ({ kind: 'Overworld sprite', title: [mono(hex(e.num, 2)), ' ', info.name], files: proj.files, file: e.file, onChange: () => touch('owsprite'),
            facts: [['Number', hex(e.num, 2)], ['File', e.file]],
            links: [{ label: 'Assign under Overworld sprites', run: () => host.show({ kind: 'owsprite' }) }],
            hint: 'To place: overworld editor, Sprites mode.' }) });
      }
      rest('owsprite', proj.files, c.rest);
    }
    for (const g of rec.gfx) add('gfx', String(g), { num: gfxName(g), name: 'graphics file', sub: '',
      inspect: () => ({ kind: 'Graphics file', title: gfxName(g),
        links: [{ label: 'Open in the graphics workspace', run: () => host.leave(() => app.showGfxFile(g)) }],
        hint: 'Removed with the package. To use: level header → graphics bypass, or “Use in slot” in the graphics workspace.' }) });
    const map16 = (id: string, label: string, tiles: number[] | undefined, link: boolean) => {
      if (tiles?.length) add('map16', id, { num: label, name: ranges(tiles), sub: `${tiles.length} tile(s)`,
        inspect: () => ({ kind: 'Map16 tiles', title: `${label} ${ranges(tiles)}`, links: link ? [toMap16(Math.min(...tiles))] : [], hint: 'Emptied again when the package is removed.' }) });
    };
    map16('fg', 'FG', rec.map16, true);
    map16('bg', 'BG', rec.bgMap16, false);
    if (rec.music?.length || rec.sfx?.length) {
      let proj = null;
      try { proj = loadMusicProject(app.rom); } catch { /* shown under Music */ }
      for (const x of proj ? currentSongs(app).filter((s) => s.file && rec.music?.includes(s.file)) : []) add('music', String(x.num), {
        lead: playButton(`song:${x.num}`, () => playSong(app, x)), num: songHex(x.num), name: x.name, sub: x.file ?? '',
        inspect: () => ({ kind: 'Song', title: [mono(songHex(x.num)), ' ', x.name], facts: [['Number', songHex(x.num)], ['File', x.file ?? '']],
          links: [{ label: 'Volume, number and levels under Music', run: () => host.show({ kind: 'music' }) }],
          hint: 'To use: level header → Music, or “Level” under Music.' }) });
      for (const x of proj?.sfx.filter((s) => rec.sfx?.includes(sfxKey(s))) ?? []) add('sfx', sfxKey(x), { num: `$${x.bank} ${songHex(x.num)}`, name: x.name, sub: x.file,
        inspect: () => ({ kind: 'Sound effect', title: x.name, facts: [['Address', `$${x.bank}`], ['Number', songHex(x.num)], ['File', x.file]],
          hint: 'Played by writing the number to the address – the package’s code does.' }) });
    }
    const warn = rec.uberasm.files.length && !parts.some((p) => p.kind === 'uberasm' && !p.rest) ? 'Its UberASM code runs nowhere – assign it under UberASM.' : '';
    return { rec, parts, warn };
  }

  // a patch's settings with Reapply, and its text files to edit (in the inspector)
  function patchSettings(p: PatchEntry, rec: Package): HTMLElement {
    const bytes = p.segs.reduce((k, s) => k + s[1], 0);
    const own = p.own.reduce((k, o) => k + Math.max(0, app.rom.isRatsAt(o)), 0);
    const box = h('div', null, h('p', { class: 'hint' }, `${bytes} bytes changed · ${own < 1024 ? `${own} bytes` : `${(own / 1024).toFixed(1)} KB`} code/data`));
    void storedUpload(app, p).catch(() => undefined).then((s) => {
      if (!s && !p.srcId) { box.appendChild(h('p', { class: 'hint' }, 'Its sources are not kept with it but with its package (e.g. a patch of a Callisto project, applied as the project’s files have it) – no settings to change.')); return; }
      if (!s) { box.appendChild(h('p', { class: 'hint' }, 'The source files are not in this ROM (exported without the editor data) – settings cannot be changed. Open the project file (.smwproj) to change them.')); return; }
      const upload = toUpload(s);
      if (upload.manifest?.description) box.appendChild(h('p', null, upload.manifest.description));
      const form = settingsForm(upload, s.main, p.defines);
      // one undoable ROM edit with the package's record (the ROM changed when ok); false when it failed (logged)
      const run = (label: string, change: () => ApplyResult): boolean => {
        let r: ApplyResult;
        try { r = app.romEdit(`Patch “${upload.name}” ${label}`, change); }
        catch (e) { r = { ok: false, errors: [errorText(e)], warnings: [], prints: [] }; }
        if (!r.ok) { logTool(`Patch “${upload.name}”`, r); return false; }
        patchDone(upload.name, true, r);
        host.changed();
        return true;
      };
      const again = () => run('reapplied', () => reapplyPackagePatch(app.rom, p.id, upload, s.fileName, s.main, form.read(), rec));
      box.append(form.el, h('div', { class: 'row' }, h('button', { class: 'primary', onclick: again, title: 'Reapply the patch with these settings (Ctrl+Z undoes)' }, 'Reapply')));
      // its text files (the main one first, then e.g. a tables file it includes): OK reapplies the patch with the file
      // (the settings above on top); when Asar fails, nothing changes
      const files = new Map(s.files);
      const texts = [...files.keys()].filter(isTextFile).sort((a, b) => Number(b === s.main) - Number(a === s.main) || a.localeCompare(b));
      const edited = (f: string) => () => {
        if (!run(`– ${base(f)} edited`, () => editPackagePatchFile(app.rom, p.id, s, f, files.get(f)!, form.read(), rec))) files.set(f, upload.files.get(f)!);
      };
      // (the main file's defines are the settings above)
      const rows = texts.map((f) => h('div', { class: 'row pkg-file' }, h('span', { class: 'mono grow', title: f }, f, f === s.main ? h('span', { class: 'hint' }, ' (main file)') : ''),
        f === s.main ? null : definesButton(files, f, edited(f)), editButton(files, f, edited(f))));
      if (rows.length) box.append(h('h4', null, `Files (${rows.length})`), h('div', { class: 'pkg-filelist' }, rows));
    });
    return box;
  }

  // ---------- drawing ----------

  const partRow = (p: Part): HTMLElement => h('div', host.sel.row(p.key, p.inspect, 'pkg-part'),
    p.lead ?? '',
    p.num ? h('span', { class: 'pkg-part-num' }, p.num) : '',
    h('span', { class: 'pkg-part-name' + (p.rest ? ' mono' : '') + (p.missing ? ' err' : ''), title: p.missing ? `${p.name} is missing from the project` : p.name }, p.name),
    h('span', { class: 'hint' }, p.sub),
    p.remove ? h('button', { class: 'icon-btn', title: p.remove.title, onclick: (e: Event) => { e.stopPropagation(); p.remove!.run(); } }, icon('close')) : '');

  function card(title: string, parts: Part[], extra: Child = ''): HTMLElement {
    const main = parts.filter((p) => !p.rest), more = parts.filter((p) => p.rest);
    // (the files stay open while one of them is the chosen part)
    return h('section', { class: 'pkg-card' },
      h('header', null, title, h('span', { class: 'hint' }, String(main.length || more.length))),
      main.map(partRow),
      more.length ? h('details', { class: 'pkg-files', open: more.some((p) => p.key === host.sel.key) }, h('summary', null, `More files (${more.length}): libraries, settings`), more.map(partRow)) : '',
      extra);
  }

  function header(it: PackageItem, files: Map<string, Uint8Array> | null): HTMLElement {
    const rec = it.rec, version = packagePatches(app.rom, rec)[0]?.version;
    return h('div', { class: 'pkg-head' },
      h('div', { class: 'grow' },
        h('div', { class: 'pkg-title' }, rec.name, version ? h('span', { class: 'hint' }, ` v${version}`) : ''),
        h('div', { class: 'hint' }, [rec.fileName, `added ${new Date(rec.added).toLocaleString()}`, ...packageSummary(rec)].filter(Boolean).join(' · '))),
      files && packageDocs(files).length ? h('button', { onclick: () => openDocs(rec.name, files) }, 'Manual …') : '',
      h('button', { class: 'danger', title: 'Remove the package and what it brought (asks first)', onclick: () => void remove(rec) }, 'Remove …'));
  }

  // into a free ExGFX number, in the graphics workspace; the number goes to the package
  function importGfx(file: File, rec: Package): void {
    host.leave(() => {
      app.gfxImport = { file, into: rec };
      app.emit('import-gfx');
    });
  }

  function filesTab(it: PackageItem, files: Map<string, Uint8Array>, paths: string[], gfx: Set<string>): HTMLElement {
    const docs = new Set(packageDocs(files));
    const shown = (p: string) => p.toLowerCase().includes(fileFilter.trim().toLowerCase());
    const list = h('div', { class: 'pkg-filelist' }, paths.map((p) => h('div', { class: 'row pkg-file', 'data-path': p, style: shown(p) ? '' : 'display: none' },
      h('span', { class: 'mono grow', title: p }, p),
      gfx.has(p) ? h('button', { title: 'Import into a free ExGFX number (in the graphics workspace; PNG colors are mapped to the palette chosen there)', onclick: () => importGfx(new File([files.get(p)! as BlobPart], base(p)), it.rec) }, 'Import as graphics …') : '',
      docs.has(p) ? h('button', { onclick: () => openDocs(it.rec.name, files, p) }, 'Read') : '',
      h('button', { class: 'icon-btn', title: 'Download', onclick: () => downloadBytes(base(p), files.get(p)!) }, '⤓'))));
    return h('div', { class: 'pkg-tab' },
      paths.length > 12 ? h('input', { type: 'search', class: 'define-search', placeholder: `Filter ${paths.length} files …`, value: fileFilter, oninput: (e: Event) => {
        fileFilter = (e.target as HTMLInputElement).value;
        for (const r of list.querySelectorAll<HTMLElement>('.pkg-file')) r.style.display = shown(r.dataset.path!) ? '' : 'none';
      } }) : '',
      list);
  }

  function packagePage(it: PackageItem): Child[] {
    let files: Map<string, Uint8Array> | null = null;
    try { files = packageFiles(app.rom, it.rec) ?? null; } catch { /* exported without the editor data: no files */ }
    const paths = files ? [...files.keys()].filter((p) => !p.endsWith('/')).sort() : [];
    const gfx = paths.filter((p) => isGfxFile(p, files!.get(p)!));
    if (!paths.length) tab = 'contents';
    const tabBtn = (t: typeof tab, label: string) => h('button', { class: tab === t ? 'active' : '', onclick: () => { tab = t; render(); } }, label);
    const kinds = PART_KINDS.filter((k) => it.parts.some((p) => p.kind === k));
    return [
      header(it, files),
      it.warn ? h('div', { class: 'warn-box' }, it.warn, ' ', h('a', { href: '#', onclick: (e: Event) => { e.preventDefault(); host.show({ kind: 'uberasm' }); } }, 'UberASM')) : '',
      h('div', { class: 'tabbar', role: 'tablist' }, tabBtn('contents', `Contents (${it.parts.filter((p) => !p.rest).length})`), paths.length ? tabBtn('files', `Files (${paths.length})`) : ''),
      tab === 'files' && files ? filesTab(it, files, paths, new Set(gfx))
        : h('div', { class: 'pkg-cards' },
          kinds.map((k) => card(PART_LABEL[k], it.parts.filter((p) => p.kind === k))),
          // graphics that came along without being installed: to take later
          gfx.length ? h('section', { class: 'pkg-card' },
            h('header', null, 'Graphics to import', h('span', { class: 'hint' }, String(gfx.length))),
            gfx.map((p) => h('div', { class: 'pkg-part' }, h('span', { class: 'pkg-part-name mono', title: p }, p),
              h('button', { title: 'Import into a free ExGFX number (in the graphics workspace; PNG colors are mapped to the palette chosen there)', onclick: () => importGfx(new File([files!.get(p)! as BlobPart], base(p)), it.rec) }, 'Import …')))) : '',
          kinds.length || gfx.length ? '' : h('p', { class: 'hint' }, 'Nothing of it is left in the ROM.')),
    ];
  }

  // the parts of one kind from all packages
  function kindPage(k: PartKind): Child[] {
    const rows = items.flatMap((it) => it.parts.filter((p) => p.kind === k && !p.rest).map((p) => ({ it, p })));
    return [
      h('div', { class: 'pkg-head' }, h('div', { class: 'grow' }, h('div', { class: 'pkg-title' }, PART_LABEL[k]), h('div', { class: 'hint' }, `${rows.length} in this ROM, from all packages`))),
      rows.length ? h('table', { class: 'uber-table pkg-kind-table' },
        h('tr', null, h('th', null, k === 'patch' ? '' : 'No.'), h('th', null, 'Name'), h('th'), h('th', null, 'Package')),
        rows.map(({ it, p }) => h('tr', host.sel.row(p.key, () => ({ ...p.inspect(), from: { name: it.rec.name, go: () => host.show({ pkg: it.rec.id }) } })),
          h('td', { class: 'mono' }, p.num), h('td', null, p.name), h('td', { class: 'hint' }, p.sub),
          h('td', null, h('a', { href: '#', onclick: (e: Event) => { e.preventDefault(); e.stopPropagation(); host.show({ pkg: it.rec.id }); } }, it.rec.name)))))
        : h('p', { class: 'hint' }, 'No package brought any.'),
    ];
  }

  function render(): void {
    const live = el.isConnected;
    if (live) host.sel.begin();
    const it = 'pkg' in view ? items.find((i) => i.rec.id === (view as { pkg: string }).pkg) : undefined;
    clear(el).append(...(('kind' in view ? kindPage(view.kind) : it ? packagePage(it) : [
      // nothing installed: the page is the drop target
      h('div', { class: 'pkg-drop' },
        h('div', { class: 'pkg-drop-title' }, 'Drop a package here'),
        h('div', null, 'A .zip or .asm, e.g. from SMWCentral – a patch, UberASM code, blocks, sprites, overworld sprites, AddmusicK songs or sound effects, graphics; or a whole UberASM Tool, GPS or PIXI folder as a .zip.'),
        h('div', { class: 'hint' }, 'Everything it contains is installed as one package and removed as one. “Upload package …” above picks a file.')),
    ]).flat(4) as (Node | string)[]).filter((x) => x !== ''));
    if (live) host.sel.end();
  }

  // ---------- removing ----------

  async function remove(rec: Package): Promise<void> {
    const parts = packageRemoval(rec);
    const i = await choose('Remove package', `Remove “${rec.name}” from the ROM completely: ${parts.join(', ')}. Files another package brought as well stay. Whatever is placed in levels stays in place.`,
      [{ label: 'Cancel' }, { label: 'Remove', danger: true }]);
    if (i !== 1) return;
    const keys = TOOL_KINDS.filter((k) => rec[k].files.length);
    try {
      const blank = blankTile(app.rom, app.render);
      const w = await app.romEditAsync(`Package “${rec.name}” removed`, () => uninstallPackage(app.rom, rec.id, blank));
      toast(`“${rec.name}” removed${w.length ? ': ' + w.join(' ') : ''}`);
    } catch (e) { toast(errorText(e), 'error'); }
    for (const k of keys) host.panes[k].reload();
    host.changed();
  }

  function reload(): string | undefined {
    let recs: Package[] = [];
    try { recs = listPackages(app.rom); } catch (e) { toast(errorText(e), 'error'); }
    items = recs.map(partsOf);
    const added = items.find((i) => known && !known.has(i.rec.id))?.rec.id;
    known = new Set(items.map((i) => i.rec.id));
    return added;
  }

  return {
    el, reload, list: () => items, remove,
    show(v) {
      if ('pkg' in v && (!('pkg' in view) || view.pkg !== v.pkg)) { tab = 'contents'; fileFilter = ''; }
      view = v;
      render();
    },
    loose() {
      const recs = items.map((i) => i.rec);
      return TOOL_KINDS.map((k) => [k, looseFiles(recs, k, host.panes[k].project() as ToolProjects[typeof k]).length] as [ToolKind, number]).filter(([, n]) => n);
    },
  };
}
