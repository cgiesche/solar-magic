// Part kinds: what a package brings into the ROM (see CONTEXT.md). One vocabulary for detection, the
// patch registry and the Packages dialog.

export type PartKind = 'patch' | 'uberasm' | 'block' | 'sprite' | 'owsprite' | 'music' | 'sfx' | 'graphics';

// the kinds whose parts go into a tool project (UberASM Tool, GPS, PIXI, BOWSIE) kept in the ROM
export type ToolKind = Extract<PartKind, 'uberasm' | 'block' | 'sprite' | 'owsprite'>;
export const TOOL_KINDS: ToolKind[] = ['uberasm', 'block', 'sprite', 'owsprite'];

export const PART_LABEL: Record<PartKind, string> = {
  patch: 'Patch', uberasm: 'UberASM code', block: 'Custom block', sprite: 'Custom sprite', owsprite: 'Overworld sprite', music: 'Music', sfx: 'Sound effect', graphics: 'Graphics',
};
