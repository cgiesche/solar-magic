# SMW Editor

A browser-based editor for Super Mario World ROMs: levels, graphics and third-party content (patches, UberASM, blocks, sprites, music) installed into the ROM.

## Language

### The editor's own patches

**Editor patches**:
The editor's own ASM in the ROM (SMWE, SMWV, SMWG, SMWP, SMWB, SMWU, SMWX, SMWH, SMWS, the ExAnimation engine, the layer 2 scroll rates, the level heights, SMWL's layer 3 graphics per level, the sprite scroll fix), installed into the clean ROM when it is opened; the editor relies on them and opens no other ROMs than the clean game and its own (ADR 0004). Only SMWM (message texts in free space) is installed when it is needed. Not third-party content and never part of a package.
_Avoid_: Lunar Magic hacks, built-in patches

### Editing

**ROM edit**:
One labelled change of the ROM (image and editor data), made through the edit session (editsession.ts, which leaves the write itself to romedit.ts): one undo step, all or nothing (one that fails changes nothing and records nothing), the open level saved before it; what it changed decides what the editor shows anew (the level reloaded, its header, structures). Outside the undo history: expanding the ROM. Every overworld change is one too (a paint stroke when the mouse is released).
_Avoid_: transaction, ROM write (for an edit)

**Remap**:
Changing 8x8 tile numbers, palettes or acts-like of chosen Map16 tiles (or the frames and targets of tile animations) in bulk, by an offset or a list in Lunar Magic's syntax (core/remap.ts); a list's sources are always the values before the remap. One ROM edit. It changes what tiles point at, never the graphics themselves.
_Avoid_: renumber (that is the level graphics placement's), move tiles (that is a tile move)

**Tile move**:
Map16 tiles 200–FFF taken to other numbers with their graphics, acts-like and block, every use rewritten (Direct Map16 objects of all levels, structures, BG tilemaps, the blocks' list) so the levels look as before (core/tilemove.ts); one ROM edit. Rewriting the uses alone, the tiles staying, is Lunar Magic's Remap Direct Map16 / Remap Background Tiles (a remap of uses, with a list of Map16 numbers).
_Avoid_: remap (for a move), renumber

**Quarter**:
One of the four 8x8 tiles of a Map16 tile, one 16-bit word: 8x8 tile number, palette, X/Y flip and priority (word order top-left, bottom-left, top-right, bottom-right). Acts-like is not a quarter's but the whole 16x16 tile's.
_Avoid_: 8x8 field, cell, subtile

**Marked quarters**:
The set of quarters of the Map16 tab's selection that an edit in the builder changes (palette, flips, priority, a chosen 8x8 tile by Enter). A new selection marks all. A **stamp** puts the chosen block of 8x8 tiles onto the quarters where it lies (right click, right drag paints; or dropped there), whatever is marked. A **flip** mirrors the marked quarters as one picture (across tile borders, each quarter's flip toggled); the marks must be symmetric to the axis. Acts-like applies to the wholly marked 16x16 tiles only and stays with its tile on a flip.
_Avoid_: selected quarter (the sheet's selection is of whole tiles)

**Conditional Direct Map16**:
A Direct Map16 object, or a tile of a structure, that depends on a flag of Lunar Magic's table at $7FC060–F (set by the user's own code, e.g. UberASM): drawn only while the flag is on, or with "always show" always, its tiles + 0x100 while it is on (cdm16.ts). The view's flags are a view setting that test play takes over, not part of the level.
_Avoid_: CDM16 (in the UI), switch object

**Level edit**:
A change of the open level in memory: its own undo step, written to the ROM when the level is saved (before every ROM edit, when another level is opened, or by hand).

**Graphics file**:
One of the files 000–FFF (the game's GFX 00–31 and the ExGFX) or an Anim graphic (A–D, numbered past them), read, written, created and imported through one interface (core/gfxfiles.ts): stored raw or LZ2, written in place when the new data fits its place, else moved to free space and the old place freed.
_Avoid_: ExGFX (for all of them), GFX entry (that is the file table's)

**Graphics slot**:
One of a level's places for a graphics file (core/gfxslots.ts): FG1–FG3, BG1 and SP1–SP4 (the header's tileset and sprite set by default), BG2/BG3, layer 3's LG1–LG4 (the game's 28–2B by default) and LT3 (none by default; an LT3 file copies at most its own length). FF puts the default back. Changing one is a ROM edit of that level only.
_Avoid_: GFX bypass (Lunar Magic's table), slot (alone, where an animation slot could be meant)

**Pixel editor**:
The zoomed view beside a graphics file's sheet in the Graphics tab, showing the 8x8 tiles picked on the sheet (at most 8x8 of them): the only place pixels are painted. The sheet itself picks tiles (left) and pastes them (right), as the other editors do.
_Avoid_: canvas, paint dialog

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

**Exit to the overworld**:
A secondary entrance that leads back to the overworld instead of into a level (Lunar Magic 3.00's): passing its level with the normal or the secret exit, or nothing, or ending the player's turn; optionally with another base event (the event of passing, + 1 for the secret exit) and teleporting Mario to a location of the overworld's star/pipe table (a star's or pipe's destination, or a location of its own). It belongs to a level, but is not one of its entrances.
_Avoid_: overworld entrance (Mario leaves the level by it), warp

**Camera start**:
Where layer 1 (FG) and layer 2 (BG) start when Mario enters: the game's FG/BG start Y, or (Lunar Magic's, horizontal levels) a number of rows above Mario, the BG then by the level's BG start – its bottom at the level's bottom (by the BG's height), rows below the FG, or at 0. Moving an entrance keeps it.
_Avoid_: FG/BG init (Lunar Magic's name), initial position

**Game view frame**:
A 256x224 frame over the level showing what the player sees there (Lunar Magic's Game View Screen), placed on the 8x8 grid inside the level and, once its camera reach is known, where the game lets the camera go; a view setting, not part of the level.
_Avoid_: camera box, screen preview

### Overworld

**Submap**:
One of the overworld's 7 maps: the main map (0) on the first 512x512 map, and Yoshi's Island, Vanilla Dome, Forest of Illusion, Valley of Bowser, Special World and Star World (1–6) sharing the second, each a fixed camera window there. Graphics, palettes, music and UberASM are per submap.
_Avoid_: world (that is the player's notion), map (alone, where the 512x512 map could be meant)

**Level tile**:
A layer 1 tile of the overworld that enters a level (tiles 56–80, and with Lunar Magic 82–86). Its translevel belongs to the tile and moves with it; the level's settings (name, base event, the direction each exit enables – in the ROM the "initial flags" byte –, the initial level flags of a new game – Lunar Magic's, with "no entry if passed" and "save prompt" – and message boxes) belong to the translevel: tiles entering the same level share them, a tile painted over leaves them with the level, a new tile entering it shows them. Free translevels that bring nothing along are given out first; the settings are reset only when asked.
_Avoid_: level dot, node

**Translevel**:
The number the overworld knows a level by (0–24 for levels 0–24, 25–5F for 101–13B), the index of everything per level on the overworld (names, base events, flags, saved progress). Stored per tile in Lunar Magic's table, not found by scanning the map, so placing a level tile shifts no other level's number.
_Avoid_: level number (for the overworld's), OW level

**Path tile**:
A layer 1 tile Mario walks, climbs or swims along, or stops or exits on; invisible in the game, drawn by the editor as an overlay. The game's 5 hardcoded paths are not tiles.
_Avoid_: road, Mario path (Lunar Magic's view name)

**Event**:
One of the overworld's 0x78 changes run once when a level is passed (its base event, + 1…3 for its secret exits) or by a teleport or the user's own code: layer 2 steps, layer 1 changes, reveals and destroyed level tiles. Chosen by the level and exit that runs it; its number shown only for those that run otherwise.
_Avoid_: path reveal (that is part of one), trigger

**Event step**:
A 6x6 or 2x2 block of 8x8 tiles an event changes on layer 2: **animated** (shown with the path fade, in order, on the submap of the level running the event) or **silent** (written at once, on other submaps). The user paints the map as it looks after the event; the editor finds its steps – which tiles changed to the map before it, the blocks, animated or silent, the order along the path from the level tile – and the user changes only their order on the timeline (ADR 0005).
_Avoid_: event tile (Lunar Magic's), piece

**Event progress**:
Up to which event the overworld is shown as passed (events applied in their number order, as the game does when it loads a save); a view setting that test play from the overworld takes over, not part of the ROM.
_Avoid_: events passed, after all events

**Reveal**:
A layer 1 tile that changes into another when an event passes over it (Lunar Magic's reveal list: which tile becomes which). An event reveals at most one tile, a tile can be revealed by several events; set on the tile, any layer 1 tile.

**Destroyed level tile**:
A layer 1 tile an event destroys when it passes (a castle, fortress or switch palace collapsing; a castle's top and the tile below it). One tile per event, 0x18 in all; set on the tile it destroys. What destroying a tile does is the game's code's.
_Avoid_: collapse (that is the animation), destruction event

**Layer 1 change**:
A layer 1 tile an event writes when it ends (a silent step on layer 1, shown when the map is loaded again: for other submaps and tiles not seen). Painted as layer 1 after the event, as event steps are.
_Avoid_: layer 1 event (Lunar Magic's mode)

**Overworld link**:
A star, pipe or exit path tile leading to another place of the overworld (one-way or both ways: an entry leading back), a location that an exit to the overworld teleports to, or the place a Koopa Kid puts Mario; an entry of the star/pipe table (0x100) or the exit path table (0x80), as in Lunar Magic. Made by dragging from the tile, drawn as an arrow.
_Avoid_: link (that is a part's), warp, teleport (for the tile)

**Overworld sprite**:
One of the game's 13 sprite slots of the overworld (Lakitu, bird, fish, Piranha Plant, cloud, Koopa Kid, smoke, Bowser sign, Bowser, Boos): a sprite and a position, the same on every submap – the sprite's own code decides where and when it shows; drawn as the game shows it at the event progress (emulated). Lunar Magic's custom overworld sprites (BOWSIE's) are another table.
_Avoid_: event sprite, OW object

**Start position**:
Where Mario and Luigi stand when a new game begins: a submap and a tile each.

### Third-party content

**Package**:
Something the user uploaded, together with everything it brought into the ROM; it is installed and removed as a whole. Uploading a package is the only way third-party content enters the ROM.
_Avoid_: Patch (for the whole thing), Resource, Download, Project

**Upload**:
The files the user hands in for one package (a single file or a .zip), before anything is installed.
_Avoid_: Download, patch package

**Callisto project**:
An upload that is a project of Underrout's build tool Callisto (it has `tools/Callisto/*.toml`), e.g. the Romhack Races baserom: one package with all its parts, its patches applied in the project's order, and the header Callisto generates (`callisto.asm`) provided for its code. Its data meant for a Lunar Magic ROM (BPS of the overworld, title screen, credits) is not part of it.
_Avoid_: baserom (that is one Callisto project), project import

**Replaced patch**:
A known third-party patch whose work an editor patch already does (e.g. a faster graphics upload for Lunar Magic's loader); skipped with a note when uploaded instead of installed.
_Avoid_: redundant patch, built-in patch (that is an editor patch)

**Part**:
One typed piece of a package: a patch, an UberASM file, a block, a sprite, a song or a graphics part. A package's kind is simply the set of its parts. Which part a file belongs to is decided per file (folder, then content, then extension), never by which other files are in the upload.
_Avoid_: Component, Item

**Graphics part**:
A part without code: Map16 tiles (.map16), an ExGFX file, a palette (.pal with its .palmask), the shared palettes' colors it changes (Lunar Magic's shared_palettes.pal: only those differing from the clean game's, which the editor keeps a copy of when it opens it; set back when the package is removed; two packages changing one color are a conflict), a global GFX file it edits (GFX00–33, only those differing from the clean game's; set back when the package is removed) or global animation slots (Lunar Magic's global ExAnimation as Callisto exports it, a BPS from the clean game to a whole Lunar Magic ROM, its list read from that ROM – the bytes the BPS takes from the clean game where this ROM still has them, told by the fingerprint of the clean game the editor keeps when it opens it; put in free slots of the global list, their frames in its Anim graphic; removed with the package, their frames too while no list reads them). Map16 tiles and ExGFX keep the author's tile or number (up to FFF) if it is free, else they take the next free one of the file's range (see ExGFX range). From an export of all Map16 (Lunar Magic's whole-ROM .map16) only the FG and BG tiles differing from the clean game are the package's, each page kept together; a tile acting like a block's tile shows that block. Its tileset pages 00–01 are the game's: differences are reported, not taken over.
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
The .mwl of a package that also has code: an example of the package in use. Optionally replaces the current level – or, when the package brings several, each its own level number –, with its Map16 tiles, ExGFX and (where certain) sprite numbers rewritten to where the package's parts landed. A level edit, not part of the package.
_Avoid_: Demo level, test level

**Level setup**:
What installing a package does to the current level so its graphics show: its ExGFX in the slots its tiles use, the ExAnimation slots that animate its tiles (their frames copied into the level's Anim graphic), its masked colors in the level's palette. A level edit: undo reverts it, removing the package does not.

**Level graphics placement**:
Bringing graphics parts (FG and BG Map16 tiles, ExGFX, palettes, animation frames) into a level by one set of rules (levelgfx.ts): Map16 tiles and ExGFX numbers are free when nothing uses them (a tile with a block of the block project is used); ExGFX go in the graphics slots, animation frames into the level's Anim graphic, masked colors into the level's palette, never into one made up when the level's colors are not known. The level setup, a level import and a sample level all place their graphics this way.
_Avoid_: background package, graphics import

**Anim graphic**:
One of four graphics (A–D, Lunar Magic's ExGFX 60–63) that tile animations take their frames from; each animation list (a level's, the global one) uses one, and every list using it shares it. The only place animation frames come from: frames a package or level file keeps elsewhere (Lunar Magic's AN2, its own ExGFX 60–63, the game's graphics in RAM) are copied in when it is imported (ADR 0003).
_Avoid_: AN2, alternative file, animation ExGFX

**Color rotation**:
An animation slot (types 18–1B) that moves a range of 2–128 palette colors along by one, right or left, every few animation frames; rotate right/left waits while its trigger does not hold, the "reverse on trigger" types always run and turn the other way while it holds. It has no frames: the colors are the level's own. Like a color animation it shows wherever the level's tiles draw those colors (the Animations tab lists and marks the Map16 tiles); colors the game itself sets every frame (Mario's palette) do not rotate in the game, found in the emulated level.
_Avoid_: palette rotate, palette cycling

**Animation trigger**:
What makes an animation slot run (Lunar Magic's ExAnimation triggers): a game condition (P-switches, ON/OFF, star, time below 100, 5 Dragon Coins – the last two also once), the precision timer (the slot shares the frame counter of the first slot of its 8), or one that the user's own code sets in the engine's RAM: a manual trigger (the frame to show), a custom trigger (on/off, a second frame set while on) or a one-shot (the slot plays once, then the engine turns it off). A list's **Trigger Init** sets custom triggers and manual frames when the level loads, the level's over the global list's. The view's triggers are a view setting that test play takes over (set after the level's load), not part of the level.
_Avoid_: event, flag (those are Conditional Direct Map16's)

### Emulated results

**Probe**:
Finding out how something behaves in the game by running the game's own code on it in an emulator: what a Map16 block does when Mario touches it, how Mario collides with it, what a sprite does when hit from below, how fast Mario runs in a tileset. A probe is always for one tileset.
_Avoid_: Test, check, lookup table

**Emulated result**:
Anything the editor learned by emulation (a probe's outcome, the kinds of a tileset's objects, a level scan, sprite images, object thumbnails, jump arcs). It stays valid as long as its inputs and the ROM bytes it read are unchanged, and is learned again otherwise (on the main thread by the result learner, core/learner.ts: a key, an input, the bytes read).
_Avoid_: Cached value, generation (for validity)

**Input**:
State outside the ROM that an emulated result depends on: the level as edited (one input for everything learned from it, with the view settings – switches, conditional Direct Map16 flags, animation triggers), the content of graphics files (their bytes don't count as read). Given next to the result's key and compared by its hash (core/inputs.ts), never by object identity.
_Avoid_: cache key (for what belongs in the input), dependency (that is a ROM byte read)

**Derived ROM data**:
What the editor reads out of the ROM without emulating (the custom sprite list, the graphics mask, the sprite memory values in use, a level as saved): memoized per ROM generation, not an emulated result.
_Avoid_: emulated result, cache

**Prefetch**:
Probing what the palettes could show before anyone asks for it, after everything asked for directly.

**Scroll bands**:
Where Mario is on the game's screen while the camera scrolls in a direction, or follows him after L/R looked ahead; learned by moving him in the probe level with the open level's mode and vertical scroll setting (an emulated result); a setting that keeps the camera still has no band that way.
_Avoid_: scroll zones, camera thresholds (they are not a table)

**Camera reach**:
What of the level the camera can show: where it goes with Mario carried along the level's top and bottom (vertical levels: its sides), standing as far as the camera is concerned; learned by the level scan (an emulated result), shown with the game view frame by darkening the rest; the game view frame is kept where the camera went (its range: from its first to its last place along the level, and where it went across there). The camera at one place (Mario standing there, the camera as the game puts it) places the game view frame by Mario.
_Avoid_: camera path (it is not one route through the level), covered area
