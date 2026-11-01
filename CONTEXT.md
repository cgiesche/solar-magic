# SMW Editor

A browser-based editor for Super Mario World ROMs: levels, graphics and third-party content (patches, UberASM, blocks, sprites, music) installed into the ROM.

## Language

### The editor's own patches

**Editor patches**:
The editor's own ASM in the ROM (SMWE, SMWV, SMWG, SMWP, SMWB, SMWU, SMWX, SMWH, SMWS, the ExAnimation engine, the layer 2 scroll rates, the level heights, SMWL's layer 3 graphics per level, the sprite scroll fix, SMWM's two messages per level, the level names and the submap palettes in Lunar Magic's layout, FastROM), installed into the clean ROM when it is opened; the editor relies on them and opens no other ROMs than the clean game and its own (ADR 0004). Not third-party content and never part of a package.
_Avoid_: Lunar Magic hacks, built-in patches

**FastROM**:
The game's code runs in the fast ROM banks ($80 and up), as in most community hacks and the code written for them; an editor patch, so every ROM the editor makes is FastROM. Not a package's part (Callisto's initial patch is left out).
_Avoid_: speed patch, HiROM

### Editing

**ROM edit**:
One labelled change of the ROM (image and editor data), made through the edit session (editsession.ts, which leaves the write itself to romedit.ts): one undo step, all or nothing (one that fails changes nothing and records nothing), the open level saved before it; what it changed decides what the editor shows anew (the level reloaded, its header, prefabs). Outside the undo history: expanding the ROM. Every overworld change is one too (a paint stroke when the mouse is released).
_Avoid_: transaction, ROM write (for an edit)

**Remap**:
Changing 8x8 tile numbers, palettes or acts-like of chosen Map16 tiles (or the frames and targets of tile animations) in bulk, by an offset or a list in Lunar Magic's syntax (core/remap.ts); a list's sources are always the values before the remap. One ROM edit. It changes what tiles point at, never the graphics themselves.
_Avoid_: renumber (that is the level graphics placement's), move tiles (that is a tile move)

**Tile move**:
Map16 tiles 200–FFF taken to other numbers with their graphics, acts-like, block and name, every use rewritten (Direct Map16 objects of all levels, prefabs, BG tilemaps, the blocks' list) so the levels look as before (core/tilemove.ts); one ROM edit. Rewriting the uses alone, the tiles staying, is Lunar Magic's Remap Direct Map16 / Remap Background Tiles (a remap of uses, with a list of Map16 numbers).
_Avoid_: remap (for a move), renumber

**Quarter**:
One of the four 8x8 tiles of a Map16 tile, one 16-bit word: 8x8 tile number, palette, X/Y flip and priority (word order top-left, bottom-left, top-right, bottom-right). Acts-like is not a quarter's but the whole 16x16 tile's.
_Avoid_: 8x8 field, cell, subtile

**Tile name**:
What the user calls an FG or BG Map16 tile, to find it by later (usernames.ts; other things, e.g. graphics files or levels, are meant to be named the same way). At most 64 characters, one per tile; several tiles share a name to name a thing of several tiles. Editor data: kept with the project file, never in the playable ROM nor in a `.smwlevel` file. Belongs to the tile number: a paste or clear leaves it, a remap too; a tile move takes it along. Found by the sheet search and the central search (one result per name).
_Avoid_: label, tag, description

**Marked quarters**:
The set of quarters of the Map16 tab's selection that an edit in the builder changes (palette, flips, priority, a chosen 8x8 tile by Enter). A new selection marks all. A **stamp** puts the chosen block of 8x8 tiles onto the quarters where it lies (right click, right drag paints; or dropped there), whatever is marked. A **flip** mirrors the marked quarters as a whole (across tile borders, each quarter's flip toggled); the marks must be symmetric to the axis. Acts-like applies to the wholly marked 16x16 tiles only and stays with its tile on a flip.
_Avoid_: selected quarter (the sheet's selection is of whole tiles)

**Conditional Direct Map16**:
A Direct Map16 object, or a tile of a prefab, that depends on a flag of Lunar Magic's table at $7FC060–F (set by the user's own code, e.g. UberASM): drawn only while the flag is on, or with "always show" always, its tiles + 0x100 while it is on (cdm16.ts). The view's flags are a view setting that test play takes over, not part of the level.
_Avoid_: CDM16 (in the UI), switch object

**Resizable object**:
A standard object of the game (01–3F): its size (or type) is part of the object, so one object covers a whole area. The picker's Objects tab lists them under "Resizable".
_Avoid_: standard object (in the UI), normal object

**Fixed-size object**:
An extended object (object 00 with its number as an extra byte, 10–FF in the picker): it always looks the same, a size is not part of it. The picker's Objects tab lists them under "Fixed size" – those that draw tiles or, drawing none, change RAM when the level loads (ObjecTool's 98–FF that set a flag); "extended object" names its encoding only (by number: "Insert by number", the properties, the ROM format). Direct Map16 ($05) and prefabs ($04) are extended objects too, but are neither listed nor called fixed-size objects.
_Avoid_: extended object (for the picker's grouping), ext object

**Custom object**:
One of object 2D's numbers 00–FF (its 4th byte) where a hook in the ROM – ObjecTool's, the Retry System's midway bars – reads object 2D as 5 bytes: the 4th and 5th bytes are its **extension** (Lunar Magic's "Extension"), the 5th a setting. Whether 2D has them is learned by emulation (obj2d.ts); without such a hook 2D is a resizable object of 3 bytes. The picker's Objects tab lists under "Custom" the numbers that draw tiles or, drawing none, change RAM when the level loads. ObjecTool's custom extended objects (98–FF) are fixed-size objects.
_Avoid_: custom normal object (ObjecTool's name), user defined object (Lunar Magic's), custom midway (only the Retry System's)

**Object name**:
What a resizable or fixed-size object is called in the picker, the properties, the status bar and the search (objectnames.ts). Built in only for the game's own numbers (standard 01–21, extended 00, 01, 10–97, and 2E–3F per object group), after Lunar Magic's descriptions; the free numbers are "Object XX" / "Extended object XX" (the editor's own 04, 05 excepted). Over them an extended object's name from an installed package's Lunar Magic `.mw0t` (the newer package's where two name it; gone with the package). The user may rename any object for the project, over those names (editor data like a tile name; Reset brings the other one back).
_Avoid_: description, tooltip (Lunar Magic's `.osc`), label

**Object tooltip**:
What the picker says about an object beyond its name: an installed package's Lunar Magic `.osc` text for it (any object; kept with the package like the `.mw0t` names, objtext.ts), else for an object that draws nothing what its load changes in RAM ("sets $7FA402 bit 1", emulated).
_Avoid_: description, object name

**Object box**:
How the editor shows an object that writes no tile when the level loads (objboxes.ts): a tile at its position with its number, on top of other objects' tiles, its name beside it while hovered or selected; it is grabbed, moved and deleted there. Editor-only, never in the ROM; the picker's thumbnail of such an object is the same box. Lunar Magic shows a placeholder tile for unused extended objects.
_Avoid_: placeholder (Lunar Magic's), marker

**Object group**:
The set of tilesets whose objects 2E–3F are the same, because the game's object loader runs them through one table (the clean game has five: 0/7/C, 1, 2/6/8, 3/9/A/B/E, 4/5/D). Which table a tileset uses is learned by emulation; names of 2E–3F belong to the table, not to a tileset.
_Avoid_: tileset group (the tilesets sharing Map16 tileset tiles, learned apart, even though in the clean game the groups are the same), "T" value (Lunar Magic's)

**Prefab**:
A reusable block of Map16 tiles (at most 64x64, cells may be transparent, tiles may be conditional) stored in the ROM under a number 00–FF and placed in a level as one object, extended object $04 with the number as 4th byte (prefabs.ts, the editor patch SMWS). Made from the selected objects, or from a suggestion (prefabsuggest.ts: an arrangement of Direct Map16 objects repeated across the levels that a prefab would make smaller, with all its places replaced); a change to it applies in every level that places it, deleting it deletes its objects in every level, "Break up" turns a placed one back into the objects it was made from (kept in the editor data, prefabsources.ts) where they draw the level the same, else into Direct Map16 objects. A `.smwlevel` file carries the prefabs its level uses.
_Avoid_: structure (the old name), custom object (one of object 2D's numbers, ObjecTool's ASM objects), stamp (that is the Map16 builder's), collection (Lunar Magic's Custom Collections of Objects are copies without a link)

**Picker**:
The panel beside the level or the overworld that something to place or paint is chosen from: in a level objects, prefabs, Map16 tiles and sprites (layer 1/2 and sprites), BG and layer 3 tiles; in the overworld its tiles and sprites. What it draws keeps its pixels of one size: fixed grids fill its width (a Map16 page keeps its 16 columns), drawn at the next whole number of screen pixels per pixel above it and shrunk smoothly; single images at whole numbers of screen pixels; below 3× the hovered entry is shown enlarged beside it.
_Avoid_: palette (that is colors), Insert panel, tile selector

**Picked item**:
What the picker has chosen for a right click (or Shift+click) in layer 1/2 and sprites to place: an object, a block of Map16 tiles, a prefab or a sprite – or none. Choosing one in the picker clears the level's selection; a single item selected in the level becomes it (shown in its tab). A click into nothing (no item of a shown layer there, not dragged, without Ctrl) clears it with the selection, so does Esc once the selection is clear. Without one – and on the selection – the right click opens the level's context menu.
_Avoid_: palette item (the old name), brush (BG and layer 3 paint with one, never empty), current object, ghost (the view's ghosted other layer)

**Selection copy**:
What a right click places instead of the picked item when the level's selection was picked after it (a click, a box, or the item just placed): a copy of the selected items with their upper left at the mouse. A right click on the selection itself opens the context menu instead.
_Avoid_: stamp (that is the Map16 builder's), duplicate (Ctrl+D, one tile down-right)

**Placement preview**:
A view option (off by default: something drawn at the mouse feels like dragging, as if a left click dropped it): what a right click at the mouse would place, drawn translucent at the tile under it: the picked item or the selection copy, objects as the level's load draws them there with them added (emulated in the background; meanwhile the last one known follows the mouse), sprites with their images. Not shown over the selection or while dragging.
_Avoid_: ghost (the view's ghosted other layer), cursor image

**Level edit**:
A change of the open level in memory: its own undo step, written to the ROM when the level is saved (before every ROM edit, when another level is opened, or by hand).

**Graphics file**:
One of the files 000–FFF (the game's GFX 00–31 and the ExGFX) or an Anim graphic (A–D, numbered past them), read, written, created and imported through one interface (core/gfxfiles.ts): stored raw or LZ2, written in place when the new data fits its place, else moved to free space and the old place freed.
_Avoid_: ExGFX (for all of them), GFX entry (that is the file table's)

**Graphics slot**:
One of a level's places for a graphics file (core/gfxslots.ts): FG1–FG3, BG1 and SP1–SP4 (the header's tileset and sprite set by default), BG2/BG3, layer 3's LG1–LG4 (the game's 28–2B by default) and LT3 (none by default; an LT3 file copies at most its own length). A submap's are FG1–FG4 and SP1–SP4 (the overworld's files by default, core/submapgfx.ts) and layer 3's LG1–LG4 and LT3 (none: the game's border). FF puts the default back. Changing one is a ROM edit of that level (or submap) only.
_Avoid_: GFX bypass (Lunar Magic's table), slot (alone, where an animation slot could be meant)

**Pixel editor**:
The zoomed view beside a graphics file's sheet in the Graphics tab, showing the 8x8 tiles picked on the sheet (at most 8x8 of them): the only place pixels are painted. The sheet itself picks tiles (left) and pastes them (right), as the other editors do.
_Avoid_: canvas, paint dialog

**Level size**:
The height of a horizontal level without layer 2 objects, one of Lunar Magic 3.00's 32 sizes (the editor offers 00-1C); its screens share the game's level data, so a taller level has fewer screens. Objects and sprites below row 31 are placed by subscreens of 32 rows.
_Avoid_: dimension, level mode (that is the header's)

**Screen**:
One of a level's sections along its length, numbered from 00 (at most 32): in a horizontal level 16 tiles wide and as tall as the level, in a vertical level 16 tiles tall and as wide as the level (two halves of 16); the unit objects, sprites, screen exits and entrances are placed by, not the part of the level in sight at once (a view, 16x14 tiles, as the game view frame shows).
_Avoid_: screen (for a view of the level)

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

**Message**:
The text a message box sprite (B9) shows: two per translevel (message 1 and 2, as the sprite is set), and Yoshi's thank-you (message 3, translevel 0's message 2, in any level). A switch palace's message 1 also presses its switch and Yoshi's house shows message 2 while Mario rides Yoshi – which translevels these are the game's table tells. A level without text shows an empty box. Shown in the translevel's level and the sub-levels reached from it; a level nothing reaches shows translevel 0's (message 1 the intro's). Which message a placed sprite opens is what hitting it does in the game (the sprite probe: the game's B9 by its X position). Edited in the message panel beside the level, in the game's 18×8 box (SMWM, Lunar Magic's layout). While a package draws the message boxes instead of the game (a VWF dialog patch; told by emulation – a box opened in the game does not show the message SMWM holds –, the package named by the code that runs only while the box opens), the panel, the hover preview and the message checks give way to a note naming it; they come back when it is removed.
_Avoid_: message slot

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
Up to which event the overworld is shown as passed (events applied in their number order, as the game does when it loads a save); a view setting that test play from the overworld takes over, not part of the ROM. Test play takes over the save at that progress too – the levels passed with their paths open and the events triggered – learned by emulation: each event's level (the first that runs it) left with its exit in the event order, the game's code setting what passing it sets (core/owprogress.ts); a level only runs an event the game hasn't run, so of two levels running the same one only the first is passed.
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
One of the game's 13 sprite slots of the overworld (Lakitu, bird, fish, Piranha Plant, cloud, Koopa Kid, smoke, Bowser sign, Bowser, Boos): a sprite and a position, the same on every submap – the sprite's own code decides where and when it shows; drawn as the game shows it at the event progress (emulated). Lunar Magic's custom overworld sprites (BOWSIE's) are another table. Gone while BOWSIE is installed: its loader takes their table's place.
_Avoid_: event sprite, OW object

**Custom overworld sprite**:
A sprite of an overworld package (BOWSIE's format, Arinsu: an .asm with init and main) placed on one submap: its number (01–7E), a position and a height in 8px steps and its extra bytes, kept in Lunar Magic's custom overworld sprite table (`$0EF55D`, up to 0x18 a submap; the entry's size from the size table BOWSIE writes). The editor does BOWSIE's insertion itself (one patch, without MaxTile) and draws each placed sprite by emulation.
_Avoid_: OW sprite (for these), BOWSIE sprite (in the UI)

**Start position**:
Where Mario and Luigi stand when a new game begins: a submap and a tile each.

**Overworld option**:
One of Lunar Magic's "Extra Options" of the overworld the community uses (Start+Select on passed levels, Start to scroll the main map, the 5 hardcoded paths, the event path fade with the path reveal speed, the save prompt after castles and the like, saving Luigi's position, life exchange and L/R for it): a switch for the whole game that changes a few bytes of the game's code to Lunar Magic's, turned back the clean game's; one ROM edit each.
_Avoid_: extra option, setting (for these)

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
One typed piece of a package: a patch, an UberASM file, a block, a sprite, a song, a sound effect or a graphics part. A package's kind is simply the set of its parts. Which part a file belongs to is decided per file (folder, then content, then extension), never by which other files are in the upload.
_Avoid_: Component, Item

**Graphics part**:
A part without code: Map16 tiles (.map16), an ExGFX file, a palette (.pal with its .palmask), the shared palettes' colors it changes (Lunar Magic's shared_palettes.pal: only those differing from the clean game's, which the editor keeps a copy of when it opens it; set back when the package is removed; two packages changing one color are a conflict), a global GFX file it edits (Lunar Magic's Graphics/GFX##.bin, GFX00–33 – never an ExGFX file; only those differing from the clean game's – a 3bpp file's .bin is the 3bpp file when its 4th bitplane is empty or what the game's upload sets anyway (by emulation), else, with 128 tiles, kept 4bpp (colors 8–F, as Lunar Magic's 4bpp GFX; a smaller one loses its 4th bitplane); it replaces the game's file and is set back to the clean game's when the package is removed, unless changed since, which is reported; two packages changing one file are a conflict; a Callisto project's are those of the Graphics folder next to its output ROM) or global animation slots (Lunar Magic's global ExAnimation as Callisto exports it, a BPS from the clean game to a whole Lunar Magic ROM, its list read from that ROM – the bytes the BPS takes from the clean game where this ROM still has them, told by the fingerprint of the clean game the editor keeps when it opens it; put in free slots of the global list, their frames in its Anim graphic; removed with the package, their frames too while no list reads them). Map16 tiles and ExGFX keep the author's tile or number (up to FFF) if it is free, else they take the next free one of the file's range (see ExGFX range). From an export of all Map16 (Lunar Magic's whole-ROM .map16) only the FG and BG tiles differing from the clean game are the package's, each page kept together; a tile acting like a block's tile shows that block. Its tileset pages 00–01 are the game's: differences are reported, not taken over.
_Avoid_: Resource, asset

**Sound effect**:
A custom AddmusicK sound effect a package brings: a text file in a folder 1DF9 or 1DFC (its bank, the address code writes its number to to play it), numbered by the package's `Addmusic_sound effects.txt`. It keeps the author's number if it is free (not one of AddmusicK's own, not another package's), else takes the lowest free one of its bank; code of the package playing it by a define then gets that number (see Link). Kept in the music project, inserted by AddmusicK with the songs; removed with the package.
_Avoid_: SFX (in the UI), sample (that is a song's sound)

**ExGFX range**:
The part of the ExGFX numbers (000–FFF, Lunar Magic's) a file belongs in: ExGFX 80–DFF (then 32–7F) for graphics, E00–FFF for files kept "as is" – layer 3 graphics (2bpp), layer 3 tilemaps – which are never 3bpp. A file's range follows from the slot it is for (layer 3's: "as is") and its data (2bpp graphics and tilemaps "as is"; 3bpp graphics always ExGFX). FF is no file's number: it is a graphics slot's "none".
_Avoid_: Super ExGFX, extended range

**Link**:
A connection between two parts of one package that the editor works out: a block on the Map16 tiles that show it, a sprite's number in the define of a block that spawns it, a sound effect's number in the define of code that plays it (one whose comment names it, or one named like a sound effect set to the author's number – of the bank a define next to it names), an ExGFX file in the graphics slot its tiles are drawn from.
_Avoid_: Dependency, binding

**Level import**:
An upload with a Lunar Magic level file (.mwl) and no code or songs, applied to the current level. It changes a level rather than installing content, so it is not a package. An upload with code is a package even when it holds a .mwl (see Sample level).
_Avoid_: Graphics package, background package

**Sample level**:
The .mwl of a package that also has code: an example of the package in use. Optionally replaces the current level – or, when the package brings several, each the level of its own number, with its screen exits and graphics slots –, with its Map16 tiles, ExGFX and (where certain) sprite numbers rewritten to where the package's parts landed. Of several, those belonging to what is not part of the package are not offered: the title screen's level (the one the game loads for it) and a level the package's overworld moved (a level tile entering it where this ROM's enters another). A level edit (one at its own number written with the install and undone with it), not part of the package.
_Avoid_: Demo level, test level

**Level setup**:
What installing a package does to the current level so its graphics show: its ExGFX in the slots its tiles use, the ExAnimation slots that animate its tiles (their frames copied into the level's Anim graphic), its masked colors in the level's palette. A level edit: undo reverts it, removing the package does not.

**Level graphics placement**:
Bringing graphics parts (FG and BG Map16 tiles, ExGFX, palettes, animation frames) into a level by one set of rules (levelgfx.ts): Map16 tiles and ExGFX numbers are free when nothing uses them (a tile with a block of the block project is used); ExGFX go in the graphics slots, animation frames into the level's Anim graphic, masked colors into the level's palette, never into one made up when the level's colors are not known. The level setup, a level import and a sample level all place their graphics this way.
_Avoid_: background package, graphics import

**Anim graphic**:
One of four graphics (A–D, Lunar Magic's ExGFX 60–63) that tile animations take their frames from; each animation list (a level's, the global one, a submap's, the overworld's global one) uses one, and every list using it shares it. The only place animation frames come from: frames a package or level file keeps elsewhere (Lunar Magic's AN2, its own ExGFX 60–63, the game's graphics in RAM) are copied in when it is imported (ADR 0003).
_Avoid_: AN2, alternative file, animation ExGFX

**Color rotation**:
An animation slot (types 18–1B) that moves a range of 2–128 palette colors along by one, right or left, every few animation frames; rotate right/left waits while its trigger does not hold, the "reverse on trigger" types always run and turn the other way while it holds. It has no frames: the colors are the level's own. Like a color animation it shows wherever the level's tiles draw those colors (the Animations tab lists and marks the Map16 tiles); colors the game itself sets every frame (Mario's palette) do not rotate in the game, found in the emulated level.
_Avoid_: palette rotate, palette cycling

**Animation trigger**:
What makes an animation slot run (Lunar Magic's ExAnimation triggers): a game condition (P-switches, ON/OFF, star, time below 100, 5 Dragon Coins – the last two also once), the precision timer (the slot shares the frame counter of the first slot of its 8), or one that the user's own code sets in the engine's RAM: a manual trigger (the frame to show), a custom trigger (on/off, a second frame set while on) or a one-shot (the slot plays once, then the engine turns it off). A list's **Trigger Init** sets custom triggers and manual frames when the level loads, the level's over the global list's. On the overworld (a list per submap and the overworld's global one) the game conditions are replaced by **event triggers** (Lunar Magic's "Event Manual 8–F"): each holds, showing its second frame set, once the overworld event whose number its manual frame 8–F has is passed; the Trigger Init sets those numbers when the submap loads (also when Mario walks there). The view's triggers are a view setting that test play takes over (set after the level's load), not part of the level.
_Avoid_: event, flag (those are Conditional Direct Map16's)

### Emulated results

**Probe**:
Finding out how something behaves in the game by running the game's own code on it in an emulator: what a Map16 block does when Mario touches it, how Mario collides with it, what a sprite does when hit from below, how fast Mario runs in a tileset. A probe is always for one tileset. What blocks look like (Map16 quarters, colors, graphics files) is not among the bytes a probe has read: drawing keeps it (ADR 0008).
_Avoid_: Test, check, lookup table

**Switch state**:
A game condition a tile may act otherwise in: the blue P-switch running, the silver P-switch running, ON/OFF set to OFF. The collision probe runs once without and once in each, one at a time, and keeps the states that change how Mario collides with the tile or what jumping against it does (vanilla: coins and used blocks swap under the blue P-switch, Munchers become coins under the silver one). The view sets them (View → Game state), the level is drawn and the collision overlay shown in them; test play takes them over.
_Avoid_: Switch mode, P-state

**Play session**:
A level played in the emulator from gameplay on, frame by frame with the buttons held: it begins once the level's gameplay has started (or once Mario has settled: standing, the sprites running), and ends when Mario dies, the level is left, or whoever plays stops. Test play, probes that move Mario and the tests play a level that way.
_Avoid_: run, game loop, harness

**Emulated result**:
Anything the editor learned by emulation (a probe's outcome, the kinds of a tileset's objects, a level scan, sprite images, object thumbnails, jump arcs). It stays valid as long as its inputs and the ROM bytes it read are unchanged, and is learned again otherwise (by the result learner: a key, an input, the bytes read). One that is no picture doesn't count the display data among the bytes it read (ADR 0008). A result may be put together from parts kept on their own the same way (the sprite images of a set: one part per test level load of six sprites, grouped by number), so a change one part read learns only that part again.
_Avoid_: Cached value, generation (for validity)

**Result learner**:
What learns emulated results: runs the emulation for a result's key and input, records the ROM bytes it reads, and keeps the result while they and the input are unchanged. A read byte that changes while it learns starts it over. Wherever it runs (beside the editor or in the background worker) it learns the same way; probes are results it learns too.
_Avoid_: prober (for the whole), worker (for what it does)

**Picture**:
An emulated result that shows what things look like (sprite images, object thumbnails, the placement preview, animated tiles and colors), and so counts the display data among the bytes it read. Any other result (a probe, a level's uses, a jump arc, …) is no picture and leaves the display data out, so drawing a tile or changing a color keeps it (ADR 0008). The palette tab's trace of where colors come from leaves out only the colors' values.
_Avoid_: image, render (for the kind of result; a sprite image is one picture)

**Display data**:
The ROM bytes that only say what tiles and colors look like: the Map16 quarters (FG tiles 000–1FF of every tileset, the extended FG tiles, the BG tiles), the shared palettes and the levels' own palettes with their pointers. Not acts-like or the blocks' code. Graphics file data is no display data: no emulated result counts it as read, a graphics file's content is an input instead. Nor is ExAnimation data: only the palette tab's trace counts it as read (a color animation writes colors).
_Avoid_: graphics data, GFX (those are graphics files)

**Input**:
State outside the ROM that an emulated result depends on: the level as edited (one input for everything learned from it, with the view settings – switches, conditional Direct Map16 flags, animation triggers), the content of graphics files (their bytes don't count as read), for pictures of a level also what its animations copy at its load (the animation lists and the parts of their Anim graphics the frames read, which don't count as read either). Given next to the result's key and compared by its hash (core/inputs.ts), never by object identity. A key keeps the results of its latest used few inputs (core/romdeps.ts INPUTS_PER_KEY), the least recently used dropped first.
_Avoid_: cache key (for what belongs in the input), dependency (that is a ROM byte read)

**Derived ROM data**:
What the editor reads out of the ROM without emulating (the custom sprite list, the graphics mask, the sprite memory values in use, a level as saved): memoized per ROM generation, not an emulated result.
_Avoid_: emulated result, cache

**Savestate**:
Test play's one slot (F5 saves, F8 loads; Select+L / Select+R on a gamepad): the whole emulated machine at a frame – memory, registers, scroll, color math, the sound unit and what is on screen – so that loading it goes on exactly as from the moment of saving. It belongs to its level on the ROM as it was then: any change of the ROM since (the level saved, a ROM edit) makes it stale, and a stale one is dropped (core/savestate.ts). Not written to disk.
_Avoid_: snapshot (that is the emulator's boot state every load starts from), save (the game's own save file, or saving the level)

**Failed spawn**:
A slot search of the running game that found every slot it looked at taken, so a sprite (normal, extended or cluster) did not appear, or replaced another where the code then takes a slot anyway (core/slotwatch.ts). Recognised by what the code does (a loop testing consecutive slots for zero), not by the game's tables; a search through a few kept slots (Mario's two fireball slots) is none. It may come with other slots free: the level's sprite memory or the spawning code (a generator) limits the slots it may use. Test play's slot meter shows the live slots and lists the failed spawns with Mario's tile.
_Avoid_: sprite overflow, slot overflow

**Sprite group**:
A largest set of a level's sprites that fit in one view (16x14 tiles) together (an isolated sprite is one alone; a sprite may be in several): what the sprite memory check plays in the emulator, one at a time, to see which sprites lose tiles (core/spritemem.ts). The latest used groups keep their result per sprite memory value while the ROM bytes it read are unchanged, kept by their sprites' places relative to each other, so after a sprite change only the groups that changed are played again (not one moved as a whole).
_Avoid_: window, object group, group sprite (one sprite that spawns several)

**Group sprite**:
One entry of the level's sprite data that is several sprites in the game, its code spawning the others when it loads ($DE five Eeries, $E0 three platforms): one sprite to the editor, the slots it spawns counted for it by the sprite memory check.
_Avoid_: sprite group (that is the sprite memory check's), cluster sprite (a kind of sprite of its own)

**Lag frame**:
A frame of the level in which the game's main loop was not done before the next NMI, so the game slowed down (core/playlog.ts, from Snes.busyLines: the CPU never reached its wait loop). The CPU load of other frames is the share of the frame's scanlines from the NMI until that wait. Frames the game spends outside the level's game mode (loading, fading) are fully busy but no lag frames. Test play's lag meter shows the load per frame and lists lag frames close together as one event with Mario's tile; the level scan counts them per screen.
_Avoid_: slowdown frame, CPU overload

**Death marker**:
Where Mario died in a recent test play of a level, drawn over it (View → Death markers) with what killed him (core/deaths.ts): a death is the frame the game sets Mario dying, the killer is learned from what the code did up to then – the timer run out, Mario fallen out of view, else what the code read last: a sprite table for the slot in X (a sprite's code, normal, extended or cluster) or a layer 1 tile (a block). Kept in the browser per project (its id in the editor data, which a file name or saving as a project doesn't change) and level, the newest 100, until cleared (per level or all); each with the level's version then, those from before the level was last changed shown faded. Editor-local, never in the ROM.
_Avoid_: death point, skull

**Prefetch**:
Probing what the palettes could show before anyone asks for it, after everything asked for directly.

**Scroll bands**:
Where Mario is on the game's screen while the camera scrolls in a direction, or follows him after L/R looked ahead; learned by moving him in the probe level with the open level's mode and vertical scroll setting (an emulated result); a setting that keeps the camera still has no band that way.
_Avoid_: scroll zones, camera thresholds (they are not a table)

**Camera reach**:
What of the level the camera can show: where it goes with Mario carried along the level's top and bottom (vertical levels: its sides), standing as far as the camera is concerned; learned by the level scan (an emulated result), shown with the game view frame by darkening the rest; the game view frame is kept where the camera went (its range: from its first to its last place along the level, and where it went across there). The camera at one place (Mario standing there, the camera as the game puts it) places the game view frame by Mario.
_Avoid_: camera path (it is not one route through the level), covered area
