# SMW Editor

A browser-based editor for Super Mario World ROMs: levels, graphics and third-party content (patches, UberASM, blocks, sprites, music) installed into the ROM.

## Language

### The editor's own patches

**Editor patches**:
The editor's own ASM in the ROM (SMWE, SMWV, SMWG, SMWP, SMWB, SMWU, SMWX, SMWH, SMWS, the ExAnimation engine, the layer 2 scroll rates, the level heights, SMWL's layer 3 graphics per level, the sprite scroll fix, SMWM's two messages per level, the level names and the submap palettes in Lunar Magic's layout, FastROM), installed into the clean ROM when it is opened (an editor ROM's SMWV from an older source is updated then); the editor relies on them and opens no other ROMs than the clean game and its own (ADR 0004). Not third-party content and never part of a package.
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
A standard object of the game (01–3F): its size (or type) is part of the object, so one object covers a whole area. The picker's Objects tab lists them under "Resizable". A custom object is resized the same way where emulation shows that the nibbles of one of its bytes size it.
_Avoid_: standard object (in the UI), normal object

**Fixed-size object**:
An extended object (object 00 with its number as an extra byte, 10–FF in the picker): it always looks the same, a size is not part of it. The picker's Objects tab lists them under "Fixed size" – those that draw tiles or, drawing none, change RAM when the level loads (ObjecTool's 98–FF that set a flag); "extended object" names its encoding only (by number: "Insert by number", the properties, the ROM format). Direct Map16 ($05) and prefabs ($04) are extended objects too, but are neither listed nor called fixed-size objects.
_Avoid_: extended object (for the picker's grouping), ext object

**Custom object**:
One of object 2D's numbers 00–FF (its 4th byte) where a hook in the ROM – ObjecTool's, the Retry System's midway bars – reads object 2D as 5 bytes: the 4th and 5th bytes are its **extension** (Lunar Magic's "Extension"), the 5th a setting. Which of its bytes sizes it (or selects its type) – the 5th, else the 3rd, else none (the midway bars) – is learned by emulation per custom number (objkinds.ts). Whether 2D has them is learned by emulation (obj2d.ts); without such a hook 2D is a resizable object of 3 bytes. The picker's Objects tab lists under "Custom" the numbers that draw tiles or, drawing none, change RAM when the level loads. ObjecTool's custom extended objects (98–FF) are fixed-size objects.
_Avoid_: custom normal object (ObjecTool's name), user defined object (Lunar Magic's), custom midway (only the Retry System's)

**Object name**:
What a resizable or fixed-size object is called in the picker, the properties, the status bar and the search (objectnames.ts). Built in only for the game's own numbers (standard 01–21, extended 00, 01, 10–97, and 2E–3F per object group), after Lunar Magic's descriptions; the free numbers are "Object XX" / "Extended object XX" (the editor's own 04, 05 excepted). Over them an extended object's name from an installed package's Lunar Magic `.mw0t` (the newer package's where two name it; gone with the package). The user may rename any object for the project, over those names (editor data like a tile name; Reset brings the other one back).
_Avoid_: description, tooltip (Lunar Magic's `.osc`), label

**Object tooltip**:
What the picker says about an object beyond its name: an installed package's Lunar Magic `.osc` text for it (any object; kept with the package like the `.mw0t` names, objtext.ts), else for an object that draws nothing what its load changes in RAM ("sets $7FA402 bit 1", emulated).
_Avoid_: description, object name

**Object box**:
How the editor shows an object that writes no tile when the level loads (objboxes.ts): a tile at its position with its number, on top of other objects' tiles, its name beside it while hovered or selected; it is grabbed, moved and deleted there. Editor-only, never in the ROM; the picker's thumbnail of such an object is the same box, and so is that of a custom extended object (98–FF) without a handler, whose load runs the game's leftover entry of its pointer table (on the clean game door parts, #110). Lunar Magic shows a placeholder tile for unused extended objects.
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
One of a level's sections along its length, numbered from 00 (at most 32): in a horizontal level 16 tiles wide and as tall as the level, in a vertical level 16 tiles tall and as wide as the level (two halves of 16); the unit objects, sprites, screen exits and entrances are placed by, not the part of the level in sight at once (that is a view), nor a 32x32-tile part of a layer's tilemap (that is a tilemap quadrant).
_Avoid_: screen (for a view of the level or a tilemap quadrant)

**View**:
The part of the level in sight at once in the game: 256x224 pixels (16x14 tiles), as the game view frame shows it, placed by the camera. The sprite memory check plays what fits in one (sprite groups). Not the editor's level view, nor its view settings.
_Avoid_: screen (that is a level section), window

**Tilemap quadrant**:
A 32x32-tile part of a tilemap laid out as the SNES reads it (in VRAM 0x800 bytes; the SNES's "screen"): a layer's tilemap is 1, 2 or 4 of them side by side and one below the other (layer 3's: core/render.ts layer3Geometry; the overworld's layer 1 and 2 maps keep that layout). Not a level's screen, nor a BG tilemap (the level's stored layer 2 background).
_Avoid_: screen, block (that is a Map16 tile's behaviour)

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
One of the overworld's 7 maps: the main map (0) on the first 512x512 map, and Yoshi's Island, Vanilla Dome, Forest of Illusion, Valley of Bowser, Special World and Star World (1–6) sharing the second, each a fixed camera window there. Graphics, palettes, music and UberASM are per submap. The windows (**views**, as the game sets the camera; core/owevents.ts submapViews) overlap: Vanilla Dome's lower rows lie in Forest of Illusion's view too (in the clean game Vanilla Dome 05,14, its entrance), so a tile of the shared map alone doesn't tell its submap. Where the user acts on a shown submap a tile in its view is on it; where an entry stores its submap (a link end) that one counts; only where the tile alone is known it is the submap whose view's center is nearest. A link end dropped on a tile several views show asks which submap, the one whose paths the tile is on preselected (its stop and level tiles connected along the paths lie in that view alone), else the shown one, else the nearest view's (core/owlinkends.ts). Mario walking stays on his submap; only a link takes him to another.
_Avoid_: world (that is the player's notion), map (alone, where the 512x512 map could be meant)

**Level tile**:
A layer 1 tile of the overworld that enters a level: one on which A starts a level, as emulation shows (the path tiles' kind "level"), not a range of tile numbers – in the clean game and in a ROM Lunar Magic saved 56–80 without 5B and 5F; 81–86 are tiles Mario stops on without entering one. Its translevel belongs to the tile and moves with it; the level's settings (name, base event, the direction each exit enables – in the ROM the "initial flags" byte –, the initial level flags of a new game – Lunar Magic's, with "no entry if passed" and "save prompt" – and message boxes) belong to the translevel: tiles entering the same level share them, a tile removed leaves them with the level, a new tile entering it shows them. Free translevels that bring nothing along are given out first; the settings are reset only when asked.
_Avoid_: level dot, node

**Level tiles as objects**:
In the overworld editor's layer 1 mode ("Layer 1 (paths, levels & links)": the overworld links are edited there too) level tiles are objects on top of layer 1 (ADR 0012, #396): selected by a left click, moved by a left drag starting on one – swapping with the tile where it is dropped, its translevel with it (another level tile swaps too), its **paths** (each from it to the next level, stop or exit tile) drawn again to it as the route brush draws them: the shortest way from the cell beside the far end the old path left it by to a side of the new cell no other path takes, the old cells first, the cells no longer used cleared, its exit directions and initial flags turned with them; a path with a cell painted at another event progress, forking on the way, or with no free way or tiles to the new place is kept where it was and said (core/owlevelmove.ts, #367; layer 2 not touched); its link ends with it (**Overworld link**); with Alt held at the drop the tile alone –, removed by Delete (the stop tile 81 in its place, the level then "without level tile": its translevel held by no tile on any map, its settings kept), placed by "Place level here…" – a look chosen as the brush in the layer 1 picker's **Levels** section (the looks: the visible tiles the path kinds call "level" and one drawn on layer 2; beside it the budget of levels with a level tile), then a right click on a cell, the look preselected – or by dragging a level without level tile onto the map. A right click on a level tile, any brush, opens its menu: Open level, Change look…, Remove. The only way to place, move or remove level tiles: layer 1 painting and picking leave them alone (hatched on the map and in the sheet; a pick rectangle starts beside one). Each one ROM edit of the map before events, or with event X chosen in the playthrough strip a layer 1 change of event X (the level tile changes from the event on). The selected level tile shows its level's name under it in the map's font; a click on that label edits the name in place (typed as its tiles, characters the font lacks refused while typing; Enter or a click elsewhere one ROM edit, Esc drops it), beside it the save prompt and "no entry if passed" switches and the other tiles entering the same level ("Also used by the tile on Vanilla Dome").
_Avoid_: Levels mode (gone with #396), level entrance (that is the tile entrance in a level)

**Translevel**:
The number the overworld knows a level by (0–24 for levels 0–24, 25–5F for 101–13B), the index of everything per level on the overworld (names, base events, flags, saved progress). Stored per tile in Lunar Magic's table, not found by scanning the map, so placing a level tile shifts no other level's number.
_Avoid_: level number (for the overworld's), OW level

**Message**:
The text a message box sprite (B9) shows: two per translevel (message 1 and 2, as the sprite is set), and Yoshi's thank-you (message 3, translevel 0's message 2, in any level). A switch palace's message 1 also presses its switch and Yoshi's house shows message 2 while Mario rides Yoshi – which translevels these are the game's table tells. A level without text shows an empty box. Shown in the translevel's level and the sub-levels reached from it; a level nothing reaches shows translevel 0's (message 1 the intro's). Which message a placed sprite opens is what hitting it does in the game (the sprite probe: the game's B9 by its X position). Edited in the message panel beside the level, in the game's 18×8 box (SMWM, Lunar Magic's layout). While a package draws the message boxes instead of the game (a VWF dialog patch; told by emulation – a box opened in the game does not show the message SMWM holds –, the package named by the code that runs only while the box opens), the panel, the hover preview and the message checks give way to a note naming it; they come back when it is removed.
_Avoid_: message slot

**Path tile**:
A layer 1 tile Mario walks, climbs or swims along, or stops or exits on; invisible in the game, drawn by the editor as a mark – each overworld mode shows what its task needs (#412, core/owlayers.ts): the layer 1 mode always (layer 2 dimmed or full by View → Layers, gone while Q is held), the layer 2 mode with all of layer 1 – its tiles, the marks, the level numbers, unreached tiles – dimmed together or not at all (View → Layers "Layer 1 while painting layer 2", on by default; Q held the other way), the links and sprites modes not (both layers full). The game's 5 hardcoded paths are not tiles.
_Avoid_: road, Mario path (Lunar Magic's view name)

**Free tile** (overworld layer 1):
A layer 1 tile drawn as tile 000, on no map (nor put there by an event) and doing what 000 does where Mario walks – room for a new tile. The editor's Map16 extension makes C1–1FF such copies of 000. The paint sheet folds them into one row ("N free tiles · New tile…").
_Avoid_: empty tile (an empty tile may still be an invisible path or level tile)

**Budget** (overworld):
How much of one of the overworld's ROM tables an edit can run out of is used: destroyed level tiles (0x18), the reveal list's pairs (0x16), layer 1 tiles (those not free, of 0x200), star/pipe entries (0x100), exit path entries (0x80), levels with a level tile, stop, star or pipe (0x5F translevels), the event tile storage (0x3600 places), custom overworld sprites per submap (0x18). Counted from the ROM by one function (core/owbudget.ts owBudgets), shown as a gauge beside the action the limit stops – neutral, amber from 80 %, red when full; its hover says what it counts, the numbers after –, all of them together for the World check to list.
_Avoid_: quota, capacity

**Map piece** (overworld layer 2):
A 16x16 block of layer 2 – 2x2 tilemap entries, each with its palette and flips – on the 16-pixel grid of a submap's view: what the map is made of (water, grass, shores, hills). The layer 2 paint panel's "Pieces on this map" lists those of the map before events, each once, the most used first; one is a 2x2 brush. "Replace piece…" turns every occurrence of one piece on the grid into another – wholly inside the **layer 2 selection** (the rectangle last picked from layer 2 when larger than a piece, dashed on the map; not the level editor's selection of objects) or, without one, in the submap's whole view after a confirmation naming the count; one stroke, one ROM edit (in an event: the map after it).
_Avoid_: Map16 tile (layer 1's), event step (an event's 6x6 or 2x2 change)

**Path without a look**:
A walk or climb path tile whose own 8x8s have no pixel in its submap's graphics (core/owlook.ts hasOwnLook, from the BG1 character base the game sets as the overworld's drawing, #373) shows only by the map pieces under it: the player sees such a path only where layer 2 draws it. The World check warns (Look group) where Mario reaches such a cell at an event progress before the first event drawing layer 2 under it is passed ("shown after Mario walks it", Show: that event in layer 2), and where an event's layer 1 changes make a cell such a path tile with nothing drawn on layer 2 under it up to that event and ground there – none of the 8x8s under it found under path cells of its region as often as under other cells ("path without a look", Show: that event in layer 2, to paint a piece). Swim, exit, stop and level tiles, tiles with a look of their own and paths on the map before events are not checked. The editor gives no look by itself: the game's looks depend on the terrain, not on the path's shape.
_Avoid_: invisible path (the tile is; the path needn't be)

**Path shape**:
How a path tile moves Mario: by a vector from where he is, by the tile and the way he steps onto it, turning him where it ends (a bend, a junction taken one way). Learned by emulation (owpaths.ts), as the path tiles' kinds. Shown as the tile's **ways**: a line through its mark from the side he steps on to where it moves him (overlay and layer 1 sheet). Where on its side he steps on is the tile before's doing, not the tile's (02, 04 and 06 move him alike, a tile on; the game's map has him on 02 at its bottom, 04 through its middle, 06 at its top), so on the map a cell shows the lines Mario walks over it, followed from every stop and level tile (core/owpathshape.ts mapWays, also in the route brush's preview); a cell no walk leads over and the layer 1 sheet show the lines the map's cells with that tile are walked on most (usualWays), else the most centred ones, and in words ("from below to the right, from the right down") in the popup and status bar; a way counts where the way back leads to where he stepped on. An exit tile's way is its **axis**: the game moves Mario on by the exit tile's vector once the exit path has taken him to the other submap, so he comes out going up or down (a vertical exit tile) or left or right (a horizontal one) – entered across its axis he is turned by 90°, off the path. Shown as a straight line through the red mark along it and "from above or below (Mario comes out going on that way)" / "from the left or right (Mario comes out going on that way)"; a line more where its first step off a stop or level tile misses the exit (4D in the clean game: Mario walks back) and where it is climbed onto (40). From the learned vectors and pose, not by tile number.
_Avoid_: tile direction, path direction

**Route**:
A way for Mario given as cells next to each other on one map, for which the editor chooses the path tiles (core/owroute.ts): per cell a tile whose way leads from the cell before to the one after and back – starting where the tile before leaves him (after a stair higher or lower), the first where his first step off the stop tile leaves him, the last ending where his first step back off the stop after it does –, of the kind at the route's start where one fits, else another, a tile already there kept where it fits. Its ends are taken on (core/owroute.ts routeEnds): one drawn on a cell without a path beside a level or stop tile, or the last tile of a path, goes on to it – the one straight on, else the only one beside it; with several and none straight on it stays: a route drawn from beside one level to beside another means those levels, not new stop tiles beside them. One on or beside the **last tile of a path** – a path tile linked to one cell besides the route's (also where the route starts on a path and runs along it), or a plain stop tile at a path's end (not a level, star or pipe, nor one whose translevel has a name, base event or messages) – goes on back along the path to the first level, stop or exit tile on it, so the path is drawn on from its end: its tiles kept where they fit, the stop tile at its end a path tile, its translevel freed (reset once no tile holds it); where the path forks on the way back the end stays and becomes a junction. A route beginning or ending in the middle of a path makes a junction there (a stop tile: on a path tile Mario can't choose, the game takes the first way open). Level, stop and exit tiles on it are left alone; a stop tile goes where it ends on nothing and where it runs into a path (a junction, as in the game). A stop tile put takes a translevel no tile holds and without name, base event or messages (those a level keeps for a tile placed later), its initial flags the ways it has (the route's and the path's it runs into): Mario walks off a stop only in the ways its translevel's flags open, a stop of translevel 0 sharing them with every other; no such translevel left, the route is refused. A cell no tile fits is refused with why, and whether a stop tile there or another turn would work. Only tiles with learned shapes are used. Drawn with the layer 1 mode's route brush, **Path (auto)** (a row above the layer 1 sheet, framed while it is the brush; P goes back and forth between it and the last tile brush): a right drag or Shift+drag draws the route cell by cell as a tile brush paints (ADR 0011), back over it shortens it, the tiles previewed, a cell refused in red, Esc cancels; a right click without a drag draws nothing (on a level tile it opens the level tile's menu); a left click or drag picks tiles into the brush as always (a left click on a level tile selects it), which ends the route brush. Released, the tiles go as one ROM edit into the progress chosen – an event's layer 1 changes, or the map before events –, and a level tile at an end whose exit runs the event gets that exit's direction (so the reveal walk takes the route); layer 2 is not touched.
_Avoid_: path (that is the tiles), line, path tool (the route brush is a brush, not a tool)

**Reached tile**:
A layer 1 tile Mario can get to at an event progress, from his start position: along the paths as the game moves him (path shapes), through stars, pipes, exit paths and the game's hardcoded paths, with the level flags of a save at the progress (the directions open) and the ways back that arriving opens (owreach.ts, path validation). Not reached: dimmed on the map ("Unreached tiles"); a way that ends without a stop tile is a **dead end**.
_Avoid_: accessible, unlocked (for a tile)

**Exit edge**:
What a level exit opens: exit E opens level B when B is reached with every event passed and not with **the events still passable without E** (start with no event passed, add every event whose level is reached, repeat until the set stops growing – never adding E: whatever order the events pass in; seconds, computed in the probe worker – no arrows until it comes) – or, as a supplement, at the event progress just after E's event and not at the one before (events in number order) – and B is a first level on the way there, not one Mario gets to only through another level E opens (owexitedges.ts, path searches over the maps at every event progress built from the events, the same searches as the World check's) – derived, never stored. A level an event destroys (a castle) stays a level. An exit whose event opens no level Mario reaches opens nothing: also one whose way leads to a level already reached another way (with every event passed: Donut Secret 1's normal exit to the Donut Ghost House; Chocolate Island 5's to Wendy's Castle, reached through the Chocolate Secret; Valley of Bowser 4's to Larry's Castle, reached from the Valley's star on Star Road) – can't be told when its own level isn't reached even with every event passed. A secret exit whose event changes nothing and opens nothing counts as one the level hasn't. Drawn in the layer 1 mode as arrows from the selected level tile – every level tile's with View → "Exit arrows", off by default (solid the normal exit, dashed a secret one, to a level on another submap ending at the link leaving the exit's submap; a red stub for nothing, a grey one for can't be told).
_Avoid_: unlock, level connection

**World check**:
Whether the overworld can be played through, answered in the player's terms: the side panel the status bar button opens (the button shows the number of errors; listed once the saves at every event progress are learned, the checks the same at every progress shown found in the probe worker). Its problems are **errors** (Mario gets stuck, a level can't be reached) or **warnings** (may be fine, e.g. the hack's own code does it; a warning never blocks), in groups – Paths, Progress, Links, Look, Budget – each found at an event progress: with every event passed, or – a **dead end**, an exit path tile leading nowhere (also 4D right off a stop: its first step ends where no link is taken) or an exit path tile Mario **comes out of off the path** (a warning: the exit tile's own way moves him on after the warp – a vertical exit tile at the end of a horizontal path, or the reverse –, or a link's target side not opposite to its source's) – at the progress shown and at every event progress, listed once with the first it is found at (one found at the progress shown that those searches – from the maps built from the events, not emulated – miss is kept, at the progress shown) with **Show** (the map at that progress, the tile outlined) and a **Fix** where one exists (a dead end: a stop tile in its place; an exit tile across the path: an exit tile of the path's axis, one the submap uses where one fits, else the lowest). Beyond the paths' problems it checks for events nothing runs (warning), stars, pipes and exit paths leading where no way leads back (**stranded**, error), links from or to a tile Mario can't use them on (a star/pipe link from a tile he doesn't stop on, an exit path from or to one neither an exit path nor a stop tile: an error from the event progress on that it stays so, a warning when it is so at every progress, nothing where the cell is empty at every progress – the clean game's dead star entry; Fix: the link removed; #413), link ends stored on the other submap of an overlap of views – the tile's paths another submap's (warning, Fix: the end moved there) –, stars, pipes and levels' teleports putting Mario standing where he can't move (warning, at every event progress: see **Overworld link**), levels without level tile another level's exit leads into (warning), **paths without a look** (warnings, from the maps at every event progress – layer 1 through the events as the game loads a save and the saves' level flags, not emulated – a hack's own code changing layer 1 then is not seen) and events a loaded save draws in another order than they ran in play (warning; the **play order**: an event runs before another when that one's level tile isn't reached without it). A level tile nothing reaches where the clean game has the same one unreached (levels 019 and 112, a fixed list) is a warning ("as in the original game"), not an error: the clean game has none. Its Budget group lists every **budget** as a gauge with the numbers of the gauges beside the actions (custom sprites: of the submap with the most, named), each with Show (the mode – and submap, or an event when none is chosen – where its gauge is); a full budget is an error, one from 80 % a warning – the reveal list's at most a warning: its pairs are a fixed list, all used in the clean game, and full it only stops a new kind of tile from being revealed. A problem's key is its kind and place (an event's: its number; two events': theirs), the same while it stays (core/worldcheck.ts): after each overworld edit, undo and redo the problems new and gone are said in one toast (new errors named, with Show; warnings counted), compared by key at the same event progress.
_Avoid_: problem list, validation (for the panel)

**Event**:
One of the overworld's 0x78 changes run once when a level is passed (its base event, + 1…3 for its secret exits) or by a teleport or the user's own code: layer 2 steps, layer 1 changes, reveals and destroyed level tiles. Chosen by the level and exit that runs it; its number shown only for those that run otherwise. What it changes is the tiles it leaves different (core/owevents.ts eventChanges): a reveal, a destroy or a layer 1 change leaving a cell's tile as it is – as the events before it in number order left it and on the map before events (in play it may pass first) – changes nothing; an event with only such changes nothing everywhere (events nothing runs, a secret exit's event, "opens nothing yet", an event revealing nothing reached: the clean game's level 112 destroying its tile 078, which has no destroy effect). An event is named by a secret exit only where the level can have it: its data or a level played from it shows it (a keyhole, a goal tape with its extra bit, an exit to the overworld passing it by a secret exit; core/secretexits.ts), or – secret exit 1 – the event is no level's base event and changes something (the clean game's Donut Secret House and Chocolate Island 2, whose data shows none) – so a level without secret exits never names the next level's event. (What a secret exit opens, its **Exit edge**, is a separate check: one whose event changes and opens nothing counts as one the level hasn't.)
_Avoid_: path reveal (that is part of one), trigger

**Event step**:
A 6x6 or 2x2 block of 8x8 tiles an event changes on layer 2: **animated** (shown with the path fade, in order, on the submap of the level running the event) or **silent** (written at once, on other submaps). The user paints the map as it looks after the event; the editor finds its steps – which tiles changed to the map before it, the blocks, animated or silent, the order along the path from the level tile – and the user changes only their order on the timeline (ADR 0005).
_Avoid_: event tile (Lunar Magic's), piece (a map piece is a 16x16 block of the map, not a change)

**Event progress**:
Up to which event the overworld is shown as passed (events applied in their number order, as the game does when it loads a save); not part of the ROM. The overworld editor's **playthrough strip** under the map chooses it by the last event passed – "Before events", then every event in number order, each labelled by the level exit running it ("Yoshi's Island 2 · secret exit", the number secondary; "Event 4F (run by no level exit)"), ADR 0013 –, and what is painted goes into that event ("Before events": into the map before events) – the map is never shown at one progress and painted at another. Test play from the overworld takes it over, and the save at that progress too – the levels passed with their paths open and the events triggered – learned by emulation: each event's level (the first that runs it) left with its exit in the event order, the game's code setting what passing it sets (core/owprogress.ts); a level only runs an event the game hasn't run, so of two levels running the same one only the first is passed. The switch palaces pressed then are those whose switch tiles are in a level played from a translevel passed (its level and those its exits lead to); which tiles press which switch is learned by the block probe (Mario landing on each tile), which levels hold them by loading the levels – no table of palace levels.
_Avoid_: events passed, after all events

**Playthrough strip**:
The overworld editor's control choosing the event progress, under the map (ADR 0013): "Before events", then every event in number order labelled by the level exit running it, the chosen one's timeline below it and "▶ Test play from here" beside it. Play order is reached by renumbering the events, not by another order of the strip.
_Avoid_: Map after (the select it replaced)

**Cell history**:
What each event changes on a layer 1 cell over the game, in number order (core/owcellhistory.ts): its layer 1 tile (by the event's layer 1 changes, a reveal, a destroy), a level tile placed or removed there, the layer 2 entries under it. Layer 1 through the events as the game loads a save: per event its layer 1 changes, then its reveal, then its destroys. Shown when the mouse rests on a cell of the overworld map; an entry jumps to its event in the playthrough strip. An event's layer 1 entry is **moved** to another event (or into the map before events) by dragging it onto the strip or by its "Move to…" (core/owmovechange.ts): the connected tiles the event changes (4-neighbours, same submap; Alt: the tile alone), its reveal and destroy with the event rules, one ROM edit; a move changes only when, never how the map ends up – refused where another event changes one of the tiles between the two events or at the target. Layer 2 steps stay with their event. A cell here is a layer 1 place (16x16) of an overworld map, not a level's quarter.
_Avoid_: tile history (a tile number moves between cells; the history is of the place)

**When beaten…**:
A level tile's sentence per exit of its level (its properties) telling what passing it does, in the player's words (core/owexitsentence.ts): the levels it opens (its exit edges, as its arrows: none told while they are learned), the level crumbling (its destroy), another tile revealed, the rest of the map its event changes, where an exit to the overworld takes Mario; "opens nothing yet" when its event changes nothing. Shown, not edited – except that a reveal or destroy can be taken away there.

**Reveal**:
A layer 1 tile that changes into another when an event passes over it (Lunar Magic's reveal list: which tile becomes which). An event reveals at most one tile, a tile can be revealed by several events; any layer 1 tile. Edited with the event (its timeline under the playthrough strip: the tile clicked on the map, then what it becomes picked in the layer 1 sheet – the cell gets the tile the reveal list turns into it); the tile's properties name the events. Stays with its cell when a level tile moves.

**Reveal walk**:
What the overworld does when a level's exit is first passed, after the exit's event: it walks the path from the level tile in the direction the exit enables to the next level tile and enables there the direction leading back. The game skips it for some translevels (in the clean game Yoshi's House and the switch palaces): their exits still run their event and enable their direction, but the level tile the path leads to gets no way back. It skips it too for an exit that runs no event (the level's base event "No event"; its secret exit 1 runs event 00): the game handles the exit at once, enabling no direction at all – neither from the level tile nor back to it. Both are learned by emulation, not from the game's list or code; the level tile's properties say "no reveal walk" beside such an exit.

**Destroyed level tile**:
A layer 1 tile an event destroys when it passes (a castle, fortress or switch palace collapsing; a castle's top and the tile below it). One tile per event, 0x18 in all; set on the tile it destroys (a castle's: its top), edited with the event (its timeline), the tile's properties naming the events; for a level tile also by "Crumbles when beaten" in its properties (a destroy in its level's normal exit's event, refused with the reason where the game can't; on and disabled where another event destroys it, naming the level exit running that event, with "Show" going to that level). Moves with its level tile (a castle moved moves whole). What destroying a tile does is the game's code's.
_Avoid_: collapse (that is the animation), destruction event

**Layer 1 change**:
A layer 1 tile an event writes when it ends (a silent step on layer 1, shown when the map is loaded again: for other submaps and tiles not seen). Painted as layer 1 after the event, as event steps are.
_Avoid_: layer 1 event (Lunar Magic's mode)

**Star** (overworld):
A layer 1 star tile (5F): a stop tile from which A takes Mario where its overworld link leads; it enters no level and runs no event, but its translevel is used as a stop tile's – its level flags are the ways Mario walks off it (a new game's: the initial flags; arriving by a path or the reveal walk opens the way back), its name the status bar's while he stands there. So a star holds a translevel of its own, as a route's stop tiles do (see **Route**): painted on a cell without one (or one sharing a level's) it takes a free one without name, base event or messages (none left: the stroke is refused; on a cell that is a level tile at another event progress too), its initial flags the ways its paths open; painted over with another star or stop it keeps it; painted over with a path it frees it (unless the cell is a stop or level tile at another event progress), its name and flags reset once no tile holds it. Its properties (layer 1 mode, Alt+click) are only the ways Mario walks off it (a switch each) and the status-bar name (drawn in the box under it on the map, typed there after its Edit… button, as a level tile's name); no base event, exits, messages or level switches. Counted by the budget of levels on the overworld. A star on translevel 0 (a hack's) shares translevel 0's flags with every tile without one and shows a blank name: a World check warning, a button gives it one. What the game uses its translevel for: docs/research/star-tile-translevels.md. A **pipe** 5B is the same (#407): Mario walks off it by its translevel's flags, so it takes, keeps and frees a translevel as a star does, with the same properties, budget, refusals and warning ("Pipe at … has no translevel of its own"); the pipe 82 – the clean game's pipes, all on translevel 0 – lets him walk off any way and takes none.
_Avoid_: star road (that is the submap), warp star

**Overworld link**:
A star, pipe or exit path tile leading to another place of the overworld (one-way or both ways: an entry leading back), a location that an exit to the overworld teleports to, or the place a Koopa Kid puts Mario; an entry of the star/pipe table (0x100) or the exit path table (0x80), as in Lunar Magic; of two entries with the same tile the game finds the last (it searches from the last entry down), an edit changes that one. Edited in the layer 1 mode (#413; no mode of its own): the cells a link ends at – both ends, a Koopa Kid's tile with a place and the place, a location (core/owlinks.ts linkEndCells) – are objects there like level tiles: hatched with a mark of their kind, left alone by painting (also into an event) and the route brush, moved with a level tile (swapped with the cell it is dropped on; Alt: they stay). Made by "Link to…" (the tile's menu or properties) and a click on the target (Esc or a click beside the map cancels), drawn as an arrow – the selected tile's, every one with View → "Link arrows"; the selected link's other end, a location or a Koopa Kid's place moved by dragging it; "Remove link" removes it, the tile staying. In the layer 2 mode dimmed or hidden with layer 1. An exit path link's ends each have the side their path goes on; the target's side follows the source's (the opposite one, never chosen): the game moves Mario on by the source exit tile's own way, whatever the target's side, so only the opposite one puts him on the path. The links panel says where he comes out and which way he walks ("Mario comes out above Yoshi's Island 04,00, walking down"); a ROM's pair of other sides is kept as it is and the World check warns of it. An end on a tile in an overlap of submaps' views is on the submap chosen when it is dropped (asked: "Submap"); a click there finds links ending on any of those submaps; one stored on a submap whose paths the tile is not on, another's whose view shows it is, gets a World check warning (Links) with a fix moving it there. A star/pipe link (and a location) leads to a tile Mario stops on: he arrives there standing, not walking, and standing he walks off only in the ways the level flags of his tile's translevel open (tile 82 any way), whatever the tile – a path tile has translevel 0, whose flags nothing opens (emulated: on Vanilla Dome 05,14, the exit path's tile, he can't move; with translevel 0's flags opened he walks off it). A level tile (A enters its level) and a star or pipe with an entry (A warps) are fine; a star or pipe 5B painted takes a translevel with its paths' ways (see **Star**), a pipe 82 lets him walk off any way, but a stop tile painted by hand gets no translevel, so it lets him go nowhere unless linked back. Where a link or location puts him so he can't move (core/owreach.ts stuckOnArrival) the World check warns (Links, Show: the target; at the event progresses it is taken at), the selected link or location says it in a warning box, and the status bar and the overlap's menu while one is dropped add "Mario can't move there".
_Avoid_: link (that is a part's), warp, teleport (for the tile)

**Overworld sprite**:
One of the game's 13 sprite slots of the overworld (Lakitu, bird, fish, Piranha Plant, cloud, Koopa Kid, smoke, Bowser sign, Bowser, Boos): a sprite and a position, the same on every submap – the sprite's own code decides where and when it shows; drawn as the game shows it at the event progress (emulated). Lunar Magic's custom overworld sprites (BOWSIE's) are another table. Gone while BOWSIE is installed: its loader takes their table's place.
_Avoid_: event sprite, OW object

**Custom overworld sprite**:
A sprite of an overworld package (BOWSIE's format, Arinsu: an .asm with init and main) placed on one submap: its number (01–7E), a position and a height in 8px steps and its extra bytes, kept in Lunar Magic's custom overworld sprite table (`$0EF55D`, up to 0x18 a submap; the entry's size from the size table BOWSIE writes). The editor does BOWSIE's insertion itself (one patch, with MaxTile while the event path fade is off, else without; re-inserted when the fade is switched) and draws each placed sprite by emulation.
_Avoid_: OW sprite (for these), BOWSIE sprite (in the UI)

**Start position**:
Where Mario and Luigi stand when a new game begins: a submap and a tile each.

**Overworld option**:
One of Lunar Magic's "Extra Options" of the overworld the community uses (Start+Select on passed levels, Start to scroll the main map, the 5 hardcoded paths, the event path fade with the path reveal speed, the save prompt after castles and the like, saving Luigi's position, life exchange and L/R for it): a switch for the whole game that changes a few bytes of the game's code to Lunar Magic's, turned back the clean game's; one ROM edit each.
_Avoid_: extra option, setting (for these)

**Overworld import**:
The overworld of another ROM the editor made (or the clean game) replacing this one's, Lunar Magic's "Copy Overworld to Another ROM" the other way round (core/owimport.ts): its maps, level tiles with their translevels, events and their steps, the translevels' settings (names, messages), overworld links, start positions, the game's overworld sprites, overworld options, and each submap's music, graphics slots, palettes and animations, read from the other ROM and written through the same modules. One ROM edit; no file format of its own. Package content (custom overworld sprites, graphics files, songs) is not copied: what the import refers to that this ROM lacks or has otherwise is told as a warning.
_Avoid_: overworld transfer, overworld export

**Refusal**:
An overworld edit the game's limits or rules don't allow, told before or instead of writing anything: the core returns it as data (its kind and the numbers involved, core/owrefusal.ts), the editor words it (ui/owrefusal.ts) as the consequence in the player's terms (an event named by the level exit running it), the reason without table names, and a way out – a fix button where one exists (core/owfixes.ts: a change added to the reveal list in a pair that never applies, the link table entries nothing uses freed (a later entry has their tile, a location no exit teleports to), a copy of tile 000 on a map taken; made with the refused edit as one ROM edit where it is one, its hover saying what it writes, the toast after it what was written), else what to do instead. The technical line (event, table, number) is folded out under "Details".
_Avoid_: error (for these), limit message

### The game

**Game workspace**:
The workspace for the game's screens that belong to no level: the title screen (gameview.ts) and the overworld's borders (owborder.ts); the credits, the title screen demo and the game-wide settings are to follow there. Its changes are ROM edits.
_Avoid_: game settings (only a part of it), title screen editor

**Overworld border**:
A map's layer 3 (the main map's or a submap's): 32 × 28 tiles fixed on the screen while the map is shown, edited as the screen in the Game workspace, in front of the screen as the game shows it after the load (owborder.ts, core/owlayer3.ts). Saved into the map's LT3 file, a new one where it has none (the game's border until then); a file shared with levels or other maps changes for all of them unless the map gets its own copy. The cells the game writes the lives and the level name over (row 4) are not painted. Lunar Magic's "Load Layer 3 of Submap". A paint stroke is one ROM edit.
_Avoid_: layer 3 (of the overworld, for the border as a whole), overworld frame, HUD

**Title screen**:
The title screen's layer 3 tilemap: the logo, the frame and the copyright line over the title screen level's layers 1 and 2, with layer 3's graphics as that level has them (titlescreen.ts). 32 × 29 tiles – the 28 rows on screen and the one below them – written in Lunar Magic's layout: one stripe image in a RATS block, pointed to by the stripe image table's entry 03 ($0084D3). A paint stroke is one ROM edit.
_Avoid_: title logo (only a part of it), title screen level (that is the level behind it, C7 in the clean game)

### Third-party content

**Package**:
Something the user uploaded, together with everything it brought into the ROM; it is installed and removed as a whole. Uploading a package is the only way third-party content enters the ROM.
_Avoid_: Patch (for the whole thing), Resource, Download, Project

**Upload**:
The files the user hands in for one package (a single file or a .zip), before anything is installed.
_Avoid_: Download, patch package

**Callisto project**:
An upload that is a project of Underrout's build tool Callisto (it has `tools/Callisto/*.toml`), e.g. the Romhack Races baserom: one package with all its parts, its patches applied in the project's order, and the header Callisto generates (`callisto.asm`) provided for its code. Its data meant for a Lunar Magic ROM (BPS of the overworld, title screen, credits) is not part of it – except that its sample levels take their messages from the overworld's BPS (see Sample level).
_Avoid_: baserom (that is one Callisto project), project import

**Replaced patch**:
A known third-party patch whose work an editor patch already does (e.g. a faster graphics upload for Lunar Magic's loader); skipped with a note when uploaded instead of installed.
_Avoid_: redundant patch, built-in patch (that is an editor patch)

**Tool project**:
The ROM's project of one community tool – UberASM Tool, GPS (blocks), PIXI (sprites), BOWSIE (overworld sprites): the files in the tool's layout with its list.txt, stored as the sources of the one patch built from them (core/toolproject.ts, an adapter per tool for its list and build). Saving builds and applies it anew; one without entries keeps its files, one without files too removes the patch. Parts of packages go into it; the tool's tab edits it.
_Avoid_: tool patch, tool folder (for the ROM's project)

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
The .mwl of a package that also has code: an example of the package in use. Optionally replaces the current level – or, when the package brings several, each the level of its own number, with its screen exits and graphics slots –, with its Map16 tiles, ExGFX and (where certain) sprite numbers rewritten to where the package's parts landed. Of several, those belonging to what is not part of the package are not offered: the title screen's level (the one the game loads for it) and a level the package's overworld moved (a level tile entering it where this ROM's enters another). Its messages, which a level file does not hold, come from a Callisto project's overworld: when that has text for the translevel of the level it was exported from, both messages are written as those of the translevel of the level it is placed as, told in the install's result. A level placed without a translevel of its own (a sub-level) takes none, which the result tells too; without text there this ROM's stay. A level edit (one at its own number written with the install and undone with it), not part of the package.
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
An animation slot (types 18–1B) that moves a range of 2–128 palette colors along by one, right or left, every few animation frames; rotate right/left waits while its trigger does not hold, the "reverse on trigger" types always run and turn the other way while it holds. It has no frames: the colors are the level's own. Like a color animation it shows wherever the level's tiles draw those colors (the Animations tab lists and marks the Map16 tiles); colors the game itself sets every frame (Mario's palette; on a submap also the level dots' 6D and 7D and the lightning's 47 where it is on) do not rotate in the game, found in the emulated level or submap (on a submap with its own animations off, so they don't count).
_Avoid_: palette rotate, palette cycling

**Animation trigger**:
What makes an animation slot run (Lunar Magic's ExAnimation triggers): a game condition (P-switches, ON/OFF, star, time below 100, 5 Dragon Coins – the last two also once), the precision timer (the slot shares the frame counter of the first slot of its 8), or one that the user's own code sets in the engine's RAM: a manual trigger (the frame to show), a custom trigger (on/off, a second frame set while on) or a one-shot (the slot plays once, then the engine turns it off). A list's **Trigger Init** sets custom triggers and manual frames when the level loads, the level's over the global list's. On the overworld (a list per submap and the overworld's global one) the game conditions are replaced by **event triggers** (Lunar Magic's "Event Manual 8–F"): each holds, showing its second frame set, once the overworld event whose number its manual frame 8–F has is passed; the Trigger Init sets those numbers when the submap loads (also when Mario walks there); one it doesn't set keeps what was there before (what the level played before, or code before the load, left), as in Lunar Magic. The Animations tab switches a submap's event triggers for its map preview only (the game run on from the load with the trigger pointed at a passed event, or at none): never saved, test play goes by the event progress. The view's triggers are a view setting that test play takes over (set after the level's load), not part of the level.
_Avoid_: event, flag (those are Conditional Direct Map16's)

### Emulated results

**Probe**:
Finding out how something behaves in the game by running the game's own code on it in an emulator: what a Map16 block does when Mario touches it, how Mario collides with it, what a sprite does when hit from below, how fast Mario runs in a tileset. A probe is always for one tileset, but a sprite's is kept for all of them: it is probed again per tileset only when it read the tileset from code that doesn't read it in the probe level without the sprite (vanilla: only the unused sprite 36). What blocks look like (Map16 quarters, colors, graphics files) is not among the bytes a probe has read: drawing keeps it (ADR 0008).
_Avoid_: Test, check, lookup table

**Switch state**:
A game condition a tile may act otherwise in: the blue P-switch running, the silver P-switch running, ON/OFF set to OFF. The collision probe runs once without and once in each, one at a time, and keeps the states that change how Mario collides with the tile or what jumping against it does (vanilla: coins and used blocks swap under the blue P-switch, Munchers become coins under the silver one). The view sets them (View → Game state), the level is drawn and the collision overlay shown in them; test play takes them over.
_Avoid_: Switch mode, P-state

**Play session**:
A level played in the emulator from gameplay on, frame by frame with the buttons held: it begins once the level's gameplay has started (or once Mario has settled: standing, the sprites running), and ends when Mario dies, the level is left, or whoever plays stops. Test play, probes that move Mario and the tests play a level that way.
_Avoid_: run, game loop, harness

**Emulated result**:
Anything the editor learned by emulation (a probe's outcome, the kinds of a tileset's objects, a level scan, sprite images, object thumbnails, jump arcs). It stays valid as long as its inputs and the ROM bytes it read are unchanged, and is learned again otherwise (by the result learner: a key, an input, the bytes read). One that is no picture doesn't count the display data among the bytes it read (ADR 0008). A result may be put together from parts kept on their own the same way (the sprite images of a set: one part per test level load of six sprites, grouped by number), so a change one part read learns only that part again; such a result is kept only as its parts, each image stored once.
_Avoid_: Cached value, generation (for validity)

**Result learner**:
What learns emulated results: runs the emulation for a result's key and input, records the ROM bytes it reads, and keeps the result while they and the input are unchanged. A read byte that changes while it learns starts it over. Wherever it runs (beside the editor or in the background worker) it learns the same way; probes are results it learns too.
_Avoid_: prober (for the whole), worker (for what it does)

**Round**:
A run of the editor over many results that will be run over again (the sprite memory check of a level's groups, the prefab suggestions over all levels): while it runs, the results it uses are kept, also more than their store's bound, and so are the latest finished round's while the next one runs (a round left unfinished doesn't replace it), so the next run finds them (core/keptresults.ts startRound/endRound).
_Avoid_: pass, generation

**Lane**:
A queue of the result learner's background jobs: one runs at a time, in the order asked; asking again for a job already there (the same key and input) joins it; a request may replace the lane's other jobs (they are not wanted any more). The busy indicator shows a lane's running job.
_Avoid_: queue (for the probes' asked and prefetched jobs)

**Open level's work**:
What the background worker does first because the open level needs it to be shown and edited: the images of its sprites, the kinds of its objects and the boxes of its objects at sizes (resizing). It runs before the probes asked directly (the overlays, the status bar), the other lanes and tasks and the prefetch (which waits for all of them), taking turns among itself. The sprite images of the set and the kinds of the tileset's objects are learned the level's sprites and objects first, and only that part is the open level's work; the rest (for the pickers, for objects added later) then takes turns with the others as before. Another level opened while they run has its sprites and objects taken next. The order changes nothing learned; an object whose kind is not known yet is plain.
_Avoid_: urgent (a job that runs while a dialog is open), priority

**Watch**:
What a view draws from the ROM through: it records the ROM bytes the drawing read, and the view is told only when a ROM change changed one of them (then it draws again). A watch held while a stroke is drawn is told nothing, and the level's re-emulation waits meanwhile; a ROM edit the view makes itself is taken as seen (it already shows it). The follow-ups of a ROM edit (the open level reloaded, its header, prefabs) are told the same way, by the bytes they read.
_Avoid_: signature, subscription (for the thing itself)

**Picture**:
An emulated result that shows what things look like (sprite images, object thumbnails, the placement preview, animated tiles and colors), and so counts the display data among the bytes it read. Any other result (a probe, a level's uses, a jump arc, …) is no picture and leaves the display data out, so drawing a tile or changing a color keeps it (ADR 0008). The palette tab's trace of where colors come from leaves out only the colors' values.
_Avoid_: image, render (for the kind of result; a sprite image is one picture)

**Display data**:
The ROM bytes that only say what tiles and colors look like: the Map16 quarters (FG tiles 000–1FF of every tileset, the extended FG tiles, the BG tiles), the shared palettes and the levels' own palettes with their pointers. Not acts-like or the blocks' code. Graphics file data is no display data: no emulated result counts it as read, a graphics file's content is an input instead. Nor is ExAnimation data: only the palette tab's trace counts it as read (a color animation writes colors).
_Avoid_: graphics data, GFX (those are graphics files)

**Input**:
State outside the ROM that an emulated result depends on: the level as edited (one input for everything learned from it, with the view settings – switches, conditional Direct Map16 flags, animation triggers), the content of graphics files (their bytes don't count as read), for pictures of a level also what its animations copy at its load (the animation lists and the parts of their Anim graphics the frames read, which don't count as read either). Given next to the result's key and compared by its hash (core/inputs.ts), never by object identity. A key keeps the results of its latest used few inputs (core/keptresults.ts INPUTS_PER_KEY), the least recently used dropped first.
_Avoid_: cache key (for what belongs in the input), dependency (that is a ROM byte read)

**Derived ROM data**:
What the editor reads out of the ROM without emulating (the custom sprite list, the graphics mask, the sprite memory values in use, a level as saved): memoized per ROM generation, not an emulated result.
_Avoid_: emulated result, cache

**Savestate**:
Test play's one slot (F5 saves, F8 loads; Select+L / Select+R on a gamepad): the whole emulated machine at a frame – memory, registers, scroll, color math, the sound unit and what is on screen – so that loading it goes on exactly as from the moment of saving. It belongs to its level on the ROM as it was then: any change of the ROM since (the level saved, a ROM edit) makes it stale, and a stale one is dropped (core/savestate.ts). Not written to disk.
_Avoid_: snapshot (that is the emulator's boot state every load starts from), save (the game's own save file, or saving the level)

**Rewind**:
Test play stepping back in time while Backspace (a gamepad's stick pressed) is held: the machine's state is kept every 6 frames, the newest 100 (10 s, about 50 MiB; core/rewind.ts), and the game goes on from the one it was stepped back to on release. The sound is off while rewinding; the play log and the death markers go back with it (what happened after that frame is dropped). The kept states are dropped on a restart and when a savestate is loaded.
_Avoid_: undo (that is an edit's), savestate (the one slot F5 saves)

**Failed spawn**:
A slot search of the running game that found every slot it looked at taken, so a sprite (normal, extended or cluster) did not appear, or replaced another where the code then takes a slot anyway (core/slotwatch.ts). Recognised by what the code does (a loop testing consecutive slots for zero), not by the game's tables; a search through a few kept slots (Mario's two fireball slots) is none. It may come with other slots free: the level's sprite memory or the spawning code (a generator) limits the slots it may use. Test play's slot meter shows the live slots and lists the failed spawns with Mario's tile.
_Avoid_: sprite overflow, slot overflow

**Missing sprite**:
A sprite of the level the game leaves out because the loader finds no slot for it when it comes into view: the level's sprite memory gives level sprites too few slots for a view's sprites, or keeps a slot for one sprite only (04: one Banzai Bill, in slot 0 – a second is skipped while the first lives). Found by the sprite memory check: a sprite without a slot right after its sprite group is loaded, with one when loaded alone (one that never takes a slot, a generator, is none; one that dies in the frames after, a line-guided sprite without its line, had one). Shown as a problem with a dashed orange box, and the check's suggestion then must make all appear. Test play's slot meter doesn't list it as a failed spawn when the loader looked at the kept slot only.
_Avoid_: failed spawn (test play's, seen while playing), despawned

**Sprite group**:
A largest set of a level's sprites that fit in one view together (an isolated sprite is one alone; a sprite may be in several): what the sprite memory check plays in the emulator, one at a time, to see which sprites lose tiles and which are left out (missing sprites; core/spritemem.ts). The latest used groups keep their result per sprite memory value while the ROM bytes it read are unchanged, kept by their sprites' places relative to each other, so after a sprite change only the groups that changed are played again (not one moved as a whole).
_Avoid_: window, object group, group sprite (one sprite that spawns several)

**Group sprite**:
One entry of the level's sprite data that is several sprites in the game, its code spawning the others when it loads ($DE five Eeries, $E0 three platforms): one sprite to the editor, the slots it spawns counted for it by the sprite memory check in every view (sprite group) it is in.
_Avoid_: sprite group (that is the sprite memory check's), cluster sprite (a kind of sprite of its own)

**Lag frame**:
A frame of the level in which the game's main loop was not done before the next NMI, so the game slowed down (core/playlog.ts, from Snes.busyLines: the CPU never reached its wait loop). The CPU load of other frames is the share of the frame's scanlines from the NMI until that wait. Frames the game spends outside the level's game mode (loading, fading) are fully busy but no lag frames. Test play's lag meter shows the load per frame and lists lag frames close together as one event with Mario's tile; the level scan counts them per screen.
_Avoid_: slowdown frame, CPU overload

**Death marker**:
Where Mario died in a recent test play of a level, drawn over it (View → Death markers) with what killed him (core/deaths.ts): a death is the frame the game sets Mario dying, the killer is learned from what the code did up to then – the timer run out, Mario fallen out of view, else what the code read last: a sprite table for the slot in X (a sprite's code, normal, extended or cluster) or a layer 1 tile (a block). Kept in the browser per project (its id in the editor data, which a file name or saving as a project doesn't change) and level, the newest 100, until cleared (per level or all); each with the level's version then, those from before the level was last changed shown faded. Editor-local, never in the ROM.
_Avoid_: death point, skull

**Prefetch**:
Probing what a panel shows before anyone asks for it (the picker's Objects tab: its objects' Map16 tiles; its Map16 tab and the Map16 editor: tiles 000–1FF; its Sprites tab: the sprites it lists, custom ones too), only while such a panel is shown, in the open level's tileset; after a ROM change only what a panel shown then wants is probed again. It runs last, only when nothing else is pending – the open level's work, the probes asked directly, the lanes and tasks – and quietly: the busy indicator counts the probes asked directly only. The panels themselves show what is known and don't ask; a search, a hover or an overlay asks.
_Avoid_: background probes (the probes asked directly also run in the background worker)

**Scroll bands**:
Where Mario is on the game's screen while the camera scrolls in a direction, or follows him after L/R looked ahead; learned by moving him in the probe level with the open level's mode and vertical scroll setting (an emulated result); a setting that keeps the camera still has no band that way.
_Avoid_: scroll zones, camera thresholds (they are not a table)

**Camera reach**:
What of the level the camera can show: where it goes with Mario carried along the level's top and bottom (vertical levels: its sides), standing as far as the camera is concerned; learned by the level scan (an emulated result), shown with the game view frame by darkening the rest; the game view frame is kept where the camera went (its range: from its first to its last place along the level, and where it went across there). The camera at one place (Mario standing there, the camera as the game puts it) places the game view frame by Mario.
_Avoid_: camera path (it is not one route through the level), covered area
