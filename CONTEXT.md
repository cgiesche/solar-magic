# SMW Editor

A browser-based editor for Super Mario World ROMs: levels, graphics and third-party content (patches, UberASM, blocks, sprites, music) installed into the ROM.

## Language

### Third-party content

**Package**:
Something the user uploaded, together with everything it brought into the ROM; it is installed and removed as a whole. Uploading a package is the only way third-party content enters the ROM.
_Avoid_: Patch (for the whole thing), Resource, Download, Project

**Upload**:
The files the user hands in for one package (a single file or a .zip), before anything is installed.
_Avoid_: Download, patch package

**Part**:
One typed piece of a package: a patch, an UberASM file, a block, a sprite, a song or graphics. A package's kind is simply the set of its parts.
_Avoid_: Component, Item

**Legacy package**:
A package wrapped around a single patch that was applied before packages were tracked.

**Level import**:
A Lunar Magic level file (.mwl) applied to the current level. It changes a level rather than installing content, so it is not a package.
_Avoid_: Graphics package, background package

### Emulated results

**Probe**:
Finding out how something behaves in the game by running the game's own code on it in an emulator: what a Map16 block does when Mario touches it, how Mario collides with it, what a sprite does when hit from below, how fast Mario runs in a tileset. A probe is always for one tileset.
_Avoid_: Test, check, lookup table

**Emulated result**:
Anything the editor learned by emulation (a probe's outcome, the kinds of a tileset's objects, a level scan). It stays valid as long as the ROM bytes it read are unchanged, and is learned again otherwise.
_Avoid_: Cached value, generation (for validity)

**Prefetch**:
Probing what the palettes could show before anyone asks for it, after everything asked for directly.
