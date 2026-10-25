// Replaced patches (CONTEXT.md): known third-party patches whose work an editor patch already does.
// An upload leaves them out with a note instead of installing them. They are recognised by what their
// code does (the places it patches, the code it checks for), not by their file name.

export interface ReplacedPatch {
  name: string; // the patch and its author
  why: string; // what the editor already does instead
  matches(code: string): boolean; // code: lower case, without comments
}

const org = (code: string, addr: string) => new RegExp(`\\borg\\s+\\$${addr}\\b`).test(code);

export const REPLACED_PATCHES: ReplacedPatch[] = [
  {
    // checks for Lunar Magic's 4bpp loader ($10A2 at $00AACD) and replaces its upload loop at $00AA80 with one DMA
    name: 'Level graphics loading optimization (freeplay)',
    why: 'the editor already uploads level graphics straight to VRAM by DMA',
    matches: (c) => /\bread2\(\s*\$00aacd\s*\)/.test(c) && org(c, '00aa80'),
  },
  {
    // sets $55/$56 by the camera's movement: hooks at $00F713/$00F7F4, the game's stores at $00F728/$00F80C skipped
    name: 'Sprite Scroll Fix (HammerBrother)',
    why: 'the editor’s sprite scroll fix, after this patch, already sets the side sprites spawn on by the way the camera moves',
    matches: (c) => ['00f713', '00f7f4', '00f728', '00f80c'].every((a) => org(c, a)),
  },
];

// the replaced patch a patch's source is, if any
export function replacedPatch(src: string): ReplacedPatch | null {
  const code = src.split(/\r?\n/).map((l) => l.replace(/;.*$/, '')).join('\n').toLowerCase();
  return REPLACED_PATCHES.find((r) => r.matches(code)) ?? null;
}

export const replacedNote = (file: string, r: ReplacedPatch) => `Not installed: ${file} – ${r.name}, a replaced patch: ${r.why}.`;
