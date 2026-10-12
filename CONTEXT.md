# SMW Editor

A browser-based editor for Super Mario World ROMs: levels, graphics and third-party content (patches, UberASM, blocks, sprites, music) installed into the ROM.

## Language

### The editor's own patches

**Editor patches**:
The editor's own ASM in the ROM (SMWE, SMWV, SMWG, SMWP, SMWB, SMWU, SMWX, SMWH, SMWS, the ExAnimation engine), installed when a ROM is opened; the editor relies on them, and a ROM whose hooks hold other code is not opened (ADR 0004). Only SMWM (message texts in free space) is installed when it is needed. Not third-party content and never part of a package.
_Avoid_: Lunar Magic hacks, built-in patches

### Third-party content

**Package**:
Something the user uploaded, together with everything it brought into the ROM; it is installed and removed as a whole. Uploading a package is the only way third-party content enters the ROM.
_Avoid_: Patch (for the whole thing), Resource, Download, Project

**Upload**:
The files the user hands in for one package (a single file or a .zip), before anything is installed.
_Avoid_: Download, patch package

**Part**:
One typed piece of a package: a patch, an UberASM file, a block, a sprite, a song or a graphics part. A package's kind is simply the set of its parts. Which part a file belongs to is decided per file (folder, then content, then extension), never by which other files are in the upload.
_Avoid_: Component, Item

**Graphics part**:
A part without code: Map16 tiles (.map16), an ExGFX file or a palette (.pal with its .palmask). Map16 tiles and ExGFX keep the author's tile or number if it is free, else they take the next free one.
_Avoid_: Resource, asset

**Link**:
A connection between two parts of one package that the editor works out: a block on the Map16 tiles that show it, a sprite's number in the define of a block that spawns it, an ExGFX file in the graphics slot its tiles are drawn from.
_Avoid_: Dependency, binding

**Legacy package**:
A package wrapped around a single patch that was applied before packages were tracked.

**Level import**:
An upload with a Lunar Magic level file (.mwl) and no code or songs, applied to the current level. It changes a level rather than installing content, so it is not a package. An upload with code is a package even when it holds a .mwl (see Sample level).
_Avoid_: Graphics package, background package

**Sample level**:
The .mwl of a package that also has code: an example of the package in use. Optionally replaces the current level, with its Map16 tiles, ExGFX and (where certain) sprite numbers rewritten to where the package's parts landed. A level edit, not part of the package.
_Avoid_: Demo level, test level

**Level setup**:
What installing a package does to the current level so its graphics show: its ExGFX in the slots its tiles use, the ExAnimation slots that animate its tiles (their frames copied into the level's Anim graphic), its masked colors in the level's palette. A level edit: undo reverts it, removing the package does not.

**Anim graphic**:
One of four graphics (A–D, Lunar Magic's ExGFX 60–63) that tile animations take their frames from; each animation list (a level's, the global one) uses one, and every list using it shares it. The only place animation frames come from: frames a package or level file keeps elsewhere (Lunar Magic's AN2, its own ExGFX 60–63, the game's graphics in RAM) are copied in when it is imported (ADR 0003).
_Avoid_: AN2, alternative file, animation ExGFX

### Emulated results

**Probe**:
Finding out how something behaves in the game by running the game's own code on it in an emulator: what a Map16 block does when Mario touches it, how Mario collides with it, what a sprite does when hit from below, how fast Mario runs in a tileset. A probe is always for one tileset.
_Avoid_: Test, check, lookup table

**Emulated result**:
Anything the editor learned by emulation (a probe's outcome, the kinds of a tileset's objects, a level scan). It stays valid as long as the ROM bytes it read are unchanged, and is learned again otherwise.
_Avoid_: Cached value, generation (for validity)

**Prefetch**:
Probing what the palettes could show before anyone asks for it, after everything asked for directly.
