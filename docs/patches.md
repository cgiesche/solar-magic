# ASM patches, UberASM and custom blocks

The editor contains [Asar](https://github.com/RPGHacker/asar) 1.91 (LGPL-3.0) as WebAssembly. With it,
three kinds of ASM code can be put into the ROM directly in the browser:

| Kind | Format | Where |
|---|---|---|
| **Patches** | any Asar patches (`.asm` or `.zip`), e.g. from SMWCentral | menu *ROM → Packages …*, tab *Packages* |
| **UberASM** | code per level, overworld map and game mode in UberASM Tool 2.x format | tab *UberASM* |
| **Custom blocks** | blocks in GPS format | tab *Blocks* (also via *Custom Blocks …* in the Map16 editor) |

Everything lives in one dialog, *ROM → Packages …*: the *Packages* tab (see [Packages](#packages)) and one tab
each for UberASM, Blocks, Sprites (PIXI, see [pixi.md](pixi.md)) and Music. **Uploading a package is the
only way third-party content gets into the ROM:** *Upload package …* at the top of the dialog
(or dropping a file onto the dialog) shows a preview of everything that was recognized, and *Install*
installs it all as **one package** (see [Uploading a package](#uploading-a-package-preview-and-install)).

The UberASM, Blocks, Sprites and Music tabs are **configuration views** of what the packages
brought along: they assign and unassign – an UberASM file to a level, game mode
or overworld map, a block to a Map16 tile, a sprite to a number, a song to a
level –, change settings of files and export the tool folder as `.zip`. Every entry
names the package it comes from. Adding content or deleting individual parts is not possible there: that is
what a package's *Upload package …* and *Remove …* do. Removing an assignment deletes nothing; the file
stays in the project and can be assigned again.

**Every change goes into the ROM immediately** – installing and removing packages as well as every
change in the configuration views (an assignment, a setting). The whole project is rebuilt and applied; if that fails, the ROM stays
unchanged and the tab shows the ROM's state again. Every change is **one step for Ctrl+Z**
(also with the dialog open; Ctrl+Y or Ctrl+Shift+Z redoes), which reverts ROM bytes and editor data
together. There is no *Apply*/*Discard* and no prompt on closing (see
[ADR 0001](adr/0001-immediate-apply-for-packages.md)).

All three are tracked in a **patch registry in the ROM** (RATS block "SMWA"). For each patch it
stores:
- the bytes it changed outside its own free space, **with the original bytes**;
- the RATS blocks it created;
- the chosen settings;
- a reference to the source files.

The **source files** (compressed) are not in the ROM but in the **editor data** next to it: in the
browser, stored with the working ROM, and with *File → Save project* in a project file (`.smwproj` =
ROM + appended editor data), which *Open project …* opens again. *Export ROM* produces the playable ROM without
them. The same goes for the UberASM, custom block, custom sprite and music projects and the files of the
packages.

That is why every patch can later be **removed completely** – even from an exported playable
ROM, since the registry and the original bytes are in the ROM. **Reapplying** with different settings or
editing a project needs the sources, i.e. the project file (or the browser the work was done in).

Since the editor loads levels by emulating the game, the effect of a patch is visible immediately. This applies
to changed level loading routines, level `init`/`load` code from UberASM, palettes, etc. In test mode (▶)
all of the code runs.

## Packages

Every added download then becomes a **package**: the list on the left, on the right the selected one with everything it
brought along –
* its **patch** with the settings and *Reapply*;
* its **UberASM code**: where it runs (✕ removes an assignment), *Settings …*/*Edit …*
  for the files, below that the remaining files (libraries, configuration);
* its **custom blocks** (tile, file, acts like; the tile opens the Map16 editor) and **custom sprites**
  (kind, number, name) with the settings of their files;
* the **ExGFX files** it created;
* **graphics in the package**: `.bin` graphics files and 128-pixel-wide `.png`. *Import as graphics …*
  switches to the graphics section and puts the file into the first free ExGFX number (a `.bin` whose name
  gives a number can optionally go there; PNG colors are mapped to the palette chosen there);
* **package files**: all files of the download – read (instructions) and download them. Adding files to an
  installed package is not possible: one upload, one package.

What a package brings is not reported by the dialogs but observed: the editor compares the
ROM's projects (patches, UberASM, blocks, sprites, ExGFX) before and after installation. Whatever happens later from
within the package (files imported as graphics, reapplied settings) belongs to the
same package. The registry is in the ROM (RATS block "SMWK"), the files of the download
in the editor data (see above).

**Remove …** takes out the whole package: patches (later ones first), UberASM files and
assignments, blocks, sprites, created ExGFX files. Files that another package also brought along
(a shared library) stay; so does whatever is placed in the level. If a step fails,
the ROM stays unchanged; Ctrl+Z brings back a removed package.

The editor's own patches (including the VRAM patch and the ExAnimation engine) are not third-party content and are not listed. Whatever in the
projects belongs to no package (added earlier or by hand) is listed at the bottom of the list with a link to the tab.
A Lunar Magic level file (`.mwl`) without code is a level import and does not become a package; in a package with code it is the package's sample level.

## Uploading a package: preview and install

An **upload** is what you put in for a package: a single file (`.asm`, an AddmusicK song `.txt`)
or a `.zip` – a download from SMWCentral as it is, or a whole folder of UberASM Tool, GPS
or PIXI. After uploading, the editor (`src/core/packages.ts`, one adapter per part kind in `src/core/pkgparts.ts`) detects which **parts** it
contains – each file on its own, by its folder, then its content, then its extension, never by which other files are
in the upload (ADR 0002) – and shows them in a **preview** ("2 sprites, 1 UberASM file, 1 song"), each part with its
kind. Nothing has been written yet: *Cancel* leaves the ROM unchanged. *Install* applies all parts at once
and creates **one** package, which is then selected in the list; Ctrl+Z reverts the whole installation in
one step. If a part fails, the ROM stays as it was.

| Recognized by | Part | What *Install* does |
|---|---|---|
| `.txt` with `#0` and `#amk`/`#samples` (MML), plus `.brr` | Song (AddmusicK) | next free number, plays in the current level; AddmusicK inserts the music (tab *Music*) |
| `print "INIT ",pc` / `print "MAIN ",pc`, `.json`/`.cfg` | Custom sprite (PIXI) | next free numbers; defines in other files naming the sprite (a block's `!bounce_num`) get its number, see [pixi.md](pixi.md) |
| `list.txt` with blocks (also a GPS folder) | Custom blocks | on the tiles of the list, see [Block packages](#block-packages) |
| `list.txt` with `level:`/`gamemode:`/`overworld:` | UberASM Tool folder | files and assignments are added to the ROM's UberASM project |
| `init:`/`main:`/… labels without `org`, or a file in `level/`, `gamemode/`, `overworld/` | UberASM code | runs in the current level (from `gamemode/`: game mode 14, from `overworld/`: map 0) |
| starts with `db $42`/`db $37` | Custom block (GPS) | on the package's Map16 tiles, else the next free Map16 tile from 200; "acts like" from the description, the `.map16` or 130 |
| `.map16`, `.bin` not included by code (ExGFX), `.pal` + `.palmask` | Graphics | Map16 tiles at the author's position if free, ExGFX under its number if free, otherwise the next free ones; the level setup puts the ExGFX into the current level's slots and the colors into its palette |
| a `patch.json`, or the remaining `.asm` | Patch | at most one per package; settings in the preview, see below |

An upload can have parts of several kinds (a boss sprite with UberASM code and a song) or many of one kind
(a sprite pack) – it remains one package that is installed and removed as a whole. Files that another
`.asm` includes, and shared code in `library/`, `routines/` and `other/` are not parts of their own
but go with the part that needs them. The assignments can be changed in the tabs afterwards.

Special cases: an **UberASM Tool folder in a subfolder whose code includes folders next to it**
(Retry System) is assigned by hand, see [Packages with several parts](#packages-with-several-parts).
An **`.mwl`** without code or songs is a level import, not a package, see [Level import](#level-import-lunar-magic);
with code it is the package's sample level. Graphics without code and without an `.mwl` are a package. Files that
no part takes (a readme, unknown formats) are listed in the preview as not installed. If nothing at all is
recognized, the preview says what was found and what is missing.

**Placement:** for blocks and graphics the preview shows where they go in this ROM and how they link up – the
first tile of the `.map16`, which block each of its tiles shows, the tiles of blocks off the `.map16`, each ExGFX
file's number and slot – and lets you change all of it before installing. Two blocks on one tile are refused.
The checkbox below sets up the current level (the ExGFX in its slots – AN2 too –, the sample level's ExAnimation slots
that animate the package's tiles, the colors of a `.pal` with its `.palmask` in its palette); it is a level edit: Ctrl+Z reverts it, removing the package does not.

**Sample level:** a package with code and an `.mwl` offers its sample level (unchecked): it replaces the current
level – layer 1, layer 2, sprites, primary and secondary header, its own colors – with its Map16 tiles where the
package's went (Lunar Magic's Direct Map16 objects 22/23/27/29 become the editor's own) and its custom sprites
with the package's numbers where that is certain (one sprite of that type in the package and one number of it in
the level, or a PIXI `list.txt` naming the number); other custom sprites are left out with a note. The `.map16`
only records the row it was exported from; the column comes from the tiles the sample level places there. The
current level keeps its screen exits (those on screens the sample level has) and secondary entrances. Its
ExAnimation list replaces the level's (slots taking frames from the alternative files ExGFX 60–63 are left out). Like the level setup it is a level edit (not saved
yet after installing).

The preview has *Manual …* if the package contains a readme or an HTML manual. It
is shown inside the editor, with images and links between the pages; the pages' scripts do not run.
Manuals of packages in UberASM, Blocks and Sprites stay stored in the browser and are listed in the
respective tab under *Manuals*.

## Packages with several parts

Some downloads cannot be sorted in one step, e.g. Retry System: UberASM code in
`src/library` and `src/gamemode`, plus a configuration folder `src/retry_config` which, according to the readme, belongs in the
top-level folder of UberASM Tool, as well as examples, AddmusicK files and a manual. For
such packages the preview shows the **manual assignment** instead of the recognized parts, filled in
with the suggestion; *Install* installs the package as it is assigned there. There is no separate button for
assigning: the assignment only appears when detection is ambiguous.

* The package tree with a choice per folder and file: a folder of the UberASM project (`level/`,
  `gamemode/`, `library/` …, the top-level folder or a folder of its own with that name) or *leave
  out*. A folder passes its assignment on to everything in it; on the right it says where each file ends up.
* **Suggestion:** folders named like those of UberASM Tool that contain `.asm` go into their folder;
  folders next to them that their code includes (`incsrc "../retry_config/…"`) go into the top-level folder. The rest
  stays out.
* **list.txt:** for files in `level/`, `gamemode/` and `overworld/`, one line each with a number or `*`.
  If the manual contains a matching line (`* retry_gm.asm`), it is used; existing entries
  with the same number stay (as in `* a.asm,retry_gm.asm`).
* **What stays out** (examples, files for AddmusicK or Lunar Magic) is then available in the package's
  files for reading and downloading. An example you want is uploaded as a package of its own –
  one upload, one package.

After that, everything is in the UberASM tab: change assignments, a file's *Settings …* (defines grouped by the
file's sections, with the comments above them as help and a search field) or
*Edit …* as text for everything that is not a define line (macro lists, tables).

Whatever is only possible in Lunar Magic or in the game (setting objects with Extension, creating a new save file)
is described in the manual.

**"Save at least one level in Lunar Magic":** some patches (e.g. Retry System) check `$0FF0A0 != $FF`.
That is where Lunar Magic writes its version text on the first save, together with its level hacks. What
Retry needs from that is the current level number in `$7E010B`; the editor patch provides it. So it marks
the ROM the same way (`Solar Magic`, `$0FF0B4` = 0, i.e. no LM version: code meant only for LM 3 is not
chosen). The editor also recognizes its own ROMs by this mark.

## Applying patches

1. *ROM → Packages …* → *Upload package …* and choose an `.asm` or `.zip` file. From an archive, a
   common top-level folder is removed; includes and binary files (`incsrc`/`incbin`) keep their
   relative paths.
2. If the archive contains several `.asm` files, the main file is selected in the preview (see the patch's
   readme).
3. **Settings** (in the preview, later in the package details):
   - Without `patch.json` the preview shows all define assignments (`!name = value`) at the top level of the
     main file. Changed values are written directly into these lines. This way the
     configuration defines of ordinary patches can be changed too, without editing the file.
   - With `patch.json`, the options described there appear instead.
4. *Install*. Asar errors and warnings are shown.

**Conflicts** are checked before applying; on error the ROM stays unchanged. A patch is rejected
if it
- changes bytes that another patch changed, or writes into its code;
- overwrites an entry point of an installed editor patch (see [Hooks](#editor-hooks));
- overwrites protected data (existing RATS blocks: levels, graphics, palettes …);
- occupies banks `$7E/$7F` (reserved for emulation in 4 MB ROMs; Asar's freespace search is
  automatically kept away from them).

This applies to all kinds equally: external patches, UberASM, custom sprites, custom blocks, VRAM layout and
ExAnimation are all entered in the patch registry and checked against each other, regardless of the
order in which they are applied (`tools/testconflicts.ts`).

**Free RAM.** Every entry in the registry can occupy RAM. The editor's own components enter their ranges
themselves, external patches via `ram` in the `patch.json` (see below):

| Component | RAM |
|---|---|
| UberASM | `freeram` from the `list.txt` (2 bytes, default `$7FAC80`) |
| Custom sprites | sprite tables `$7FAB10-$7FAB6F`, `$7FAB9E-$7FABA9`, `$7FAC00-$7FAC17` (interface, see below), `$7FAC18-$7FAC19` |
| VRAM layout | `$7F0000-$7F3653` |
| ExAnimation | `$7FC003-$7FC0FF` |

- If two entries occupy the same RAM, the second is rejected ("RAM conflict with …").
- In addition, the editor searches each patch's code for long writes (`STA $7Fxxxx`,
  `STA $7Fxxxx,x`) and remembers the addresses. If a patch writes like this into RAM that another one occupies (or
  occupies RAM that another one writes to), there is a **warning**. The search does not find everything
  (indirect accesses, `DB = $7F`), so it is not an error.
- Ranges that are an **interface** do not warn: blocks and UberASM code also write to the sprite tables,
  for example when spawning a custom sprite.
- RAM of the original game (e.g. `$7F837B`) belongs to no one and is not checked.
- Addresses in the low RAM mirror (`$0DC4`) are compared as `$7E0DC4`.

The editor's own patches are installed when a ROM is opened (see [Editor hooks](#editor-hooks)), so a
patch that changes one of their entry points is rejected. The one exception is SMWM (message texts in free
space), installed only when the texts no longer fit in place: a patch on its entry point only gets a
warning, and moving the texts is then no longer possible.

**Removing** resets the changed bytes to their original state and frees the patch's free
space. If a patch applied later has modified this patch's code, that one has to be removed
first.

### Limitations

* **LoROM only, no SA-1.** Patches see `!sa1 = 0`. Patches meant exclusively for SA-1
  do not work.
* **Patches that require Lunar Magic do not work.** Such patches read, for example, the
  LM version marker at `$0FF0B4` or build on LM's own hooks for ExGFX, Map16 or level data.
  The editor provides its own interfaces for this (see `smwe.asm`). The level number in `$7E010B`
  exists as in LM.
* The editor sets the checksum on export; patches do not need to take care of it.

## Writing your own patches

Patches are ordinary Asar patches. For the editor, additionally:

* `!smwe` is defined as 1, `!sa1` as 0.
* Code and data go into free space with `freecode`/`freedata`. Hijacks in the original code via `org`.
  The editor detects both automatically; `autoclean` is not needed but does no harm.
* Write configurable values as **`!name ?= value`** (only set if not already defined); then
  they are passed via `patch.json` as Asar defines. `!name = value` at the top level of the
  main file works too: the editor writes the value directly into that line.
* `incsrc "smwe.asm"` includes the editor's interfaces (see below).

### `patch.json`

Optional, in the root directory of the archive:

```json
{
  "name": "Start-Powerup",
  "author": "someone",
  "version": "1.0",
  "description": "Mario starts every level with the chosen powerup.",
  "main": "startpowerup.asm",
  "requires": ["smwe"],
  "smwc": "https://www.smwcentral.net/?p=section&a=details&id=…",
  "options": [
    { "define": "powerup", "label": "Powerup", "type": "enum", "default": "1",
      "values": [ { "value": "0", "label": "small" }, { "value": "1", "label": "big" },
                  { "value": "2", "label": "Cape" }, { "value": "3", "label": "Fire" } ] },
    { "define": "keep_yoshi", "label": "Keep Yoshi", "type": "bool", "default": true },
    { "define": "timer", "label": "Time", "type": "number", "default": 300, "hint": "decimal" },
    { "define": "freeram", "label": "Free RAM", "type": "hex", "default": "$7FB000" }
  ],
  "ram": [ { "define": "freeram", "size": 1 } ]
}
```

| Field | Meaning |
|---|---|
| `name`, `main` | Required. `main` is the main file (path in the archive) |
| `options[]` | Form fields; `define` without `!`. Types: `bool` (1/0), `number`, `hex` (`$…`), `enum` (`values`), `text` |
| `ram[]` | Free RAM the patch uses: `{ "define": "freeram", "size": 4 }` (address = value of the setting or of the assignment in the main file) or `{ "addr": "$7FB000", "size": 4 }`; `"shared": true` for ranges others may write to |
| `requires` | Editor patches installed beforehand: `"smwe"` (editor patch), `"smwx"` (Map16 extension) |
| `author`, `version`, `description`, `smwc` | Shown in the dialog |

### `smwe.asm`

Generated for every patch from the ROM's current state; a file of the same name in the
patch takes precedence. Every ROM the editor opens has all editor patches, so all addresses are set.

| Define | Content |
|---|---|
| `!SMWE_LEVEL` | `$7E010B`: current level number (16 bits), set when a level is loaded |
| `!SMWE_PATCH` | 1 if the editor patch (SMWE) is installed |
| `!SMWE_SPRITE_BANKS` | 512 bytes: bank of each level's sprite data |
| `!SMWE_GFX_LO/HI/BANK`, `!SMWE_GFX_FLAGS` | 256 entries: pointers to GFX/ExGFX files, format (1 = raw 4bpp) |
| `!SMWE_LEVEL_GFX` | 512 × 8 bytes: graphics bypass per level (SP4…SP1, FG3, BG1, FG2, FG1; `$FF` = default) |
| `!SMWE_PALETTES` | 512 × 3 bytes: pointer to a level's 256-color palette (0 = none) |
| `!SMWE_BG_BANKS` | 512 bytes: bank of a level's BG tilemap (0 = original) |
| `!SMWE_LEVEL_MUSIC` | 512 bytes: a level's song instead of its header setting, 0 = header (music per level, SMWU) |
| `!SMWE_EXT_GFX` | 512 × 2 bytes: a level's BG2/BG3 graphics file (tiles 200–27F/280–2FF), `$FF` = none |
| `!SMWE_MAP16X` | 1 if the Map16 extension (SMWX) is installed |
| `!SMWE_BG_MAP16_GFX` | 8 bytes (4 tile words) per BG tile 200–FFF (SMWH) |
| `!SMWE_ACTS_LIKE` | `$1000` × 2 bytes: "acts like" of Map16 tiles 000–FFF |
| `!SMWE_MAP16_GFX` | 8 bytes (4 tile words) per tile 200–FFF |
| `!SMWE_BLOCKS` | `$1000` × 4 bytes: custom block per tile (address of the JMP table, flags) |
| `%smwe_require(X)` | aborts with a message if `!SMWE_X` is 0, e.g. `%smwe_require(MAP16X)` (kept for older patches; always passes) |

## UberASM

Code per **level** (000–1FF), **overworld map** (0–6) and **game mode** (00–FF) as well as global code.
The format matches UberASM Tool 2.x; existing resources work unchanged:

* Folders `level/`, `overworld/`, `gamemode/`, `library/`, `routines/`, `other/` and a `list.txt`. An
  UberASM Tool folder is uploaded as a `.zip` (one package); the tool's own files (`asm/`, `.exe` …)
  are ignored. *Export* in the tab produces a folder for UberASM Tool again.
* Labels `init`, `main`, `end`, `load`, `nmi`, each with `RTL`. A/X/Y are 8 bits, the DBR is the bank
  of the resource (except with `;>dbr off`).
* Extra bytes: `;>bytes n` or `;>bytes any`; pointer in `$00-$01`. In the `list.txt` they follow `:`,
  e.g. `105 wind.asm : 02`.
* `library/` files: as in UberASM Tool, each one is assembled on its own (own namespaces and labels);
  their labels are then called `<file name>_<label>`. Shared routines from `routines/` are called with
  `%UberRoutine(Name)`.
* `%prot_file()`, `%prot_source()`, `%require_uber_ver()`, `%move_block()` and the sprite table defines
  (`!sprite_num`, `!14C8` …) are available.
* `global:` (`init` with `RTS`), `statusbar:` (`main` with `RTS`), `macrolib:` and `freeram:` (2 bytes) as in
  UberASM Tool.

**Differences from UberASM Tool:**
- Everything is entered as **one** patch: first one Asar run per library, then one for
  resources and dispatchers.
- Skipping `*` resources (`-file.asm`) is not supported.
- No SA-1, so `;>sa1` is ignored.
- Level resources need the level number in `$7E010B`, which the editor patch provides.

The entry points are the same as in UberASM Tool (see [Hooks](#editor-hooks)). Patches that
collide with UberASM Tool therefore collide here too.

## Custom blocks (GPS format)

A block is an `.asm` file in `blocks/`. It starts with `db $42`, followed by one `JMP` per offset;
each offset ends with `RTL`:

```asm
db $42
JMP MarioBelow : JMP MarioAbove : JMP MarioSide
JMP SpriteV : JMP SpriteH : JMP MarioCape : JMP MarioFireball
JMP TopCorner : JMP BodyInside : JMP HeadInside
; with "db $37" additionally: JMP WallFeet : JMP WallBody

MarioAbove:
MarioSide:
    ; ...
    RTL
```

* On entry, **Y:`$1693`** contain the tile's "acts like". The block can change it; the new behavior
  then applies. Example: `LDY #$00 : LDA #$25 : STA $1693` turns the block into air for this contact.
* **X** is the caller's X (sprite index for `SpriteV/H`, fireball index for `MarioFireball`). It
  is restored afterwards.
* Shared routines from `routines/` are called as `%name()` and inserted only once. The
  standard routines of GPS 1.4.5 are built in (`change_map16`, `get_map16`, `spawn_bounce_sprite`,
  `spawn_sprite`, `shatter_block`, `glitter`, `teleport` …, with the same inputs and outputs, written after the game's
  routines); files of the same name in `routines/` take precedence. Likewise the additional defines
  of GPS (`!sprite_extra_bits`, `!bounce_map16_low` … for the custom bounce block patch).
* `list.txt` as in GPS: `200 block.asm` or `200:130 block.asm` (tile, optionally "acts like").
  Assigning also works in the Map16 editor: *Custom Blocks …* opens the *Blocks* tab with the selected tile.

The blocks depend on the Map16 extension (SMWX), which every ROM the editor opens has. Custom blocks
work for all tiles 000–FFF.

**Which offset is called** follows from the caller of the block routine `$00F545`:

| Caller | Offset |
|---|---|
| Mario, body center point | `BodyInside` |
| Mario, side points | `MarioSide` |
| Mario, head point | `MarioBelow` when rising, otherwise `HeadInside` |
| Mario, foot points | `MarioAbove` when falling/standing, otherwise `TopCorner` |
| Mario wall-running | `WallFeet` / `WallBody` (only blocks with `db $37`) |
| Sprites (`$019441`) | `SpriteV` for floor/ceiling, `SpriteH` for walls |
| Cape (`$0295AE`) | `MarioCape` |
| Fireballs / extended sprites (`$02A6xx`) | `MarioFireball` |

This mapping is derived from the original code and not taken from Lunar Magic. Blocks that
rely on LM-specific details (e.g. exactly when `TopCorner` comes) may behave slightly
differently.

## Block packages

Many blocks on SMWCentral come as a package, e.g.:
- `list.txt`: GPS list, such as `500:025 LeftWallLedge.asm`;
- the block files;
- `Tiles.map16`: the graphics of the Map16 tiles, as a Lunar Magic export;
- `ExGFX80_BG2.bin`: the 8×8 graphics the Map16 tiles refer to, here for the BG2 slot.

Once uploaded, *Install* sets it all up together:
1. The blocks go onto the tiles from the `list.txt` – if those are taken, the blocks and the `.map16` tiles move
   together to the next free place. Without a `list.txt`, a block goes onto the `.map16` tiles (one block: all of
   them; as many blocks as tiles: one each, in order), otherwise onto the next free tile.
2. The `.map16` tiles go into the Map16 table starting at the list's first tile (without a list: where the
   `.map16` was exported from, if free), with their "acts like" unless the list specifies one.
3. The ExGFX file is stored under the number from its file name (if free, otherwise the next free one) and,
   with the level setup, put into the current level's slot: from the file name (`_BG2`, `_FG1` …), the sample
   level's slots, or the one slot the `.map16` tiles draw from. For other levels: graphics section → *Graphics* →
   slot card → "Swap …".

This also works step by step:
- *Graphics* → *Import/Export → Import (.bin) …* (4 KB = uncompressed 4bpp, 3 KB = 3bpp, otherwise LZ2-compressed);
- *Map16 tiles* → *Import/Export → Import (.map16) …* (starting at the selected tile).

**BG2/BG3:** like Lunar Magic, the editor has two additional graphics slots per level for Map16 tiles
200–27F (BG2) and 280–2FF (BG3), in the graphics section under *Graphics* as the BG2/BG3 slot cards. In the original game, this
spot in VRAM (`$2000–$2FFF`) holds the layer 1 tilemap. The slots therefore need the **VRAM patch**
("SMWV"), which relocates the tilemaps as LM does, see below. Like the other editor patches it is installed when
the ROM is opened.

### VRAM patch (SMWV)

With the patch, the layer 1/2 tilemaps in levels are 64×32 at `$3000`/`$3800` instead of 64×64 at
`$2000`/`$3000`.
- **Horizontal levels:** a 64×32 tilemap holds 32 of the 54 tile rows. All rows of both layers are
  kept in a RAM shadow at `$7F0000–$7F3653`; the tilemap holds a window around the camera, and on
  vertical scrolling rows are reloaded from the shadow.
- **Vertical levels:** they load row by row anyway; there the game prebuilds only 1 block above and 15 blocks
  below the camera instead of 8 and 23.
- **Individual tile changes** (coins, blocks …) go into the shadow and, if visible, into VRAM.
- **Overworld, title screen and credits** stay unchanged.

This is verified by playing every level with and without the patch using the same inputs: with the same
game state, the visible content of both tilemaps must match exactly (`tools/testvram.ts`). The
patch costs some CPU time. In frames that are already at the limit in the original, this rarely causes
one extra lag frame – in the test about 0.1 % of frames. If another patch occupies RAM in the `$7F0000` range (via
`ram` in the `patch.json`), the editor rejects it; if it only writes there, there is a warning (see
[Free RAM](#applying-patches)). Patches that use the range anyway or modify the tilemap uploads themselves
are not compatible with it.

### Layer 2 scroll rates

The level header pairs a horizontal and a vertical layer 2 rate in one of 16 settings. As in Lunar Magic 3.40,
a level can instead have **separate horizontal and vertical rates** (*Level header → Layer 2 scroll →
Separate H/V*): None, Constant, Medium (1/2), Slow (1/32), Medium 2–4 (1/4, 1/8, 1/16), Slow 2 (1/64), Fast (1.2×),
and auto-scrolls up/down or left/right (layer 2 follows layer 1 and moves on by 1/4 to 4 pixels per frame
while the game runs). The data is Lunar Magic's: a byte per level at `$06FA00` (`SHCVVVVV`: S separate,
H the header's 4 bits are a horizontal auto-scroll, C Lunar Magic's "auto-set screens", V the vertical
rate), also read from a `.mwl` (level information byte 17). The format was learned from what a Lunar
Magic-saved ROM does in the editor's emulator, not from Lunar Magic's code. The patch hooks the level load
(`$05D915`) and the layer 2 scroll (`$00F79D`, the place Lunar Magic hooks); levels without separate rates
run the game's own code. The dialog shows what each setting does by letting the level run
(`src/core/l2scroll.ts`, `tools/testl2scroll.ts`).

### Level heights

A horizontal level without layer 2 objects can be taller or shorter than the game's 27 rows, as in Lunar
Magic 3.00 (Vitor Vilela's level height hack): *Level header → Level height* offers Lunar Magic's sizes 00–1B
(28 to 448 rows; 1C–1F are left out: 1C needs Lunar Magic's swapped screen jump, extended object `$03`, which
is the editor's structure, 1D–1F have more than 32 screens). The level data's 0x3800 bytes are shared by the
screens, a screen taking as many bytes as the level is high in pixels: the taller the level, the fewer screens
(size 0D: 56 rows, 16 screens; 1A: 298 rows, 3 screens). Heights the level's screens, objects or sprites don't
fit in can't be chosen.

The data is Lunar Magic's: a byte per level (`TB0MMMMM`, M the size; Lunar Magic's T and B are kept), here at
`$06CA00` (Lunar Magic keeps its table next to its own code), also read from a `.mwl` (level information byte 16).
Below row 31 objects are placed by screen jumps with a subscreen of 32 rows (`000HHHHH 0000VVVV 00000001`; the
new screen flag keeps the subscreen), sprites in Lunar Magic's new format (header bit 5; `$FF V` sets the
subscreen, `$FF $FE` ends the data, `$FF $FF` is a sprite starting with `$FF`). Only levels taller than 32
rows use subscreens. The sprite memory is the header's bits 0–4. All of this was learned from a Lunar
Magic-saved ROM in the editor's emulator (what Lunar Magic's code sets as the level's height per size, where
it puts objects after a screen jump) and from level files Lunar Magic 3.71 exported, not from Lunar Magic's code.

The patch makes the game's own level load build such a level, which is what the editor shows: the level's
setup (`$05D928`) takes the screen size for the level's size, each object (`$0586BB`) its address from the
screen, the subscreen and the high Y bit, and where objects go on to the next screen (`$0DA963`, `$0DA9D6`,
`$0DA9EF`, the places Lunar Magic changes) they step by the level's screen size; Direct Map16 and
structures too. Those three places are Lunar Magic's: a patch written for a Lunar Magic ROM that changes them is
not compatible. After the load (`$058091`) the size is cleared, so loads without the setup (the credits) are
the game's. Levels of the game's size run the game's code (`src/core/levelheight.ts`,
`tools/testlevelheight.ts`).

**Playing** a taller level works as in Lunar Magic: the same RAM (`$13D7` the height in pixels, `$0BF6–$0CF5`
the screens' Map16 addresses, which the game's mode tables of horizontal screen pointers now point to) and
mostly the places Lunar Magic changes, learned from what a Lunar Magic-saved ROM does in the emulator; the
code is the editor's.

- Finding a block below row 26 – Mario, sprites, line guides, bounce blocks, the cape, extended sprites,
  wall-following sprites and sprites checking the block ahead: the limits the game has (`CMP #$01B0`, a Y
  high byte below 2) follow the height, the screens' addresses come from RAM. Changing a tile (`$00BEB0`, also
  PIXI's `ChangeMap16`/`GetMap16`) works on every row; a sprite is erased below the level's height.
- The camera goes down to the height less `$F0` (the game's `$C0`). Like Lunar Magic, the game's lower bound
  of `$C0` while Mario hasn't scrolled the camera up stays, so the camera follows a jump where the game's
  would stay at the bottom.
- The tilemap (SMWV): a window of 16 block rows follows the camera; the rows entering it are built from the
  level data each frame (at most two, 32 block columns around the camera, each block's tiles from the game's
  renderer at `$058A66` or the code a patch put there, e.g. the Map16 extension's), columns are built from the
  window's first row on.
- Sprites load from Lunar Magic's new format (`$FF V` marks subscreen V) with the subscreen in their Y high
  byte – normal sprites, shooters, generators and the groups the game spawns; the editor's PIXI runtime takes
  the markers through the same code.
- Entrances: the game's table positions don't reach a taller level's rows. Lunar Magic 3.00's entrances
  can put Mario at a tile of the entrance screen (main entrance: `$05DE00` bit 5, X bits 4–3 there and bits
  2–0 in `$05F200`, Y bits 9–4 in `$06FC00` and 3–0 in `$05F000`; secondary entrances: `$05FE00` bit 6,
  X bits 4–3 there and 2–0 in `$05FC00`, Y bits 9–4 in a table of the editor's at `$06CC00` (Lunar Magic
  keeps it with its code, at no fixed place; nothing reads it but the entrance code – no .mwl carries
  secondary entrances, community code reads only the RAM – so the editor's own place costs nothing) and 3–0 in
  `$05FA00`). The camera can start relative to Mario (`$06FE00` / the
  editor's `$06CE00` bit 7): 16 × the 5-bit signed offset made of `$06FC00` bit 6 (secondary: `$06CC00` bit 6)
  and the FG/BG start Y bits, inside the level; the BG then shows its bottom when the camera is at the
  level's (its height in rows − 1 in `$06FE00` bits 4–0) or, with `$06FC00` bit 7, starts at the FG + 16 ×
  that offset (`$10`: at 0). For the bottom the patch lets the code that moves layer 2 each frame (the game's at
  `$00F79D`, or the separate rates') place layer 2 once with the camera at the level's bottom, at the first
  camera update after the load, and sets layer 2's offset (`$1417`) from that – at every rate the BG shows its
  bottom there, without a copy of the rates. The format is Lunar Magic's (the bit layout as the SMW speedrunning wiki's
  *Level Data Format* gives it; what each value does as observed in a Lunar Magic-saved ROM). In a level with
  a size the editor places entrances at tiles with the camera 10 rows above Mario. The level header dialog sets
  the camera start (the FG/BG start Y, or rows above Mario – horizontal levels only, the patch ignores it in
  vertical ones) and, for every horizontal level, the BG start of its relative entrances (bottom-aligned by the
  BG's height, relative to the FG by −15 to +15 rows, or at 0, as Lunar Magic's *Change Layer 1/2 Settings*).
  Moving an entrance, creating one and test play from a spot keep these settings (as Lunar Magic 3.50 can
  drag entrances); only a tile entrance with the game's camera gets the relative one. Test play from a
  secondary entrance starts with its own camera start. `tools/testfgbginit.ts` checks by emulation that test
  play starts FG and BG where each setting puts them. The level's own slippery, water, face-left and midway
  bits of Lunar Magic are kept but not used.

The emulation check (`tools/testlevelheightplay.ts`): levels of the game moved down into taller levels play
exactly like the game's – Mario and every sprite at the same positions under the same input, the same visible
tiles whenever the cameras are the same; a pipe in the moved part leads where the game's does, a secondary
entrance there puts Mario at its tile. Still the game's: the BG of a level without the relative camera
(it scrolls past its 27 rows), Lunar Magic's T and B bits of the size byte, the midway entrance of its own.

### Layer 3 graphics per level

As Lunar Magic's *Layer 3 GFX/Tilemap Bypass*, a level can have its own layer 3 graphics and tilemap
(*Graphics → Graphics*, the cards LG1–LG4 and LT3):
- **LG1–LG4** replace the game's layer 3 files 28–2B (2bpp, 0x800 bytes each, VRAM `$4000–$4FFF`; the
  status bar, message text and tides use them too). The game uploads 28–2B only at boot; the patch uploads a
  level's own at the graphics upload of its load (`$00A9DA`) and puts 28–2B back for the next level without
  its own and for the overworld.
- **LT3** is a file of layer 3 tilemap data, copied into the layer 3 tilemap (VRAM `$5000–$5FFF`, 64×64
  tiles) instead of the image of the level's layer 3 setting (`$00A01F`, the place Lunar Magic changes);
  what the setting does (a tide …) stays. Where it goes and how much of it, as in Lunar Magic: under the
  status bar (`$50A0`, the file's first `$A0` words are skipped), the start of layer 3 (the status bar's
  tile numbers are still written over it every frame), the status bar's last line (`$5080`), the bottom half
  (`$5800`); 0x2000 bytes (512×512), 0x1000 (512×256) or 0x800 (256×256).

The settings are Lunar Magic's: in its ExGFX table and a `.mwl`'s section 7 the LT3 word's high nibble
`DDFF` (destination, size), AN2's bits for "layer 3 GFX" and "layer 3 tilemap" bypassed (the bit layout as the
SMW speedrunning wiki's *Level Data Format* gives it). What each destination and size does was observed in a
Lunar Magic-saved ROM in the editor's emulator, by changing the nibble and reading VRAM after the level load.
The editor keeps them in a table of its own (LT3, LG1–LG4, `DDFF` per level, the patch "SMWL"; Lunar Magic's
table is at no fixed place and holds the other slots too). ExGFX of 0x800 and 0x2000 bytes are stored
uncompressed; a compressed LG file goes through the game's decompression, an LT3 file must be uncompressed and
at least as long as its size (the slots offer only 2bpp files for LG and such files for LT3).
`tools/testlayer3gfx.ts` checks by emulation that levels without them load layer 3 as the clean game, that
every slot, destination and size lands where it should, and that the game's files come back.

**Editing the tilemap** (the level editor's *Layer 3* mode, as Lunar Magic's "Load Layer 3 of Level" in its
overworld editor, LM help `ov_file_load_layer3_level.htm`; `src/core/layer3map.ts`): the level's layer 3
tilemap is painted over the level in 8×8 tiles where the level view draws layer 3 (its position at the end of
the load – in the game it scrolls by its own rates). The edit is the whole tilemap (`$5000–$5FFF`, as the level
loaded it) and a level edit; saving writes the part the level's LT3 file is copied to into that file (in place:
other levels with the same file change too, the panel names them), or, for a level without one, into a new
0x2000-byte file under the status bar. Before saving the emulator loads the level with the file as edited (its
LT3 entry and the file's pointer pointed at the overlay), so the level view and test play show it. The status
bar's rows are not edited (the game writes the status bar over them). Erasing puts in the first tile of layer 3's
graphics without a visible pixel ($FC in the game's). Where the patch copies an LT3 file is one function
(`lt3Copy`); the patch's tables are generated from it. `tools/testlayer3map.ts` checks by emulation that the
edited tilemap shows for every destination and size, before and after saving, and that a level pixel names the
entry drawn there.

## Level import (Lunar Magic)

Graphics in SMWCentral's graphics section are Lunar Magic exports, as the submission rules
there require: a sample level (`.mwl`), the `.map16` files of the Map16 tiles used (FG
and/or BG), the slots' ExGFX files, and palettes as `.pal` with a `.palmask` stating which
colors belong to the package. Such a file is a **level import**, not a package: it changes a level instead of
installing content. It is imported in the level editor with *Level → Import LM level file …* (an `.mwl`
or a `.zip` containing one). Whatever is checked in the dialog is applied to the **current level**; layer 1,
sprites and header stay. No package entry is created. If such a file is uploaded in the Packages dialog,
the preview says that it is a level import and leads to the level editor.

Which file is what is stated in the files themselves, not in their names (every author picks those differently):
Lunar Magic writes into the `.map16` header at 0x24 where the tiles come from (first tile / 16,
bit 0x400 = BG Map16; e.g. 0x20 = FG from 200, 0x420 = BG from 200, 0x50 = FG from 500). Each `.pal`
belongs to the `.palmask` of the same name.

1. **Background** (if layer 2 of the `.mwl` is a BG tilemap and the level has a BG
   background, i.e. no layer 2 objects): the BG tilemap is taken over as a level change (not yet
   saved). The BG `.map16` tiles go onto the extended BG Map16 pages 2–F
   (BG Map16 extension, SMWH). The location from the package is suggested. If it is already taken,
   they go onto the next free tiles; the tilemap is shifted accordingly.
2. **Foreground**: the FG `.map16` tiles (with "Acts like") go onto the extended Map16 pages,
   for placing in levels. Here too the location from the package is suggested, otherwise the next
   free pages. "Acts like" that points to tiles of the package is shifted along.
3. **Graphics slots**: the slots that the imported tiles actually use are set (from the
   8×8 tile numbers of the tile words: 000 FG1, 080 FG2, 100 BG1, 180 FG3, 200 BG2, 280 BG3), with the
   number the `.mwl` gives for them. The package's ExGFX files are stored under free numbers
   (Lunar Magic counts up to FFF, the editor up to FE). A file the ROM already has is only set for the
   part's own slots (a background does not change FG slots).
4. **Colors**: per palette, the colors according to the `.palmask` and, if marked, the background color (from the
   `.mwl`) go into the level's custom palette. It is created from the current colors when needed.
   Palettes with only colors 0–31 (the 2bpp palettes of layer 3) are preselected only with layer 3.
5. **Layer 3** (in the `.mwl` the slots LT3 = tilemap file and LG1–LG4 = layer 3 graphics, Lunar Magic's
   layer 3 bypass): the LG files that are not the game's 28–2B and the LT3 file with its destination and size
   go into the level's layer 3 slots (see [Layer 3 graphics per level](#layer-3-graphics-per-level)).

Undo: Ctrl+Z first reverts the tilemap, then the rest (Map16 tiles, ExGFX files, slots,
palette).

### BG Map16 extension (SMWH)

The game draws BG columns in a single routine (`$058D7A`, also for the initial build). The
tile words of a BG tile are located there at `$0D9100 + tile × 8`. The hook at `$058DE6` uses a separate table
(`!SMWE_BG_MAP16_GFX`) for tiles 200–FFF; 000–1FF stay unchanged. The high bytes
of the tilemap (`$7EBD00`) are already fully written by the game's RLE decoder, so no further hook
is needed for them. In the graphics section, *Map16 tiles → Background* shows pages 2–F. The BG brush
has a page selection.

## Editor hooks

Locations in the original code that the editor itself modifies. A patch that changes the same locations is
not compatible with the respective feature.

| Address | Feature |
|---|---|
| `$05D8F5`, `$00BA2C`, `$00AA6B`, `$00A9E1`, `$00AA22`, ext. object table `$0DA115` | Editor patch (SMWE) |
| `$00922F` | Level palettes (SMWP) |
| `$058060` | BG tilemaps (SMWB) |
| `$058DE6` | BG Map16 extension, BG tiles 200–FFF (SMWH) |
| `$058551` | Music per level (SMWU) |
| `$00AA50` | BG2/BG3 graphics slots (SMWG) |
| `$00A9DA`, `$00A01F` | Layer 3 graphics per level (SMWL); RAM `$7F3678` |
| `$05D915`, `$00F79D`, table `$06FA00` | Layer 2 scroll rates; RAM `$7F3660–$7F3665` |
| `$05D928`, `$0586BB`, entrance options and screen exit flags `$009708`, `$0DA532`, `$0DA536`, the slanted pipe to the left `$00D2B2`, `$0DA963`, `$0DA9D6`, `$0DA9EF`, `$058091`, tables `$06CA00`, `$05DE00`, `$06FC00`, `$06FE00`, `$06CC00`, `$06CE00`; finding a block `$00F478`, `$00F492`, `$00F49A`, `$0194D6`, `$019500`, `$019512`, `$01D97B`, `$01D981`, `$0292D9`, `$0292F9`, `$02930A`, `$0295C0`, `$0295EC`, `$0295FD`, `$02A6BA`, `$02A6CB`, `$02BA50`, `$02BA71`, `$02BA82`, `$02D15A`, `$02D18C`, `$02D19D`, `$03D793`; changing a tile `$00BEEC`, `$00BF41`, `$00C079`, `$00C0C6`, `$00C1B1`, `$00C3D3`; mode tables `$00BDA8`, `$00BDE8`, `$00BE28`, `$00BE68`; sprites `$02A82E`, `$02A968`, `$02AA5F`, `$02AB54`, `$02ABD0`, `$02AF3D`, `$02AFA7`, `$01AC3E`, `$02D038`, `$03B86A`; camera `$00F70D`; entrances `$05D7E0`, `$05DA17` | Level heights (Lunar Magic 3.00's entrances, their options); RAM `$7F3666–$7F3677`, `$7F3679`, Lunar Magic's `$13D7`, `$0BF6–$0CF5` |
| `$008A7F`, `$0087AD`, `$0085E3`, `$0580B0`, `$0580B4`, `$0580BF`, `$0580C3`, `$058730`, `$058770`, `$0587D4`, `$0587DB`, `$05880B`, `$058812`, `$0586F7`, `$058A3A` | VRAM patch (SMWV): tilemaps relocated, taller levels' rows; RAM `$7F0000–$7F3654` |
| Ext. object table `$0DA118` (entry `$03`) | Structures (SMWS); empty in the original, no code hook |
| `$05B20F` | Messages in free space (SMWM), only if the texts no longer fit |
| `$00F545`, `$029328`, `$058A66`, `$058B46`, `$058C34`, `$058D2B`, `$00C096`, `$00C0E7`, `$00C176` | Map16 extension and custom blocks (SMWX) |
| `$05808C`, `$00A5EE`, `$00A242`, `$00A295`, `$00A2EE` | UberASM: level `load`/`init`/`main`/`end` |
| `$00A18F`, `$00A1C3` | UberASM: overworld |
| `$009322` | UberASM: game modes |
| `$00804E`, `$008176`, `$008E1A` | UberASM: global init, NMI, status bar |
| Banks 01/02/07 (list in [pixi.md](pixi.md#implementation)) | Custom sprites |

The UberASM hooks are only set if there is code for the respective area (`$00804E` always).

## Compatibility of known patches

No patches are bundled, because licenses on SMWCentral vary. Whether a patch
fits can usually be read from its readme:

* Compare **hijack addresses** with the table above. Example: a VWF dialog patch that replaces the
  message routine at `$05B1xx–$05B2xx` does not get along with relocated message texts
  (SMWM). As long as the texts stay in their place, SMWM is not installed.
* **"Requires Lunar Magic" or "LM x.y+"** usually means the patch builds on LM hooks; that
  does not work here.
* **SA-1-only** does not work.
* **Patches for UberASM Tool/GPS** (resources, blocks) belong in the UberASM or Blocks tab, not
  in a patch upload.

When in doubt, just apply it: the editor rejects conflicts, and *Remove …* undoes any patch
again.

## Technical details

* `src/core/asar.ts`: Asar WASM (`tools/build-asar.sh` builds it with Emscripten into `src/vendor/asar/`).
  Paths of `incsrc`/`incbin` are resolved as on a file system (`a//b`, several `..`
  in a row; `tools/asar-wasm/normalize-paths.patch`), since the files only exist in memory.
* `src/core/packages.ts`, `src/ui/upload.ts`: upload, preview, install.
* `src/core/pkgmap.ts`, `src/ui/pkgmap.ts`: packages with several parts; `src/ui/docview.ts`: manuals.
* `src/core/bgpack.ts`, `src/ui/levelimport.ts`: level import (Lunar Magic).
* `src/core/patchapply.ts`: applying, conflict checking, removing.
* `src/core/patchreg.ts`: patch registry "SMWA" in the ROM.
* `src/core/pkgreg.ts`, `src/ui/pkgtrack.ts`, `src/ui/packages.ts`: package registry "SMWK", observing,
  removing; the *Packages* tab.
* `src/core/patchpkg.ts`: `.zip`, `patch.json`, defines.
* `src/core/uberasm.ts`, `src/core/uberproject.ts`: UberASM generator and project.
* `src/core/blocks.ts`, `src/core/map16ext.ts`: custom blocks.
* `src/core/structs.ts`: structures (extended object `$03`). Level data: `00` object bytes as for any
  extended object with `$03`, then 1 byte structure number. Without SMWS, `$03` counts as an ordinary
  3-byte object, so that patches that use `$03` themselves keep working.
* Tests: `tools/testasar.ts`, `tools/testuberasm.ts`, `tools/testblocks.ts`, `tools/teststructs.ts`,
  `tools/testpkgreg.ts` (part of `npm test`).
