// Part kinds: what a package brings into the ROM (see CONTEXT.md). One vocabulary for detection, the
// patch registry and the Packages dialog.

export type PartKind = 'patch' | 'uberasm' | 'block' | 'sprite' | 'owsprite' | 'music' | 'sfx' | 'graphics';

// the one order of the part kinds: installing applies a package's parts so and the preview lists them so –
// the patch first, the sprites' numbers before the blocks spawning them, AddmusicK after the UberASM code
// (as Callisto has it: it fits its NMI changes to a hijack of UberASM's that is there), the Map16 tiles
// after the blocks on them. Removing a package goes the other way round (pkgsections.ts), and so does
// detection for a file two kinds claim equally sure (pkgparts.ts DETECT_ORDER: the patch, the fallback, last).
export const PART_KINDS: PartKind[] = ['patch', 'uberasm', 'sprite', 'block', 'owsprite', 'music', 'sfx', 'graphics'];

// the kinds whose parts go into a tool project (UberASM Tool, GPS, PIXI, BOWSIE) kept in the ROM
export type ToolKind = Extract<PartKind, 'uberasm' | 'block' | 'sprite' | 'owsprite'>;
export const TOOL_KINDS: ToolKind[] = ['uberasm', 'block', 'sprite', 'owsprite'];

export const PART_LABEL: Record<PartKind, string> = {
  patch: 'Patch', uberasm: 'UberASM code', block: 'Custom block', sprite: 'Custom sprite', owsprite: 'Overworld sprite', music: 'Music', sfx: 'Sound effect', graphics: 'Graphics',
};
