# The overworld's exit path tiles: what tells them apart

Research note, 2026-11-06. The question (the user's, in German): the layer 1 tiles "exit to another submap" all look
the same in the editor, but behave differently in the game. How can we make the difference visible, so that the user
picks the right one?

Sources:

- the SMW disassembly SMWDisX, `bank_04.asm` (`https://github.com/IsoFrieze/SMWDisX/blob/master/bank_04.asm`; the
  copy fetched for [lunar-magic-overworld-paths-and-links.md](lunar-magic-overworld-paths-and-links.md)), cited by
  label (the label is the SNES address),
- the bytes of the ROMs in `test/fixtures` (the clean game `smw.smc`, Journey to Kaizo, Nemesis, Super Luigi Land 2),
- emulation on the editor's image of the clean game (`tools/fixture.ts editorImage`), with the repo's own
  `LevelEmulator`, `pathKinds` and `pathShapes` (the same jobs the editor runs),
- the help and the program of Lunar Magic 3.71 (`Lunar Magic.chm` and `Lunar Magic.exe` from
  `https://fusoya.eludevisibility.org/lm/download/lm371.zip`, page names below),
- the code of this repo (file:line).

The scripts were run in the `node:24-slim` container and live in the session scratchpad, not in the repo; what each
did is described where its result is used. SMW Central was not fetched (it refused automated access for the earlier
note); nothing below depends on it.

## Result

1. **Ten tile numbers are exit path tiles: 25, 40, 42, 43, 44, 45, 46, 47, 48, 4D** (and their page 1 copies 125 …
   14D). Which tile is an exit is a list in the game's code; **where an exit leads is not the tile's**: the game
   looks up Mario's pixel position in the exit path table (Lunar Magic's, 0x80 entries). So any exit tile leads to
   the same place from the same spot.
2. **They differ in three ways, and only three:**
   - **The axis (the one that matters).** After the warp Mario walks on by the *exit tile's* vector, from where the
     table put him. 42 is a horizontal tile; the other nine are vertical. On a path of the matching axis he comes out
     walking the way he went in, as Lunar Magic's help says. Entered across its axis (a vertical exit tile at the end
     of a horizontal path, or 42 at the end of a vertical one), he comes out **turned by 90°** and ends up standing
     beside the path: his pixel position no longer on his tile (emulated, below).
   - **4D next to a stop or level tile.** 4D is one of the 24 tiles with a first step of their own: stepping onto it
     straight off a stop or level tile moves Mario diagonally (+4, −8 pixels) whatever the direction, so he never
     reaches the position the exit path table expects, the exit matches nothing and Mario walks back. From a path
     tile 4D works as the other vertical ones do.
   - **40 is climbed onto** (the pose table marks it as a ladder; the Yoshi's Island ladder). Only Mario's animation
     differs.
   Apart from those, 25, 43–48 and 4D behave alike in the game's code; they differ only in their Map16 look.
3. **In Solar Magic today all ten show the same**: the red "exit" mark without ways (or a red border where the tile
   has pixels), and the same popup text "Path: exit to another submap". The orientation is already *learned* (the
   path shapes job has the exit tiles' vectors), it just isn't shown.
4. **Neither the World check nor the links mode catches a wrong choice.** The path search takes the exit from the
   tile's position, not from where Mario's step really ends, and takes the direction after the warp from the target
   of the table entry, not from the exit tile's vector. A link's target side can be set to any side; only one is
   right.
5. **Lunar Magic doesn't make it visible either**: one red image for all exit tiles, the "side to enter from" asked
   only in the link dialog, and a general warning about misalignment.
6. **Recommendation:** show each exit tile's axis the way path tiles already show their ways (a line through the red
   mark, words in the popup), name the 4D and 40 cases in words, model the exit vector in the path search so the
   World check warns about a wrong tile, and derive (not ask) a link's target side. Details at the end.

## 1. Which tiles are exit tiles

| Claim | Source |
|---|---|
| The exit tiles are a 10-byte list: `44 43 45 46 47 48 25 40 42 4D` | `DATA_049426`; the same bytes in all four fixture ROMs (read at PC `0x021426` after the 0x200 header) |
| Mario looking ahead onto one of them (`CMP.W DATA_049426,X`, loop `CODE_049616`) calls the exit path lookup `CODE_049A24`, sets the music swap and the transition (`OverworldProcess = $0A`) | `CODE_049616` ff. |
| The tile number is taken without its high byte (`LDA.L Map16TilesLow,X : AND #$00FF`), so 125, 140 … 14D act as 25, 40 … 4D | `CODE_0495CE`; the editor's sheet says so for page 1 (`src/core/owl1sheet.ts:71` ff., "Acts like tile …") |
| Emulation agrees: the editor's path kinds job finds exactly `25 40 42 43 44 45 46 47 48 4D 125 140 142 143 144 145 146 147 148 14D` as kind `exit` on the clean game | `pathKinds` (`src/core/owpaths.ts`, `tools/fixture.ts:38`) run on `editorImage()` |
| `CODE_049A24` searches the exit path table by Mario's **Y pixel, X pixel and submap** (`CMP DATA_049964,Y`, `CMP DATA_049966,Y`, `CMP DATA_049968,Y`) and on a match puts him at the entry's destination position, submap and tile. The tile number plays no part. Lunar Magic hooks this at `$049A35` to its own table of 0x80 entries | `CODE_049A24`; `src/core/owteleport.ts:14-19`, `:36` |
| An exit whose position matches no entry does nothing: Mario walks back. Lunar Magic: "If Mario's coordinates are off by even a single pixel when he hits an exit tile, it will malfunction and Mario will end up right back at the same location" | `CODE_049A85` (loop ends without a match); `ov_overworld_exitstar_link.htm`; `Lunar Magic.exe` string "If any of your overworld paths are even slightly misaligned, an exit tile will malfunction and return you to the same screen." |

### Where the clean game and the hacks use them

Read with `readL1`/`readLinks` on `editorImage()`, the neighbours' kinds from `pathKinds`:

| Cell | Tile | Path next to it | Link |
|---|---|---|---|
| main 02,14 / YI 04,00 | 40 / 40 | climb above / below | the Yoshi's Island ladder |
| main 05,15 / YI 09,00 | 4D / 4D | walk above / below | the second Yoshi's Island exit; event 06 writes 25 over main 05,15 (a layer 1 change at loc `0x255`) |
| main 0D,09 / VD 05,14 | 83 (a stop) / 48 | walk below / above | Vanilla Dome; the reveal list turns 83 into **45** (pair `83→45`) |
| main 0E,15 / VoB 1E,09 | 4D / 47 | swim below / walk above | Valley of Bowser |
| main 1C,0A / FoI 08,15 | 4D / 4D | walk above / below | Forest of Illusion |
| main 1C,10 / FoI 08,1F | 4D / 4D | walk below / above | Forest of Illusion |
| main 19,10 / FoI 00,1E | **42** / **42** | walk left / right | Forest of Illusion, the only horizontal one |

The reveal list also holds `4D→25`, `52→44` and `53→43` (`readRevealList`; the pairs for 52–54 the game doesn't use,
`src/core/overworld.ts:618-620`). 43, 44 and 46 are on no map of the clean game.

In every placement the tile's axis matches the path into it. The same holds in the two hacks whose maps could be read
(`readL1` on the unpatched ROM, so a hint only): Journey to Kaizo uses 43 ×7 (+143 ×1) on vertical paths and 42 ×2 on
horizontal ones; Nemesis 42 ×2 horizontal, 43, 45, 46, 48 vertical. `readL1` found no exit tile on Super Luigi Land 2
(not checked further). Hack authors evidently know the convention; nothing in either editor tells it.

## 2. How they differ

### The axis: the exit tile's vector is applied after the warp

After a match, `CODE_049616` branches to `CODE_049648`; every tile below 56 then goes to `CODE_04971D`, which adds the
tile's vector (`DATA_049EA7`, its signs per direction from `DATA_049F49`) to `OWPlayerXPos`/`YPos` and stores the
result as the target `OverworldDestXPos`. `CODE_049A24` has already moved `OWPlayerXPos`/`YPos` to the destination,
so **the exit tile's vector decides where Mario walks from the destination**.

The tables (identical in all four fixture ROMs):

| Tile | `DATA_049EA7` (x, y) | `DATA_049F49` | Pose `DATA_049FEB` |
|---|---|---|---|
| 25, 43, 44, 45, 46, 47, 48, 4D | 0, +16 | 01 00 (negated going up or left) | 00 |
| 40 | 0, +16 | 01 00 | **14** (climb: `CMP #$0014` sets `OverworldClimbing`) |
| 42 | **+16, 0** | 01 00 | 04 |

The sign rule (`CODE_04974A`: index 0 for up/left, 1 for down/right) gives, for a vertical exit tile, **up when
going up or left, down when going down or right**; for 42, **left when going up or left, right when going down or
right**. The editor's learned shapes say the same (`pathShapes` on the clean game, "walk" vectors up/down/left/right):
`0,-16 | 0,16 | 0,-16 | 0,16` for the nine, `-16,0 | 16,0 | -16,0 | 16,0` for 42. Pose 04 on 42 is the value the
horizontal walk tiles (01–07, …) have; that it means "sideways" is an inference from the table, not traced.

**Emulated** (the clean game's Forest of Illusion link main 19,10, path on the left; and the ladder main 02,14, path
above; the link's tile replaced, Mario started on a stop two cells away with a straight walk tile between, walked
until he stood again):

| Exit tile at main 19,10 (Mario walks right onto it) | First steps on Forest of Illusion | Stands at |
|---|---|---|
| 42 (the game's), 142 | `0,1E8 → 1,1E8 → 2,1E8` (right) | `48,1C8`, tile 4,1C |
| 25, 40, 43, 44, 47, 4D | `0,1E8 → 0,1E9 → 0,1EA` (down) | `38,1D8`, tile 4,1C – the pixel position on tile 3,1D |

| Exit tile at main 02,14 (Mario walks down onto it) | First steps on Yoshi's Island | Stands at |
|---|---|---|
| 40 (the game's), 25, 43, 44, 47, 4D | `48,0 → 48,1 → 48,2` (down) | `38,88`, tile 3,8 |
| 42 | `48,0 → 49,0 → 4A,0` (right) | `48,78`, tile 3,8 – the pixel position on tile 4,7 |

So the wrong axis doesn't stop the warp; it leaves Mario walking off the path and standing with a position that
disagrees with his tile – the "erratic" movement Lunar Magic's help warns about. Lunar Magic's link help says "the
player will still be moving in the same direction after they go through the warp" (`ov_overworld_exitstar_link.htm`):
true only for a tile of the path's axis.

### The target's side doesn't steer him

Emulated the same way: the ladder main 02,14 linked one-way (`makeLink`) to Yoshi's Island 04,00 with each target
side. Mario always walks **down** after the warp (the source tile's vector); only where he appears changes. With the
side the game uses (path below the target) he stands at `38,88`; with the others at `38,98`, `40,90`, `30,90` – all
off his tile. The target side must be the opposite of the source side; any other choice breaks the link.

### 4D's first step

`DATA_04A03C` lists 24 tiles whose first step off a stop tile is a vector of its own (`CODE_049384`/`CODE_04938E`,
offsets `DATA_04A084`/`DATA_04A086`, `DATA_04A0E4`); 4D is its entry 0x16 – the only exit tile in it. The learned
shapes ("first" vectors): `0,-8 | 0,8 | -8,0 | 8,0` for the other nine, `4,-8` in **all four directions** for 4D.
Emulated: Mario standing on a stop next to 4D (main 19,10 walking right, main 05,15 walking down) steps to `+4,−8`,
the transition starts (`OverworldProcess` 0A) but no entry matches his position, and he walks back to the stop. With
a path tile between the stop and 4D the warp works (table above). Up and left were not emulated; the learned vector
(`+4,−8`, never the tile's edge on the axis) says they fail too. In the clean game no exit tile is next to a stop or
level tile (the neighbour table above).

## 3. What the editor shows and assumes today

| What | Where |
|---|---|
| One kind for all ten: `exit: 'Path: exit to another submap'` | `src/core/owpaths.ts:23-26` |
| The popup in the layer 1 sheet: the kind's name; ways only for walk, climb, swim | `src/core/owl1sheet.ts:71` ff., `src/core/owpathshape.ts:8` (`SHAPED_KINDS`), `:89` ff. (`pathTileText`) |
| The mark: a red square (`exit: ['235,60,60', 0.8]`), no ways; in the sheet a tile without pixels gets the mark, one with pixels a red border | `src/ui/overworld.ts:2284-2318` (`drawPathMark`), `:2066-2069` |
| The learned shapes **do** hold the exit tiles' vectors, though the comment says NO_SHAPE for an exit | `src/core/owpaths.ts:113-115` and the run above |
| The path search: onto an exit tile, the entry is looked up at the tile's centre minus half a tile, not at where Mario's step ended; after the warp his direction is the one from the entry's destination toward its tile – not the exit tile's vector | `src/core/owreach.ts:109-118`, `:219-224` |
| A link's ends: the side the editor proposes is toward a path tile beside it (`pathSide`); the links panel lets each end's side be chosen freely and says "Mario comes out *opposite side* of the target, walking on" | `src/core/owlinks.ts:221-230`, `src/ui/owlinkview.ts:100-104`, `:360-371` |
| An exit is refused inside a route and kept at its end; the route brush never places one | `src/core/owroute.ts:110-116`, `src/core/owrefusal.ts:111` |

So a vertical exit tile at the end of a horizontal path, 4D right next to a level tile, or a link whose target side
isn't opposite to its source side all pass the World check as working, and the game breaks.

## 4. Other tools

| Tool | What it shows | Source |
|---|---|---|
| Lunar Magic, "Layer 1 Mario Paths" | the same red image for every exit tile ("red tiles are used to mark 'exit tiles'"); its path images are per tile number and can be replaced per ROM (`.ovpathbmp`/`.ovpathtxt`) – editor only | `ov_view_layer1_paths.htm`, `info_custom_ov_path.htm` |
| Lunar Magic, the 16x16 tile selector | "Most of the tiles will appear blank" unless the path view is on | `ov_editor_16x16.htm` |
| Lunar Magic, link dialog | asks "Side to enter FIRST tile from:" (strings in `Lunar Magic.exe`); the help: the player "will still be moving in the same direction after they go through the warp" | `ov_overworld_exitstar_link.htm` |
| Lunar Magic, "Show Exit Path Numbers" | the table index and the index it leads to; a red number for a one-way target or "the direction to enter from on this tile is mismatched with the other one" | `ov_view_exitpath_number.htm` |
| Lunar Magic, tooltips per tile (`.dsc`) | for level Map16 tiles only, not the overworld | `info_custom_tooltip_map16.htm` |

Lunar Magic thus shows *that* a tile is an exit, and flags a mismatched side only through the numbers view; nothing
tells the tiles' axes or 4D's first step. **Not found:** another SMW overworld editor with primary documentation of
this (BOWSIE and OverworldTables deal with sprites and tables, not path tiles); SMW Central's tile documentation was
not fetched.

## 5. Options for Solar Magic

Each in the editor's vocabulary (CONTEXT.md "Path shape" – a tile's **ways**, not "tile direction"; "Overworld
link"; ADR 0011/0012), and each derived from what is learned by emulation (kinds, "walk" and "first" vectors), not
from the tile numbers above – a hack may change them (the earlier note found Kaizo hooking `$049799` inside
`CODE_04971D`).

**A. Show the exit's way in the mark and in words.** Draw a line through the red mark along the axis of the exit
tile's "walk" vectors (vertical for nine, horizontal for 42), as walk tiles show their ways; in the popup and the
status bar: "Path: exit to another submap · from above or below (Mario comes out going on that way)" / "· from the
left or right". Add a line where the "first" vector misses the exit ("Not next to a stop or level tile: Mario's first
step off it misses the exit" – 4D) and where the pose is a climb ("climbed onto" – 40). Cheap: the data is there
(`pathShapes`), `pathWays` needs an exit case (the "way back" test doesn't apply: the vector acts on the other map).
Answers "which one" directly where the user picks – the sheet – and on the map with the "Path tiles" overlay.

**B. Group the exit tiles in the picker**, as ADR 0012 did for level tiles ("Levels" with its looks): a section
"Exits" with the tiles grouped by way (↕, ↔) and the caveats. Clear, but the exit tiles are ordinary brush tiles
(painted, picked; ADR 0011), and their looks differ (25, 43–45 have graphics of their own; 40 and 4D share one Map16
entry, 42 shares walk tile 04's), so a group duplicates the sheet. Worth it only if A proves not enough.

**C. World check: warn where the tile doesn't fit.** Model the game in the path search (owreach.ts): look the entry
up at Mario's real position after his step (the first vector from a stop), and after the warp move him by the exit
tile's "walk" vector as the game does. Then the existing groups catch the failures: "exit path tile at … leads
nowhere" for 4D beside a stop, and a new **Paths** warning "Mario comes out of the exit at … walking down, off the
path (the exit tile is vertical, the path into it horizontal)" with Show and a **Fix** (the tile of the other axis
that the editor already has, e.g. the map's own 42 for a horizontal path). This is the safety net for maps already
made or imported (owimport.ts).

**D. Derive a link's target side, don't ask it.** The game never reads it apart from the position; only the opposite
of the source's side works. In the links mode, set the target side from the source side (both ways: each end's from
the other's), drop or disable the "Path at" select for the target, and say in the panel which way Mario comes out
(from the source tile's vector: "Mario comes out above Yoshi's Island 04,00, walking down"). Where the ROM already
has a mismatched pair (a Lunar Magic ROM), show it as the World check's warning from C.

**E. Show the way after the warp on the map.** In the links mode, extend the exit link's arrow with a short arrow at
the target in the direction Mario walks on (from the source tile's vector), red where it leaves the path. Nice, but
the information is C's and D's.

**F. Refuse painting an exit tile across a path.** Rejected: a brush paints what it holds (ADR 0011), the path may
be drawn after the exit tile, and the World check is where "may be fine" is said.

## Recommendation (opinion, not a source)

Do **A** first, with **C** and **D**:

1. **A** makes the difference visible where the user chooses – the layer 1 sheet's mark and popup and the "Path tiles"
   overlay – in the existing "ways" language, from learned data. It answers the question for the one difference
   that matters in practice (the axis) and names the two special cases in a line each.
2. **C** makes the World check tell the truth: today it reports a broken exit as working. The change belongs in
   owreach.ts (two places, `:109-118`), and the warnings follow from it.
3. **D** removes a choice with one right answer, and fixes the hint, which now promises a direction the game doesn't
   take when the sides disagree.

B and E can wait; F should not be done. CONTEXT.md would need a line under "Path shape" (an exit tile's way: the axis
Mario walks on after the warp) and under "Overworld link" (the target's side follows the source's), and the comment
at `src/core/owpaths.ts:113-115` corrected (exit tiles do get vectors).

## Unverified / open

- Why 4D is in the first-step list `DATA_04A03C`. No clean-game exit tile is next to a stop or level tile, so the
  quirk shows only in user maps; whether Nintendo meant something by it is not known.
- Up and left onto 4D off a stop were not emulated (inferred from the learned `+4,−8`).
- Whether pose 04 means "sideways" (inferred from the horizontal walk tiles sharing it) and what 40's climb pose
  looks like in play (not looked at).
- The Map16 looks of the ten tiles in a submap's graphics: 40 and 4D share one Map16 entry, 42 shares walk tile 04's,
  25/43/44/45/46–48 have their own (`owTileWords`); whether each draws pixels on every submap was not checked.
- Which event reveals main 0D,09 (83 → 45), and why event 06 replaces 4D with 25 at main 05,15 (the same behaviour,
  another look) – not traced.
- Super Luigi Land 2: no exit tile found by `readL1`; not checked whether that is real or a read problem.
- Whether a hack changing `CODE_04971D` (Kaizo's hook at `$049799`) changes the exit vectors: the editor learns them
  by emulation, so A and C would follow; not checked on Kaizo.
