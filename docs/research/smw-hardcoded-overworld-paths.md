# SMW's hardcoded overworld paths: Lunar Magic, SMW Central, the editor

Research note, 2026-11-10. The question: how do Lunar Magic and the SMW community deal with the game's hardcoded
overworld paths (the tables at `$049078` ff.)? Does Lunar Magic show, edit or disable them; which patches exist; what do
hackers do with them; and what follows for an editor that wants to be at least as good as Lunar Magic here?

What the repo already knows (not re-derived here): the game's 10 entries (5 two-way paths), read in
`src/core/owreach.ts` (`hardPaths`), drawn on the map (`hardPathCells`, `src/ui/overworld.ts`), and the Lunar Magic
option that turns them off (`src/core/owoptions.ts`, confirmed with ROMs Lunar Magic 3.71 saved in
[lunar-magic-overworld-options.md](lunar-magic-overworld-options.md)). The German note
[lunar-magic-overworld-paths-and-links.md](lunar-magic-overworld-paths-and-links.md) already quotes Lunar Magic's help
("Currently LM does not support displaying or editing these") and lists Journey to Kaizo's hooks at `$049313`,
`$04952E`, `$0495C4`, `$049799` as "patch unknown". This note identifies that patch (section 3).

Sources:

- Lunar Magic 3.71: `readme.txt` and `Lunar Magic.chm` from `https://fusoya.eludevisibility.org/lm/download/lm371.zip`
  (local copies `~/Downloads/lm371.zip`, `~/tools/lunarmagic/Lunar Magic.chm`, unpacked with 7-Zip; help pages named
  by file).
- SMWDisX, `https://github.com/IsoFrieze/SMWDisX/blob/master/bank_04.asm` and `rammap.asm` (labels).
- SMW Central's ROM and RAM map (`https://www.smwcentral.net/?p=memorymap&game=smw`), entries `$049078`, `$049082`,
  `$049086`, `$0490CA`, `$04910E`, `$7E1B78`, `$7E1B7A`, read once on 2026-11-10.
- SMW Central's hijack map, from the local export `resources_local/hijack-list.csv` (git-ignored), cited as "hijack
  map #id".
- Kevin's patch, local copy `test/fixtures/more_hardcoded_paths.zip` (`README.txt`, `more_hardcoded_paths.asm`,
  `more_hardcoded_paths_tables.asm`), cited as "MHP" with file and label.
- Byte comparisons of `test/fixtures/smw.smc`, `test/fixtures/Super Luigi Land 2.smc`, `test/fixtures/Nemesis.smc` and
  `resources_local/Journey to Kaizo v1.1 (LM rom).smc` (Python, headerless LoROM; scripts in the scratchpad, not in
  the repo), and one emulation run (section 4).
- SMW Central's patch pages and forum threads refuse automated access (copyright/human-verification page; the same
  as in the earlier notes). What is known about them comes **only from search-engine snippets** and is marked so
  ("snippet"). Treat it as unconfirmed wording.

## Result

1. **Lunar Magic can only turn all of them off.** Since 3.11 (2020-02-09) its overworld "Extra Options" have
   "Allow hardcoded default layer 1 paths" (`readme.txt`, 3.11: "added an option to disable all the hardcoded default
   layer 1 paths"). It writes `BRA $04937A` (`80 71`) at `$049307`, its only change in `$049301–$049384` and the
   tables. It does not show or edit them, in any version up to 3.71 (help `ov_view_layer1_paths.htm`). Its help says
   most people can ignore them.
2. **There is one community patch for editing them: Kevin's "Custom Overworld Hardcoded Paths"** (SMW Central patch
   id 35761, v1.1). The local copy calls itself "More Hardcoded Paths". It moves the tables to freespace (up to 128
   paths, per-tile swim/climb/priority overrides) and hooks `$049312`, `$04952D`, `$0495B6`, `$0495C3`, `$049798`
   (and, in v1.1, `$0489AE`, `$048D63`). Journey to Kaizo has this patch (v1.0 hooks) **with an empty level list,
   so its hardcoded paths are off, while the vanilla tables at `$049078` are unchanged and Lunar Magic's option still
   reads "on"**. No dedicated "remover" patch was found; removal is Lunar Magic's option or a hex edit of
   `$049078`.
3. **Practice (from forum snippets, unconfirmed): ignore them or turn them off.** Problems that come up are
   "invisible" paths (DP1–DP2 not on layer 1) and Mario walking where no path is drawn. A common hex tip, "set the
   level to 0", is wrong: emulated here, an entry set to `$00` makes translevel-0 pipes (tile 82) walk that path.
4. **For the editor:** it already does more than Lunar Magic (it draws the paths). Gaps: it ignores the Lunar Magic
   option at `$049307` (Super Luigi Land 2 has it off), it reads the vanilla tables even when Kevin's patch has
   replaced the code (Kaizo), and its lookup differs from the game's for translevel 0 and for a translevel listed
   twice. Details and suggestions are in sections 4 and 5.

## 1. Lunar Magic

### What the help and changelog say (verbatim)

| Statement | Source |
|---|---|
| "You'll probably notice that there are 5 paths in SMW that are not displayed in the editor. These are the hardcoded "default paths" that Mario will follow for certain levels or positions if there is no path already set up on layer 1. They appear to mainly have been created so that you can cross over regular layer 1 paths at a few places … Currently LM does not support displaying or editing these. You can still use them as they are if you want, or you can just ignore them. You can also turn them off in Extra Options." | `ov_view_layer1_paths.htm` |
| "The Allow hardcoded default layer 1 paths option can disable the 5 hardcoded default layer 1 Mario paths … In the original game these connect level 9 with 15 in Donut Plains, level 23 with 1B in Chocolate Island, level 24 with a pipe (by position) in Chocolate Island, level 11F with 120 in Forest of Illusion, and level 10C with 10D in Valley of Bowser. Most of the time you can just ignore them since starting a path with a regular path tile will override them anyway, but if you need to you can turn them all off." | `ov_overworld_extra_options.htm` |
| "If there is no path or level tile beside the level on layer 1 in that direction, and none of the 5 hardcoded default paths connect to this position or use this level number, the player will be unable to move in that direction even if it's enabled." / "In cases where there is a normal path right where a hardcoded path also begins, the game will use the normal path." / Pipe 0x82 "lets the player walk from it to any standard path that connects to it, excluding the default paths." | `ov_overworld_modify_level.htm` |
| Version 3.11 (February 9, 2020): "-added an option to disable all the hardcoded default layer 1 paths to the overworld's "Extra Options" dialog." | `readme.txt` (What's New) |
| Version 3.50: "-added the ability to display custom overworld layer 1 Mario path images, in case someone edits the path data in the ROM. Note that this only affects display in the editor, not the actual game." (per tile; nothing about hardcoded paths) | `readme.txt` |

No other line of `readme.txt` (versions 1.0 to 3.71) mentions hardcoded or default paths (`grep -i "hardcod\|default.*path"`).

### What Lunar Magic changes in the ROM

- **Only `$049307`.** Lunar Magic 3.71 writes `80 71` (`BRA $04937A`, past the whole lookup) instead of the game's
  `A6 08` (`LDX $08`) when the option is off; nothing else differs between its saves
  ([lunar-magic-overworld-options.md](lunar-magic-overworld-options.md)). The hijack map lists `$049307` as "Modified
  by Lunar Magic." (hijack map #8140) and no other Lunar Magic entry in `$049290–$0495E0`.
- The BRA sits **after** `STZ $1B78` / `STZ $1B7A` (`$049301`) and **before** the translevel load and the search loop
  (`LDX #$0009` at `$049312`), so the "is used" flag is still cleared (SMWDisX `CODE_049301`).
- `$049301–$049384` and the tables `$049078–$049117` are byte-identical to the clean game in Nemesis, Super Luigi Land
  2 and Journey to Kaizo except for `$049307` (SLL2: `80 71`) and Kaizo's hooks (section 3). So Lunar Magic's usual
  saves don't touch them.

## 2. The game's routine and tables (for reference)

SMWDisX `bank_04.asm`, `CODE_049301` ff.; SMW Central ROM map.

- **When the lookup runs:** the tile next to Mario in the pressed (or auto) direction is checked first. If it is
  `01–86` (any path, level or stop tile), the normal walk is taken (`CMP #$0056`/`CMP #$0087`, `BCC CODE_0492FE` →
  `CODE_049384`). If it is `00`, `87+` or off the map (`_4` negative or `≥ $0800`), the hardcoded lookup at
  `CODE_049301` runs. This is the source of Lunar Magic's "a regular path tile will override them".
- **Lookup:** the translevel of Mario's tile (`OWLayer1Translevel`, `$7ED000`) is compared with `HardCodedOWPaths`
  (`$049078`, 10 bytes) from index 9 down to 0. `$FF` means "by position": Mario's Y (`$1F19`) = `$049082` (`$0178`),
  X (`$1F17`) = `$049084` (`$0128`), and submap 0 (the main map, tile 12,17). **At the first entry whose translevel
  matches, the direction is checked once (`OWHardCodedDirs` at the path's start); if it differs the search ends
  (`BNE CODE_04937A`), it doesn't go on to lower entries.**
- **Format:** `DATA_04910E` (10 bytes): each entry's start offset into `OWHardCodedTiles` (`$049086`) and
  `OWHardCodedDirs` (`$0490CA`), 68 bytes each (one tile and one direction per step: 0 up, 2 down, 4 left, 6 right).
  The last tile is the level tile where he stops. A step tile `$58` means "use the map's own tile here"
  (`CMP #$0058` / `BNE CODE_0495DE`, else `CODE_0495CE` reads `Map16TilesLow`).
- **While walking:** `$1B78` (`HardcodedPathIsUsed`) = 1, `$1B7A` (`HardcodedPathIndex`) = the step. Each step
  compares Mario's direction with the next direction byte (`$0495B6`: `LDA OWHardCodedDirs,X` … `BNE ADDR_049575`).
  `$1B78` is cleared on arriving (`STZ $1B78` at `$049527`). SMW Central's RAM map: `$7E1B78` "#$0001 means that a
  hard coded path/event is processed", and Lunar Magic reuses both addresses in levels for its "Fix Layer 3 scroll
  sync" option.

Discrepancies in third-party docs (the code above is the reference):

- SMW Central's ROM map calls `$049082` "the 16-bit X and Y position", and `smwspeedruns.com/Overworld_Data_Format`
  says `$049082` is X and `$049084` is Y. The code compares `$049082` with `OWPlayerYPos` and `$049084` with
  `OWPlayerXPos`; Kevin's patch agrees (`ci2_pipe_x_pos: dw $0128`). `owreach.ts` (`HP_Y = 0x049082`) is right.
- SMW Central's ROM map gives `$04910E` 18 bytes; SMWDisX has 10 (`DATA_049118` follows).
- SMW Central's ROM map says an invalid level such as `$FE` disables an entry (true, see section 4).

## 3. SMW Central patches

### Custom Overworld Hardcoded Paths, by Kevin

- **Identity.** The hijack map names it "the Custom Overworld Hardcoded Paths, by Kevin" (#8141, #8143, #8146, #8147,
  #8149). A search snippet gives the patch page `https://www.smwcentral.net/?p=section&a=details&id=35761`, title
  "Custom Overworld Hardcoded Paths v1.1", listed "Added: 29 Jul 2025" (snippet). The local copy's `README.txt` calls
  it "More Hardcoded Paths patch by Kevin" (v1.0 initial, v1.1 "added option to change Mario's priority during a
  path"), files dated 2024-11. Same hooks and code as the hijack map describes, so it is the same patch, probably
  renamed on submission (the name is **unconfirmed** beyond the snippet).
- **What it does** (`README.txt`): "edit/remove vanilla hardcoded paths on the Overworld and add your own". The 5
  vanilla paths come pre-filled and "you can freely edit or remove [them] altogether"; up to 128 paths; one-way
  paths; several paths from one level in different directions; the CI2 pipe's `$FF` "by position" entry kept as an
  option. Asar; SA-1 aware (`sa1rom` branch in `more_hardcoded_paths.asm`).
- **Data format** (`more_hardcoded_paths_tables.asm`): `levels` (2 translevels per entry, `level()` maps `1xx` to
  `xx+$DC`; `$FF` = by position from `ci2_pipe_x_pos`/`_y_pos`/`_submap`), `directions` (the start direction per
  side: `!Up $00`, `!Down $02`, `!Left $04`, `!Right $06`), `paths` (`.XX_1`, `.XX_2`: the layer 1 tiles walked over,
  ending with the destination's level tile; `$58` keeps its vanilla meaning because `$0495C9` is untouched),
  `animation` (per step: `$01` swim, `$02` climb, `+$10` Mario behind layer 1), `offsets` (word offsets made by the
  `%offsets()` macro). **No per-step direction table:** the patch drops the game's direction check per step.
- **Hooks** (`more_hardcoded_paths.asm`; hijack map descriptions in quotes):

  | Address | Change | What |
  |---|---|---|
  | `$049312` | `JML hardcoded_paths_check` (4 bytes, replaces `LDX #$0009`) | the lookup over its own tables, returns to `$04937A` (none) or `$049384` (found); goes on to the next entry on a wrong direction, unlike the game. "expands the original hardcoded path init code to load from expanded tables" (#8141) |
  | `$04952D` | `JML settle_on_level_fix`, back at `$04953E` | sets Mario's tile position mirrors and the level tile under him: "fix level names being sometimes wrong at the end of a hardcoded path" and "issue with destroyed castle tiles" (asm comments; #8143) |
  | `$0495B6` | `BRA $08` | "skips the code which checks for the player's facing direction in the hardcoded path" (#8146) |
  | `$0495C3` | `JSL hardcoded_paths_movement : NOP #2` | next tile from its table; `$1B78` = animation flags (`ROR #3 : INC`: bit 15 climb, bit 14 swim, bit 1 behind layer 1), no longer only 0/1 (#8147) |
  | `$049798` | `JSL hardcoded_paths_animation : NOP` | the forced swim/climb pose (`$1F13`) (#8149) |
  | `$0489AE`, `$048D63` | `JSL`/`JML mario_priority_1/2` | v1.1 only: Mario's sprite priority on `+$10` steps; not in the hijack map export |
- **Compatibility.**
  - *With Lunar Magic's option:* the patch page warns, per a snippet, "Make sure to not disable hardcoded paths in
    Lunar Magic's extra options or it won't work" (snippet). The code agrees: Lunar Magic's `BRA` at `$049307` jumps
    over the hook at `$049312`. The reverse also holds: Lunar Magic's checkbox reads only `$049307`, so a ROM with
    the patch shows "on" whatever the patch's tables say (Kaizo, below).
  - *With Lunar Magic's own hooks:* none overlap. Lunar Magic's nearby ones are `$049307` and `$049549`
    (#8145, level names). Not tested with a Lunar Magic save after patching (**unconfirmed**), but Kaizo is a Lunar
    Magic ROM with both.
  - *With other patches:* `$04945D` (Overworld Speed Changer, by ASMagician Maks, carol and wye, #8142) and `$049542`
    (Custom Overworld Level Names UberASM, by Kevin, #8144) are close but don't overlap. Anything else that hooks
    `$049312–$049315`, `$04952D–$04953D`, `$0495B6–$0495C8` or `$049798–$04979C` conflicts (inference from the
    addresses). Kevin's patch is listed in nsmwhf-team's Overworld Revolution README
    (`https://github.com/nsmwhf-team/OverworldRevolution`, "(Patch) Custom Overworld Hardcoded Paths by Kevin"), and
    the "Donkey Kong Country 2 Navigation Arrows" UberASM supports it and should be reapplied after it (snippet,
    `https://smwcentral.net/?a=details&id=40812&p=section`).
- **In the wild: Journey to Kaizo v1.1** (`resources_local/…`). `$049312` `5C FA DA 90`, `$04952D` `5C 96 DB 90`,
  `$0495B6` `80 08`, `$0495C3` `22 61 DB 90 EA EA`, `$049798` `22 78 DB 90 EA`: Kevin's hooks. The code at `$90DAFA`
  matches `hardcoded_paths_check` byte for byte in structure (`PHB : PHK : PLB : LDX #…`, the `$FF` branch with
  `$0DD6`, `$1F17`, `$1F19`, `$0DB3`, `$1F11`). `$0489AE`/`$048D63` hold other code, so this is v1.0. Its CI2
  position (`28 01 78 01 00 00` at `$90DBCA`) is followed directly by the `paths` data: **`levels` and `directions`
  are empty** (`LDX #$FFFF`). The one pass with X = `$FFFF` reads `$91DBCF` (`$4A`) as translevel and as direction;
  `$4A` is no direction, so nothing matches. So Kaizo used the patch to remove all hardcoded paths, while
  `$049078–$049117` are still the game's and `$049307` still `A6 08`. This resolves the "patch unknown" in
  [lunar-magic-overworld-paths-and-links.md](lunar-magic-overworld-paths-and-links.md) for these four hooks. Its
  `$04945D` (`5C 51 DD 90 EA`, JML : NOP) has the shape of the Overworld Speed Changer's hook (#8142); not checked
  further.

### Removers and other patches

- **No dedicated "no hardcoded paths" patch was found** (web search for "hardcoded path" on smwcentral.net; SMW
  Central's own patch search could not be opened). Removal routes seen:
  - Lunar Magic's option (since 3.11). Forum answers point to it: "Overworld -> Extra Options..." and unchecking
    "Allow hardcoded default Layer 1 paths" (snippet, "Hidden Paths", `https://www.smwcentral.net/?p=viewthread&t=123917`).
  - A hex edit of `$049078`: "replace the entries … with values from $60 to $FE, avoiding $FF" (snippet, "Disable old
    Hardcoded paths", `https://www.smwcentral.net/?p=viewthread&t=92185`); SMW Central's ROM map: "Setting any of
    these levels to an invalid level (e.g. 0xFE) will disable that hardcoded path."
  - Older threads give "set these bytes to 00" (snippets, "Missing paths in SMW overworld",
    `https://www.smwcentral.net/?p=viewthread&t=17385`, and `t=78037`). **This is wrong**; see section 4.
- Overworld Revolution (nsmwhf-team) "will remove all the overworld hijacks LM inserts as of version 3.40" on its
  first application (its README); whether it keeps the hardcoded paths was not checked.

## 4. Practice and problems (forum snippets; opinions marked)

Only search snippets were available; the threads themselves could not be opened.

- **Confusion about invisible paths.** "Missing paths in SMW overworld" (`t=17385`): the DP1–DP2 path is not on the
  tilemap and Lunar Magic can't show it (snippet). "How does Chocolate Island 3's Overworld event work (overlapping
  paths)?" (`https://www.smwcentral.net/?p=viewthread&t=101035`) and "overlapping paths" (`t=78037`) point to
  `$049086`, `$0490CA`, `$04910E` and call editing them "likely difficult" (snippet). "Overworld Path Overlapping"
  (`t=15346`) and "paths crossing." (`t=32873`) are about the same need (titles only).
- **Opinion, Lunar Magic's author:** "Most of the time you can just ignore them" (help, above). **Opinion, a forum
  poster:** a warning against recoding them unless experienced in ASM (snippet).
- **Observation (the repo's hacks):** 1 of 4 Lunar Magic hacks in the repo turned them off with Lunar Magic's option
  (SLL2), 1 removed them with Kevin's patch (Kaizo), 2 left them as in the game (Nemesis, teamshell; byte comparison
  above and in the earlier note). Too few to call this "common practice".
- **When they bite (inference from the code, matching Lunar Magic's help):** only when Mario leaves a tile of a
  listed translevel (09, 15, 23, 1B, 24, 43, 44, 30, 31) in the listed direction and the tile there is `00` or `87+`,
  or leaves main map tile 12,17 (the `$FF` entry) in its listed direction. A from-scratch overworld that reuses one of
  these translevel numbers for a level with no path in that direction makes Mario walk the game's DP/CI/FoI/VoB
  path, usually into nothing. With a path tile there, nothing happens. That is why "ignore them" usually works.

### Emulated: "set the entry to 00" breaks pipes

`tools/`-style scratch script (scratchpad, not in the repo) on the editor's test image (`tools/fixture.ts`
`editorImage`), `PlaySession.overworld` on each main-map pipe tile 82 with translevel 0 and an empty tile below, Down
pressed, `$1B78` watched for 90 frames:

| Pipe tile (l1 index) | game's tables | `$049078` = `$00` | `$049078` = `$FE` |
|---|---|---|---|
| 03A, 0EB, 171, 209 | no hardcoded walk | **hardcoded walk** | no hardcoded walk |

The game does not skip translevel 0 (`CMP.B _0` / `BNE`), and all pipes of the clean game are translevel 0 (Lunar
Magic's help, `ov_overworld_modify_level.htm`). So "00" turns that entry into a path from every translevel-0 tile in
that direction. `$60–$FE` (no translevel the game uses on the overworld, not `$FF`) is the safe value.

## 5. For an editor that wants to be better than Lunar Magic (recommendation, not sourced)

The editor already draws the hardcoded paths' cells and names them in the status bar (`hardPathCells`,
`overworld.ts` `hardCells`/`hardCellText`, uncommitted work at the time of writing), which Lunar Magic never did.
What else follows:

1. **Respect `$049307`.** `hardPaths(rom)` reads the tables whether or not Lunar Magic's option is off;
   `owOptionValue(rom, 'hardcodedPaths')` exists but `owreach.ts`/`overworld.ts` don't consult it. On SLL2 the editor
   would draw (and the reach search use) paths the game never takes. `false` → no hard paths; `null` (code patched)
   → see 2.
2. **Don't trust the tables when the code is patched.** If `$049312` isn't `A2 09 00` (Kaizo: `JML`), the tables at
   `$049078` are stale. Per the project's rule (emulate, don't hardcode), the robust way is to learn them like the
   path kinds: from each level/stop tile × direction whose neighbour is `00`/`87+`, run the emulator and record the
   cells walked while `$1B78` ≠ 0 (any non-zero value: Kevin's patch stores flags there). The cheaper interim is to
   treat a patched `$049312` as "unknown" (like `owoptions.ts` `codePatched`) and say so, rather than draw the vanilla
   paths.
3. **Match the game's lookup.** `hardPathAt` returns the last entry with the same translevel *and* direction and
   skips translevel 0. The game takes the last entry with the same translevel (or position) and gives up if its
   direction differs, and it does match translevel 0 (emulated above). Same result for the game's own tables;
   different for hand-edited ones. Under Kevin's patch the "go on to the next entry" behaviour is right, which is
   another reason to learn rather than reimplement (point 2).
4. **Warn where they bite.** A level/stop tile with a listed translevel (or main map 12,17) whose neighbour in the
   listed direction is not a path tile, so the game walks its own path: say so on the tile ("Mario walks the game's
   hardcoded path DP2→DP1 here"), and flag it when that walk ends stuck (`hardWalk` → `to: -1`) or on a tile that is
   not the intended level. That is the case Lunar Magic's help only describes in prose. Offer the two fixes Lunar
   Magic users have: draw a path tile there (overrides it) or turn the paths off (`owoptions.ts`, Lunar Magic's
   bytes).
5. **Editing them:** if the editor ever offers this, write Kevin's patch's format (Asar patch plus tables), not an own
   one, so the ROM stays usable with the SMW Central ecosystem and Lunar Magic's option keeps its meaning. The
   vanilla tables have room for only 68 steps and 10 entries. Credit: Kevin.

## Not confirmed

- The SMW Central patch page text (id 35761), its exact version history and date: snippets only.
- Whether any other SMW Central patch (remover or editor) exists: SMW Central's search could not be opened.
- The forum threads' content and authors: titles and snippets only.
- How Lunar Magic behaves when saving the overworld of a ROM with Kevin's patch (it should leave `$049312` alone; not
  tested).
- Kaizo's `$04945D` hook being the Overworld Speed Changer: shape only.
