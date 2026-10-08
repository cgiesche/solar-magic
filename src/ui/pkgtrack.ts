// Files of installed packages that older editor versions kept in the browser (pkg:<id>) move into the
// editor data with the package record (rom.extra, saved with the project), where they are under undo
// like everything else of the package.

import { zipSync } from 'fflate';
import type { App } from './app.ts';
import { kvGet, kvWrite } from './storage.ts';
import { listPackages, savePackage } from '../core/pkgreg.ts';

const kvKey = (id: string) => `pkg:${id}`;

// moves them (the ROM is stored before the browser copies are deleted); the number of packages moved
export async function moveBrowserPackageFiles(app: App): Promise<number> {
  const moved: string[] = [];
  for (const rec of listPackages(app.rom)) {
    if (rec.srcId || rec.src || rec.legacy) continue;
    const kept = await kvGet<[string, Uint8Array][]>(kvKey(rec.id)).catch(() => undefined);
    if (!kept) continue;
    const now = listPackages(app.rom).find((r) => r.id === rec.id); // (the ROM may have changed meanwhile)
    if (!now || now.srcId) continue;
    savePackage(app.rom, now, zipSync(Object.fromEntries(kept), { level: 9 }));
    moved.push(rec.id);
  }
  if (!moved.length) return 0;
  app.romWritten();
  await kvWrite([], moved.map(kvKey));
  return moved.length;
}
