// Files in and out of the editor: in the browser a file input and a download, in the desktop app (Tauri)
// the system's open/save dialogs and the file itself. The only place that tells the two apart.

import { h, toast } from './dom.ts';

export const desktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

// where a file picked in the desktop app lies (browser files have none)
const paths = new WeakMap<File, string>();
export function filePath(f: File): string | undefined { return paths.get(f); }

// the folder of the last file opened or saved: the dialogs start there
let lastDir = '';
function remember(path: string): void { lastDir = path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))); }
function inLastDir(name: string): string { return lastDir ? `${lastDir}${lastDir.includes('\\') ? '\\' : '/'}${name}` : name; }
function baseName(path: string): string { return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1); }

// the extensions of an <input accept> list ('.smc,.sfc,image/png' → smc, sfc, png)
function extensions(accept: string): string[] {
  const ext = accept.split(',').map((a) => a.trim()).map((a) => a.startsWith('.') ? a.slice(1) : a.startsWith('image/') ? a.slice(6) : '');
  return [...new Set(ext.filter(Boolean))];
}

export async function pickFile(accept: string): Promise<File | null> {
  if (!desktop) {
    return new Promise((resolve) => {
      const inp = h('input', { type: 'file', accept, style: 'display:none' });
      inp.addEventListener('change', () => { resolve(inp.files?.[0] ?? null); inp.remove(); });
      document.body.appendChild(inp);
      inp.click();
    });
  }
  const { open } = await import('@tauri-apps/plugin-dialog');
  const { readFile } = await import('@tauri-apps/plugin-fs');
  const ext = extensions(accept);
  const path = await open({ multiple: false, directory: false, defaultPath: lastDir || undefined, filters: ext.length ? [{ name: ext.map((e) => `.${e}`).join(', '), extensions: ext }] : [] });
  if (typeof path !== 'string') return null;
  let data: Uint8Array;
  try { data = await readFile(path); } catch (e) { toast(`Could not read “${path}”: ${e instanceof Error ? e.message : e}`, 'error'); return null; }
  remember(path);
  const f = new File([data as BlobPart], baseName(path));
  paths.set(f, path);
  return f;
}

// false: the save dialog was cancelled or writing failed (told in a toast)
export async function downloadBytes(name: string, data: Uint8Array, mime = 'application/octet-stream'): Promise<boolean> {
  if (!desktop) {
    const blob = new Blob([data as BlobPart], { type: mime });
    const a = h('a', { href: URL.createObjectURL(blob), download: name });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    return true;
  }
  const { save } = await import('@tauri-apps/plugin-dialog');
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  const path = await save({ defaultPath: inLastDir(name), filters: ext ? [{ name: `.${ext}`, extensions: [ext] }] : [] });
  if (!path) return false;
  return writeTo(path, data);
}

async function writeTo(path: string, data: Uint8Array): Promise<boolean> {
  const { writeFile } = await import('@tauri-apps/plugin-fs');
  try { await writeFile(path, data); } catch (e) { toast(`Could not write “${path}”: ${e instanceof Error ? e.message : e}`, 'error'); return false; }
  remember(path);
  return true;
}
