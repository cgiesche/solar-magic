# SMW Editor

A browser-based editor for Super Mario World ROMs: levels, graphics and third-party content (patches, UberASM, blocks, sprites, music) installed into the ROM.

## Language

### Third-party content

**Package**:
Something the user uploaded, together with everything it brought into the ROM; it is installed and removed as a whole. Uploading a package is the only way third-party content enters the ROM.
_Avoid_: Patch (for the whole thing), Resource, Download, Project

**Part**:
One typed piece of a package: a patch, an UberASM file, a block, a sprite, a song or graphics. A package's kind is simply the set of its parts.
_Avoid_: Component, Item

**Legacy package**:
A package wrapped around a single patch that was applied before packages were tracked.

**Level import**:
A Lunar Magic level file (.mwl) applied to the current level. It changes a level rather than installing content, so it is not a package.
_Avoid_: Graphics package, background package
