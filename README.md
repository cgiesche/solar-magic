# Solar Magic – Level Editor for Super Mario World

Browser-based editor for *Super Mario World* (US), modelled on the feature set of Lunar Magic.
Runs entirely locally in the browser; the ROM is never uploaded anywhere (it is only cached in the browser's IndexedDB).

Solar Magic is an unofficial fan tool, not affiliated with or endorsed by Nintendo. *Super Mario World* and Nintendo
are trademarks of Nintendo. The editor works on a ROM you supply yourself.

## Getting started

```sh
npm install
npm run dev          # http://localhost:5173 – open a ROM via the button or drag & drop
npm run build        # static build into dist/
npm test             # regression tests (need the ROM as test/fixtures/smw.smc, see test/fixtures/README.md)
```

In dev mode, `?rom=/<file name>` loads a ROM directly from the project folder.

### Desktop app (Tauri)

```sh
npm run tauri dev    # desktop window against the Vite dev server
npm run desktop      # release build with installers into src-tauri/target/release/bundle/
```

Requires Rust and, on Linux, WebKitGTK 4.1 (`webkit2gtk-4.1`). Same code as in the browser; the only differences live in
`src/ui/platform.ts`: opening/saving goes through the system's dialogs, "Save project" writes directly to the opened
`.smwproj`, and closing with unsaved changes asks first. Installers for Linux/Windows/macOS are built by the
*Desktop* workflow (on push to master or manually).

A release is a fast-forward of master to a tested develop commit, never a merge:

```sh
git push origin develop:master
```

So the release has the same commit as its develop build: the same version (`tools/version.ts`) and the same
`sha-<commit>` Docker image tag. A merge commit would count as one more commit and get its own hash.

## Core idea: the game renders itself

Instead of reimplementing SMW's roughly 250 object routines, the editor contains a 65816 CPU emulator
with an SNES memory map (DMA, VRAM/CGRAM/OAM, math registers, NMI/IRQ, APU handshake stub).
When a level is displayed, it runs the ROM's **original loading routines** (~15 ms per level):

* The level's Map16 data (`$7EC800`/`$7FC800`), graphics (VRAM) and palette (CGRAM) come straight from the game –
  pixel-perfect, even with modified graphics and ROM patches.
* While loading, the editor records which object writes which tile. This makes selection, hover and
  outlines exact without the editor having to know object shapes.
* Object previews in the palette and sprite graphics are also produced by letting the game render them
  (sprites: run a few frames and collect the OAM entries).
* Provenance tracking follows which ROM byte each CGRAM color comes from – that is how the
  palette editor writes back to the right place.
* With the built-in PPU scanline renderer, the edited level can be **play-tested** right away – with sound: the sound chip
  (SPC700 + S-DSP, [snes_spc](docs/credits.md)) is emulated too, and the game uploads its sound driver and music itself.

## Features

### Level editor
* All 512 levels; list with level names (from the overworld), filter by number/name.
* **Layer 1 / Layer 2 (in L2 levels) / Sprites / Screen exits / BG / Layer 3** as editing modes (keys 1–6).
* **Painting the background (BG mode):** edit the BG tilemap (32×27 BG Map16 tiles 000–1FF, up to FFF with the BG Map16 extension) with a brush
  – just like the other modes: click/drag picks up a tile or a block as the brush (in the level
  or in the palette), right-click/Shift+click paints (dragging keeps painting); it is saved in free space (BG patch).
* **Painting layer 3 (Layer 3 mode):** the level's layer 3 tilemap in 8×8 tiles over the level, with the same brush
  (picked from the level or layer 3's 2bpp tiles), palette, priority, flips and erase; saved into the level's
  layer 3 tilemap file (LT3, a new one when it has none).
* Objects: select (also by rectangle, Ctrl+click), move (mouse/arrow keys), resize via handle/keys,
  insert (right-click/Shift+click with a palette entry; after selecting in the level, a copy of the selection),
  delete, copy/paste/duplicate,
  drawing order (PgUp/PgDn), undo/redo.
* Palette: standard objects 01–3F, extended objects, **direct Map16 placement** (any tile, see patch),
  sprites with names and real graphics, including custom sprites (PIXI) with their extra bytes in the properties.
* **Prefabs:** save selected objects (e.g. an arrangement of Direct Map16 blocks) as a prefab
  (Palette → Objects → Prefabs → "Selection as prefab"). In the level it is then a single 4-byte object;
  cells that belong to none of the selected objects are transparent. Changing a prefab affects
  all levels. "Break up" turns a placed prefab back into the objects it was made from (or individual
  Direct Map16 objects where those would look different).
  Pasting the same Direct Map16 arrangement a third time (in any level) suggests saving it as a prefab
  when that saves bytes; the hint never blocks editing, ✕ stops it for that arrangement.
  `.smwlevel` files carry along the prefabs they use.
* Header dialog (H): primary header (mode, screens, tileset, palettes, music, time, sprite GFX, …),
  entrance & scrolling (entrance, midway point, layer 2/3 settings), sprite header, BG tilemap selection.
  Which GFX/ExGFX files a level loads (graphics bypass) is set in the graphics section:
  *Graphics* → slot cards ("Swap …") or "Use in slot" next to a file on the right.
* Screen exits per screen (destination, secondary), **secondary entrances** (dialog). Exits lead into any of
  the 0x200 levels and secondary entrances, also from 0xx into 1xx and back (Lunar Magic's new-style exits:
  every exit the editor writes is one, and the game's are made so when a clean ROM is opened, leading where
  the game leads them – so moving a level tile to another submap no longer changes where its exits lead); a
  secondary entrance leads into a level of either bank.
* **Entrance options** (Lunar Magic's): Mario faces left, water level (Mario swims), slippery for the main entrance
  (also the midway point unless it has its own) and each secondary entrance; "Water level" for a secondary screen exit. With face
  left the slanted pipe entrance shoots Mario out to the left. Slippery comes from the entrance, so a level can be
  slippery from one door and not from another: an exit says "arrives slippery" when its target entrance makes the
  level slippery (by the option or, as in the game, its entrance action – which actions do is learned by
  emulation), the main entrance's properties and the header dialog list the level's slippery entrances. Test play
  from an entrance starts with them and with its entrance action.
* **Menu *Level*:** save as, **insert/delete screen** (shifts everything after it), clear level;
  **menu *File*:** **export/import as a `.smwlevel` file** (objects, sprites, exits, header, graphics bypass, custom palette).
* **Entrance markers** for the main entrance (M), midway point (Z) and secondary entrances (S) – movable by
  dragging (snaps to the possible entrance positions).
* **Midway entrance** (Lunar Magic 3.00's): dragging the midway point (Z) gives it its own tile, with its own
  action, camera start and options (face left, water, slippery) in the exit panel; without them it shares the main
  entrance's position within its screen, as in the game. Test play from it starts there. A standard screen exit
  can "go to midway entrance" (Lunar Magic's): Mario comes out there when the target's midway point has its
  own settings, else at its main entrance.
* **Insert by number** (Ins/I): object, extended object or sprite with size/extra bits.
* Menu *View*: grid, screen boundaries, toggle layers; **inactive layer translucent** (the object layer not being edited is semi-transparent);
  view with switch palaces pressed or ON/OFF set to OFF; zoom 50–400 %.
* **Game view frame** (View → Game view frame, V; acts like Lunar Magic's Game View Screen): a 256x224 frame over the level showing what the player sees there, dragged by its edge or label onto the 8x8 grid; it keeps its place while editing. **Scroll bands** inside it: where Mario is on the screen while the camera scrolls right (red), left (green), up (blue) and down (purple), and after L/R looked ahead (dashed) – learned by moving Mario in the emulated game under the open level's mode and vertical scroll setting (walking, running, P-speed, turning around, climbing a vine and jumping up a staircase as he rises in the game, falling, L/R), so a ROM with other camera code and each setting show their own bands (no vertical scroll: no up/down bands). With the frame shown, the level is darkened where the camera never goes (its **reach**, found by the level scan: Mario carried along the level's top and bottom, the game's limits and the header's scroll settings deciding; the frame can't be dragged past where the camera goes, e.g. below Y $C0 in a horizontal level), and **Shift+V** puts Mario with his feet in the tile under the mouse and the frame where the game puts the camera then (emulated, learned again when the level changes); dragging the frame places it by hand again.
* **Layer 3** (tides, layer 3 images) as a preview (scrolling approximated); the header dialog uses emulation to tell what the four layer 3 settings do in the chosen tileset (rising/falling or fixed tide, layer 3 image). With a rising/falling tide, the level view shows the highest and lowest water level (measured by the level scan), and the collision overlay shows the tide water in blue. **Animated tiles/palettes** (View → Animation).
* Status bar with object/sprite count and data size (warning from 128 sprites); export the **level as PNG** (*File → Level as PNG*) as the level view shows it (the View menu's layers, sprites, exits, screen boundaries, grid); **several levels as images** at once (*File → Levels as images*: used, all or chosen levels – also those the level list shows –, a zoom, cropped to the screens each level uses; one PNG per level named after its number and name, in one .zip; levels that cannot be drawn are listed; Lunar Magic's Export Multiple Levels to Image Files).
* **Sprite memory check:** the editor runs the sprites that can be on screen at the same time in the game and
  detects when a sprite loses parts of its graphics because of insufficient sprite memory (sprite header, `$1692`)
  (e.g. E0, three chained platforms, with value 00). Affected sprites get an orange outline, and the status bar
  a notice with an explanation and a suitable value. A value is suitable if the ROM's levels use it, it shows all
  sprites completely and it does not let fewer sprites appear at the same time.
  **Auto-correction:** if a sprite edit makes other sprites incomplete, the editor adjusts the value itself.
  This is part of the same undo step. A value chosen by hand in the header dialog stays as long as no new
  overlaps arise.
* **Message boxes** (*Level → Message boxes*, a double click on a message box sprite, or *Edit …* at a level tile on the
  overworld): every level has two messages (those of its translevel, as in Lunar Magic, shared with its sub-levels) and
  Yoshi's thank-you (message 3), edited in a panel beside the level. You type into the game's 18×8 box itself, drawn in the
  ROM's own font: Enter starts a line, Backspace at a line's start joins it to the line above, text never leaves the box;
  pasted text wraps (optionally justified like the game's texts), a character picker shows the font's glyphs, characters
  the font lacks get a look-alike. Hovering a message box sprite shows the message it opens – which one is learned by
  hitting it in the emulator. *Show in game* plays the level with the box open. The problem list reports boxes opening an
  empty message and messages no box opens. The clean game's messages move to the levels that showed them. When an
  installed package draws the message boxes itself (a VWF dialog patch – the editor finds out by opening a box in the
  emulator), the panel, the preview and the checks say which package draws them instead; its install says so too.
* **Test level (T):** play the level in the built-in emulator (a changed level is saved first, so entering it again after dying plays the same), with keyboard or gamepad, with music and sound effects (M mutes the sound). It is played in a game in progress, entered from its overworld tile (a sub-level through its main level), so the midway tape counts: dying returns to the overworld, entering the level again starts at the midway point once touched.

### Music
* **Import songs** (*ROM → Packages … → Upload package …*): songs in AddmusicK format (`.zip` from SMWCentral
  or `.txt`). The editor finds the songs (MML with `#0`) and puts the BRR samples where the song looks for them (`#path`),
  even if the archive ships them in its own `samples` folder; missing samples are reported.
  The song gets the next free number from 29 on and plays in the current level; you can listen to it
  in the *Music* tab.
* Insertion is done with **AddmusicK 1.0.11**, which is built into the editor as WebAssembly (song compiler, sound driver, SNES patch).
  Every run reinserts the whole music project (~1 s) and is a single entry in the patch registry: hijacks with
  original bytes, free space; the songs and samples are kept as sources in the editor data (not in the ROM). That is why AddmusicK can always be
  removed completely; songs from a package go with the package.
* **Assignment to levels:** in the header dialog *Song for this level* or in the Music tab *Level* – any song in the ROM instead of the
  8 header settings (editor patch SMWU, like Lunar Magic's music bypass; also works without AddmusicK with
  the original driver's songs). Numbers are converted when AddmusicK is installed/removed.
* **Song settings** (Music tab, *Settings …*): options a song offers through AddmusicK's preprocessor
  (`#define NAME value` outside of `#if` blocks, e.g. the key in "Faith in Wily"). Derived from the song itself:
  values from `#if NAME == v ; text` become a choice (labelled with the comment or with lines `; v = text`
  after the define), defines only checked with `#ifdef`/`#ifndef` become a switch. The values are stored with the song in the project and
  are only applied on insertion – the file stays as delivered, *Reset* restores the song's values; ▶ in the
  dialog plays the song with the chosen values. For everything else: *Edit …* (the song file as text); if AddmusicK
  then reports an error, everything stays as it was.
* **Volume** per song (25–300 %): scales the song's global volume on insertion.
* **Playback (▶):** in the song list, in the header dialog and for packages. Playback is emulated, as in the game: the level
  is loaded with the sound chip, the game sends its music, after which only the SPC700 keeps running.

### Graphics, palettes, Map16
* **Map16 editor** (M): FG and BG tiles of the current tileset, per quarter 8x8 tile, palette, flip, priority.
  The builder shows the whole selection of the sheet (fitted into its column; Ctrl+wheel zooms, the middle
  button pans); so does the 8x8 graphics view, whose width can be dragged and edits many tiles at once: mark quarters (click, drag, Ctrl+click/drag
  adds or removes, Shift+click the whole 16x16 tile, Ctrl+A all, Esc none); palette, flips, priority (buttons or
  keys 1–8, X, Y) and a clicked 8x8 tile go into every marked quarter, mixed values are shown as mixed. Dragging a
  block of 8x8 tiles onto the builder stamps it there (tile numbers set, flips cleared, palettes kept; the overhang
  is cut off). Acts-like applies to the wholly marked tiles. Every change is one undo step. Double click or the
  right-click menu opens a quarter's 8x8 tile in the Graphics tab. Tileset tiles 073–0FF are shared by several
  tilesets (in the game 0/7/C, 2/6/8, 3/9/A/B/E, 4/5/D – found by loading a level with each tileset in the emulator):
  the tab names the tilesets a change applies to, and *Used in levels* lists the levels of all of them.
* **Extended Map16 pages 2–F** (tiles 200–FFF, for all tilesets) and **"Acts like" per tile** – also for
  vanilla tiles (e.g. ground that behaves like air). "Copy" (graphics + acts-like) quickly creates new tiles;
  they are placed via the Direct Map16 object (Palette → Map16 → page selection).
* **Remap** (Map16 tab → *Remap …*, like Lunar Magic's Remap): changes the 8x8 tile numbers, palettes and "acts like"
  of the selected tiles (or of the tiles 200–FFF that use given 8x8 tiles) by an offset or a list in Lunar Magic's
  syntax (`100,25`, `100-101,+25`, `100-101,M125`, `R100-111,M25`, `P5-6,7`, `100-101,P7`, `G100-101,+25`,
  `R200-211,S25`; sources are the tiles before the remap, so `100,25,25,100` swaps). Bad lines are marked where they
  are while typing, a preview shows the tiles before and after, one undo step. Visually: mark 8x8 tiles in the
  graphics view and drag them to where they are now – the list gets the line. Moving an ExGFX to another slot in the
  Graphics tab, or importing a `.map16` whose tiles draw from a slot without ExGFX, offers the remap with the offset
  filled in. The Animations tab remaps the frames and targets of chosen tile animations with the same list
  (Lunar Magic's ExAnimation Remap).
* **Move tiles with their uses** (Map16 tab → *Move …*): the selected tiles 200–FFF go to other numbers – type the
  new top left tile or drag the selection in the sheet – with graphics, "acts like" and custom block, and every use
  is rewritten: Direct Map16 objects in all levels (both layers), prefabs, BG tilemaps, the blocks' `list.txt`.
  Every level looks as before; the panel lists what it rewrites first. Moving onto a tile something places, a tile
  placed by an object's code, or only one of an "always show" pair (tile and tile + 100) is refused; defined but
  unused tiles there are overwritten after asking. One undo step. (Lunar Magic only rewrites the uses, below.)
* **Remap Direct Map16 / Remap Background Tiles** (Level menu, Lunar Magic's): rewrites which Map16 tiles the
  Direct Map16 objects or the BG tilemaps use, with a list of Map16 numbers in the same syntax (`200-2FF,+300`,
  `R200-231,M500`, swaps), for this level or all levels, the levels it rewrites listed before applying; the tiles
  themselves stay. A Direct Map16 object fills its rectangle with one tile, so it moves as a whole. Each BG tile
  keeps its own page, so unlike Lunar Magic there is no BG bank to change and a BG may mix pages; a game BG is
  stored by the editor once rewritten. Importing a `.map16` elsewhere than it was exported from offers this remap
  for the levels using the old numbers.
* **Animations tab** (Lunar Magic's ExAnimation, its format): tile animations, color animations and **color
  rotations** per level and globally. A rotation's colors are chosen by dragging over the palette (2–128); its
  type (rotate right or left, each also "reverse on trigger"), trigger and delay ("Frames", also shown as steps per
  second) are set beside a strip that shows the colors rotating at that speed. Color animations and rotations list
  the level's Map16 tiles that draw their colors (layer 1, layer 2, BG; marked in the level preview), say when no
  tile of the level does or the colors are sprite palettes, and name colors the game itself sets every
  frame (Mario's palette), as found in the emulated level; the level view (View → Animation) plays
  the level's animations for as long as they take to repeat. **Triggers** as in Lunar Magic – the game's
  conditions (time below 100 and 5 Dragon Coins also as one-shots), the precision timer, manual 0–F, custom 0–F,
  one-shot 00–1F – and each list's **Trigger Init** (custom triggers and manual frames set when the level loads,
  the level's over the global's); a one-shot used by several slots, an init frame FF or 256 frames played once
  are warned about. The **trigger panel** (Triggers, beside the level preview) lists every trigger the level's and
  the global slots use and switches it for the preview and test play – set in the emulated game after the level's
  load, the game's animation code runs –, with its RAM, ready ASM lines (e.g. `LDA $7FC0FC : ORA #$0200 :
  STA $7FC0FC`) and the slots using it; View → Animation triggers switches the same, and test play fires a chosen
  trigger while playing.
  A tile animation's frames are previewed in the palette its target's Map16 tiles use, or one chosen for the
  slot; when Map16 tiles show the target in another palette, the tab says which and **applies the chosen
  palette** to their quarters showing the target on request (one undo step, the tiles of this level preselected,
  each with the levels placing it) – never by itself: Map16 tiles are shared by every level.
* **Palette editor** (P): edit colors directly at their ROM source, `.pal` import/export,
  optionally a **custom palette per level** (all 256 colors).
* **Graphics:** view GFX00–31 and ExGFX up to FFF (as Lunar Magic: ExGFX 80–DFF, and E00–FFF for files kept
  "as is" – layer 3 graphics and tilemaps, never 3bpp), listed by range; export/import as PNG.
  New files and imports ask for their number, with the next free one of their range suggested (an imported
  file's own number when it fits); a 3bpp file numbered E00–FFF by its author goes to the next free ExGFX.
  Import either LZ2-compressed (original format, 2/3/4bpp) or as uniform **uncompressed 4bpp**
  (16 colors, via DMA from the ROM – no more 3bpp detour).
  The editor's own LZ2 compressor produces smaller data than the original.
* **Used in levels:** for the selected Map16 tile (FG or BG), GFX file or sprite, the levels using it, how often,
  in which slots or by which kind of object (object, Direct Map16, prefab) – a click opens the level at the first place.
  The Map16 tab also names the tiles acting like the tile, prefabs and custom blocks on it, and *Mark unused*
  crosses out tiles 200–FFF that are defined but placed nowhere; the Graphics tab marks inserted ExGFX that no level
  loads. Which tiles a level places is learned by loading it in the emulator (in the background, kept while the ROM
  and the level are unchanged), like Lunar Magic's "Analyze Resources in Levels".

### Overworld editor (O)
* Main map and all submaps; paint layer 1 (paths/level tiles) and layer 2 (terrain, 8x8) – mouse buttons as
  in the level editor: click/drag picks up a tile or a block as the brush (map or palette),
  right-click/Shift+click paints; X/Y flip for layer 2 blocks.
* Event progress: a slider shows the overworld – both layers – as after loading a save in which the events up to
  one have run (none to all, in their number order as the game applies them; Lunar Magic's "Change Events
  Passed"), the event named by the level exit that runs it; `,`/`.` step through them. Both layers stay editable –
  painting changes the map before events. A view setting kept per ROM (by its name), not in the ROM, not undone.
* Level tiles show translevel → level number; on the left, the list of the map's level tiles (click selects and
  centers, double-click opens the level); level names can be composed from the three name parts.
* Undo/redo as in the level editor (also for names); when leaving with unsaved changes:
  save, discard or cancel.
* Saving: layer 1 in place, layer 2 with an optimal RLE encoder into free space.

### ROM
* A header (512 bytes) is detected and kept on export; the checksum is fixed.
* Expansion to 1/2/4 MB (automatically when saving, if needed). Free space is managed via
  RATS tags (compatible with the usual scheme); old blocks are freed.
* Changed levels are written in place if they fit; shared or larger data moves
  to free space.
* **Editor data outside the ROM:** sources of patches, packages and the projects (UberASM, blocks, sprites,
  music) take up no ROM space. *File → Save project* saves ROM + editor data as `.smwproj`
  (for further editing, open with *Open project …*), *Export ROM* the playable ROM without them, *Export patch …* a BPS patch (Flips) against a chosen clean ROM.

## Custom ROM patch ("SMWE")

Installed into the clean ROM when it is opened, together with the editor's other patches below. The patches are
assembled at runtime and
change only a few verified locations:

| Location | Purpose |
|---|---|
| `$05D8F5` | Sprite data in any bank (bank table for 512 levels); current level number in `$7E010B` (like Lunar Magic) |
| `$00BA2C` | GFX pointer table with 4096 entries (ExGFX 000–FFF); the high bytes of the slots' numbers in RAM `$7F367A`–`$7F3682` |
| `$00AA6B`, `$00AA80` | Format selectable per file: LZ2/3bpp (original) or uncompressed 4bpp via DMA – also the game's own GFX00–31 (colors 8–F, as Lunar Magic's 4bpp GFX); the game's other code reading such a file gets it as 3bpp; an LZ2 file the game decompresses over part of it in the same upload (GFX31 over GFX01 after the special world) is converted as in the game, the rest stays 4bpp; RAM `$7F3687`–`$7F368E` |
| `$00A9E1`, `$00AA22` | Graphics bypass: 8 GFX slots per level (SP1–4, FG1–3, BG1), ExGFX up to FFF |
| Ext. object `$05` | "Direct Map16": places any Map16 tile as a rectangle (6 bytes); entry `$05` is empty in the original and in Lunar Magic (whose `$02` is a 5-byte object) |
| Ext. object `$04` ("SMWS") | Prefabs: places a stored block of Map16 tiles (4 bytes, 4th byte = prefab number 00–FF); only occupies entry `$04` of the extended object table, which is empty in the original and in Lunar Magic (whose `$03` is its swapped screen jump), independent of the editor patch |
| `$00922F` ("SMWP") | Custom 256-color palette per level |
| `$058060` ("SMWB") | BG tilemap data per level in any bank (edited backgrounds) |
| `$058DE6` ("SMWH") | BG Map16 extension: BG tiles 200–FFF (pages 2–F) from a separate table, like Lunar Magic's BG Map16 pages |
| `$00F545`, `$029328` ("SMWX") | Map16 "acts like" table for tiles 000–FFF (Mario, sprites, fireballs, blocks hit from below) |
| `$058A66`, `$058B46`, `$058C34`, `$058D2B` | Tilemap building: tiles from 200 on come from the extended Map16 graphics table |
| `$00C096`, `$00C0E7` | Tile replacement sets the page to 0/1 instead of only bit 0 (for tiles on page ≥ 2) |
| `$00C176` | Tile replacement draws tiles from 200 on from the extended Map16 graphics table (blocks changing into such a tile) |
| `$00A153` | Submap layer 3 tilemap (LT3) in place of the overworld's border; LG1–LG4 per submap through SMWL's upload |
| `$04DBB9` | Submap graphics files: the game's upload when Mario walks to another submap (the files per submap in SMWE's bypass, entries 200–206) |
| `$00AD32` | Submap palettes: Lunar Magic's routine copies all 256 colors of the submap (14 palettes: 7 submaps, again after the special world) instead of the game's shared tables |
| `$048E81`, `$049549` | Level names as free text: Lunar Magic's routine at `$03BB20` (19 tiles per translevel, table address at `$03BB57`) instead of the game's three shared words |
| `$05B1A3` ("SMWM") | Two messages per level, Lunar Magic's routine at `$03BB90` (pointers `$03BE80`, text in free space) |
| `$058551` ("SMWU") | Music per level: song number from a table (512 levels) instead of the 8 header settings (`$0584DB`), 0 = header |
| `$00AA50` ("SMWG") | BG2/BG3 graphics slots per level for Map16 tiles 200–2FF (as in Lunar Magic); requires the VRAM patch |
| 13 locations ("SMWV") | VRAM patch: layer 1/2 tilemaps in levels 64×32 at `$3000`/`$3800` instead of 64×64 at `$2000`/`$3000` (like LM), so that BG2/BG3 have room; details in [docs/patches.md](docs/patches.md) |

The tests check that all vanilla levels load identically with the patches installed.

## ASM patches, UberASM, custom blocks, custom sprites

The editor contains Asar (as WebAssembly) and uses it to apply ASM code directly in the browser:
- **Patches** (`.asm`/`.zip`, e.g. from SMWCentral), with settings and conflict checking;
- **UberASM** code per level, overworld map and game mode (UberASM Tool 2.x format);
- **Custom blocks** in GPS format;
- **Custom sprites** in PIXI format: sprites, shooters, generators and all misc types (cluster, extended,
  bounce …), with extra bytes; shown in the palette with names and real graphics ([docs/pixi.md](docs/pixi.md));
- **Level import** from Lunar Magic (*Level → Import LM level file …*, `.mwl` or `.zip` with `.mwl`, `.map16`, ExGFX, `.pal`/`.palmask`): background, FG Map16 tiles, graphics slots and colors into the current level – not a package.

Every patch is recorded in the ROM with its original bytes and sources and can be removed again at any
time. Details, `patch.json` and the interfaces for your own patches: [docs/patches.md](docs/patches.md).
Whose formats and interfaces the editor follows: [docs/credits.md](docs/credits.md).

## Limitations / not included

* **Music:** AddmusicK only (no Addmusic 4.05/AddmusicM driver, though AddmusicK converts their songs); custom
  sound effects and the music of the overworld maps/special songs (title, credits) cannot be set. A ROM into which
  AddmusicK was inserted outside the editor cannot get additional songs.
* **Test emulator:** no Mode 7 (boss levels); window/HDMA effects are ignored.
* **Overworld:** events, overworld sprites and path settings are not editable. Translevel numbers follow the scan order as in vanilla – new level tiles
  shift the numbers of subsequent levels.
* Title screen and credits are not included.
* ASM patches: LoROM only, no SA-1; patches that require Lunar Magic do not work.
* Opens only the clean US ROM (`Super Mario World (U) [!]`, MD5 `cdd3c8c37322978ca8669b34bc89c804`, with or
  without header) and ROMs/projects made with the editor; ROMs edited with Lunar Magic or other tools are not opened.

## Structure

```
src/core/cpu.ts          65816 interpreter
src/core/snes.ts         memory map, DMA, PPU registers, timing, APU stub, provenance tracking
src/core/ppu.ts          scanline renderer for test mode
src/core/levelemu.ts     level loading via emulation, tile ownership per object
src/core/level.ts        level format: header, objects, exits, sprites, secondary headers/entrances
src/core/render.ts       render level layers from the emulation result
src/core/save.ts         write levels into the ROM
src/core/asar.ts         Asar (WebAssembly, LGPL-3.0; built with tools/build-asar.sh)
src/core/patchapply.ts   apply/remove ASM patches, conflict checking; patchreg.ts: registry in the ROM
src/core/uberasm.ts      UberASM generator; blocks.ts: custom blocks (GPS format)
src/core/rom.ts          LoROM addresses, expansion, checksum, RATS
src/core/lz2.ts          LZ2 (de)compression
src/core/patches.ts      editor patch (assembled with asm.ts)
src/core/overworld.ts    overworld formats, RLE, names, OW emulation
src/core/spritegfx.ts    capture sprite graphics from the running game
src/core/spritemem.ts    sprite memory check: incompletely shown sprites, suitable value
src/core/apu.ts          sound chip (snes_spc as WebAssembly, tools/build-spc.sh)
src/core/amk.ts          AddmusicK as WebAssembly (tools/build-amk.sh); music.ts: music project, songs per level
src/ui/*                 user interface (no framework)
tools/*                  tests and analysis tools (disassembler: node tools/dis.ts 05D796 40)
```
