// Settings of a file as the define assignments at its top (`!name = value`): the form used when adding a
// patch or resource, and changing them after a project file was added, rewritten in place like when adding.

import { h, modal } from './dom.ts';
import { scanDefines, rewriteDefines } from '../core/patchpkg.ts';

const dec = new TextDecoder();
const enc = new TextEncoder();

export function hasDefines(files: Map<string, Uint8Array>, path: string): boolean {
  const d = files.get(path);
  return !!d && /\.(asm|asar)$/i.test(path) && scanDefines(dec.decode(d)).length > 0;
}

// one row per define of `text`, prefilled with `values`; read() gives the values differing from the file
export function definesForm(text: string, values: Record<string, string> = {}): { rows: HTMLElement[]; read: () => Record<string, string> } {
  const inputs = scanDefines(text).slice(0, 80).map((d) => {
    const inp = h('input', { value: values[d.name] ?? d.value, spellcheck: false, style: 'width: 12em' });
    return { d, inp, row: h('div', { class: 'prop' }, h('label', { title: d.comment }, '!' + d.name), inp, d.comment ? h('span', { class: 'hint' }, d.comment) : null) };
  });
  return {
    rows: inputs.map((x) => x.row),
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
  return h('button', { title: 'Defines der Datei ändern', onclick: () => openDefines(files, path, onChange) }, 'Einstellungen …');
}

export function openDefines(files: Map<string, Uint8Array>, path: string, onChange: () => void): void {
  const text = dec.decode(files.get(path)!);
  const form = definesForm(text);
  const body = h('div', { class: 'patch-settings' },
    h('p', { class: 'hint' }, 'Die Werte stehen in der Datei selbst; wirksam werden sie mit „Übernehmen“.'),
    form.rows);
  modal(`Einstellungen: ${path.split('/').pop()}`, body, [
    { label: 'Abbrechen' },
    { label: 'OK', primary: true, onClick: () => {
      const changed = form.read();
      if (!Object.keys(changed).length) return;
      files.set(path, enc.encode(rewriteDefines(text, changed).text));
      onChange();
    } },
  ]);
}
