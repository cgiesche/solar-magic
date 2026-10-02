// Changing the settings of a project file (UberASM resource, block, sprite) after it was added: the
// define assignments at the top of the file (`!name = value`), rewritten in place like when adding.

import { h, modal } from './dom.ts';
import { scanDefines, rewriteDefines } from '../core/patchpkg.ts';

const dec = new TextDecoder();
const enc = new TextEncoder();

export function hasDefines(files: Map<string, Uint8Array>, path: string): boolean {
  const d = files.get(path);
  return !!d && /\.(asm|asar)$/i.test(path) && scanDefines(dec.decode(d)).length > 0;
}

// button opening the settings of `path`; onChange after the file was rewritten
export function definesButton(files: Map<string, Uint8Array>, path: string, onChange: () => void): HTMLElement | null {
  if (!hasDefines(files, path)) return null;
  return h('button', { title: 'Defines der Datei ändern', onclick: () => openDefines(files, path, onChange) }, 'Einstellungen …');
}

export function openDefines(files: Map<string, Uint8Array>, path: string, onChange: () => void): void {
  const text = dec.decode(files.get(path)!);
  const defs = scanDefines(text).slice(0, 80);
  const inputs = defs.map((d) => {
    const inp = h('input', { value: d.value, spellcheck: false, style: 'width: 12em' });
    return { d, inp, row: h('div', { class: 'prop' }, h('label', { title: d.comment }, '!' + d.name), inp, d.comment ? h('span', { class: 'hint' }, d.comment) : null) };
  });
  const body = h('div', { class: 'patch-settings' },
    h('p', { class: 'hint' }, 'Die Werte stehen in der Datei selbst; wirksam werden sie mit „Übernehmen“ im Projekt.'),
    inputs.map((x) => x.row));
  modal(`Einstellungen: ${path.split('/').pop()}`, body, [
    { label: 'Abbrechen' },
    { label: 'OK', primary: true, onClick: () => {
      const changed: Record<string, string> = {};
      for (const { d, inp } of inputs) { const v = inp.value.trim(); if (v && v !== d.value) changed[d.name] = v; }
      if (!Object.keys(changed).length) return;
      files.set(path, enc.encode(rewriteDefines(text, changed).text));
      onChange();
    } },
  ]);
}
