# Sprite images and the sprite GFX set: finding which ones are correct by emulation

Research note, 2026-10-23. The question: depending on the level's sprite GFX set (header "sprite set" / SP1–SP4), some sprites in the sprite palette look right and others look like garbage. Can the editor tell which is which **without built-in SMW knowledge**, by emulation only?

Short answer: partly. Emulation can show **where** each sprite's tiles come from, whether a sprite **brings its own graphics**, whether its tiles are **the same under every set**, and whether they are **empty**. It cannot show whether non-empty tiles are the **intended** graphics. That needs evidence from outside the sprite's code: the ROM's own levels that use the sprite (data, not knowledge), or the author's declaration (PIXI `GFXInfo`, the same thing Lunar Magic shows). A tiered verdict built from these covers vanilla sprites and used custom sprites fully. Only "unused custom sprite without a declaration, with non-empty tiles" stays undecidable, and the editor should say so honestly.

## Sources

- **SMWDisX** (IsoFrieze/SMWDisX, local clone `~/sources/SMWDisX`, commit `3390ee1a`): https://github.com/IsoFrieze/SMWDisX. Cited as `bank_XX.asm:line`.
- **fullsnes** (Martin Korth), PPU register and OAM description: https://problemkaputt.de/fullsnes.htm, section "2101h - OBSEL" and "OAM".
- **Lunar Magic 3.71 help** (FuSoYa), `Lunar Magic.chm` from `lm371.zip` (https://fusoya.eludevisibility.org/lm/download/lm371.zip). Cited as "LM help: `html/x.htm`".
- **PIXI** (JackTheSpades/SpriteToolSuperDelux, commit `734b8ed3`): https://github.com/JackTheSpades/SpriteToolSuperDelux. Its `README.md` and `src/json.cpp`.
- **This repo**: cited as `path:line` at commit `c5c4b53`.

## 1. How SMW puts sprite graphics into VRAM

**The sprite set is one header nibble.** At level load the game stores the low nibble of the primary header's third byte as `SpriteTileset` ($192B) (`bank_05.asm:571-574`, "Load sprite set"). So a level can choose sets 0–F. The editor parses the same nibble (`src/core/level.ts:225`). Cutscenes, credits and boss rooms set larger values in code (for example `bank_00.asm:2354-2357` and `2516-2523`), but a level header cannot reach them.

**The set picks four files from a table.** `UploadSpriteGFX` (`bank_00.asm:5325`) reads 4 bytes at `SPRITEGFXLIST + set*4` (`bank_00.asm:5232`, SNES $00A8C3). It then uploads each file with `UploadGFXFile` (`bank_00.asm:5401`) to the VRAM word addresses in `DATA_00A9D2` = $78/$70/$68/$60 ×$100 (`bank_00.asm:5320`). The first byte of the entry ends up at $6000 (SP1), then $6800 (SP2), $7000 (SP3) and $7800 (SP4), matching the VRAM map in `rammap.asm:2301-2306` (`VRam_OBJTiles: VRam_GFX_SP1 … SP4`). A file already listed in `SpriteGFXFile` ($0101–$0104, `rammap.asm:1026`) is not uploaded again (`bank_00.asm:5346-5349`).

**SP1 and SP2 are the same in every header set.** All 16 header sets (0–F) start with `$00,$01`. Only SP3/SP4 vary: for example Forest `13,02`, Castle `12,03`, Ghost House `06,11` (`bank_00.asm:5233-5248`).

**Where OAM tiles point in VRAM.** At boot the game writes `HW_OBJSEL = VRam_OBJTiles>>13 | size 8/16` (`bank_00.asm:45-46`). That makes the name base $6000 (words) with a name-select gap of 0, so the second table starts at $7000. Per fullsnes (OBSEL):
- bits 0–2 are the OBJ base in 8K-word steps;
- bits 3–4 are the gap between tile 0FFh and 100h in 4K-word steps, plus 1;
- OAM attribute bit 0 is tile number bit 8.

As a result:

| OAM tile | Page bit (attr bit 0) | VRAM (words) | Slot |
|---|---|---|---|
| 00–7F | 0 | $6000–$67FF | SP1 |
| 80–FF | 0 | $6800–$6FFF | SP2 |
| 00–7F | 1 | $7000–$77FF | SP3 |
| 80–FF | 1 | $7800–$7FFF | SP4 |

The editor already uses this mapping. It decodes OBSEL generically in `src/core/spritegfx.ts:272-274` and names the slots with their first OAM tile in `src/core/gfxslots.ts:20-23` (SP1 000, SP2 080, SP3 100, SP4 180). This is PPU knowledge, not SMW knowledge.

**Part of SP1 is rewritten every frame.** NMI copies Mario/Yoshi/cape/Podoboo graphics from the WRAM buffer to $6000 and $6100 (with `DynGfxTilePtr`) and to $67F0 (tile $7F) on every frame (`bank_00.asm:4567-4606`; `rammap.asm:1318-1326`: "10 pointers to graphics that make up various parts of Mario, Yoshi, cape, and Podoboo"). Sprites can point these pointers at their own graphics. Examples: `bank_01.asm:13192-13195`, and `bank_02.asm:14096-14099` (key/keyhole area). These are the vanilla **dynamic** tiles. Lunar Magic notes the same thing for Yoshi versus castle fireballs and Baby Yoshi (LM help: `html/editor_sprites.htm`).

## 2. How a sprite picks its tiles

**Tile numbers are fixed constants in the sprite's code.** The shared tilemap `SprTilemap` (`bank_01.asm:3795`) is a byte table of OAM tile numbers ($82, $A0, $A2, …) indexed per sprite through `SprTilemapOffset` (`bank_01.asm:3829`). Boss and special sprites have their own tables (`ThwompTiles`, `CloudTiles`, `YoshiHeadTiles`, … in `bank_01.asm`).

**The page bit comes from the sprite's tweaker byte.** `LoadSpriteTables` stores `Sprite166EVals[n] & $0F` (palette plus page bit T) into `SpriteOBJAttribute` ($15F6) (`bank_07.asm:972-981`). The code therefore hard-wires "tile X of quarter Q". It does not say which file it expects in Q, and nothing in the game checks that the right file is there. The intent exists only in the level designer's choice of sprite set.

**Exception: a sprite that looks at the set.** Sprite A5 (ground-guided Fuzzy/Sparky) reads `SpriteTileset`. In set 02 (Mushroom) it draws tile $C8 (the Fuzzy); otherwise it draws tile $0A (the Sparky) (`bank_02.asm:8257-8283`, `CMP.B #$02`). This was the only read of `SpriteTileset` by sprite code that a grep of `bank_0*.asm` found. So in vanilla, a sprite's tile references are set-independent with this one known exception. Custom sprites can do anything.

## 3. What Lunar Magic does

From LM help: `html/editor_sprites.htm`:
- "Standard Sprites" are the ones "available in all sprite tile sets (because in all sprite tile sets, SP1=0 and SP2=1)".
- "Tile set Specific Sprites" depend on SP3/SP4: "the contents of this list won't change so these sprites are always technically available, but most of them will still appear corrupt without the correct tile set loaded."
- "a small line of text will sometimes appear at the top of the preview window to suggest which GFX files could be loaded into SP3 and/or SP4 to view the sprite correctly."

So LM **hides nothing and marks nothing** per tileset. It shows a static hint, and it draws sprites from its own internal sprite Map16, not from the ROM's code.

The hint is **built-in knowledge**, and authors can extend it. From LM help: `html/info_custom_tooltip_sprites.htm`, "Custom Sprite GFX Information": since 3.30, type 8 lines in the `.ssc` give SP1–4 file sets ("7F" = any), for example `AB 8 7F,7F,7F,11 7F,7F,7F,20` shows "SP4=11/20". Adding $8000 forces a combination of slots.

**PIXI carries the same data per custom sprite.** The json format's `Displays[].GFXInfo` has keys "0"–"3" (SP1–SP4) with a gfx number and a "Separate" flag. PIXI's `README.md:385-397` says "refer to the LM manual, section Custom Tooltips for Sprites", and `src/json.cpp:126-138` parses it into `gfx_files[i].gfx_num`/`.sep`. The editor's json reader does not read `GFXInfo` yet (`src/core/pixi.ts:185-187` reads only `Collection` and the first `Description`).

Acts-like target: the editor should at least show "which files make this sprite look right", and should be better than LM: derived from the ROM, per tile, and with a verdict for the current level rather than a static hint.

## 4. How the editor captures sprites today

- `captureSprites` (`src/core/spritegfx.ts:51`) loads a test level with the open level's header and sprite header. The game's own `UploadSpriteGFX` therefore puts the level's real SP1–SP4 files (including the GFX bypass) into VRAM. It places up to six sprites, runs 3 frames with `SlotTracker` (`spritegfx.ts:184`, which attributes OAM buffer writes to the slot whose code runs) and keeps each sprite's OAM tiles.
- `drawTiles` (`spritegfx.ts:270-307`) renders those tiles from the emulated VRAM and CGRAM. When every pixel is transparent it returns null, and the editor marks the spot (`spritegfx.ts:304-305`).
- The UI learns all images once per `spriteGfx-spritePalette` (`src/ui/app.ts:623-642`). The input includes a hash of the level's four SP files (`app.ts:660-667`, `spriteGfxFiles` `app.ts:720`, which reads the default files with `defaultGfx`, `src/core/patches.ts:448-453`, a direct read of the $00A8C3 table).
- The palette lists them in `src/ui/panels.ts:657-671`. It already has an "unused" badge for custom sprites, from `app.spriteUsers` → `spriteUsage` (`src/core/levelusage.ts:263`).

So the image already shows what the game would show in this level, which is correct by construction. What is missing is a **verdict** on whether that is the intended look.

## 5. What emulation can determine, and how

All of this comes from the OAM entries the capture already has, plus VRAM snapshots. No SMW tables are needed.

### 5.1 Per-tile provenance (the basis)

For each captured OAM tile, compute its 8x8 VRAM addresses from OBSEL, the tile number, the page bit and the size, exactly as `drawTiles` does. Map each address to a quarter: (addr − base − page·gap) / $800 words → SP1–SP4. Record per sprite the set of **referenced 8x8 tiles** (VRAM word address, 16 bytes of 4bpp data each). Everything below works on these addresses and their contents.

Widen the window. Three frames only see the first pose. Recording more frames (for example 30–60) and taking the union of referenced tiles catches walking and turning frames. States that need a trigger (a Chuck throwing, a Rex squashed) are not seen; see 5.6.

### 5.2 Own graphics (dynamic sprites): always correct

Snapshot OBJ VRAM ($6000–$7FFF) after the empty test level (`testLevel`, `spritegfx.ts:150`) has loaded. Compare it with VRAM at the end of the capture.

- A referenced tile whose content **changed after the set's upload** was written by the running game. That covers vanilla `DynGfxTilePtr` users (Yoshi, Podoboo, keyhole) and custom dynamic sprites (PIXI dynamic routines, sprites that DMA their own frame).
- Such tiles do not depend on the sprite set. Count them as correct, unless another sprite overwrites them.

A cleaner variant is a VRAM write hook (`MemHook.onVramWrite`). Add it to `Snes` next to the `$2118/$2119` writes (`src/core/snes.ts:327-338`); DMA goes through `writeIO` (`snes.ts:380-410`), so one hook covers both. Turn it on once gameplay starts, the same boundary `record` uses (`spritegfx.ts:252-261`). Caveat: Mario's own per-frame upload also writes into $6000–$61FF and $67F0. A sprite that just uses Mario's tiles is "set-independent" either way (5.3), so no harm is done.

### 5.3 Set-independent: always correct

Load the empty test level once per header set 0–F and keep OBJ VRAM. That is 16 loads, the game's own upload, and no table read. The same snapshots replace the `defaultGfx` table read for this purpose. If every referenced tile has **identical content in all 16 snapshots**, the sprite looks the same in every level that keeps the default files. This is the emulated form of LM's "Standard Sprites", and it also holds for SP3 tiles where all sets share a file. Under a GFX bypass, compare against the level's actual files instead (5.5).

### 5.4 Empty tiles: certainly wrong (or invisible by design)

If a referenced tile is all zero in the current VRAM but non-zero in some other set's snapshot, the current level lacks the sprite's graphics. Mark it "graphics missing (SPn)". If the tile is empty in all sets, the sprite is invisible by design (generators, commands); keep today's marker. Today `drawTiles` only catches the *all*-empty case (`spritegfx.ts:305`). This makes it per tile and per quarter.

### 5.5 Usage evidence from the ROM: the main signal for "intended"

The game's own levels show which graphics a sprite was meant to have. This is data, not knowledge.

1. `spriteUsage(rom, usedLevels(rom))` (`levelusage.ts:263`) lists the levels that place sprite *n*.
2. `levelSlots` (`gfxslots.ts:33`) gives each of those levels' SP1–SP4 files, including bypass and ExGFX.
3. Build the reference contents of the sprite's referenced tiles under each using level's files. Either decompress the files with `gfxBytes` (`src/core/gfxfiles.ts:35`) and take the tile at quarter offset, or use the per-set VRAM snapshot when the level has no bypass.
4. Verdict for the current level, per referenced tile: **correct** if its content equals the content in at least one using level. With several using levels, prefer the majority, because a sprite may be placed somewhere it never appears on screen. Otherwise it is **unlike every use**.
5. Bonus, better than LM: a hint line "looks right with SP4 = 06 (as in levels 105, 10B, …)". It is generated from the same data and covers ExGFX hacks, which LM's static list does not.

Comparing tile **content** instead of file numbers handles copies and edited files correctly. Two files that share the referenced tiles count as correct. A file that was edited is judged by what it shows now.

For A5-style sprites (tile choice depends on the set) the reference has to come from a **real capture** under the using level's set, not from re-rendering the current OAM tiles with another VRAM. To stay cheap, re-render first and run a real capture only for the sprites the verdict depends on.

### 5.6 Author's declaration: custom sprites

Read `Displays[].GFXInfo` from the PIXI json (see section 3; the editor's reader is `pixi.ts:185`). Check the current level's files per slot against it, with 7F meaning any. This is third-party data, the same data LM uses, so it is allowed. It is the only source for custom sprites that no level uses yet. For packages, the existing Link "an ExGFX file in the graphics slot its tiles are drawn from" (`CONTEXT.md`, Link; `src/core/pkgplan.ts:213`) and the sample level's slots are the same kind of evidence and can be stored as a declaration at install time.

### 5.7 What emulation cannot decide

- **Valid-looking but unintended graphics.** Only the designer knows the intent. If a custom sprite is used nowhere and declares nothing, and its tiles are non-empty, the editor can only say "unverified". Whether a picture looks like noise or like a Goomba is not something the game's code, the PPU or VRAM state can tell. Heuristics such as edge continuity across adjacent 8x8 tiles in a 16x16 group, or colour-index statistics, could rank candidates. But they misjudge sparse or blocky sprites and accept garbage that happens to be smooth, so they should not drive a verdict.
- **Unseen states.** Tiles referenced only in poses the capture doesn't reach (thrown, stunned, attacking) are not checked. The verdict is "the captured poses are right".
- **Majority errors in the ROM.** A hack whose levels place a sprite in a wrong set teaches the wrong reference. Vanilla is clean as far as LM's hints suggest, but that was not checked level by level.
- **Palette** is a separate question (sprite palette header, not GFX). The same tiles with the wrong palette pass this check.
- **Mid-level GFX changes** (UberASM or patches that re-upload SP3/SP4 later) are not seen in a 3–60 frame test level.

## 6. Recommended heuristic (tiered verdict per sprite and level)

Evaluate in order; the first tier that matches decides.

| Tier | Condition (emulated or ROM data) | Verdict shown |
|---|---|---|
| 1 | All referenced tiles are dynamic (5.2) | correct (own graphics) |
| 2 | Contents identical under all 16 header sets and the level uses default files (5.3) | correct (standard) |
| 3 | Some referenced tile is empty here but non-empty elsewhere (5.4) | missing graphics, name the slot |
| 4 | Using levels exist: contents equal a (majority) use (5.5) | correct; else wrong, hint "as in level …" |
| 5 | PIXI `GFXInfo` / package link exists (5.6) | correct or wrong against the declaration |
| 6 | None of the above | unverified (no mark, tooltip says why) |

**Failure cases, in short:**
- Tiers 1–3 are sound, with the caveat for poses not captured.
- Tier 4 is as good as the ROM's own usage. A single odd use can wrongly approve a set; a majority vote reduces this.
- Tier 5 is as good as the author's file.
- Tier 6 is the honest remainder.

**Cost.**
- 16 extra test-level loads per ROM state for the VRAM snapshots.
- Re-rendering existing OAM captures against other VRAM is cheap, with no emulation.
- Real captures only for A5-like disagreements.
- Usage data is already read without emulation (`levelusage.ts`).

## 7. Where it would go in the code

- `src/core/spritegfx.ts`:
  - `captureSprites`/`captureSpriteAt` also return each sprite's referenced VRAM tile addresses. Today they are thrown away after `drawTiles`. Return the `OamTile[]` group plus OBSEL.
  - `record` gets an optional VRAM-write recording.
  - A new pure function `tileRefs(obsel, tiles) → word addresses + quarter`.
- `src/core/snes.ts`: `MemHook.onVramWrite?(wordAddr)` in the `$2118/$2119` cases (`snes.ts:327-338`), covering DMA through `runDma` (`snes.ts:380-410`).
- A new `src/core/spritesets.ts` (name to be decided):
  - per-set OBJ VRAM snapshots by emulation (header nibble 0–F through `testLevel`), kept in the result cache like other emulated results (`src/core/learner.ts`);
  - the tier logic of section 6;
  - the reference contents from `spriteUsage` + `levelSlots` + `gfxBytes`.
- `src/core/pixi.ts:185`: parse `Displays[].GFXInfo` into `CustomSprite`.
- `src/ui/app.ts`:
  - `ensureSpriteImages` (`app.ts:623`) also stores the references;
  - a `spriteVerdict(id)` next to `spriteUsers`;
  - its input includes the SP files hash (already in `spriteInput`, `app.ts:660`) and the usage data.
- `src/ui/panels.ts:657-671`:
  - a badge per row ("missing SP4", "unlike its uses", "unverified") like the existing `gt-unused`;
  - the hint line in the row title;
  - optionally a filter "looks right in this level", which LM does not have.
- Domain words for `CONTEXT.md` if this is built: "Standard sprite" (set-independent by emulation) and "Sprite verdict".
