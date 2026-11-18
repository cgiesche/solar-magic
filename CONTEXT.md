# SMW Editor

A browser-based editor for Super Mario World ROMs: levels, overworld, graphics and third-party content (patches, UberASM, blocks, sprites, music) installed into the ROM.

This file holds the vocabulary (each term, the words to avoid for it) and what the code doesn't say: game facts, rules and why. How a feature works in detail: read its module.

## Language

### The editor's own patches

**Editor patches**: the editor's own ASM in the ROM (SMWE, SMWV, SMWG, SMWP, SMWB, SMWU, SMWX, SMWH, SMWS, SMWL, SMWM, ExAnimation, FastROM, …), installed into the clean ROM when it is opened. The editor opens only the clean game and its own ROMs (ADR 0004). Never part of a package.
_Avoid_: Lunar Magic hacks, built-in patches

**FastROM**: the game's code runs in banks $80+; every ROM the editor makes is FastROM (ADR 0007). Callisto's initial patch is therefore left out of packages.
_Avoid_: speed patch, HiROM

### Editing

**ROM edit**: one labelled change of the ROM through the edit session: one undo step, all or nothing, the open level saved before it. Every overworld change is one (a paint stroke on mouse release).
_Avoid_: transaction, ROM write

**Level edit**: a change of the open level in memory; its own undo step, written to the ROM when the level is saved.

**Remap**: changing 8x8 numbers, palettes or acts-like of Map16 tiles in bulk (Lunar Magic's syntax); never changes graphics. A list's sources are the values before the remap.
_Avoid_: renumber, move tiles

**Tile move**: Map16 tiles 200–FFF taken to other numbers with graphics, acts-like, block and name, every use rewritten. Rewriting the uses alone is Lunar Magic's Remap Direct Map16 / Remap Background Tiles.
_Avoid_: remap, renumber

**Quarter**: one of a Map16 tile's four 8x8 words (order TL, BL, TR, BR). Acts-like belongs to the whole 16x16 tile.
_Avoid_: 8x8 field, cell, subtile

**Tile name**: the user's name for a Map16 tile (≤64 chars; several tiles may share one). Editor data: in the project file, never in the ROM or `.smwlevel`. Belongs to the tile number (stays on paste/clear/remap, moves with a tile move).
_Avoid_: label, tag, description

**Marked quarters**: the quarters of the Map16 tab's selection a builder edit changes. **Stamp** puts 8x8s onto quarters regardless of marks; **flip** mirrors the marked quarters as a whole (marks must be symmetric).
_Avoid_: selected quarter

**Conditional Direct Map16**: a Direct Map16 object or prefab tile depending on a flag of Lunar Magic's table $7FC060–F (set by user code); its tiles +0x100 while on. The view's flags are a view setting, not level data.
_Avoid_: CDM16 (in the UI), switch object

**Resizable object**: a standard object 01–3F; picker group "Resizable".
_Avoid_: standard object (in the UI), normal object

**Fixed-size object**: an extended object (00 + number byte, 10–FF in the picker); picker group "Fixed size". "Extended object" names only the encoding. Direct Map16 ($05) and prefabs ($04) are extended objects but not called fixed-size.
_Avoid_: extended object (for the grouping), ext object

**Custom object**: a number 00–FF of object 2D where a ROM hook (ObjecTool, Retry System's midway bars) reads 2D as 5 bytes; bytes 4–5 are its **extension**. Whether 2D has them, and which byte sizes it, is learned by emulation.
_Avoid_: custom normal object, user defined object, custom midway

**Object name**: the name in picker, properties, status bar, search. Built in only for the game's numbers (after Lunar Magic's descriptions); over them a package's `.mw0t`; over those the user's rename (editor data).
_Avoid_: description, tooltip, label

**Object tooltip**: a package's `.osc` text, else for an object drawing nothing what its load changes in RAM (emulated).
_Avoid_: description, object name

**Object box**: how the editor shows an object that writes no tile (a tile with its number). Editor-only.
_Avoid_: placeholder, marker

**Object group**: the tilesets whose objects 2E–3F are the same because the loader runs them through one table (clean game: 0/7/C, 1, 2/6/8, 3/9/A/B/E, 4/5/D); learned by emulation. Names of 2E–3F belong to the group.
_Avoid_: tileset group (Map16 sharing, learned separately), "T" value

**Prefab**: a reusable block of Map16 tiles (≤64x64, may be transparent/conditional) stored under 00–FF, placed as extended object $04 (patch SMWS). Edits apply in every level; "Break up" restores its source objects. A `.smwlevel` carries the prefabs it uses.
_Avoid_: structure (old name), custom object, stamp, collection

**Picker**: the panel something to place or paint is chosen from. Keeps pixels at whole-number scale.
_Avoid_: palette, Insert panel, tile selector

**Side panel**: right panel holding only the tool and the selection ("Picker | Properties" in every editor); settings go to popovers/dialogs, reference to popovers or the status bar (ADR 0015).
_Avoid_: sidebar, inspector

**Picked item**: what a right click places (object, Map16 block, prefab, sprite – or none). Without one the right click opens the context menu.
_Avoid_: palette item (old name), brush, current object, ghost

**Selection copy**: what a right click places when the selection was picked after the picked item.
_Avoid_: stamp, duplicate (Ctrl+D)

**Placement preview**: translucent preview of what a right click would place. Off by default: something drawn at the mouse feels like dragging.
_Avoid_: ghost, cursor image

**Graphics file**: files 000–FFF (GFX 00–31 and ExGFX) or an Anim graphic, all through one interface (core/gfxfiles.ts).
_Avoid_: ExGFX (for all), GFX entry

**Graphics slot**: a level's (or submap's) place for a graphics file: FG1–3, BG1, SP1–4, BG2/3, LG1–4, LT3. FF = default.
_Avoid_: GFX bypass, slot (alone)

**Pixel editor**: the zoomed view beside a graphics sheet; the only place pixels are painted.
_Avoid_: canvas, paint dialog

**Level size**: height of a horizontal level, one of Lunar Magic 3.00's sizes; taller = fewer screens. Below row 31 objects/sprites are placed by 32-row subscreens.
_Avoid_: dimension, level mode

**Screen**: a level section (00–1F) objects, sprites, exits are placed by. Not what is in sight (view) nor a 32x32 tilemap part (tilemap quadrant).

**View**: the 256x224 part of a level in sight in the game. Not the editor's level view or view settings.
_Avoid_: screen, window

**Tilemap quadrant**: a 32x32-tile tilemap part as the SNES reads it (the SNES's "screen").
_Avoid_: screen, block

**Tile entrance**: an entrance putting Mario at a tile of its screen (Lunar Magic's); entrances in sized levels are these.
_Avoid_: method 2, exact entrance

**Midway entrance**: where Mario starts after the midway tape: the main entrance on the midway screen, or (Lunar Magic's) its own tile and settings.
_Avoid_: checkpoint (the tape), midway screen

**New-style exit**: a screen exit with Lunar Magic's u flag (target in either bank). The editor writes only these and converts the game's on patching, preserving the game's old-style rule (high bit from the submap Mario is on).
_Avoid_: LM exit, exit format 2

**Exit to the overworld**: a secondary entrance leading back to the overworld (Lunar Magic 3.00): passing with normal/secret exit or nothing, optionally another base event and a teleport. Belongs to a level but is not one of its entrances.
_Avoid_: overworld entrance, warp

**Camera start**: where layers 1/2 start on entry (game's FG/BG init, or Lunar Magic's rows above Mario).
_Avoid_: FG/BG init, initial position

**Game view frame**: a 256x224 frame over the level showing what the player sees (Lunar Magic's Game View Screen); a view setting.
_Avoid_: camera box, screen preview

### Overworld

**Submap**: one of 7 maps: main (0) on the first 512x512 map, 1–6 sharing the second as fixed camera windows (**views**). Views overlap (Vanilla Dome's lower rows lie in Forest of Illusion's view), so a tile alone doesn't tell its submap: shown submap where the user acts, stored submap where stored, else nearest view center; ambiguous drops ask. Mario walking stays on his submap.
_Avoid_: world, map (alone)

**Translevel**: the number the overworld knows a level by (0–24 → 0–24, 25–5F → 101–13B); stored per tile (Lunar Magic's table), so placing a tile shifts nothing.
_Avoid_: level number, OW level

**Level tile**: a layer 1 tile where A enters a level – by emulation, not by tile number range. Its translevel moves with it; the level's settings (name, events, exit directions, initial flags, messages) belong to the translevel.
_Avoid_: level dot, node

**Level tiles as objects**: in the layer 1 mode level tiles and link ends are objects on top of the map – selected, moved (paths redrawn, translevel and links along), removed only that way; painting leaves them alone (ADR 0012).
_Avoid_: Levels mode (gone), level entrance

**Message**: the text of message box B9: two per translevel, plus Yoshi's thank-you (translevel 0's message 2). Which message a sprite opens is learned by emulation. When a package draws message boxes itself (VWF), the editor's message UI yields to a note naming it.
_Avoid_: message slot

**Path tile**: a layer 1 tile Mario walks/climbs/swims, stops or exits on; kind learned by emulation (walk, climb, swim, exit, stop, warp, level, none). Invisible in the game; the editor draws marks.
_Avoid_: road, Mario path

**Hardcoded path**: a way the game walks Mario by tables in its code, not tiles (clean game: 5 two-way paths). Learned by emulation ($1B78 set while walked), so Lunar Magic's option and Kevin's patch are followed. Not editable on the map.
_Avoid_: default path, invisible path

**Path shape**: how a path tile moves Mario (learned vectors and pose), shown as its **ways**. Where on a side he steps on is the previous tile's doing, so map cells show the walked ways. An exit tile's way is its **axis**: entered across it, Mario comes out turned 90°, off the path.
_Avoid_: tile direction, path direction

**Route**: cells given by the user for which the editor chooses path tiles ("Path (auto)" brush). Joins and extends existing paths; a stop tile takes a free translevel with initial flags = its ways (Mario only walks off a stop as its translevel's flags allow). Refused with reason where no tile fits.
_Avoid_: path, line, path tool

**Free tile** (OW layer 1): a tile drawn as 000, on no map and acting like 000 – room for a new tile.
_Avoid_: empty tile

**Budget** (overworld): use of a limited OW table (destroys 0x18, reveal pairs 0x16, layer 1 tiles 0x200, star/pipe 0x100, exit paths 0x80, translevels 0x5F, event tiles 0x3600, custom sprites 0x18/submap). Gauge: amber from 80 %, red full.
_Avoid_: quota, capacity

**Map piece**: a 16x16 block of OW layer 2 (2x2 entries with palette/flips) on a submap's grid.
_Avoid_: Map16 tile, event step

**Path without a look**: a walk/climb tile with no pixels of its own; the player sees the path only where layer 2 draws it. The editor gives no look automatically (the game's looks depend on terrain).
_Avoid_: invisible path

**Reached tile**: a layer 1 tile Mario can get to at an event progress (paths, links, hardcoded paths, level flags). A way ending without a stop is a **dead end**.
_Avoid_: accessible, unlocked

**Exit edge**: the level(s) a level exit opens – derived, never stored: B reached with every event passed but not with the events still passable without E (fixpoint), and B a first level on the way. An exit whose way leads to an already-reached level opens nothing (clean game: DS1 normal, CI5, VoB4).
_Avoid_: unlock, level connection

**World check**: whether the overworld can be played through, in the player's terms. **Errors** (stuck, unreachable) vs **warnings** (may be intended; never block). Groups Paths, Progress, Links, Look, Budget; each problem with Show and maybe Fix; keyed by kind and place to report new/gone problems after each edit. Levels 019 and 112 unreached are "as in the original game" (warning).
_Avoid_: problem list, validation

**Event**: one of 0x78 overworld changes, run when a level is passed (base event, +1…3 for secret exits), by a teleport or user code. What it changes = the tiles it leaves different. Named by the level exit running it; a secret exit names it only where the level can have one.
_Avoid_: path reveal, trigger

**Event step**: a 6x6 or 2x2 block an event changes on layer 2, **animated** or **silent**. The user paints the map after the event; the editor finds the steps; the user only orders them.
_Avoid_: event tile, piece

**Event progress**: the set of events shown as passed (the **checked** events), applied in number order as the game loads a save (ADR 0014). Non-playable sets allowed. Test play starts from the emulated save of that set. Not in the ROM.
_Avoid_: events passed, after all events

**Event list**: the OW editor's left panel: events grouped by submap, labelled by the exit running them. Checkbox = checked (progress); click = **edited** (painting goes into it). Play order is changed by renumbering, not reordering.
_Avoid_: playthrough strip (ADR 0013, replaced), Map after

**Cell history**: what each event changes on one layer 1 cell, in number order. An entry can be **moved** to another event – changing when, never how the map ends up.
_Avoid_: tile history

**When beaten…**: a level tile's sentence per exit, what passing it does, in the player's words. Display only.

**Reveal**: a layer 1 tile that changes into another when an event passes (Lunar Magic's reveal list). ≤1 per event.

**Reveal walk**: after an exit's event the game walks to the next level tile and opens the way back. Skipped for some translevels (Yoshi's House, switch palaces) and for exits without event – learned by emulation.

**Destroyed level tile**: a tile an event destroys (castle collapsing); one per event, 0x18 total.
_Avoid_: collapse, destruction event

**Layer 1 change**: a layer 1 tile an event writes when it ends (silent).
_Avoid_: layer 1 event

**Star** (overworld): tile 5F; A takes Mario along its link. Holds a translevel of its own (its flags = the ways off it, its name in the status bar); painting takes/keeps/frees one. Pipe 5B the same; pipe 82 (clean game, translevel 0) lets him walk any way. See docs/research/star-tile-translevels.md.
_Avoid_: star road, warp star

**Overworld link**: a star/pipe (table 0x100) or exit path (0x80) leading elsewhere, a teleport location, or a Koopa Kid's place. Of two entries with the same tile the game uses the last. A star/pipe link only from a "warp" tile. Mario arrives standing and walks off only as his tile's translevel flags allow – a path tile (translevel 0) strands him. An exit path's target side is always opposite the source's.
_Avoid_: link, warp, teleport

**Overworld sprite**: one of the game's 13 OW sprite slots. Gone while BOWSIE is installed.
_Avoid_: event sprite, OW object

**Custom overworld sprite**: a BOWSIE-format sprite (Arinsu) placed on a submap, in Lunar Magic's table `$0EF55D`. The editor does BOWSIE's insertion itself.
_Avoid_: OW sprite, BOWSIE sprite (in the UI)

**Start position**: where Mario and Luigi stand at a new game.

**Overworld option**: one of Lunar Magic's overworld "Extra Options"; a game-wide switch.
_Avoid_: extra option, setting

**Overworld import**: another editor ROM's overworld replacing this one's (Lunar Magic's "Copy Overworld" reversed). Package content is not copied, only warned about.
_Avoid_: overworld transfer, overworld export

**Refusal**: an overworld edit the game's limits don't allow, returned by the core as data and worded by the UI in player terms, with a fix or alternative; technical details folded away.
_Avoid_: error, limit message

### The game

**Game workspace**: the game's screens belonging to no level: the pre-game's screens, the overworld's prompts, the overworld borders (credits etc. to follow). It lists the screens the emulated game gets into, each with its picture; a screen a patch removed is not listed.
_Avoid_: game settings, title screen editor

**Pre-game**: everything the game shows from reset to the first overworld: Nintendo Presents, the title screen, file select, file erase, player select and, on a new save file, the intro.
_Avoid_: boot screens, front end, main menu

**Nintendo Presents**: the logo at power-on: a few OBJ (the logo's **tiles**), shown for a **time** the game counts in frames. Its page has as fields what the emulated game was seen to read from the ROM – each tile's position, tile number and properties, the time – and names the graphics file the tiles are from; what the game computes (a patch's larger logo) is shown without a field.
_Avoid_: intro logo, presents screen

**Title screen**: what the game shows until a button is pressed: the **title screen level** (C7 in the clean game) with the title screen movement, the **title screen picture** on layer 3 over it (the logo, the frame and the copyright line: a 32x29 tilemap in Lunar Magic's layout, stripe image entry 03, $0084D3) and the **title screen colours**.
_Avoid_: welcome screen, start screen, title logo

**Title screen movement**: the recorded joypad input the game plays the title screen level with (Lunar Magic: "Title Moves"): the game's table of **pairs** of buttons and frames, found by what the emulated title screen reads. A button of the table is pressed anew every frame it is held; it has B, Y and the directions, no A, L or R. Its **run** is Mario's way as the game plays it, shown on the title screen page as a **timeline** with a playhead. A **recording** is made on the page – the title screen level played from the title screen's own state, the buttons fed to the game through its table – and written into the table in place. A recording in which Mario dies (on the title screen a game over, after which the title screen level loads as a level to play) or leaves the level is not written.
_Avoid_: demo, attract mode, title moves, input sequence

**Menu**: a screen of text on layer 3 with a cursor, drawn from a stripe image: file select, file erase, player select, save prompt, game over prompt.
_Avoid_: dialog, selection screen

**Stripe image**: the game's data for tiles put on a layer's tilemap: entries of a VRAM address, a length and the tile words (or one word as a run), ended by a byte with bit 7 set. The title screen picture and every menu's text are stripe images.
_Avoid_: stripe (alone, for the whole image), tilemap data

**Menu text**: a menu's tiles on layer 3 as its stripe image has them. The editor finds the image by what the emulated game writes to the screen on the way to the menu and edits its tiles in place: the tiles the image has, where it has them. Marked on it, learned from the emulated game: the **cursor's places** (the cells the cursor is drawn in, one per choice) and the cells **written over by the game** (a file's exit count, the word blanked for a file in use). A menu a patch draws without a stripe image has no menu text: its page is a picture.
_Avoid_: menu string, menu tilemap

**File select**: the menu that chooses the save file, each shown with its exit count or as empty.
_Avoid_: save select, file menu

**File erase**: the menu that erases a save file, entered by "ERASE DATA" in the file select.
_Avoid_: file delete, erase screen

**Player select**: the menu that chooses a 1 or 2 player game.
_Avoid_: player count, mode select

**Save prompt**: the overworld's menu after a level that saves: "CONTINUE AND SAVE" or "CONTINUE WITHOUT SAVE". Not pre-game, but a menu like its menus.
_Avoid_: save dialog, save menu

**Game over prompt**: the overworld's menu after a game over: "CONTINUE" or "END".
_Avoid_: continue screen, continue/end menu

**Intro**: what a new save file shows before its first overworld: the **intro level** (C5 in the clean game) showing the intro message (level 0's message 1).
_Avoid_: intro cutscene, welcome message

**Save file**: one of the three saved games in SRAM.
_Avoid_: savegame, slot

**New file data**: what an empty save file starts with: the start position, the initial level flags, the lives.
_Avoid_: defaults, initial save

**Overworld border**: a map's layer 3 (Lunar Magic's "Load Layer 3 of Submap"), saved into its LT3 file. Row 4 (lives, level name) not painted.
_Avoid_: layer 3, overworld frame, HUD

### Third-party content

**Package**: what the user uploaded plus everything it brought into the ROM; installed and removed as a whole – the only way third-party content enters the ROM (ADR 0001).
_Avoid_: Patch, Resource, Download, Project

**Upload**: the files handed in for one package, before install.
_Avoid_: Download, patch package

**Callisto project**: an upload with `tools/Callisto/*.toml` (e.g. the RHR baserom): one package, patches in the project's order (ADR 0006). Its BPS data for a Lunar Magic ROM is not part of it, except that sample levels take messages from its overworld and the overworld's changed layer 1 tiles are a graphics part.
_Avoid_: baserom, project import

**Replaced patch**: a known patch an editor patch already covers; skipped with a note.
_Avoid_: redundant patch, built-in patch

**Tool project**: the ROM's project of one tool (UberASM Tool, GPS, PIXI, BOWSIE) stored as the sources of one built patch.
_Avoid_: tool patch, tool folder

**Part**: one typed piece of a package (patch, UberASM file, block, sprite, song, sound effect, graphics part). Detected per file, never by other files in the upload (ADR 0002).
_Avoid_: Component, Item

**Graphics part**: a part without code: Map16, ExGFX, palette, changed shared palette colors, a changed global GFX file, global animation slots, changed overworld layer 1 tiles (their Map16, from a BPS of Lunar Magic's overworld). Only differences from the clean game count; two packages changing the same color/file/tile conflict; removal restores the clean game's (a color's or tile's: what was there). Keeps the author's number if free.
_Avoid_: Resource, asset

**Sound effect**: an AddmusicK SFX (bank 1DF9/1DFC); keeps the author's number if free, else renumbered and the package's defines follow.
_Avoid_: SFX (in the UI), sample

**ExGFX range**: 80–DFF (then 32–7F) for graphics; E00–FFF for "as is" files (layer 3 2bpp, tilemaps). FF is no file.
_Avoid_: Super ExGFX, extended range

**Link**: a connection the editor works out between parts of one package (block↔Map16, sprite number in a block's define, SFX number in a define, ExGFX↔slot).
_Avoid_: Dependency, binding

**Level import**: an upload with a `.mwl` and no code or songs, applied to the current level; not a package.
_Avoid_: Graphics package, background package

**Sample level**: the `.mwl` of a package with code; optionally placed, with numbers rewritten to where the parts landed. A level edit, not part of the package.
_Avoid_: Demo level, test level

**Level setup**: what installing a package does to the current level so its graphics show. A level edit: removing the package doesn't revert it.

**Level graphics placement**: the one set of rules for bringing graphics into a level (levelgfx.ts), used by level setup, level import and sample level. Never puts colors into a palette made up when the level's colors are unknown.
_Avoid_: background package, graphics import

**Anim graphic**: one of four graphics A–D (Lunar Magic's ExGFX 60–63), the only source of animation frames; other sources are copied in on import (ADR 0003).
_Avoid_: AN2, alternative file, animation ExGFX

**Color rotation**: animation slot types 18–1B rotating a palette range; colors the game sets itself every frame don't rotate (found by emulation).
_Avoid_: palette rotate, palette cycling

**Animation trigger**: what makes an animation slot run (Lunar Magic's ExAnimation triggers). On the overworld **event triggers** ("Event Manual 8–F") replace game conditions. View triggers are a view setting.
_Avoid_: event, flag

### Emulated results

Principle: behavior is learned by running the game's code, never from hardcoded SMW tables.

**Probe**: learning how something behaves by running the game's code (block behavior, collision, sprite reactions, run speed). Per tileset; display data is not among its reads (ADR 0008).
_Avoid_: Test, check, lookup table

**Switch state**: blue P-switch, silver P-switch, ON/OFF off – the states a tile may act otherwise in. A view setting, taken over by test play.
_Avoid_: Switch mode, P-state

**Play session**: a level played in the emulator from gameplay start until death, exit or stop.
_Avoid_: run, game loop, harness

**Emulated result**: anything learned by emulation; valid while its input and the ROM bytes it read are unchanged.
_Avoid_: Cached value, generation

**Result learner**: runs emulation for a key and input, records bytes read, keeps the result. Same behavior on main thread and worker.
_Avoid_: prober, worker

**Round**: a run over many results to be repeated; results kept beyond store bounds while it and the next run (core/keptresults.ts).
_Avoid_: pass, generation

**Lane**: a queue of background jobs, one at a time; identical requests join.
_Avoid_: queue

**Open level's work**: what a probe worker does first because the open level needs it (its sprite images, object kinds, object boxes).
_Avoid_: urgent, priority

**Probe worker**: a worker thread running the probes and the result learner's jobs on its own copy of the ROM. There are at most three; which one a task or lane belongs to is fixed (ADR 0016), told apart as the first, the second and the third worker.
_Avoid_: pool, thread

**Watch**: records the bytes a view's drawing read; the view redraws only when one changed.
_Avoid_: signature, subscription

**Picture**: an emulated result showing looks; only pictures count display data as read (ADR 0008).
_Avoid_: image, render

**Display data**: ROM bytes that only say what tiles and colors look like (Map16 quarters, palettes and pointers). Not acts-like, not graphics file data (an input), not ExAnimation data.
_Avoid_: graphics data, GFX

**Input**: state outside the ROM a result depends on (the edited level with view settings, graphics file contents, …); compared by hash, never identity.
_Avoid_: cache key, dependency

**Derived ROM data**: read from the ROM without emulating; memoized per ROM generation.
_Avoid_: emulated result, cache

**Savestate**: test play's one slot (F5/F8); stale (dropped) after any ROM change. Not on disk.
_Avoid_: snapshot, save

**Rewind**: stepping back in test play (Backspace held), states every 6 frames, 10 s.
_Avoid_: undo, savestate

**Failed spawn**: a slot search that found all slots taken; recognised by the code's behavior, not tables.
_Avoid_: sprite overflow, slot overflow

**Missing sprite**: a level sprite the loader leaves out for lack of a slot (sprite memory); found by the sprite memory check.
_Avoid_: failed spawn, despawned

**Sprite group**: a largest set of sprites fitting one view together – what the sprite memory check plays.
_Avoid_: window, object group, group sprite

**Group sprite**: one sprite data entry that spawns several sprites ($DE, $E0).
_Avoid_: sprite group, cluster sprite

**Lag frame**: a frame whose main loop didn't finish before the next NMI. Loading/fading frames are not lag.
_Avoid_: slowdown frame, CPU overload

**Death marker**: where Mario died in recent test plays, with the killer. Browser-local per project and level.
_Avoid_: death point, skull

**Prefetch**: probing what a shown panel will need, last and quietly.
_Avoid_: background probes

**Scroll bands**: where Mario is on screen while the camera scrolls; learned by emulation, not a table.
_Avoid_: scroll zones, camera thresholds

**Camera reach**: what of the level the camera can show; learned by the level scan.
_Avoid_: camera path, covered area
