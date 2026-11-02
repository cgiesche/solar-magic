# Lunar Magic's submap graphics

Research note, 2026-11-01 (issue #83). The question: how does Lunar Magic store a submap's own graphics – its
palettes, graphics files, layer 3 and animations – so that the editor writes the same layout (ADR 0005)? Its help
(`ov_editor_palette.htm`, `ov_overworld_super_bypass.htm`, `ov_overworld_layer3_gfx.htm`, `ov_overworld_ex20*.htm`)
describes the dialogs, not the layout.

## Method

1. **ROMs Lunar Magic saved**, read in the tools only (the editor refuses them, ADR 0004): *QW2* (2.53), *celery*
   (3.40), *Bluerio's Adventure*. `tools/dis.ts` disassembles their hooks (`ROM=… node tools/dis.ts <address>`).
2. **SMW Central's hijack map** (`resources_local/hijack-list.csv`) for the places Lunar Magic changes.
3. **The game's code**, in the clean ROM, and **emulation** (`tools/testsubmapgfx.ts`).

## Palettes

The game builds the overworld's colors at `$00AD25` (called while the overworld loads, `$00A14D`, and through
`$00A594` when Mario walks to another submap, `$04DBAE`): shared tables from `$00B3D8` (after the special world
`$00B732`, when `LDA $1EEA` in 16 bit is negative – bit 7 of `$1EEB`, translevel 49's passed flag), a BG palette
per submap from `$00ABDF`.

Lunar Magic replaces everything from `$00AD32` on with `JSL routine : RTS`. The routine is the same in *celery* and
*Bluerio's Adventure* apart from where its table is (*QW2* jumps to another address, its code not compared):

```
TAX                               ; A = $1EEA (16 bit): its sign, the special world passed
LDA $1931 : AND #$000F : DEC : CLC ; the submap: the overworld's tileset $1931 is $11–$17
TXY : BPL + : ADC #$0007          ; after the special world: palettes 7–13
+ XBA : ASL : ADC #table          ; × $200, the table's low 16 bits
TAX : LDY #$0703 : LDA #$01FF
PHB : MVN $00,bank : PLB          ; 0x200 bytes to the palette buffer
SEP #$30 : RTL
```

| Place | Contents |
|---|---|
| `$00AD32` | `JSL routine`, `RTS` (5 bytes) |
| routine `+$12` | the table's low 16 bits (the ADC's operand) |
| routine `+$1E` | the table's bank (the MVN's source bank) |
| table | 14 × 0x200 bytes: submaps 0–6, then 0–6 after the special world; 256 colors each, color 0 the back area color |

The editor installs the routine byte for byte, its table in free space. Its colors are the game's: the editor runs
the overworld's load on each submap (as after loading a save, before and after the special world) and takes the
0x200 bytes of `$0703` when the game's routine returns. Colors the routine doesn't write (layer 3's, most of the
sprites') are those the game had there then; the patched game shows the same colors as the clean game on every
submap, and the 22 bytes the game rewrites after the load (Mario, the level tiles' blinking, the lightning) are the
game's as before.

## Graphics files

Lunar Magic's "Submap GFX" loads its own files for FG1–FG4 (FG5/FG6 with its option to merge FG1/FG2 into
SP3/SP4), SP1–SP4 and AN2. Its hooks: `$00A140` (`JSL $0FFAB0`, which points its ExGFX routines at a 32-byte list of
the submap's files: `$7FC006` = table + submap × $20) before the overworld's load uploads the files (`$00A144 JSR
$A9DA`), and `$04DBB9` (`JSL $0FFB20`, 6 bytes, the game's `STA $0704 : STZ $0803`) where Mario walks to another
submap: the game sets the tileset `$1931` (`$04DC02` per submap) and loads the palette there, not the graphics; Lunar
Magic's routine turns NMI off (`STZ $4200`) and uploads the new files at once.

In the game every submap's tileset (`$11–$17`) has the same files (1C 1D 08 1E), the sprite set is `$11` (`LDA #$11 :
STA $192B` at `$04DC1C`): walking to another submap needs no upload.

The editor keeps the files in its own bypass (SMWE: levels' and submaps' lists differ from Lunar Magic's anyway) and
takes Lunar Magic's place at `$04DBB9`: its code turns the screen off (the window has closed over it there) and NMI,
runs the game's upload routine `$00A9DA` – which reads the submap's files and uploads only those that changed – and
turns them on again.

### FG5/FG6 and AN2

Decision for issue #263, after #283 kept the editor's bypass: the editor offers neither.

- **FG5/FG6** come in Lunar Magic only with its option to merge FG1/FG2 into SP3/SP4 (an Extra Option, not among those #86 made editor patches). The
  game's overworld has no files there (every submap's tileset has 1C 1D 08 1E, its sprite set `$11`), and no community
  content at hand uses the merge (the packages and baseroms in "The editor's bypass instead of Lunar Magic's lists"
  below). They come when content that asks for them turns up; were the submaps' files ever to move to Lunar Magic's
  lists, they would come with that layout.
- **AN2** is in Lunar Magic the 4 KB file an animation list's slots take frames from in RAM (in a level at `$7EAD00`,
  `src/core/exanim.ts`; where it goes on the overworld is not checked, a decision not to offer it needs no more). The editor's
  animations take their frames only from the Anim graphics (ADR 0003, which removed the levels' AN2), and a submap's
  animation list has an Anim graphic of its own as a level's has: an AN2 per submap would bring back the second source ADR 0003
  removed, for no source of submap frames (the editor opens only the clean game and its own ROMs, and nothing it imports
  brings a submap's animations). Should an import ever bring one, the frames its slots take from AN2 are copied into
  the submap's Anim graphic, as a level's are.

### The editor's bypass instead of Lunar Magic's lists

Research for issue #283: does the editor's own bypass break ADR 0005 – does a tool or community content read Lunar
Magic's list?

What the ROMs Lunar Magic saved hold (*QW2*, *celery*, *Bluerio's Adventure*, *Journey to Kaizo*): the same routine at
`$0FFAB0` in all four, called with the player's submap × 2 in X (`$1F11` doubled at `$00A12D`), in 16 bit `STA $20 :
TXA : ASL #4 : CLC : ADC #table : STA $7FC006` (table + submap × `$20`), then the table's bank to `$7FC008`, `$42` to
`$7FC009`, 0 to `$7FC00B`, `RTL`. Only the table's place differs: `$12ED08` in *QW2*, `$12F8A8` in *Bluerio's
Adventure*, `$C1ED00` in *celery* and *Journey to Kaizo*. A submap's list is 16 file numbers as words; the game's
layer 3 files `2B 2A 29 28` (LG4–LG1) come last in every list. Where a submap keeps the overworld's files, `1E 08 1D
1C` (FG4–FG1) are in words 4–7 in *QW2*, in words 6–9 in *celery*'s submaps 2–6.

Who reads it: a scan of all four ROMs for the long-addressed opcodes (`$xF`) on `$7FC006`–`$7FC008`, and for the
absolute ones on `$C006`–`$C008` (with the data bank `$7F`); indirect accesses (`[dp]`) are not covered.

- In *QW2*, *celery* and *Bluerio's Adventure* every long access is in Lunar Magic's own code in bank `$0F`
  (`$0FF808`–`$0FFDA8`): its ExGFX routines, which levels and the overworld share, take their list from that pointer.
  The absolute hits lie in data, not code.
- *Journey to Kaizo* has one reader more: a patch hooked at `$00A9DF` (`JML $CFFCF2`, inside the game's graphics
  upload `$00A9DA`; not in the hijack map, its RATS block at `$4FFCEA`), which, while the Retry System respawns
  (`$7FB405`, Retry's `is_respawning`) into the same level (`$010B` against its own `$7FB600`), reads the list from
  `$7FC006` and `$7FC009` and takes its own way through the upload (back at `$00AA54`). It reads a level's list: the overworld isn't its
  case. Neither the Retry System 2.2.0 at hand nor any other package at hand contains it. In the editor's ROMs a level's
  files are in its own bypass (SMWE, `src/core/patches.ts`) too, so such a patch finds no list in a level either,
  whatever the submaps do: a question for the levels' bypass (#309), not for the overworld's.
- The hijack map names nothing else at `$0FFAB0` or `$7FC006`. None of the community code at hand reads the list or
  the pointer: BOWSIE (1.21), AddmusicK, the RHR baserom (its patches, UberASM code and documentation; it names Lunar
  Magic's "GFX Bypass" windows only as a UI), No Overworld, the Retry System, VWF dialogues and the blocks and sprites
  in `resources_local` and `test/fixtures`.

So the bypass stays: nothing but Lunar Magic's own ExGFX routines reads a submap's list, and writing the list would
mean writing those routines as well, for no other reader. ADR 0005 records it among its considered options. Should a
tool or community content turn up that reads a submap's list (or its pointer at `$7FC006`–`$7FC008` on the
overworld), the submap's files move there byte for byte, confirmed with a ROM Lunar Magic saved.

## Layer 3

Lunar Magic's help: layer 3's files (LG1–LG4) and a tilemap file (LT3, destination "Start of layer 3", 0x800 bytes for
256x256) per submap; "using an exit tile during the game will not reload the layer 3 tilemap, but the layer 3
graphics will reload". The hijack map names `$00A153` (the overworld's load: `LDA #$06 : STA $12`, the border's
stripe image) as the place Lunar Magic skips the border when a submap has an LT3 file.

The editor keeps them in its layer 3 table (SMWL, entries 200–206 after the levels'): its graphics upload, which the
overworld's load and the editor's code at `$04DBB9` run, takes the submap's LG files; a JSL at `$00A153` copies the
LT3 file instead of setting the border's stripe image. The level name's stripe (`$508B`) and the lives are written
over the file as over the border.

## Animations

Research for issue #244. Lunar Magic's overworld ExAnimation (help `ov_overworld_ex20.htm`, `_global.htm`,
`_settings.htm`) hooks three places with `JSL routine : RTS`: `$048086` (the overworld's load sets up the game's
animated tiles there; game mode `$0C`, the screen off, data bank `$04`), `$0480E0` (each frame, where the game animates
them) and `$00A4E3` (the NMI's upload of the game's tiles from `$0AF6` and the level dots' colors 6D/7D). It also
makes the game's tile animation count with `$14` instead of `$13` (`$048102`, `$04810D`, `$04813B`, and its frame hook
reads `$14` where the game's `LDA $13` was): see "The frame counter" below. *celery*, *Bluerio's Adventure* and *Journey to Kaizo* have the same code at different places; its tables are
operands at fixed offsets from the first hook's target (the same in all three):

| Place | Contents |
|---|---|
| target `+$4A` | the address of 7 settings bytes, one per submap (`LDA long,x`; a RATS block of its own) |
| target `+$57` | the overworld's global list's address >> 8 (`LDA #`; 0: none) |
| target `+$61` | its low word (`LDA #`) |
| target `+$D6` | the submaps' list table's address plus one |
| target `+$E1` | the address of 7 3-byte pointers to the submaps' lists (`$0000FF`: none; a RATS block of its own) |

The lists are a level's (the editor's parser reads the 7 lists of *Bluerio's Adventure* and *Journey to Kaizo*), but
for the triggers: the jump table at `$C0C27B` in *celery* sends 01–08 to code that takes the event number from manual
frame 8–F (`$7FC078`+) and holds while that event's bit in `$1F02` is set (the first event the high bit) – Lunar
Magic's "Event Manual 8–F". The slot code takes the second frame set for every trigger that holds, so on the
overworld 06 and 08 have one too. Color animations write the palette `$0703` (no fading copy), the RAM and the frame
counters are the level's (`$7FC070`, `$7FC080`, `$7FC0A0`, `$7FC0F8`, `$7FC0FC`); the settings byte of the submap is
kept at `$7FC00A`. Its bits, as the code reads them: `$80` the level dots' colors (the NMI), `$40` the game's
animated tiles, `$20` the submap's list, `$10` the global list – each off when set. The help's lightning switch
(color 47) is none of these bits: see "The lightning switch" below. At the load Lunar Magic runs the lists eight times, `$14` from 0 to 7, with their uploads.

The editor's engine (Kobo's, `src/core/kobo/exanimation.ts`) runs the overworld's lists on the same code as a level's,
from its own hooks at those places, with its tables at Lunar Magic's offsets.

### The frame counter

Research for issue #253. On the overworld the game counts both `$13` (every frame, `$008070`) and `$14` (each frame of
game mode `$0E`, `$00A1C1`), so the two differ in phase only. Lunar Magic's lists run by `$14` (slots k, k+8, … at
`$14` mod 8 = k, the load's eight frames `$14` 0–7) and the game's tiles with them, so a list that adds frames to the
game's own animated tiles keeps step with them. The editor does the same (the three operands, its frame hook reading
`$14`); `tools/testowexanim.ts` checks the overworld without lists frame by frame against the clean game with those
bytes changed.

### Walking to another submap

Research for issue #253. Lunar Magic sets the lists up in its load hook only (`$048086`, which the game reaches from
the overworld's load alone, `JSR $8086` at `$048EEB`): its frame hook never reads the submap, its routine at
`$04DBB9` (the submap's graphics) doesn't call it. Emulated in *Journey to Kaizo* (lists on submaps 0 and 5): after
`$1F11` changes the list pointer it set up (`$7FC000`–`$7FC002`) and the settings (`$7FC00A`) stay those of the
submap the overworld loaded on (`tools/lmowsubmap.ts`). So in Lunar Magic the lists of the submap Mario left keep running on the new one until
the overworld loads again (a level entered and left).

The editor sets the new submap's lists up there instead: its own code at `$04DBB9` (`src/core/submapgfx.ts`), where the
game has loaded the new submap's palette and the window has closed, runs the load's hook again after the graphics
upload, the screen still off – the game's animated tiles from their start (also when the submap left had them off and
they were never set up), the lists set up and run eight frames with their uploads, as at the load. In the walk from the
main map to Yoshi's Island `$1F11` changes 9 frames before that (the window closing); the lists of the main map run on
until then. Unlike the game, the walk so starts the game's animated tiles from their start (their phase, behind the
closed window).

### Event Manual 8–F at the load

Research for issue #261. On the overworld the manual frames 8–F hold the events of triggers 01–08, and Lunar Magic's
load sets only those a list's Trigger Init names: `tools/lmowmanual.ts` sets every manual frame to `$A0`+n (as a level
might leave them) and loads the overworld again on each submap, in *Journey to Kaizo* and *Bluerio's Adventure* (whose
lists set no manual frame) and with each submap's list given a Trigger Init of Manual 8 = 01 alone. Lunar Magic's code
writes Manual 8 then (`$C28106` in *Journey to Kaizo*, `$CFA4C5` in *Bluerio's Adventure*), and nothing else: Manual
9–F keep `$A9`–`$AF`, and without a Trigger Init all of them keep the last level's. So in Lunar Magic an event trigger
whose manual frame the Trigger Init leaves out waits for whatever event number the level played before left there
(in a new game `$00`, event 00).

The editor does better: its load (`ow_setup`, also when Mario walks to another submap) sets Manual 8–F to `$FF` before
the Trigger Init, and its event code takes `$78`–`$FF` for no event, so such a trigger never holds, whatever was played
before; Manual 0–7 keep what was left, as in Lunar Magic. A level entered from the overworld finds `$FF` in Manual 8–F
where its own Trigger Init sets nothing (the engine's "nothing shown yet": a manual trigger 18–1F shows no frame until
code sets one). Since 18–1F read the bytes of 01–08's events on the overworld, the Animations tab warns when an overworld
list (the submap's or the global one) uses a manual trigger 18–1F and the event trigger of the same byte.

### `$7FC00B`

Research for issue #253. The engine keeps the submap the lists were set up for at `$7FC00B` (`$FF` in a level), next to
Lunar Magic's `$7FC00A`. Lunar Magic doesn't leave it free: its overworld graphics routine (`$0FFAB0`, from `$00A140`)
writes 0 there, and its level load keeps the level's layer 2 tilemap settings there (`$0EF510`, from the table at
`$0EF310`; hijack map), which its graphics code reads (`$0FF7D2`: bit 0, `$0EFD09`: bit 2). Emulating *Journey to
Kaizo* through the overworld and a level, Lunar Magic reads and writes all of `$7FC000`–`$7FC01C` but `$7FC005` (the
engine's `$7FC019`/`$7FC01A` among them). None of the community packages at hand (BOWSIE, No Overworld, the Retry
System, the blocks and sprites in `resources_local`) uses `$7FC00A`/`$7FC00B`.

The editor first kept it there: its ROMs run none of Lunar Magic's code that reads it. Issue #265 moved the engine's
own bytes instead, so that it no longer depends on that: `!LastFrame`, `!OwSubmap` and `!QueueEnd` (16-bit) are at
`$7FC05C`–`$7FC05F` now, the top of the gap below the conditional Direct Map16 flags (`$7FC060`).

The evidence, from `tools/lmramprobe.ts` (each ROM booted with the sound unit, a new game to the overworld, each submap
loaded and run 60 frames, then every level `000`–`1FF` loaded and played 120 frames, right held, jumping), which
records every read and write of `$7FC000`–`$7FC0FF` (no level failed to load in any of them):

| ROM | Lunar Magic | `$7FC000`–`$7FC05F` touched |
|---|---|---|
| *QW2* | 2.53 | `$7FC000`–`$7FC004`, `$7FC006`–`$7FC012`, `$7FC016`–`$7FC01A` |
| *Bluerio's Adventure* | 3.31 | `$7FC000`–`$7FC004`, `$7FC006`–`$7FC01C` |
| *celery* (no overworld: its new game goes into a level) | 3.40 | `$7FC000`–`$7FC004`, `$7FC006`–`$7FC01C` |
| *Journey to Kaizo* | 3.40 | `$7FC000`–`$7FC004`, `$7FC006`–`$7FC01C` |
| the clean game saved by Lunar Magic 3.71 under wine (its command line: expanded to 4 MB, *Bluerio's Adventure*'s graphics, ExGFX, Map16, shared palette, overworld, global animation and 177 levels imported) | 3.71 | `$7FC000`–`$7FC004`, `$7FC006`–`$7FC01C` |

In all five `$7FC005` and `$7FC01D`–`$7FC05F` stay untouched; above them only what Lunar Magic's help documents
(`edit_cdm16.htm`, `level_ex20.htm`: `$7FC060` on), which content sets. Lunar Magic's help names nothing in
`$7FC005`–`$7FC05F`. Lunar Magic's own use grew from the low end (2.53 up to `$7FC01A`, 3.31 on up to `$7FC01C`), so
the engine's bytes are at the gap's top, away from it. Community code ran only as far as these ROMs contain it (their own patches); besides, none of the packages at hand (the archives in
`resources_local` and `test/fixtures`, the RHR baserom's among them) names any address of `$7FC000`–`$7FC0FF`. The
editor's patch registry still claims `$7FC003`–`$7FC0FF` for the engine (but the shared flags), so packages that
declare their RAM don't get the new bytes either. `tools/testowexanim.ts` checks that the engine writes no other byte
of `$7FC000`–`$7FC05F` than `$7FC003`, `$7FC004`, `$7FC00A` (shared with Lunar Magic, with its meaning) and its own.

### The lightning switch

Research for issue #256. Lunar Magic's "Edit Animation Settings" dialog has the switch "Enable original game's
lightning palette animation" per submap. Lunar Magic 3.71 saved the clean game's overworld (`test/fixtures/smw.smc`)
with it changed, from its UI under wine (how: [lunar-magic-overworld-options.md](lunar-magic-overworld-options.md),
"Making the ROMs"; the dialog is Overworld → "Edit Animation Settings...", the menu's fifth item, with the submap in
combo box 107 and the switch in checkbox 105). The dialog shows it on for the Valley of Bowser alone in the clean game.

Each save differs from the one before only in `$04F709` and in Lunar Magic's checksum make-up bytes (`$0FF093`–`$0FF094`,
as `$0FF025` for the "Extra Options"):

| The lightning on | `$04F709` |
|---|---|
| the Valley of Bowser (the clean game, saved as it was) | `F7` |
| none (the Valley of Bowser's turned off) | `FF` |
| the main map | `7F` |
| the main map and the Valley of Bowser | `77` |
| the main map, the Valley of Bowser and Star Road | `75` |

`$04F709` is the operand of the game's own `LDA #$F7 : JSR $F882 : BNE $F76E` at `$04F708`, the start of its lightning
code: `$04F882` gives non-zero (and the code skips the lightning) when the mask has the player's submap's bit, from the
game's table at `$04F875` (`80 40 20 10 08 04 02`, the main map to Star Road). So the switch is a mask of the submaps the
lightning is off on, kept in the game's code, and works without ExAnimation; the settings bytes (target `+$4A`) stayed
the same. *Journey to Kaizo* has `7D` there (the lightning on the main map and Star Road).

The editor writes that byte the same way (`submapLightning`/`setSubmapLightning` in `src/core/owoptions.ts`, an overworld option (#267), each submap's bit read
from the game's table as its check does; BOWSIE's code from `$04F76E` leaves the table alone, checked with BOWSIE installed) and keeps no bit of its own;
`tools/testowoptions.ts` checks the bytes and the lightning by emulation.
