// The project's own id: random, made once and kept in the editor data (so in the browser's copy and the
// project file, not in an exported ROM), for what the browser keeps per project apart from it (death markers)
// – a project's file name changes when it is saved as a project, its id doesn't.

import type { Rom } from './rom.ts';

const ID = 'project-id';

// makes the id (puts it into the editor data) unless the ROM has one; whether it made it
export function makeProjectId(rom: Rom): boolean {
  if (rom.getBlob(ID)) return false;
  const id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (x) => x.toString(16).padStart(2, '0')).join('');
  rom.setBlob(ID, new TextEncoder().encode(id));
  return true;
}

// the id (made when the ROM has none)
export function projectId(rom: Rom): string {
  makeProjectId(rom);
  return new TextDecoder().decode(rom.getBlob(ID)!);
}
