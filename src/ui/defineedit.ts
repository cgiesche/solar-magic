// Settings of a file as the define assignments at its top (`!name = value`): the form used when adding a
// patch or resource, and changing them after a project file was added, rewritten in place like when adding;
// and a project file edited as text, for everything else.

import { h, modal } from './dom.ts';
import { scanDefines, rewriteDefines } from '../core/patchpkg.ts';

const dec = new TextDecoder();
const enc = new TextEncoder();

export function hasDefines(files: Map<string, Uint8Array>, path: string): boolean {
  const d = files.get(path);
  return !!d && /\.(asm|asar)$/i.test(path) && scanDefines(dec.decode(d)).length > 0;
}

// one row per define of `text`, prefilled with `values`, grouped by the file's section headings, with the
// comments above each as help and a search field for long lists; read() gives the values differing from
// the file
export function definesForm(text: string, values: Record<string, string> = {}): { rows: HTMLElement[]; read: () => Record<string, string> } {
  const defs = scanDefines(text);
  const inputs = defs.map((d, i) => {
    const inp = h('input', { value: values[d.name] ?? d.value, spellcheck: false, style: 'width: 12em' });
    // a comment above several defines in a row is shown once, above the first
    const doc = d.doc && d.doc !== defs[i - 1]?.doc ? h('div', { class: 'hint define-doc' }, d.doc) : null;
    const row = h('div', { class: 'define-row' },
      doc,
      h('div', { class: 'prop' }, h('label', { title: d.comment || d.doc }, '!' + d.name), inp, d.comment ? h('span', { class: 'hint' }, d.comment) : null));
    return { d, inp, row };
  });
  const sections = [...new Set(defs.map((d) => d.section))];
  const heads = new Map(sections.filter(Boolean).length > 1 ? sections.map((t) => [t, h('h4', { class: 'define-section' }, t || 'General')]) : []);
  const rows: HTMLElement[] = [];
  for (const x of inputs) {
    const head = heads.get(x.d.section);
    if (head && !rows.includes(head)) rows.push(head);
    rows.push(x.row);
  }
  if (inputs.length > 12) {
    const search = h('input', { type: 'search', placeholder: `Search ${inputs.length} settings …`, spellcheck: false, class: 'define-search', oninput: () => {
      const q = search.value.trim().toLowerCase();
      for (const x of inputs) x.row.hidden = !!q && !`${x.d.name} ${x.d.comment} ${x.d.doc} ${x.d.section}`.toLowerCase().includes(q);
      for (const [t, el] of heads) el.hidden = inputs.every((x) => x.d.section !== t || x.row.hidden);
    } });
    rows.unshift(search);
  }
  return {
    rows,
    read: () => {
      const out: Record<string, string> = {};
      for (const { d, inp } of inputs) { const v = inp.value.trim(); if (v && v !== d.value) out[d.name] = v; }
      return out;
    },
  };
}

// button opening the settings of `path`; onChange after the file was rewritten
export function definesButton(files: Map<string, Uint8Array>, path: string, onChange: () => void): HTMLElement | null {
  if (!hasDefines(files, path)) return null;
  return h('button', { title: 'Change the file\'s defines', onclick: () => openDefines(files, path, onChange) }, 'Settings …');
}

export function openDefines(files: Map<string, Uint8Array>, path: string, onChange: () => void): void {
  const text = dec.decode(files.get(path)!);
  const form = definesForm(text);
  const dlg = modal(`Settings: ${path.split('/').pop()}`, h('div', { class: 'patch-settings define-dialog' },
    h('div', { class: 'row' },
      h('span', { class: 'hint grow' }, 'The values are stored in the file itself; they take effect with “Apply”.'),
      h('button', { title: 'The whole file as text – for anything that is not a setting of the form !name = value', onclick: () => { dlg.close(); openTextEdit(files, path, onChange); } }, 'Edit as text …')),
    form.rows), [
    { label: 'Cancel' },
    { label: 'OK', primary: true, onClick: () => {
      const changed = form.read();
      if (!Object.keys(changed).length) return;
      files.set(path, enc.encode(rewriteDefines(text, changed).text));
      onChange();
    } },
  ]);
}

// a project file as text: for settings that are not defines (macro lists, tables) or anything else
export const isTextFile = (path: string) => /\.(asm|asar|txt|cfg|json|md)$/i.test(path);

export function editButton(files: Map<string, Uint8Array>, path: string, onChange: () => void): HTMLElement | null {
  if (!isTextFile(path)) return null;
  return h('button', { title: 'Edit the file as text', onclick: () => openTextEdit(files, path, onChange) }, 'Edit …');
}

export function openTextEdit(files: Map<string, Uint8Array>, path: string, onChange: () => void): void {
  const text = dec.decode(files.get(path)!);
  const area = h('textarea', { class: 'text-edit mono', spellcheck: false, value: text, onkeydown: (e: KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    area.setRangeText('\t', area.selectionStart, area.selectionEnd, 'end');
  } });
  modal(`Edit: ${path}`, h('div', { class: 'text-edit-box' },
    h('p', { class: 'hint' }, 'The change takes effect with “Apply”; Asar then reports errors with file and line.'), area), [
    { label: 'Cancel' },
    { label: 'OK', primary: true, onClick: () => {
      if (area.value === text) return;
      files.set(path, enc.encode(area.value));
      onChange();
    } },
  ]);
}
