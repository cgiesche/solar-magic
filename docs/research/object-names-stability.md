# Are the game's object numbers stable enough to name?

Research note, 2026-10-27. The question: the editor derives behaviour by emulation and avoids built-in SMW tables. As an exception, it could give the level objects (standard objects 01–3F, extended objects 00–FF) their well-known names ("Water (blue)", "Ledge", "Coin" …) from a data file in the repo, not from the ROM. Is that safe? Do patches and tools in the SMW scene replace these objects, or do they stay what they are? Should the names be fixed, or overridable per project?

Short answer: **the vanilla object numbers are stable; the free numbers around them are not.** In the clean game, standard objects 01–21 and the tileset-specific objects 2E–3F (per tileset group), and extended objects 00, 01 and 10–97, have fixed routines. No tool or patch found here points one of them at a different object:

- Lunar Magic fills only numbers that are empty in the game (standard 22–29, 2D; extended 02, 03).
- ObjecTool takes extended 98–FF and the 5-byte object 2D.
- Every other hijack in bank 0D changes *how* a vanilla object behaves (item memory, switch bits, bug fixes, a moon variant), not *which* object it is.

What does change in practice is the **look**: objects draw Map16 tiles, and hacks edit Map16, ExGFX and palettes freely. A "Cement block" may well look like something else. Recommendation:

1. **Fixed names, from a repo data file, for the vanilla numbers only**: standard 01–21; 2E–3F per tileset group; extended 00, 01, 10–97. This is what `src/core/names.ts` already does for 01–21.
2. **No built-in name for the free numbers**: standard 22–2D, extended 02–0F, 98–FF. Name them from what is installed in the ROM: Lunar Magic's slots, the editor's own patches, ObjecTool. Otherwise use "Object XX" / "Extended object XX".
3. **Per-project override on top**, acts-like Lunar Magic's `.osc` tooltips and `.mw0t` names. Lunar Magic itself lets a project re-describe *vanilla* objects (its own help uses horizontal pipes and the 3-UP moon as examples). Custom objects need this anyway (see [objectool-custom-objects.md](objectool-custom-objects.md), open question 2).
4. **Names of 2E–3F are per tileset group** (five groups, §1.2), not per tileset, and several standard objects have sub-types (a nibble of the settings byte). The name key must be (object, tileset group for 2E–3F, sub-type). Sub-types are already found by emulation (`src/core/objkinds.ts`).

## Sources

- **SMWDisX** (IsoFrieze, https://github.com/IsoFrieze/SMWDisX; local clone `~/sources/SMWDisX`, commit `3390ee1`). Cited as `bank_0D.asm:line`.
- **Lunar Magic 3.71** (FuSoYa), local copy `~/tools/lunarmagic/`:
  - the help file `Lunar Magic.chm` (decompiled with 7z), cited as "LM help: `html/x.htm`";
  - `readme.txt`, cited as "LM readme:line";
  - `Lunar Magic.exe`, its strings (`strings -t x`), cited as "LM exe @offset".
- **SMW Central hijack map** (https://www.smwcentral.net/?p=memorymap&game=smw, "SMW Central contributors"). Read from a local export, `resources_local/hijack-list.csv`: 2626 entries, git-ignored. Cited as "hijack map #id". SMW Central's pages are behind a human-verification wall, so they could not be fetched today. The same is true of the patch section and ObjecTool's page (as in [objectool-custom-objects.md](objectool-custom-objects.md)).
- **ROMs**, read with a small Python script in the session scratchpad (not committed). It decodes the five standard-object pointer tables and the extended-object table:
  - the clean game, `test/fixtures/smw.smc`;
  - four hacks saved by Lunar Magic: *Journey to Kaizo* v1.1, *celery*, *QW2* (LM 2.53) and *bluerios-adventure*, all in `resources_local/`;
  - the Romhack Races baserom 5.15 (`test/fixtures/rhr-baserom-5.15.zip`), its `workspace/RHRv5.osc`.
- **This repo** at commit `99a0cf8`, cited as `path:line`.

## 1. How the game dispatches objects

### 1.1 Extended objects (object 00)

`CODE_0DA106` takes the extended number (`$59`) and jumps through a table of 256 long pointers (`bank_0D.asm:1056-1317`):

| Numbers | Routine | Meaning |
|---|---|---|
| 00 | `CODE_0DA512` (`bank_0D.asm:1416`) | screen exit (4 bytes) |
| 01 | `CODE_0DA53D` (`bank_0D.asm:1441`) | screen jump |
| 02–0F | `$000000` | empty: the level load crashes ([lunar-magic-extended-object-03.md](lunar-magic-extended-object-03.md), table "Clean game") |
| 10–97 | 43 distinct routines, e.g. `CODE_0DA57B` shared by 48 of them (`bank_0D.asm:1458`) | the game's extended objects |
| 98–FF | all `CODE_0DA6D1`, the door routine of 47/48 (`bank_0D.asm:1660`) | unused: they read past a 2-byte table and draw door parts ([objectool-custom-objects.md](objectool-custom-objects.md) §3.1) |

Extended objects are the same in every tileset. There is a single table, not one per tileset.

### 1.2 Standard objects 01–3F

`CODE_0DA415` picks one of five object tables by `ObjectTileset` (`$1931`, set from the level header's FG/BG tileset, `bank_05.asm:626`) (`bank_0D.asm:1324-1342`). Each table is 63 long pointers for objects 01–3F:

| Table | Tilesets (index → names as in `src/core/names.ts` `TILESETS`) |
|---|---|
| `CODE_0DA44B` (`bank_0D.asm:1345`) | 0 Normal 1, 7 Normal 2, C Cloud/Forest |
| `CODE_0DC190` (`bank_0D.asm:4693`) | 1 Castle 1 |
| `CODE_0DCD90` (`bank_0D.asm:5425`) | 2 Rope 1, 6 Rope 2, 8 Rope 3 |
| `CODE_0DD990` (`bank_0D.asm:6307`) | 3 Underground 1, 9 Underground 2, A Switch Palace 2, B Castle 2, E Underground 3 |
| `CODE_0DE890` (`bank_0D.asm:7552`) | 4 Switch Palace 1, 5 Ghost House 1, D Ghost House 2 |

Comparing the five tables entry by entry:

- **01–2D are identical in all five.** These are Lunar Magic's "Standard Objects", "available in all tile sets" (LM help: `html/editor_objects.htm`).
  - 01–0E share one routine, `CODE_0DA8C3` (`bank_0D.asm:1913`).
  - 0F–21 each have their own routine; 18–1B share `CODE_0DB3E3`.
- **22–2D are unused in the game.** They all point to `CODE_0DB3E3`, the routine of 18–1B. It indexes the 4-entry table `DATA_0DB3DB` with (number − 1 − $17) (`bank_0D.asm:3474-3502`). For 22–2D that index is 0A–15, which reads past the table into the bytes that follow it: garbage.
- **2E–3F differ per table.** These are Lunar Magic's "Tile set Specific Objects". Some groups also leave a few of them on `CODE_0DB3E3`, which makes them unused there too:
  - `CODE_0DA44B`: 2E–2F;
  - `CODE_0DC190`: 2E–33;
  - `CODE_0DCD90`: 2E–31;
  - `CODE_0DD990`: 2E–33;
  - `CODE_0DE890`: none.

  Lunar Magic calls the group the "T" value: "The 'T' value in the FG/BG list indicates which group of tileset specific objects will be available" (LM help: `html/level_change_graphics.htm`).

So the routine of every vanilla object is fixed by its number (and, for 2E–3F, by the tileset group). The *tiles* it places are Map16 numbers. Lunar Magic notes that "the FG/BG index … even change[s] some of the Map16 tile data loaded" (LM help: `html/level_change_graphics.htm`). It also notes that "some objects … will look like garbage if the tile set doesn't have the particular GFX tiles or Map16 tile data" (LM help: `html/editor_objects.htm`). So a name describes what the object *does* (which Map16 tiles it places). It does not describe what those tiles look like in a given hack.

### 1.3 Sub-types

Several standard objects use a nibble of the settings byte as a type, not as a size. Examples: 12 slopes, 13 ledge edges/vines, 15 midway/goal point, 17 rope/clouds. Lunar Magic shows these as separate list entries with a blank number. Its custom tooltips can key on the low bits of X/Y or on one byte's value or nibble (LM help: `html/editor_objects.htm`, `html/info_custom_tooltip_objects.htm`). The editor finds these types by emulation (`src/core/objkinds.ts:1-7`). A name table would only add labels to types that emulation has already found.

## 2. Which numbers others take

### 2.1 Lunar Magic

Lunar Magic fills **free** numbers only. Measured in the four Lunar Magic-saved ROMs, against the clean game:

| Table entry | Clean game | All LM ROMs | LM's own description (LM exe) |
|---|---|---|---|
| standard 22 | `$0DB3E3` (garbage) | `$0DF08A` | "Internal Direct Map16 Access Code 0." @1a9a8c |
| standard 23 | `$0DB3E3` | `$0DF08E` | "Internal Direct Map16 Access Code 1." @1a9a64 |
| standard 24 | `$0DB3E3` | `$0DF0E0` | "Internal ExGFX Code." @1a9a4c |
| standard 25 | `$0DB3E3` | `$0DF0F0` | "Internal Animated Tile Extension Code." @1a9a24 |
| standard 26 | `$0DB3E3` | `$0DF130` | "Internal Music Bypass Code." @1a9a08 |
| standard 27 | `$0DB3E3` | `$0DF150` | "Internal Direct Map16 Access Code X." @1a99e0 |
| standard 28 | `$0DB3E3` | `$0DF160` in *bluerios* only | "Internal Time Limit Bypass Code." @1a99bc. `$0DF160` is "inserted the first time the time limit setting is bypassed" (hijack map #8608) |
| standard 29 | `$0DB3E3` | `$0DFF50` | "Internal Direct Map16 Access Code X2." @1a9994 |
| standard 2A–2C | `$0DB3E3` | unchanged | "This is a null or unused object. Using it isn't recommended..." @1aa948 |
| standard 2D | `$0DB3E3` | unchanged in the table | "Reserved for 5-byte user defined objects." @1aaa1c. In LM help: `html/edit_insert.htm`, "set aside as a 5 byte object for user defined purposes" (since 1.80, LM readme:2309-2313) |
| extended 01 | `$0DA53D` | `$0DE1D0` (not in *QW2*) | still the screen jump, extended for level heights ([lunar-magic-extended-object-03.md](lunar-magic-extended-object-03.md)) |
| extended 02, 03 | empty | `$0DE1B0`, `$0DE1E0` (only 02 in *QW2*) | "Internal Screen Exit Code 2." / "Internal Screen Jump Code 2." @1a9324/@1a9304 |

Notes on the table:

- The mapping of strings to numbers is inferred from their order in the exe: they run 29, 28, 27 … 22, then 21 "A wide-scale ground ledge object" … down to "Internal Extended Object Code." for 00. That order matches the measured pointers.
- Lunar Magic writes the same pointers into all five tables. The five-table comparison found no other change in 01–21, 2E–3F or extended 04–FF in any of the four ROMs.
- Since 3.60, Lunar Magic shows a placeholder for unused extended objects, "as some hacks use these for turning on/off settings" (LM readme:249-252).

Lunar Magic also **changes the code of vanilla objects without changing what they are**:

- item memory index 3 checks for coins, blue coins, Dragon Coins and some blocks (hijack map #8575, #8578, #8588, #8591);
- the level-height pointer steps (#8581, #8583, #8584);
- a fix for the left diagonal ledge 3A (#8582; LM readme:157-160);
- forest tree top 33 at any Y (LM readme:983-987).

### 2.2 ObjecTool and Retry

Covered in [objectool-custom-objects.md](objectool-custom-objects.md) §1. ObjecTool 0.5 (imamelia; original by 0x400) hooks `$0DA106` and takes **extended 98–FF**: numbers below `$98` go back to the game's table. It also hooks `$0DA415` for **object 2D** as a 5-byte custom object with 256 sub-numbers (hijack map #8567, #8568). The Retry System (kkevinm) hooks `$0DA415` too, for its custom midway bars as 2D sub-numbers (hijack map #8569). Both use only numbers that are unused in the game and set aside by Lunar Magic. Neither touches 01–21, 2E–3F or extended 10–97.

### 2.3 Other patches on object code

All bank 0D entries of the hijack map that touch object routines, beyond Lunar Magic's, ObjecTool's and Retry's:

| Patch (author) | Hijack map | Effect on the vanilla object |
|---|---|---|
| Item Memory Table Expansion (Isikoro) | #8572, #8577, #8579, #8585–#8587, #8589, #8590, #8592 | extended 10–40, coins, Dragon Coins, blue coins: item memory only |
| Individual Dragon Coin Save (worldpeace, JackTheSpades, LX5) | #8586 | Dragon Coin not placed once collected |
| Random Chance Custom Tile Instead of 3-up Moon (Arinsu) | #8573 | the moon may place another tile |
| Collected Moon Outline (Koopster) | #8574 | the moon draws an outline tile once collected |
| "Beat level by collecting all of the coins" (author not given) | #8580 | counts coin objects |
| Switch Palace RAM Optimizer (Sonikku) | #8593, #8594, #8603 | switch blocks / palace switch read a bit instead of a byte |
| Forest Treetop Fix (author not given) | #8595 | tree top at any Y |
| Castle Intro Ledge Fix (Kevin) | #8597, #8598 | ledge positioning across screen boundaries |
| Flat Rope Conveyor for All Headers (spooonsss) | #8602, #8604 | the ghost house ledge's right tile moves from Map16 10C to 10F |
| Retry System v2.2.0 (kkevinm) | #8576 | midway bar placed or not by checkpoint |

None of these makes a number into a different object. Outside bank 0D, the map lists no hijack of the object loader. A search of all 2626 descriptions for object-number wording found only Lunar Magic's layer 2 table at `$0EF310` (#8618), which is not an object routine.

The biggest change to an object's look comes from the user, not from patches. Map16 and ExGFX editing change what every object looks like. An "Invisible coin block" stays one, but a "Brown block" may be drawn as anything.

## 3. How Lunar Magic names objects

- **Built-in descriptions.** The exe carries a one-sentence description for every object, extended object and sub-object. Examples: "A grey cement block that Mario can't walk through." @1aa0a4; "The top of a mushroom ledge." @1aaf54; "A forest tree top object. Place this at subscreen coordinate X=0 for the intended result." @1a9880. There are also descriptions for its own slots (§2.1). The short list labels of the Add Objects window were not found as plain strings and are not checked here.
- **Per-project override, including vanilla objects.** `RomName.osc` (since 3.60) sets the tooltip of any object, keyed by:
  - object number;
  - ExType (the extended number, or the 4th byte of 2D);
  - type, which can key on X/Y low bits, one byte's value or nibble, or "the Tileset Specific Objects group (this is from the 'T' value)" for standard objects (not for extended objects or 2D).

  The help's own examples re-describe *vanilla* objects: "to change the tooltip for horizontal pipes (object 10)", "the 3-UP moon (extended object 18)", "the mushroom ledge (object 3C) which is only available when the 'T' value is 2" (LM help: `html/info_custom_tooltip_objects.htm`). Type 8/A entries set the GFX files and FG/BG indexes an object needs, for display only (same page).
- **Custom collections.** `RomName.mw0t` names entries ("a 2 hex digit command of the extended object, a tab, and then a short description") over `.mw0` object data (LM help: `html/info_custom_object_collection.htm`).
- **In practice.** The Romhack Races baserom's `RHRv5.osc` overrides only custom numbers: 42 extended entries and 68 entries of 2D, none of a vanilla object. One sample, so this says nothing about how often projects re-describe vanilla objects.

So Lunar Magic's model is the same as the recommendation: built-in descriptions, keyed per tileset group and sub-type where the game varies, and a project file that can override any of them.

## 4. Today's editor

- `src/core/names.ts:9-14` already names standard objects 01–21 from a built-in list ("best effort, vanilla SMW").
  - Everything above 21 becomes "Tileset object XX". That mislabels 22–2D, which are not tileset objects but unused or Lunar Magic/ObjecTool slots (§1.2, §2.1).
  - It is also blind to the tileset group, so 2E–3F get no name at all.
- Extended objects are "Extended object XX", except the editor's own `$04` (Prefab) and `$05` (Direct Map16) (`src/core/names.ts:12`).

## Stability by number

| Numbers | Status | Name source |
|---|---|---|
| standard 01–21 | stable vanilla, same in every tileset | built-in |
| standard 22–29 | unused in the game; Lunar Magic's internal objects (Direct Map16 22/23/27/29, ExGFX 24, animation 25, music 26, time limit 28) | from what is installed: LM's slots by name, if the editor recognizes them |
| standard 2A–2C | unused (garbage) in the game and in LM | none ("Object XX", or hide) |
| standard 2D | unused in the game; LM: 5-byte user-defined; ObjecTool/Retry custom objects | project files (`.osc`) / installed tool |
| standard 2E–3F | stable vanilla **per tileset group** (5 groups); some numbers unused in some groups | built-in, keyed by group |
| extended 00, 01 | screen exit, screen jump (LM extends 01) | built-in (they are not placed as objects in the palette) |
| extended 02, 03 | empty in the game; LM's screen exit/jump variants | LM's |
| extended 04, 05 | empty in game and LM; the editor's prefabs and Direct Map16 | the editor's own |
| extended 06–0F | empty (crash) | none |
| extended 10–97 | stable vanilla | built-in |
| extended 98–FF | unused (door garbage) in the game; ObjecTool's custom range | project files (`.mw0t`/`.osc`) / installed tool |

## Open questions

1. **Override scope.** Should overrides apply only to custom numbers, or also to vanilla ones, as `.osc` allows? Allowing both costs nothing once the override file exists. It also helps hacks whose graphics turn e.g. "Brown block" into something else.
2. **Reading `.osc`/`.mw0t`.** Should a package upload or a ROM's side files fill the override (acts-like Lunar Magic)? Or should the editor have its own per-project names, for example stored in the ROM like other editor data? This overlaps with [objectool-custom-objects.md](objectool-custom-objects.md) open question 2.
3. **Tileset group key.** The group is a property of the ROM's dispatch at `$0DA415`. Can the editor learn the group by emulation (which of the five tables the dispatcher jumps to for a tileset) rather than from a hardcoded tileset → group list? The names would then be keyed by table, which is robust even if a patch remaps tilesets.
4. **Recognizing "still vanilla".** Should a built-in name be shown only when the object's table entry still holds the clean game's pointer? Every hack checked here passes this test for all vanilla numbers. A hijack *inside* the routine (§2.3) would still pass, which is right, since those keep the object's identity.
5. **Sub-type names.** The editor finds sub-types by emulation (`objkinds.ts`). Their names (e.g. the many ledge edges of 13) would need a built-in list per (object, type), and per group for 2E–3F. Is that in scope, or does "Slopes – type 3" suffice?
6. **Short names.** Lunar Magic's short list labels were not located in the exe; only its descriptions were. Where they come from in Lunar Magic is not checked.
7. **Credits.** If built: the names follow the community's/Lunar Magic's descriptions (FuSoYa); the dispatch facts follow SMWDisX (IsoFrieze and contributors); the hijack facts follow SMW Central's hijack map. Add them to `docs/credits.md` with the feature.
