# SMW Editor

A browser-based editor for Super Mario World ROMs: levels, graphics and third-party content (patches, UberASM, blocks, sprites, music) installed into the ROM.

## Language

### The editor's own patches

**Editor patches**:
The editor's own ASM in the ROM (SMWE, SMWV, SMWG, SMWP, SMWB, SMWU, SMWX, SMWH, SMWS, the ExAnimation engine, the layer 2 scroll rates, the level heights, SMWL's layer 3 graphics per level), installed into the clean ROM when it is opened; the editor relies on them and opens no other ROMs than the clean game and its own (ADR 0004). Only SMWM (message texts in free space) is installed when it is needed. Not third-party content and never part of a package.
_Avoid_: Lunar Magic hacks, built-in patches

### Editing

**ROM edit**:
One labelled change of the ROM (image and editor data), made through the edit session (romedit.ts): one undo step, all or nothing (one that fails changes nothing and records nothing), the open level saved before it; what it changed decides what the editor shows anew (the level reloaded, its header, structures). Outside the undo history: the overworld's save (the overworld editor has its own undo) and expanding the ROM.
_Avoid_: transaction, ROM write (for an edit)

**Remap**:
Changing 8x8 tile numbers, palettes or acts-like of chosen Map16 tiles (or the frames and targets of tile animations) in bulk, by an offset or a list in Lunar Magic's syntax (core/remap.ts); a list's sources are always the values before the remap. One ROM edit. It changes what tiles point at, never the graphics themselves.
_Avoid_: renumber (that is the level graphics placement's), move tiles

**Quarter**:
One of the four 8x8 tiles of a Map16 tile, one 16-bit word: 8x8 tile number, palette, X/Y flip and priority (word order top-left, bottom-left, top-right, bottom-right). Acts-like is not a quarter's but the whole 16x16 tile's.
_Avoid_: 8x8 field, cell, subtile

**Marked quarters**:
The set of quarters of the Map16 tab's selection that an edit in the builder changes (palette, flips, priority, a chosen 8x8 tile by Enter). A new selection marks all. A **stamp** puts the chosen block of 8x8 tiles onto the quarters where it lies (right click, right drag paints; or dropped there), whatever is marked. Acts-like applies to the wholly marked 16x16 tiles only.
_Avoid_: selected quarter (the sheet's selection is of whole tiles)

**Conditional Direct Map16**:
A Direct Map16 object, or a tile of a structure, that depends on a flag of Lunar Magic's table at $7FC060–F (set by the user's own code, e.g. UberASM): drawn only while the flag is on, or with "always show" always, its tiles + 0x100 while it is on (cdm16.ts). The view's flags are a view setting that test play takes over, not part of the level.
_Avoid_: CDM16 (in the UI), switch object

**Level edit**:
A change of the open level in memory: its own undo step, written to the ROM when the level is saved (before every ROM edit, when another level is opened, or by hand).

**Level size**:
The height of a horizontal level without layer 2 objects, one of Lunar Magic 3.00's 32 sizes (the editor offers 00-1B); its screens share the game's level data, so a taller level has fewer screens. Objects and sprites below row 31 are placed by subscreens of 32 rows.
_Avoid_: dimension, level mode (that is the header's)

**Tile entrance**:
An entrance that puts Mario at a tile of its screen (Lunar Magic's), instead of at one of the game's table positions, which don't reach a taller level's rows; its camera starts a number of rows above Mario. Entrances placed in a level with a size are tile entrances.
_Avoid_: method 2, exact entrance

**Midway entrance**:
Where Mario starts in a level once he has touched its midway tape (the midway point, Z): the main entrance's position and settings on the midway screen as in the game, or (Lunar Magic's) a tile of its own with its own action, camera start and options. Dragging it gives it its own. A standard screen exit set to "go to midway entrance" leads there when it has its own settings.
_Avoid_: checkpoint (that is the tape), midway screen (for the whole entrance)

**New-style exit**:
A screen exit with Lunar Magic's u flag: its own number (with the high bit) is the target level or secondary entrance, and it is secondary or standard on its own – so it leads into either bank (0xx/1xx). Every exit the editor writes is one, and the game's exits are made new-style when the clean game is patched, leading where the game leads them – an old-style exit (the game's rule) takes the high bit from the overworld submap Mario is on, the level's last exit deciding secondary.
_Avoid_: LM exit, exit format 2

**Camera start**:
Where layer 1 (FG) and layer 2 (BG) start when Mario enters: the game's FG/BG start Y, or (Lunar Magic's, horizontal levels) a number of rows above Mario, the BG then by the level's BG start – its bottom at the level's bottom (by the BG's height), rows below the FG, or at 0. Moving an entrance keeps it.
_Avoid_: FG/BG init (Lunar Magic's name), initial position

**Game view frame**:
A 256x224 frame over the level showing what the player sees there (Lunar Magic's Game View Screen), placed on the 8x8 grid inside the level and, once its camera reach is known, where the game lets the camera go; a view setting, not part of the level.
_Avoid_: camera box, screen preview

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
A part without code: Map16 tiles (.map16), an ExGFX file or a palette (.pal with its .palmask). Map16 tiles and ExGFX keep the author's tile or number (up to FFF) if it is free, else they take the next free one of the file's range (see ExGFX range).
_Avoid_: Resource, asset

**ExGFX range**:
The part of the ExGFX numbers (000–FFF, Lunar Magic's) a file belongs in: ExGFX 80–DFF (then 32–7F) for graphics, E00–FFF for files kept "as is" – layer 3 graphics (2bpp), layer 3 tilemaps – which are never 3bpp. A file's range follows from the slot it is for (layer 3's: "as is") and its data (2bpp graphics and tilemaps "as is"; 3bpp graphics always ExGFX). FF is no file's number: it is a graphics slot's "none".
_Avoid_: Super ExGFX, extended range

**Link**:
A connection between two parts of one package that the editor works out: a block on the Map16 tiles that show it, a sprite's number in the define of a block that spawns it, an ExGFX file in the graphics slot its tiles are drawn from.
_Avoid_: Dependency, binding

**Level import**:
An upload with a Lunar Magic level file (.mwl) and no code or songs, applied to the current level. It changes a level rather than installing content, so it is not a package. An upload with code is a package even when it holds a .mwl (see Sample level).
_Avoid_: Graphics package, background package

**Sample level**:
The .mwl of a package that also has code: an example of the package in use. Optionally replaces the current level, with its Map16 tiles, ExGFX and (where certain) sprite numbers rewritten to where the package's parts landed. A level edit, not part of the package.
_Avoid_: Demo level, test level

**Level setup**:
What installing a package does to the current level so its graphics show: its ExGFX in the slots its tiles use, the ExAnimation slots that animate its tiles (their frames copied into the level's Anim graphic), its masked colors in the level's palette. A level edit: undo reverts it, removing the package does not.

**Level graphics placement**:
Bringing graphics parts (FG and BG Map16 tiles, ExGFX, palettes, animation frames) into a level by one set of rules (levelgfx.ts): Map16 tiles and ExGFX numbers are free when nothing uses them (a tile with a block of the block project is used); ExGFX go in the graphics slots, animation frames into the level's Anim graphic, masked colors into the level's palette, never into one made up when the level's colors are not known. The level setup, a level import and a sample level all place their graphics this way.
_Avoid_: background package, graphics import

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

**Scroll bands**:
Where Mario is on the game's screen while the camera scrolls in a direction, or follows him after L/R looked ahead; learned by moving him in the probe level with the open level's mode and vertical scroll setting (an emulated result); a setting that keeps the camera still has no band that way.
_Avoid_: scroll zones, camera thresholds (they are not a table)

**Camera reach**:
What of the level the camera can show: where it goes with Mario carried along the level's top and bottom (vertical levels: its sides), standing as far as the camera is concerned; learned by the level scan (an emulated result), shown with the game view frame by darkening the rest; the game view frame is kept where the camera went (its range: from its first to its last place along the level, and where it went across there). The camera at one place (Mario standing there, the camera as the game puts it) places the game view frame by Mario.
_Avoid_: camera path (it is not one route through the level), covered area
