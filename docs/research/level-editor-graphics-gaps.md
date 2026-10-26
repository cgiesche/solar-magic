# Level editor and graphics: what users may miss compared with Lunar Magic

Research note, 2026-10-14. Question: which level-editor and graphics features might users still want or miss compared with Lunar Magic (LM, by FuSoYa)? Result: a Top 10 ranked by priority.

## Sources and method

- **Lunar Magic 3.71** (27 Sep 2026), the current release on FuSoYa's site: https://fusoya.eludevisibility.org/lm/program.html. The download (`https://fusoya.eludevisibility.org/lm/download/lm371.zip`) contains the official help file `Lunar Magic.chm` and `readme.txt`. In this note, "LM help: `x.htm`" means the page `html/x.htm` inside that CHM, and "LM changes" means `html/changes.htm` ("What's New", the full version history). These are FuSoYa's own documents and are the primary source for every claim about LM.
- **Feature overview:** https://fusoya.eludevisibility.org/lm/index.html.
- **User demand:** SMW Central's official thread "Lunar Magic suggestions and discussion" (https://www.smwcentral.net/?p=viewthread&t=93018). The site answered with a bot-verification page, so it could only be seen through search-result excerpts. Claims based on it are marked **[demand, secondary]**. They are weak evidence and are never the main reason for a rank.
- **Graphics workflow tutorial:** SnesLab, "How to Insert Custom Graphics" (https://sneslab.net/wiki/Tutorials/Lunar_Magic/How_to_Insert_Custom_Graphics). Used as evidence of the usual LM workflow (extract, edit in YY-CHR, re-insert). **[secondary]**
- **The editor itself:** checked in code (`src/`), together with `CONTEXT.md`, `docs/adr/0001`–`0004` and the git log. Paths below are relative to the repo root.

## What the editor already has (and is therefore not on the list)

Each of these was checked in code so it is not reported as missing.

- **Objects and sprites:** place, move, resize, delete, z-order, duplicate, rectangle and multi-select, cross-level copy/paste, and insert by number. In `src/ui/levelview.ts` and `src/ui/app.ts`.
- **Sprite properties:** extra bits and extra bytes sized from PIXI's table. In `src/ui/panels.ts` `Properties`.
- **Custom sprite display:** drawn by emulation, in `src/core/spritegfx.ts`.
- **Undo/redo** for level and ROM edits: `src/core/levelhistory.ts`, `src/core/romedit.ts`.
- **View:** zoom 50–400 %, grid, screen boundaries, and layer toggles for L1, L2/BG, L3 preview, sprites and exits. In `src/ui/viewmenu.ts`.
- **Emulated overlays** (`src/ui/viewmenu.ts`, `src/ui/levelview.ts`):
  - collision, which corresponds to LM's "Tile Surface Outlines";
  - block contents;
  - jump arcs;
  - animation;
  - ON/OFF and switch-palace state.
- **Test play** with sound and gamepad, from any entrance or the mouse position: `src/ui/testplay.ts`. This replaces LM's internal emulator.
- **Level structure:**
  - header dialog: `src/ui/headerdialog.ts`;
  - sprite-memory check: `src/core/spritemem.ts`;
  - screen exits and secondary entrances with destination positions: `src/ui/exitpanel.ts`, `src/ui/tools.ts`;
  - main entrance and midway screen;
  - screen insert/delete;
  - Save as (copy a level);
  - Clear level;
  - level list with a "used only" filter;
  - Level as PNG: `src/main.ts:160`, `src/ui/levelview.ts` `exportPng`.
- **Direct Map16 placement:** the editor's own extended object, placed from the palette's Map16 tab (`src/ui/panels.ts`, `src/core/patches.ts` `DM16_EXT`). It also has **prefabs** (then called structures), which LM lacks: `src/core/prefabs.ts`.
- **Map16 editor:** `src/ui/gfx/map16tab.ts`.
  - 8x8 quarters, palette, flip, priority, acts-like, custom block link.
  - FG pages 0–F (SMWX, `src/core/map16ext.ts`) and BG pages 2–F (SMWH, `src/core/bgmap16.ts`).
  - Multi-select copy/paste.
  - `.map16` import/export.
- **BG (layer 2 image) editor:** BG mode, `src/core/bg.ts`.
- **Palette editor:** `src/ui/gfx/palettetab.ts`. Shared rows or a per-level palette, gradient, copy/paste row, `.pal`/`.palmask` import/export.
- **Graphics editor:** `src/ui/gfx/gfxtab.ts`. Pixel editor with pen, fill, pipette, selection, flip/rotate. PNG import/export and `.bin` import. GFX slots FG1–3, BG1–3 and SP1–4. LM only offers a "fairly basic tile editor" and recommends external tools (LM help: `editor_8x8.htm`).
- **ExAnimation:** level and global lists, frames from the Anim graphics A–D (ADR 0003). In `src/ui/gfx/animtab.ts` and `src/core/exanim.ts`.
- **Overworld:** layer 1/2 painting and level names: `src/ui/overworld.ts`. **Message boxes:** `src/ui/messagedialog.ts`.

## Top 10 (ranked by priority)

How the ranking was decided:

- How central the feature is to building levels in LM.
- How often LM users rely on it.
- How large the gap to the editor is today.
- Effort is a tie-breaker only.

### 1. Full `.mwl` level import and export (objects, sprites, exits, entrances, header)

- **What it is:** saving a complete level to a Lunar Magic level file and loading one back, including into several level numbers at once.
- **What LM does:** saves and opens a level as `.mwl` (LM help: `file_save_mwl.htm`, `file_open_mwl.htm`). It can export and import many levels at once, "useful if you're transferring all your levels to a new ROM" (LM help: `file_export_directory.htm`, `file_save_directory.htm`). The `.mwl` is the format in which levels move between hacks, collabs and SMW Central submissions.
- **The editor today:**
  - A Level import (`src/ui/levelimport.ts`, `src/core/bgpack.ts`) takes only the graphics side of an `.mwl`: BG tilemap, Map16, GFX slots, palette and ExAnimation. Objects and sprites are not taken.
  - A full `.mwl` level (L1, L2, sprites) is applied only as a package's **Sample level** (`src/core/mwl.ts` `sampleLevel`, `parseLmObjects`).
  - There is no `.mwl` export. The editor's own level file is JSON (`src/core/levelfile.ts`).
- **Why #1:** ADR 0004 makes the editor refuse LM ROMs. A user's existing LM levels can therefore only come in as `.mwl` files, and the editor's levels can only go back out the same way. Most of the parsing already exists in `src/core/mwl.ts`.
- **Effort:** medium.
  - The import can reuse `sampleLevel` and the level graphics placement (`src/core/levelgfx.ts`).
  - The export needs a writer for the sections in Ankouno's MWL format notes (already credited in `docs/credits.md`).
  - Levels built on LM-only features (CDM16, custom heights, LM entrance bits) need a note about what is lost.

### 2. Level dimensions and scrolling: horizontal level height, separate layer 2 H/V scroll rates, BG height and FG/BG init

- **What it is:** levels with a height other than the vanilla one, plus finer control of how layer 2 scrolls and where FG and BG start.
- **What LM does:**
  - Since 3.00 (Vitor Vilela's hack) the height of horizontal levels can be changed, "effectively making it possible to change the level dimensions" (LM changes, 3.00).
  - 3.00 added a new FG/BG init system with a BG height setting (LM changes, 3.00).
  - 3.40 added separate vertical and horizontal layer 2 scroll settings and more rates: "Fast", several "Auto-Scroll", "Medium 3/4", "Slow 2" (LM changes, 3.40; LM help: `level_layer12_settings.htm`).
  - The number of screens can be set automatically per level (LM changes, 3.40).
- **The editor today:**
  - Screens 1–32 and screen insert/delete only (`src/ui/headerdialog.ts:81`, `src/ui/tools.ts` `openScreenDialog`).
  - Only the vanilla 4-bit layer 2 scroll value.
  - No custom height.
- **Why #2:** level size and camera behaviour are core level design. Tall horizontal levels are common since 3.00, and the editor cannot make or display them.
- **Effort:** large.
  - It needs its own patch (editor patch rules, ADR 0004).
  - The patch should follow the established layout (Vitor's Dynamic Levels), so that community content relying on it works.
  - Rendering, exits, screen math and sprite loading must follow.
  - Correctness can be checked by emulation (camera and sprite spawning in test play) rather than by tables.

### 3. Layer 3 editing (tilemap and GFX per level)

- **What it is:** editing the layer 3 tilemap and choosing layer 3 graphics per level.
- **What LM does:**
  - "Layer 3 GFX/Tilemap Bypass": layer 3 GFX and tilemap per level and per submap (LM help: `level_layer3_gfx.htm`).
  - Layer 3 settings for tides and images, scroll rates and offsets, and tides acting as water, lava or solid (LM help: `level_layer3_settings.htm`; LM changes, 3.10).
  - Layer 3 of a level is edited in the overworld editor's 8x8 mode ("Load Layer 3 of Level", LM help: `ov_file_load_layer3_level.htm`; LM changes, 3.20).
- **The editor today:**
  - View only. `src/core/layer3.ts` names what the setting does (by emulation), and `src/core/render.ts` `renderLayer3` previews it.
  - On import, LT3/LG1–4 are explicitly dropped (`src/core/bgpack.ts:34`, `:184`).
  - There are no LG slots in the Graphics tab (`src/ui/gfx/gfxtab.ts` `slotsOf`).
- **Why #3:**
  - Layer 3 backgrounds and foregrounds (mist, rain, a third parallax layer) are common in graphics submissions.
  - The editor's own test package "Sonic Mania – Studiopolis" ships layer 3 (`docs/credits.md`), and the editor currently loses it.
- **Effort:** large.
  - Patch: a layer 3 bypass in the established format.
  - A 2bpp tilemap editor, which can reuse the BG editor's interaction.
  - LG slots in the Graphics tab.
  - Taking LT3/LG over in the level graphics placement.

### 4. Remap tools: 8x8 references, Direct Map16 in levels, BG tilemap; moving Map16 tiles with their uses

- **What it is:** changing tile numbers in bulk after graphics or Map16 tiles have moved, so that everything still points at the right tiles.
- **What LM does:**
  - The Map16 editor's Remap dialog changes the 8x8 tile numbers, palettes and acts-like settings of selected tiles by offset, range, rectangle or list. It is meant for cases where "you may have imported a GFX file to a different slot than it was originally made for" (LM help: `editor_16x16.htm`).
  - "Remap Direct Map16" rewrites placed tiles in the level (LM help: `edit_remap_dm16.htm`).
  - "Remap Background Tiles" does the same for the BG tilemap (LM help: `level_bg_offset.htm`).
  - The ExAnimation dialog has a frame/destination Remap (LM changes, 3.32).
- **The editor today:** there is no remap command. The level graphics placement already renumbers tiles automatically on import (`src/core/levelgfx.ts`). A user who reorganises Map16 or GFX by hand has no tool.
- **Why #4:** this is a frequent clean-up step in LM after moving graphics. The editor could do better than LM: moving tiles in the Map16 tab could rewrite every use in every level, Direct Map16, BG maps, structures and block links. The editor already tracks these uses for packages.
- **Effort:** small to medium.

### 5. Entrance and exit options beyond vanilla (midway entrance, face left, water, exit to overworld, screen exit flags)

- **What it is:** the extra entrance and exit settings LM added on top of the vanilla game.
- **What LM does:** LM 3.00 added:
  - separate main and midway entrances, with redirecting a midway entrance to another level;
  - "Mario face left";
  - "make this a water level" for secondary entrances;
  - secondary entrances that exit to the overworld (pass normal or secret exit, teleport);
  - Secret Exit 2/3.

  Sources: LM changes, 3.00; LM help: `level_main_entrance.htm`, `level_second_entrance.htm`, `level_screen_exit.htm`. Entrances can be dragged without changing FG/BG init (LM changes, 3.50).
- **The editor today:**
  - The midway point is only the midway screen (`src/core/level.ts:63`). It shares X/Y with the main entrance.
  - The extra secondary-entrance bits are kept raw but cannot be edited (`raw3`, `src/core/level.ts:436`).
  - Screen-exit flags are kept raw (`flags`, `src/core/level.ts:29`).
- **Why #5:** designers use these every day: a midway point placed freely, and water sublevels without a separate level. The gap is visible (values exist but are locked).
- **Effort:** medium. Some options are plain data that the editor's patches may already allow. Midway position and exit-to-overworld need patch code in the established layout, since `.mwl` files rely on it (ties in with #1).

### 6. Complete ExAnimation editing: manual, custom and one-shot triggers; colour rotations

- **What it is:** the trigger types and colour animations the editor can show but not set.
- **What LM does:**
  - 32 slots per level plus global, with tile and palette animation.
  - Trigger types including manual triggers, custom triggers and one-shot triggers.
  - Up to 0x100 frames, insert/rotate frames, and point-and-click "8x8 Select".
  - Warnings for duplicate one-shot triggers.

  Sources: LM help: `level_ex20.htm`, `level_ex20_global.htm`, `level_ex20_settings.htm`; LM changes, 3.32, 3.40, 3.50.
- **The editor today:** `src/ui/gfx/animtab.ts`.
  - Only the predefined triggers can be chosen (Always, ON/OFF, P-switches, star, timer, dragon coins). Manual, custom and one-shot triggers are shown only when already set (`animtab.ts:325`).
  - The list's manual/custom-trigger fields are not editable.
  - Colour rotations: "cannot be edited here yet (created in Lunar Magic)" (`animtab.ts:343`).
- **Why #6:** manual and one-shot triggers are how UberASM, blocks and sprites drive custom animations (switch states, cutscenes). The editor installs such code itself through packages, so the matching animation setup belongs here.
- **Effort:** small to medium. The engine is already LM-compatible (`src/core/kobo/exanimation.ts`). Test play can set the trigger RAM so the result can be watched.

### 7. Conditional Direct Map16

- **What it is:** Direct Map16 objects that appear, or switch to a second tile set, depending on a flag.
- **What LM does:** Direct Map16 objects can depend on a flag bit in $7FC060–F. The object is not drawn when the flag is off, or with "Always show" it uses tile+0x100. There is a view toggle that simulates the flags (LM help: `edit_cdm16.htm`, `view_cdm16.htm`). Since 1.80.
- **The editor today:** nothing. No CDM16 anywhere in `src/`.
- **Why #7:** this is the standard way to make level layouts that change with progress or switches (paired with UberASM that sets the flags). Lower than #6 because it needs a level-format extension plus game code.
- **Effort:** medium.
  - A patch extending the editor's DM16 object, following LM's flag table so community UberASM works.
  - A property field.
  - A view toggle that sets the flags before the emulated level load. The rendering then comes from emulation, not from a hardcoded rule.

### 8. ExGFX range and graphics file I/O: numbers 100–FFF, `.bin` export, layer 3 GFX slots, descriptive file names

- **What it is:** the full ExGFX number range and getting graphics out of the editor in LM's format.
- **What LM does:**
  - ExGFX 80–FFF (LM help: `file_insert_exgfx.htm`, `level_super_bypass.htm`).
  - Extract/insert all GFX and ExGFX as `.bin` files (LM help: `file_extract_exgfx.htm`, `file_extract_gfx.htm`).
  - An external tile editor (YY-CHR) launched with the level palette (LM help: `file_tile_editor_setup.htm`; LM changes, 3.30).
  - Descriptive names `ExGFX###Name.bin` (LM changes, 3.70).
- **The editor today:**
  - ExGFX numbers 00–FF only (`src/core/map16file.ts:74`). LM numbers above are remapped on import.
  - PNG import/export and `.bin` import, but no `.bin` export (`src/ui/gfx/gfxtab.ts:476`).
  - No LG slots (see #3).
- **Why #8:**
  - The built-in pixel editor already covers most of what LM users do in YY-CHR. The SnesLab tutorial shows the extract → YY-CHR → insert loop LM needs **[secondary]**.
  - So the remaining gap is exchange (handing `.bin` to other tools and resources) and very large projects, which may hit 256 numbers.
- **Effort:** small for `.bin` export and file names. Medium for a 12-bit ExGFX pointer table, which needs an editor patch change.

### 9. Game view screen: an SNES-sized camera frame in the editor

- **What it is:** an overlay showing what the player will see at a given point.
- **What LM does:** "Game View Screen", a draggable 256×224 frame with bands where Mario is while scrolling in each direction, "to figure out what will be visible on the screen" (LM help: `view_game_screen.htm`). LM also has sub-screen boundaries with object/sprite screen labels (LM help: `view_sub_screen.htm`).
- **The editor today:** screen boundaries, grid and test play exist. No camera frame in the editor.
- **Why #9:** cheap and frequently useful when placing enemies and secrets just off-screen. The editor can do better than LM's approximate bands: the levelscan emulation (`src/core/levelscan.ts`) already moves the camera through the level, so the real camera path could be drawn.
- **Effort:** small (static frame) to medium (camera path from emulation).

### 10. Resource analysis across levels and batch image export

- **What it is:** a ROM-wide report of what each level uses, plus exporting many levels as images at once.
- **What LM does:**
  - "Analyze Resources in Levels" writes a report of which Map16 tiles, GFX/ExGFX, sprites and music are used in which levels. It includes "defined but not used" tiles and "inserted but not loaded" ExGFX (LM help: `file_analyze_levels.htm`; LM changes, 3.03/3.04).
  - "Export Multiple Levels to Image Files" (LM help: `file_export_directory_bitmap.htm`; LM changes, 3.20).
- **The editor today:**
  - Usage counts for the current level's Map16 in the Map16 tab.
  - The package registry knows what packages brought.
  - Level as PNG for one level.
  - No ROM-wide "where is this tile, ExGFX or sprite used" view, and no batch image export.
- **Why #10:** useful for clean-up and for knowing whether a tile or ExGFX can be changed safely, but not an everyday step.
- **Effort:** small to medium.
  - "Used in levels …" in the Map16, Graphics and sprite views reuses the ROM's level loader.
  - Batch export loops over `exportPng`.
  - Results learned by emulation follow the emulated-result rule in `CONTEXT.md`.

## Considered but not in the Top 10

- **Overworld beyond painting** (events, paths, OW sprites and palettes, submap layer 3) and **title screen and credits.** LM has them (LM help: `ov_editor_event.htm`, `ov_edit_sprites.htm`, `ov_file_load_title_screen.htm`, `ov_file_load_credits.htm`). They are real gaps (`src/ui/overworld.ts`), but outside the level and graphics focus of this question. They would deserve their own list.
- **Tileset-specific Map16 page 2:** LM calls it "an older feature that is off by default in new ROMs" (LM help: `editor_16x16.htm`). Not worth adding.
- **Custom object/sprite collections and tooltip files** (`.mw0`/`.mw2`, `.dsc`/`.ssc`; LM help: `info_custom_object_collection.htm`, `info_custom_tooltip_map16.htm`):
  - structures, the emulated PIXI display and the package metadata already cover most of the need;
  - a tooltip or name per Direct Map16 tile could be a small add-on.
- **Palette niceties:**
  - hex entry (LM changes, 3.50) and vertical gradients (LM changes, 3.40);
  - HSL gradients and SNES-valid colour picking were asked for in the LM thread **[demand, secondary]**.
  - Small polish for `src/ui/gfx/palettetab.ts`.
- **Line-guide outlines, exit-enabled tiles, invisible objects view** (LM help: `view_line_guide_outlines.htm`, `view_exit_tiles.htm`, `view_invisible.htm`): the block-contents and collision overlays cover most of it. An "enterable" arrow already exists. Line guides could be added to the collision overlay by probing sprite interaction.
- **Map16 multi-tile selection:** long requested for LM **[demand, secondary]**, already present in the editor.

## Project constraints that shape the items

- **No SA-1 for now.** None of the items needs it. LM's SA-1 variants (e.g. the CDM16 RAM remap, LM help: `option_sa1_ramremap.htm`) can wait. Game RAM is reached only through `src/core/ram.ts`, ROM mapping only through `src/core/rom.ts`.
- **Emulate, don't hardcode.** These are learned by running the game:
  - #2: camera and sprite spawning in tall levels;
  - #3: what a layer 3 setting does (already the case in `src/core/layer3.ts`);
  - #6 and #7: trigger and flag effects (set the RAM, load, look);
  - #9: the camera path.

  None of these needs a table of SMW behaviour.
- **Own patches must fit the SMW ecosystem** (ADR 0004). These should use the layouts community content already relies on, not new ones:
  - #2: Vitor's level-height hack in LM's layout;
  - #5: LM's secondary-entrance bits;
  - #7: LM's $7FC060 flag table;
  - #8: LM's ExGFX pointer layout.
- **English UI only.**
- **Credits:** the ideas behind #2 (Vitor Vilela's Dynamic Levels / level height hack as integrated into LM) and every LM format followed (FuSoYa) belong in `docs/credits.md` when built. Ankouno's MWL notes are already listed there.
