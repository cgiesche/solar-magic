// UberASM dialog: assign resources to levels, overworld maps and game modes, manage the project's
// files, import/export an UberASM Tool folder (.zip). Changes are applied with "Übernehmen".

import type { App } from './app.ts';
import { h, modal, clear, toast, pickFile, downloadBytes, hexInput, select } from './dom.ts';
import { loadAsar } from '../core/asar.ts';
import { unzipSync } from 'fflate';
import { loadProject, saveProject, emptyProject, projectFromZip, projectToZip, type UberProject } from '../core/uberproject.ts';
import { resourceFiles, ALL, CONTEXT_SIZE, type UberContext, type UberCall } from '../core/uberasm.ts';
import { hex } from '../core/names.ts';
import { definesButton } from './defineedit.ts';

const CTX_LABEL: Record<UberContext, string> = { level: 'Level', overworld: 'Overworld-Karten', gamemode: 'Game Modes' };
const FOLDERS = ['level/', 'overworld/', 'gamemode/', 'library/', 'routines/', 'other/'];

function bytesText(b: number[]): string {
  return b.map((v) => v.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}
function parseBytes(s: string): number[] {
  const t = s.trim();
  if (!t) return [];
  return t.split(/[\s,]+/).map((x) => {
    const v = parseInt(x.replace(/^\$/, ''), 16);
    if (Number.isNaN(v) || v < 0 || v > 255) throw new Error(`Ungültiges Extra-Byte „${x}“`);
    return v;
  });
}

export async function openUberDialog(app: App, onDone?: () => void): Promise<void> {
  const body = h('div', { class: 'uber-dialog' }, h('p', { class: 'hint' }, 'Asar wird geladen …'));
  let ctx: UberContext = 'level';
  let proj: UberProject;
  let dirty = false;
  const log = h('div', { class: 'patch-log' });

  const dlg = modal('UberASM', body, [
    { label: 'Schließen', onClick: () => (!dirty || confirmDiscard()) },
    { label: 'Übernehmen', primary: true, onClick: () => apply() },
  ]);
  void dlg;
  try { await loadAsar(); proj = loadProject(app.rom) ?? emptyProject(); } catch (e) {
    clear(body).appendChild(h('p', { class: 'hint error' }, String(e instanceof Error ? e.message : e)));
    return;
  }
  function confirmDiscard(): boolean {
    // no browser dialogs: a second click on "Schließen" discards
    if (body.dataset.warned) return true;
    body.dataset.warned = '1';
    toast('Nicht übernommene Änderungen – erneut „Schließen“ verwirft sie.');
    return false;
  }
  const change = () => { dirty = true; delete body.dataset.warned; build(); };

  function apply(): boolean {
    if (app.dirty) app.saveLevel(true);
    let r;
    try { r = saveProject(app.rom, proj); } catch (e) {
      clear(log).appendChild(h('div', { class: 'err' }, e instanceof Error ? e.message : String(e)));
      return false;
    }
    clear(log);
    for (const m of r.errors) log.appendChild(h('div', { class: 'err' }, m));
    if (!r.ok) return false;
    app.emu.syncRom();
    app.persist();
    app.openLevel(app.level.number);
    app.emit('patch');
    toast(`UberASM übernommen${r.warnings.length ? ` – ${r.warnings.join(' ')}` : ''}`);
    onDone?.();
    return true;
  }

  function assignments(): HTMLElement {
    const map = proj.list[ctx];
    const digits = ctx === 'level' ? 3 : 2;
    const rows = [...map.entries()].sort((a, b) => a[0] - b[0]).flatMap(([num, calls]) => calls.map((c, i) => h('tr', null,
      h('td', null, i === 0 ? (num === ALL ? '*' : hex(num, digits)) : ''),
      h('td', { class: files().has(c.file) ? '' : 'err' }, c.file.replace(/^(level|overworld|gamemode)\//, '')),
      h('td', { class: 'mono' }, bytesText(c.bytes)),
      h('td', null, definesButton(files(), c.file, change), h('button', { class: 'icon-btn', title: 'Entfernen', onclick: () => { calls.splice(i, 1); if (!calls.length) map.delete(num); change(); } }, '✕')),
    )));
    // new assignment
    let num = ctx === 'level' ? app.level.number : 0;
    let all = false;
    const res = resourceFiles(files(), ctx);
    let file = res[0] ?? '';
    const bytesIn = h('input', { placeholder: 'z. B. 01 FF', spellcheck: false, style: 'width: 8em' });
    const allBox = h('input', { type: 'checkbox', onchange: (e: Event) => (all = (e.target as HTMLInputElement).checked) });
    const add = () => {
      if (!file) { toast(`Zuerst eine .asm-Datei in ${ctx}/ hinzufügen.`, 'error'); return; }
      let bytes: number[];
      try { bytes = parseBytes(bytesIn.value); } catch (e) { toast(String((e as Error).message), 'error'); return; }
      const key = all ? ALL : num;
      const calls: UberCall[] = map.get(key) ?? [];
      calls.push({ file, bytes });
      map.set(key, calls);
      change();
    };
    return h('div', null,
      rows.length ? h('table', { class: 'uber-table' }, h('tr', null, h('th', null, 'Nr.'), h('th', null, 'Datei'), h('th', null, 'Extra-Bytes'), h('th')), rows)
        : h('p', { class: 'hint' }, `Noch keine Zuordnungen für ${CTX_LABEL[ctx]}.`),
      h('div', { class: 'row uber-add' },
        hexInput(num, digits, (v) => (num = v), CONTEXT_SIZE[ctx] - 1),
        h('label', { class: 'row small' }, allBox, 'alle (*)'),
        res.length ? select(res.map((f, i) => [i, f.slice(f.indexOf('/') + 1)] as [number, string]), 0, (i) => (file = res[i])) : h('span', { class: 'hint' }, `keine Dateien in ${ctx}/`),
        bytesIn,
        h('button', { onclick: add }, 'Zuordnen')),
    );
  }

  const files = () => proj.files;

  function other(): HTMLElement {
    const opts = [...files().keys()].filter((f) => /\.asm$/i.test(f) && f.startsWith('other/')).sort();
    const pick = (label: string, cur: string | null, set: (v: string | null) => void) => {
      const all: [number, string][] = [[-1, '(keine)'], ...opts.map((f, i) => [i, f] as [number, string])];
      return h('div', { class: 'prop' }, h('label', null, label), select(all, cur ? opts.indexOf(cur) : -1, (i) => { set(i < 0 ? null : opts[i]); change(); }));
    };
    return h('div', null,
      pick('Global (init)', proj.list.global, (v) => (proj.list.global = v)),
      pick('Statusleiste (main)', proj.list.statusbar, (v) => (proj.list.statusbar = v)),
      pick('Makro-Bibliothek', proj.list.macrolib, (v) => (proj.list.macrolib = v)),
      h('div', { class: 'prop' }, h('label', null, 'Free RAM (2 Bytes)'), hexInput(proj.list.freeram, 6, (v) => { proj.list.freeram = v; change(); })),
    );
  }

  function fileList(): HTMLElement {
    const list = [...files().keys()].filter((f) => f !== 'list.txt').sort();
    let folder = FOLDERS[0];
    const addFile = async () => {
      const f = await pickFile('.asm,.bin,.zip');
      if (!f) return;
      const data = new Uint8Array(await f.arrayBuffer());
      if (/\.zip$/i.test(f.name)) {
        for (const [p, c] of Object.entries(unzipSync(data))) if (!p.endsWith('/') && !p.startsWith('__MACOSX/')) files().set(folder + p.replace(/\\/g, '/').split('/').pop(), c);
      } else files().set(folder + f.name, data);
      change();
    };
    return h('div', null,
      h('div', { class: 'uber-files' }, list.length ? list.map((f) => h('div', { class: 'row' },
        h('span', { class: 'mono' }, f),
        definesButton(files(), f, change),
        h('button', { class: 'icon-btn', title: 'Datei löschen', onclick: () => { files().delete(f); change(); } }, '✕'))) : h('p', { class: 'hint' }, 'Keine Dateien.')),
      h('div', { class: 'row' },
        select(FOLDERS.map((f, i) => [i, f] as [number, string]), 0, (i) => (folder = FOLDERS[i])),
        h('button', { onclick: addFile }, 'Datei hinzufügen … (.asm, .bin oder .zip)')),
    );
  }

  function build(): void {
    clear(body).append(
      h('p', { class: 'hint' }, 'Code pro Level, Overworld-Karte und Game Mode im Format von UberASM Tool 2.x (Labels init/main/end/load/nmi, Bibliotheken, Shared Routines, Extra-Bytes). Ein vorhandener UberASM-Tool-Ordner kann als .zip importiert werden; die Quellen werden in der ROM gespeichert.'),
      h('div', { class: 'row' },
        h('button', { onclick: async () => {
          const f = await pickFile('.zip');
          if (!f) return;
          try { proj = projectFromZip(new Uint8Array(await f.arrayBuffer())); change(); toast(`UberASM-Projekt „${f.name}“ geladen – „Übernehmen“ wendet es an.`); } catch (e) { toast(String((e as Error).message), 'error'); }
        } }, 'UberASM-Ordner importieren (.zip) …'),
        h('button', { onclick: () => downloadBytes('uberasm.zip', projectToZip(proj), 'application/zip') }, 'Exportieren (.zip)')),
      h('div', { class: 'tabs' }, (['level', 'overworld', 'gamemode'] as UberContext[]).map((c) =>
        h('button', { class: c === ctx ? 'mode active' : 'mode', onclick: () => { ctx = c; build(); } }, CTX_LABEL[c]))),
      assignments(),
      h('h3', null, 'Weitere Dateien'),
      other(),
      h('h3', null, 'Projektdateien'),
      fileList(),
      dirty ? h('p', { class: 'hint' }, 'Nicht übernommene Änderungen.') : '',
      log,
    );
  }
  build();
}
