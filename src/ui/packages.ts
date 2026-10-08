// "Packages" tab of the patches dialog: the installed packages on the left, the chosen one on the right
// with everything it brought – its patch with the settings, where its UberASM code runs, its blocks and
// sprites with their files' settings, its ExGFX files – the graphics and other files in the package to
// take later (import a graphic, add a part), and removing it with all of that. Patches applied before
// packages were recorded are legacy packages (wrapped when the ROM is opened); the editor's VRAM patch is
// listed on its own.

import type { App } from './app.ts';
import { h, clear, toast, choose, downloadBytes } from './dom.ts';
import { listPatches, type PatchEntry } from '../core/patchreg.ts';
import { uninstallVramPatch } from '../core/vrampatch.ts';
import { listPackages, type Package } from '../core/pkgreg.ts';
import { removePackage } from '../core/packages.ts';
import { loadMusicProject, songHex } from '../core/music.ts';
import { playButton, playSong, currentSongs } from './musicdialog.ts';
import { extraParts } from '../core/pkgmap.ts';
import { lz2Decompress } from '../core/lz2.ts';
import { hex } from '../core/names.ts';
import { ALL, type UberContext } from '../core/uberasm.ts';
import { KIND_LABEL as SPRITE_KIND, spriteConfig, type PixiProject } from '../core/pixi.ts';
import type { UberProject } from '../core/uberproject.ts';
import type { BlockProject } from '../core/blocks.ts';
import { map16Source } from '../core/render.ts';
import { storedUpload, toUpload, settingsForm, runPatch, patchDone, type PackagesTab } from './patchmanager.ts';
import { recordFiles, forgetRecordFiles, trackPackage } from './pkgtrack.ts';
import { romChanged, logView, errorText, type Pane } from './projectpane.ts';
import { definesButton, editButton } from './defineedit.ts';
import { openDocs, packageDocs, forgetDocs } from './docview.ts';
import { gfxName } from './gfx/map16tab.ts';
import { TOOL_KINDS, type ToolKind } from '../core/parts.ts';

// the parts record's field of each tool (as stored in the ROM)
const TOOL: Record<ToolKind, 'uber' | 'blocks' | 'pixi'> = { uberasm: 'uber', block: 'blocks', sprite: 'pixi' };
const CTX_LABEL: Record<UberContext, string> = { level: 'Level', gamemode: 'Game Mode', overworld: 'Overworld map' };

export interface PackagesHost {
  panes: Record<ToolKind, Pane>;
  changed(): void; // the ROM changed from this tab
  show(tab: PackagesTab): void;
  leave(then: () => void): void; // closes the dialog, then `then`
  addPart(name: string, files: Map<string, Uint8Array>, rec: Package): void;
}

// one entry of the list: a package, or the editor's VRAM patch
interface Item { key: string; name: string; rec: Package | null; patch: PatchEntry | null }

const GFX_SIZES = new Set([0x1000, 0xc00, 0x800, 0x2000]);
// a .png 128 pixels wide (16 tiles, what the import takes; not the screenshots of the docs), or a .bin
// that is a graphics file (4bpp/3bpp, plain or LZ2)
function isGfxFile(path: string, data: Uint8Array): boolean {
  if (/\.png$/i.test(path)) return data.length > 24 && ((data[16] << 24) | (data[17] << 16) | (data[18] << 8) | data[19]) === 128;
  if (!/\.bin$/i.test(path)) return false;
  if (GFX_SIZES.has(data.length) || /(^|\/)(ex)?gfx[^/]*$/i.test(path)) return true;
  try { return GFX_SIZES.has(lz2Decompress(data, 0).data.length); } catch { return false; }
}
const base = (p: string) => p.split('/').pop()!;

// what the package brought, in a few words
function summary(r: Package): string[] {
  const out: string[] = [];
  if (r.patches.length) out.push(r.patches.length > 1 ? `${r.patches.length} patches` : 'Patch');
  if (r.uber.files.length || r.uber.calls.length) out.push('UberASM');
  if (r.blocks.tiles.length) out.push(r.blocks.tiles.length > 1 ? `${r.blocks.tiles.length} blocks` : 'Block');
  if (r.pixi.list.length) out.push(r.pixi.list.length > 1 ? `${r.pixi.list.length} sprites` : 'Sprite');
  if (r.gfx.length) out.push('ExGFX');
  if (r.music?.length) out.push(r.music.length > 1 ? `${r.music.length} songs` : 'Song');
  if (r.map16?.length || r.bgMap16?.length) out.push('Map16 tiles');
  return out;
}

export function packagesPane(app: App, host: PackagesHost): { el: HTMLElement; reload(): void } {
  const el = h('div', { class: 'pkg-pane' });
  const list = h('div', { class: 'pkg-list' });
  const detail = h('div', { class: 'pkg-detail' });
  el.append(list, detail);
  let items: Item[] = [];
  let sel = '';
  let fileFilter = '';
  let seq = 0; // detail renders started, to drop stale async ones
  let known: Set<string> | null = null; // keys listed before

  function reload(): void {
    let recs: Package[] = [];
    try { recs = listPackages(app.rom); } catch (e) { toast(errorText(e), 'error'); }
    const owned = new Set(recs.flatMap((r) => r.patches));
    items = [
      ...recs.map((r): Item => ({ key: r.id, name: r.name, rec: r, patch: null })),
      ...listPatches(app.rom).filter((p) => p.kind === 'vram' && !owned.has(p.id))
        .map((p): Item => ({ key: 'patch:' + p.id, name: p.name, rec: null, patch: p })),
    ];
    // a package just added is shown
    const added = items.find((i) => known && !known.has(i.key));
    known = new Set(items.map((i) => i.key));
    if (added) sel = added.key;
    else if (!items.some((i) => i.key === sel)) sel = items[0]?.key ?? '';
    renderList();
    renderDetail();
  }

  function renderList(): void {
    clear(list).append(...items.map((it) => h('button', { class: 'pkg-item' + (it.key === sel ? ' active' : ''), onclick: () => { sel = it.key; fileFilter = ''; renderList(); renderDetail(); } },
      h('div', { class: 'pkg-item-name' }, it.name),
      h('div', { class: 'hint' }, it.rec ? [it.rec.legacy ? 'Legacy package' : '', ...summary(it.rec)].filter(Boolean).join(' · ') : 'Editor patch'))),
    items.length ? '' : h('p', { class: 'hint' }, 'Nothing installed yet.'),
    orphans());
  }

  // content of the tool projects no package brought (added before packages were recorded, or by hand)
  function orphans(): HTMLElement | string {
    const recs = items.flatMap((i) => (i.rec ? [i.rec] : []));
    const notes: [ToolKind, string][] = [];
    const count = (k: ToolKind, label: string) => {
      const files = [...host.panes[k].project().files.keys()].filter((f) => f !== 'list.txt' && !recs.some((r) => r[TOOL[k]].files.includes(f)));
      if (files.length) notes.push([k, `${label}: ${files.length} file(s)`]);
    };
    count('uberasm', 'UberASM'); count('block', 'Custom Blocks'); count('sprite', 'Custom Sprites');
    if (!notes.length) return '';
    return h('div', { class: 'pkg-orphans hint' }, h('div', null, 'Not from a package (added earlier or by hand):'),
      notes.map(([k, t]) => h('div', null, h('a', { href: '#', onclick: (e: Event) => { e.preventDefault(); host.show(k); } }, t))));
  }

  function renderDetail(): void {
    const it = items.find((i) => i.key === sel);
    const n = ++seq;
    if (!it) {
      clear(detail).append(h('p', { class: 'hint' }, '“Add …” above takes a download (.asm or .zip, e.g. from SMWCentral): patch, UberASM code, custom block, block package or custom sprite. It then shows up here as a package – with everything it brought.'));
      return;
    }
    const rec = it.rec;
    const patches = rec ? rec.patches.flatMap((id) => listPatches(app.rom).filter((p) => p.id === id)) : [it.patch!];
    const filesBox = h('div');
    const patchBox = h('div');
    clear(detail).append(
      h('div', { class: 'row pkg-head' },
        h('div', { class: 'grow' },
          h('div', { class: 'pkg-title' }, it.name, patches[0]?.version ? h('span', { class: 'hint' }, ` v${patches[0].version}`) : ''),
          h('div', { class: 'hint' }, rec?.legacy ? `Legacy package: applied ${new Date(rec.added).toLocaleString()}, before packages were tracked`
            : [rec ? `added ${new Date(rec.added).toLocaleString()}` : patches[0] ? `applied ${new Date(patches[0].applied).toLocaleString()}` : '', rec?.fileName].filter(Boolean).join(' · '))),
        h('span', { class: 'pkg-docs' }),
        h('button', { class: 'danger', onclick: () => void remove(it) }, 'Remove …')),
      patchBox,
      ...(rec ? toolSections(rec) : []),
      filesBox,
    );
    for (const p of patches) void patchSection(p, rec, n).then((s) => { if (n === seq) patchBox.appendChild(s); });
    void (async () => {
      // a legacy package's files are kept with its patch
      const files = rec?.legacy ? new Map((patches[0] && (await storedUpload(app, patches[0]))?.files) || []) : rec ? await recordFiles(app, rec) : null;
      if (n !== seq || !files?.size) return;
      const docs = detail.querySelector('.pkg-docs')!;
      if (packageDocs(files).length) docs.appendChild(h('button', { onclick: () => openDocs(it.name, files) }, 'Manual …'));
      filesBox.append(...filesSection(it, files));
    })().catch(() => {});
  }

  // ---------- what the package brought ----------

  async function patchSection(p: PatchEntry, rec: Package | null, n: number): Promise<HTMLElement> {
    const bytes = p.segs.reduce((k, s) => k + s[1], 0);
    const own = p.own.reduce((k, o) => k + Math.max(0, app.rom.isRatsAt(o)), 0);
    const box = h('section', { class: 'pkg-sec' },
      h('h3', null, rec && rec.patches.length > 1 ? `Patch ${p.name}` : 'Patch'),
      h('p', { class: 'hint' }, p.kind === 'vram' ? 'Editor patch: tilemaps for BG2/BG3 moved.' : `${bytes} bytes changed · ${own < 1024 ? `${own} bytes` : `${(own / 1024).toFixed(1)} KB`} code/data`));
    if (p.kind === 'vram') return box;
    const s = await storedUpload(app, p).catch(() => undefined);
    if (n !== seq) return box;
    if (!s) { box.appendChild(h('p', { class: 'hint' }, 'The source files are not in this ROM (exported without the editor data, or not kept) – settings cannot be changed. Open the project file (.smwproj) to change them.')); return box; }
    const upload = toUpload(s);
    const m = upload.manifest;
    if (m?.description) box.appendChild(h('p', null, m.description));
    const form = settingsForm(upload, s.main, p.defines);
    const log = h('div');
    const again = () => {
      const t = rec ? trackPackage(app, rec.name, rec.fileName, null, rec) : null;
      const r = runPatch(app, upload, s.fileName, s.main, form.read(), p);
      if (!r.ok) { clear(log).appendChild(logView(r)); return; }
      t?.done();
      patchDone(upload.name, true, r);
      host.changed();
    };
    box.append(form.el, h('div', { class: 'row' }, h('button', { onclick: again, title: 'Reapply the patch with these settings' }, 'Reapply')), log);
    return box;
  }

  function toolSections(rec: Package): HTMLElement[] {
    const out: HTMLElement[] = [];
    const fileRow = (k: ToolKind, files: Map<string, Uint8Array>, f: string, label: string = f, extra: HTMLElement | null = null) =>
      h('tr', null, h('td', { class: files.has(f) ? 'mono' : 'mono err', title: files.has(f) ? f : `${f} is missing from the project` }, label), extra ? h('td', null, extra) : null,
        h('td', { class: 'actions' }, definesButton(files, f, () => touch(k)), editButton(files, f, () => touch(k))));
    const section = (k: ToolKind, title: string, intro: string, ...body: (HTMLElement | string)[]) => h('section', { class: 'pkg-sec' },
      h('div', { class: 'row' }, h('h3', { class: 'grow' }, title), h('a', { href: '#', class: 'hint', onclick: (e: Event) => { e.preventDefault(); host.show(k); } }, `in the ${host.panes[k].title} tab`)),
      intro ? h('p', { class: 'hint' }, intro) : '', ...body);

    // UberASM: where it runs, then its files
    if (rec.uber.files.length || rec.uber.calls.length) {
      const proj = host.panes.uberasm.project() as UberProject;
      const calls = rec.uber.calls.filter(([ctx, num, file]) => proj.list[ctx].get(num)?.some((c) => c.file === file));
      const shown = new Set(calls.map((c) => c[2]));
      const rest = rec.uber.files.filter((f) => !shown.has(f)).sort();
      const where = ([ctx, num]: [UberContext, number, string]) => num === ALL ? `all ${CTX_LABEL[ctx].toLowerCase()}s` : `${CTX_LABEL[ctx]} ${hex(num, ctx === 'level' ? 3 : 2)}`;
      const unassign = (c: [UberContext, number, string]) => {
        const cs = proj.list[c[0]].get(c[1])?.filter((x) => x.file !== c[2]) ?? [];
        if (cs.length) proj.list[c[0]].set(c[1], cs); else proj.list[c[0]].delete(c[1]);
        touch('uberasm');
      };
      out.push(section('uberasm', 'UberASM', '',
        calls.length ? h('table', { class: 'uber-table' }, h('tr', null, h('th', null, 'runs in'), h('th', null, 'File'), h('th')),
          calls.map((c) => h('tr', null, h('td', null, where(c)), h('td', { class: 'mono' }, c[2]),
            h('td', { class: 'actions' }, definesButton(proj.files, c[2], () => touch('uberasm')), editButton(proj.files, c[2], () => touch('uberasm')),
              h('button', { class: 'icon-btn', title: 'Remove assignment (the file stays)', onclick: () => unassign(c) }, '✕'))))) : h('p', { class: 'hint' }, 'Runs nowhere – assign it in the UberASM tab.'),
        rest.length ? h('details', { class: 'pkg-files' }, h('summary', null, `More files (${rest.length}): libraries, settings`),
          h('table', { class: 'uber-table' }, rest.map((f) => fileRow('uberasm', proj.files, f)))) : ''));
    }
    // blocks
    if (rec.blocks.tiles.length || rec.blocks.files.length) {
      const proj = host.panes.block.project() as BlockProject;
      const blocks = proj.list.filter((b) => rec.blocks.tiles.includes(b.tile) && rec.blocks.files.includes(b.file)).sort((a, b) => a.tile - b.tile);
      const rest = rec.blocks.files.filter((f) => !blocks.some((b) => b.file === f)).sort();
      out.push(section('block', 'Custom Blocks', 'To place: palette → Map16, or a Direct Map16 object with the tile.',
        blocks.length ? h('table', { class: 'uber-table' }, h('tr', null, h('th', null, 'Tile'), h('th', null, 'Block'), h('th', null, 'acts like'), h('th')),
          blocks.map((b) => h('tr', null,
            h('td', { class: 'mono' }, h('a', { href: '#', title: 'Open in the Map16 editor', onclick: (e: Event) => { e.preventDefault(); host.leave(() => app.editMap16(b.tile)); } }, hex(b.tile, 3))),
            h('td', { class: 'mono' }, b.file.replace(/^blocks\//, '')),
            h('td', { class: 'mono' }, b.acts !== undefined ? hex(b.acts, 3) : '–'),
            h('td', { class: 'actions' }, definesButton(proj.files, b.file, () => touch('block')), editButton(proj.files, b.file, () => touch('block')))))) : '',
        rest.length ? h('details', { class: 'pkg-files' }, h('summary', null, `More files (${rest.length})`),
          h('table', { class: 'uber-table' }, rest.map((f) => fileRow('block', proj.files, f)))) : ''));
    }
    // sprites
    if (rec.pixi.list.length || rec.pixi.files.length) {
      const proj = host.panes.sprite.project() as PixiProject;
      const mine = new Set(rec.pixi.list.map((e) => e.join(':')));
      const sprites = proj.list.filter((e) => mine.has(`${e.kind}:${e.num}`) && rec.pixi.files.includes(e.file));
      const nameOf = (e: PixiProject['list'][number]) => { try { return spriteConfig(proj, e).names[0]?.name ?? ''; } catch { return ''; } };
      const asmOf = (e: PixiProject['list'][number]) => { try { return spriteConfig(proj, e).asm ?? e.file; } catch { return e.file; } };
      const used = new Set(sprites.flatMap((e) => [e.file, asmOf(e)]));
      const rest = rec.pixi.files.filter((f) => !used.has(f)).sort();
      out.push(section('sprite', 'Custom Sprites', 'To insert: sprite mode, custom sprite with the number.',
        sprites.length ? h('table', { class: 'uber-table' }, h('tr', null, h('th', null, 'Type'), h('th', null, 'No.'), h('th', null, 'Name'), h('th')),
          sprites.map((e) => h('tr', null, h('td', null, SPRITE_KIND[e.kind]), h('td', { class: 'mono' }, hex(e.num, 2)), h('td', { title: e.file }, nameOf(e)),
            h('td', { class: 'actions' }, definesButton(proj.files, asmOf(e), () => touch('sprite')), editButton(proj.files, asmOf(e), () => touch('sprite')))))) : '',
        rest.length ? h('details', { class: 'pkg-files' }, h('summary', null, `More files (${rest.length})`),
          h('table', { class: 'uber-table' }, rest.map((f) => fileRow('sprite', proj.files, f)))) : ''));
    }
    // graphics files it created
    if (rec.gfx.length) {
      out.push(h('section', { class: 'pkg-sec' }, h('h3', null, 'Graphics'),
        h('div', { class: 'row' }, rec.gfx.map((g) => h('button', { title: 'Open in the graphics workspace', onclick: () => host.leave(() => app.showGfxFile(g)) }, gfxName(g)))),
        h('p', { class: 'hint' }, 'Removed with the package. To use: level header → graphics bypass, or “Use in slot” in the graphics workspace.')));
    }
    // Map16 tiles it filled
    if (rec.map16?.length || rec.bgMap16?.length) {
      const ranges = (ts: number[]) => ts.slice().sort((a, b) => a - b).reduce<[number, number][]>((rs, t) => {
        const l = rs[rs.length - 1];
        if (l && l[1] === t - 1) l[1] = t; else rs.push([t, t]);
        return rs;
      }, []).map(([a, b]) => (a === b ? hex(a, 3) : `${hex(a, 3)}–${hex(b, 3)}`)).join(', ');
      out.push(h('section', { class: 'pkg-sec' }, h('h3', null, 'Map16 tiles'),
        rec.map16?.length ? h('p', null, `FG: ${ranges(rec.map16)}`) : '',
        rec.bgMap16?.length ? h('p', null, `BG: ${ranges(rec.bgMap16)}`) : '',
        h('p', { class: 'hint' }, 'Emptied again when the package is removed.')));
    }
    // songs it added to the music project
    if (rec.music?.length) {
      let proj = null;
      try { proj = loadMusicProject(app.rom); } catch { /* shown in the Music tab */ }
      const songs = currentSongs(app).filter((x) => x.file && rec.music!.includes(x.file));
      out.push(h('section', { class: 'pkg-sec' },
        h('div', { class: 'row' }, h('h3', { class: 'grow' }, 'Music'), h('a', { href: '#', class: 'hint', onclick: (e: Event) => { e.preventDefault(); host.show('music'); } }, 'in the Music tab')),
        proj ? h('table', { class: 'uber-table' }, songs.map((x) => h('tr', null,
          h('td', null, playButton(`song:${x.num}`, () => playSong(app, x))), h('td', { class: 'mono' }, songHex(x.num)), h('td', null, x.name), h('td', { class: 'mono hint' }, x.file ?? ''))))
          : h('p', { class: 'hint' }, 'The music project is not in the ROM any more.'),
        h('p', { class: 'hint' }, 'To use: level header → Music, or “Level” in the Music tab.')));
    }
    return out;
  }

  const touch = (k: ToolKind) => { host.panes[k].touch(); renderDetail(); };

  // ---------- the package's own files ----------

  function filesSection(it: Item, files: Map<string, Uint8Array>): HTMLElement[] {
    const rec = it.rec;
    const paths = [...files.keys()].filter((p) => !p.endsWith('/')).sort();
    const gfx = paths.filter((p) => isGfxFile(p, files.get(p)!));
    const docs = new Set(packageDocs(files));
    const parts = new Map(rec ? extraParts(files, new Map([['', null]])).flatMap((p) => (p.files ? [[p.path, p.files] as const] : [])) : []);
    const importBtn = (p: string) => h('button', { title: 'Import into a free ExGFX number (in the graphics workspace; PNG colors are mapped to the palette chosen there)', onclick: () => importGfx(new File([files.get(p)! as BlobPart], base(p)), rec) }, 'Import as graphics …');
    const actions = (p: string) => [
      gfx.includes(p) ? importBtn(p) : null,
      parts.has(p) ? h('button', { title: 'Add this file (with the files it includes) like a package of its own – it then belongs to this package', onclick: () => host.addPart(base(p), parts.get(p)!, rec!) }, 'Add …') : null,
      docs.has(p) ? h('button', { onclick: () => openDocs(it.name, files, p) }, 'Read') : null,
      h('button', { class: 'icon-btn', title: 'Download', onclick: () => downloadBytes(base(p), files.get(p)!) }, '⤓'),
    ];
    const row = (p: string) => h('div', { class: 'row pkg-file', 'data-path': p, style: shown(p) ? '' : 'display: none' }, h('span', { class: 'mono grow', title: p }, p), ...actions(p));
    const shown = (p: string) => p.toLowerCase().includes(fileFilter.trim().toLowerCase());
    const all = h('details', { class: 'pane-adv' }, h('summary', null, `Package files (${paths.length})`),
      paths.length > 12 ? h('input', { type: 'search', class: 'define-search', placeholder: 'Filter files …', value: fileFilter, oninput: (e: Event) => {
        fileFilter = (e.target as HTMLInputElement).value;
        for (const r of all.querySelectorAll<HTMLElement>('.pkg-file')) r.style.display = shown(r.dataset.path!) ? '' : 'none';
      } }) : '',
      h('div', { class: 'pkg-filelist' }, paths.map(row)),
      rec ? h('p', { class: 'hint' }, '“Add …” takes another part of the package (e.g. example blocks); what it brings then belongs to this package and is removed with it.') : '');
    return [
      gfx.length ? h('section', { class: 'pkg-sec' }, h('h3', null, 'Graphics in the package'),
        h('div', { class: 'pkg-filelist' }, gfx.map((p) => h('div', { class: 'row pkg-file' }, h('span', { class: 'mono grow', title: p }, p), importBtn(p))))) : '',
      all,
    ].filter((x): x is HTMLElement => x !== '');
  }

  // into a free ExGFX number, in the graphics workspace; the number goes to the package
  function importGfx(file: File, rec: Package | null): void {
    host.leave(() => {
      const t = rec ? trackPackage(app, rec.name, rec.fileName, null, rec) : null;
      app.gfxImport = { file, done: (n) => { if (n !== null) t?.done(); } };
      app.emit('import-gfx');
    });
  }

  // ---------- removing ----------

  async function remove(it: Item): Promise<void> {
    const rec = it.rec;
    if (!rec) return removeVramPatch(it.patch!);
    const parts: string[] = [];
    if (rec.patches.length) parts.push(rec.patches.length > 1 ? `${rec.patches.length} patches` : 'the patch');
    if (rec.uber.files.length) parts.push(`${rec.uber.files.length} UberASM file(s) with their assignments`);
    if (rec.blocks.tiles.length) parts.push(`block(s) at ${rec.blocks.tiles.map((t) => hex(t, 3)).join(', ')}`);
    if (rec.pixi.list.length) parts.push(`sprite(s) ${rec.pixi.list.map(([, n]) => hex(n, 2)).join(', ')}`);
    if (rec.gfx.length) parts.push(rec.gfx.map(gfxName).join(', '));
    if (rec.map16?.length || rec.bgMap16?.length) parts.push(`${(rec.map16?.length ?? 0) + (rec.bgMap16?.length ?? 0)} Map16 tile(s)`);
    if (rec.music?.length) parts.push(`${rec.music.length > 1 ? 'songs' : 'the song'} (AddmusicK inserts the music again)`);
    const i = await choose('Remove package', `Remove “${rec.name}” from the ROM completely: ${parts.join(', ')}. Files another package brought as well stay. Whatever is placed in levels stays in place.`,
      [{ label: 'Cancel' }, { label: 'Remove', danger: true }]);
    if (i !== 1) return;
    const keys = TOOL_KINDS.filter((k) => rec[TOOL[k]].files.length);
    if (app.dirty) app.saveLevel(true);
    try {
      const blank = map16Source(app.rom, app.render).fg(0x025);
      const w = await app.romEditAsync(`Package “${rec.name}” removed`, () => removePackage(app.rom, rec.id, blank));
      forgetRecordFiles(rec.id);
      forgetDocs(rec.name);
      romChanged(app);
      toast(`“${rec.name}” removed${w.length ? ': ' + w.join(' ') : ''}`);
    } catch (e) { toast(errorText(e), 'error'); }
    for (const k of keys) host.panes[k].reload();
    host.changed();
  }

  // the editor's VRAM patch (BG2/BG3 graphics)
  async function removeVramPatch(p: PatchEntry): Promise<void> {
    const i = await choose('Remove editor patch', `Remove “${p.name}” from the ROM? The bytes it changed are restored.`, [{ label: 'Cancel' }, { label: 'Remove', danger: true }]);
    if (i !== 1) return;
    if (app.dirty) app.saveLevel(true);
    try {
      const w = app.romEdit(`“${p.name}” removed`, () => uninstallVramPatch(app.rom));
      romChanged(app);
      toast(`Patch “${p.name}” removed${w.length ? ': ' + w.join(' ') : ''}`);
    } catch (e) { toast(errorText(e), 'error'); }
    host.changed();
  }

  reload();
  return { el, reload };
}
