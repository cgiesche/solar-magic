// The files of an installed package: kept with its record in the editor data (rom.extra, saved with the
// project), or by older editor versions in the browser. Recording what a package puts into the ROM is
// core/pkgreg.ts (recordPackageChange).

import { unzipSync } from 'fflate';
import type { App } from './app.ts';
import { kvGet, kvDel } from './storage.ts';
import { packageArchive, type Package } from '../core/pkgreg.ts';

const kvKey = (id: string) => `pkg:${id}`;

// the files of an installed package, null if they are kept nowhere
export async function recordFiles(app: App, rec: Package): Promise<Map<string, Uint8Array> | null> {
  const a = packageArchive(app.rom, rec);
  if (a) return new Map(Object.entries(unzipSync(a)));
  const kept = await kvGet<[string, Uint8Array][]>(kvKey(rec.id)).catch(() => undefined);
  return kept ? new Map(kept) : null;
}

export function forgetRecordFiles(id: string): void {
  kvDel(kvKey(id)).catch(() => {});
}
