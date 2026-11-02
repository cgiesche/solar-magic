# ObjecTool's custom objects in the object list (issue #104)

Research note, 2026-10-26. The question (issue #104, part of #96): ObjecTool's custom extended objects (98–FF) run through the game's code once ObjecTool is installed, but they can't be chosen in the object list. Should the editor list them, found by emulation and not from a hardcoded table?

Short answer: the premise needs correcting first. In the Romhack Races baserom, **no ObjecTool object draws a single tile**. Extended objects 98–DF only set a bit in a FreeRAM flag table, which the baserom's "UberASM Objects" read. Extended objects E0–FF and all custom normal objects (2D) are a bare `RTS`. The object list keeps only extended objects whose emulated load wrote a tile, so all 104 of them (98–FF) drop out. On the clean game the same numbers *are* listed, but as garbage: they run a door routine and draw door parts. Lunar Magic does not find these objects either. It shows a placeholder tile for unused extended objects, and the baserom ships LM side files (`.mw0`/`.mw0t`/`.osc`) that name its 42 objects. Emulation can tell "does nothing" (E0–FF) from "has a side effect" (98–DF). It can tell "has an effect in play" only for some of them. Names and descriptions exist only in those side files.

## Sources

- **ObjecTool 0.5** (imamelia; original ObjecTool by 0x400), as shipped in the Romhack Races baserom: `resources/patches/objectool/objectool.asm`, `custom_object_code.asm`, `baserom_custom_objects.asm`. Cited as `objectool.asm:line`. The official file page is https://smwc.me/s/24217 (https://www.smwcentral.net/?p=section&a=details&id=24217). It sits behind a human-verification page and could not be read. So the patch's own header comment is the primary source for its behaviour here. The baserom ships no ObjecTool readme.
- **Romhack Races baserom 5.15** (https://github.com/romhackraces/baserom, clone at commit `60adcadb`). Its release zip is checked in as `test/fixtures/rhr-baserom-5.15.zip`. The files cited below are byte-identical in both (md5 compared). Cited as baserom `path:line`.
- **Retry System** as configured in the baserom: `tools/UberASMTool/retry_config/code/hijacks/custom_midway.asm`, `.../include/rom.asm`, `settings_global.asm`.
- **Lunar Magic 3.71** (FuSoYa), local copy `~/tools/lunarmagic/`: help file `Lunar Magic.chm`, cited as "LM help: `html/x.htm`", and `readme.txt`, cited as "LM readme:line".
- **SMWDisX** (IsoFrieze/SMWDisX, local clone `~/sources/SMWDisX`, commit `3390ee1`): https://github.com/IsoFrieze/SMWDisX. Cited as `bank_0D.asm:line`.
- **This repo**: cited as `path:line` at commit `be70af4`.
- **Experiments**, 2026-10-26: Node scripts that use this repo's own modules. The baserom is installed into the editor ROM as `tools/testcallisto.ts:94-111` does. The scripts live in the session scratchpad and are not committed. Their method is given where the results are cited.

## 1. How ObjecTool works

### 1.1 Hooks

- **Extended objects.** `org $0DA106` → `autoclean JML NewExObjects` (`objectool.asm:37-38`). In the game, `$0DA106` starts the extended-object dispatcher: `SEP #$30 : LDA $59 : TAX : JSL ExecutePtrLong`, followed by a table of 256 long pointers (`bank_0D.asm:1056-1317`). `NewExObjects` repeats the 4 overwritten bytes. For an extended number below `$98` it jumps back to `$0DA10A`, so the game's own table and every slot in it (including the editor's `$02` Direct Map16 and `$04` structures (`$03` before #117), `src/core/patches.ts:35-37`) keep working. For numbers `$98` and up it calls `JSR (ExtendedObjPtrs,x)` with X = 2 × (n − $98) and A = n − $98, then returns through an `RTS` in bank 0D at `$0DA53C` (`objectool.asm:47-64`).
- **Custom normal objects (object 2D).** `org $0DA415` → `JML NewNormObjects` (`objectool.asm:41-43`) hooks the standard-object dispatcher (`bank_0D.asm:1324-1327`). For object `$2D` it reads two extra bytes: the 4th byte becomes the custom object number (`$5A`), the 5th a second settings byte (`$58`). It advances the level-data pointer `$65/$66` by 2 ("since this is a 5-byte object"), then dispatches through `NormalObjPtrs` (256 words, 00–FF) (`objectool.asm:66-104`, `228-487`).
- **In the baserom this second hook is commented out** "for Retry Compatibility" (`objectool.asm:40-43`; baserom `docs/retry-system/objectool_info.html`). The Retry System hooks `$0DA415` itself when `!use_custom_midway_bar = 1`, which the baserom sets (`settings_global.asm:164`). It handles 2D numbers 00–1F, 40, 41, 50 and 51 as its custom midway bars. It forwards 20–3F, 42–4F and 52–FF to ObjecTool, but only if `$0DA106` holds a `JML` (`$5C`). To do that it jumps to the address at `$0DA107` + 68, "in the middle of the NewNormObjects routine … assuming the code won't change in future updates" (`custom_midway.asm:11-58`; `rom.asm:10-11`).
- The editor installs both hooks with the baserom. Experiment: after installing it, `$0DA106` = `5C 10 C0 95` and `$0DA415` = `5C 30 CB 96`.

### 1.2 Encoding in level data

The standard 3-byte object is `NBBYYYYY bbbbXXXX SSSSSSSS`, with object number `BBbbbb` (parsed the same way in `src/core/level.ts:327-372`).

| Kind | Bytes | Number | Size / settings |
|---|---|---|---|
| Custom extended object 98–FF | 3 | object 0, 3rd byte = 98–FF | none (the 3rd byte is the number) |
| Custom normal object | 5 | object 2D, 4th byte = custom number 00–FF | 3rd byte (`$59`, as for any object) and 5th byte (`$58`) |

LM help: `html/edit_insert.htm` agrees. Object 2D "was set aside as a 5 byte object for user defined purposes (do not use this object unless you've inserted code into the game for it, or in-game level parsing errors will occur)". LM help: `html/info_custom_tooltip_objects.htm` agrees too: for 2D, "the ExType value should be set to the 4th byte of the object (first value in the 'Extension' field)".

### 1.3 Where the code and tables live

`NewExObjects`, `NewNormObjects`, both pointer tables and `custom_object_code.asm` go into `freecode` (`objectool.asm:45`, `489`), so their address depends on the ROM. The only fixed anchor is the `JML` at `$0DA106` (and, where it is installed, `$0DA415`). Emulation follows it without knowing the layout.

### 1.4 Is anything in the ROM marked "defined"?

No. Both pointer tables always have every entry (`objectool.asm:112-216`, `228-487`, "Don't change them"). An undefined object is a label that shares a bare `RTS` with its neighbours. In the baserom:

- **98–DF** all share one routine, `.set_object_flag`. It takes n − $98 from X and ORs bit (n − $98) & 7 into byte (n − $98) >> 3 of `!objectool_level_flags_bank` (baserom `resources/patches/objectool/baserom_custom_objects.asm:10-97`). That table is `$7FA400` without SA-1, "13 bytes used" (baserom `shared/freeram.asm:15`). 13 bytes are 104 bits, one for each of 98–FF.
- **E0–FF** share one `RTS` (`custom_object_code.asm:10-42`).
- **CustObj00–FF** (object 2D) share one `RTS` (`custom_object_code.asm:50-306`). The square, ledge, slope and cluster helpers and tables that follow (`custom_object_code.asm:314` on) are ObjecTool's library, and nothing in the baserom calls them.

So identical pointers group objects ("these do the same thing"), but they don't separate used from unused. All of 98–DF share one routine, yet only 42 of those 72 numbers have a routine on the UberASM side (§4).

## 2. What Lunar Magic does (the floor)

- **Add Objects window.** It has the categories "All Objects", "Standard Objects", "Tile set Specific Objects", "Extended Objects", "Custom Collections of Objects" and "Direct Map16 Access". The custom collection "is mainly intended to hold custom extended objects" (LM help: `html/editor_objects.htm`).
- **Custom Collections of Objects** come from two files beside the ROM (LM help: `html/info_custom_object_collection.htm`):
  - `RomName.mw0t`: one line per entry, "a 2 hex digit command of the extended object, a tab, and then a short description".
  - `RomName.mw0`: object data "in the exact same format as you'd find the object data in the ROM": a 5-byte header (zero), the objects as if on the first subscreen, the new-screen bit starting the next group (one group per text line), and `$FF` at the end.
  - Users can add the selected objects with Ctrl+Shift+F12.
  - This was added in 3.60 (LM readme:253-256, under "Version 3.60" at line 194).
- **Custom object tooltips**, `RomName.osc` (since 3.60): `Object TAB ExType TAB Type TAB text`. For extended objects, ExType is the extended number. For 2D it is the 4th byte. Further variants:
  - type values can depend on X/Y bits or on one byte's value;
  - type 8 gives the GFX-slot hints;
  - type A gives the FG/BG GFX indexes.

  (LM help: `html/info_custom_tooltip_objects.htm`; LM readme:257-262.)
- **Unused extended objects get a placeholder.** 3.60 "made unused extended objects display a placeholder tile by default, as some hacks use these for turning on/off settings and they were sometimes displaying parts of doors in LM which would trigger exit warnings" (LM readme:249-252). The help does not say how LM decides "unused".
- **Manual insert.** For objects not in the list there is Insert Manual, with the "Size/Type/Ext" byte for the extended number and the "Extension" field for 2D's extra bytes (LM help: `html/edit_insert.htm`).
- **The baserom relies on this.** Its docs say: insert the UberASM objects "right from Lunar Magic's 'Add Objects Window' by scrolling to the end or by selecting the 'Custom Collections of Objects' category" (baserom `docs/baserom_readme/UberASM Objects.html:96`). That works only through the side files of §4.

So LM's floor is: names and tooltips from `.mw0t`/`.osc`, a placeholder instead of door garbage, and manual insert. LM does not discover custom objects itself.

## 3. How this editor does it today

- **The list.** The "Extended" tab is built from `ObjSpec`s for extended objects 10–FF (`src/ui/panels.ts:505`). An entry is kept only if it got a thumbnail: "invalid ext objects produce nothing" (`src/ui/panels.ts:541`). The name is `Extended object XX` (`src/core/names.ts:12`).
- **Thumbnails by emulation** (`src/ui/thumbs.ts:67-117`, learned in the background by `App.objectThumbs`, `src/ui/app.ts:1123-1127`):
  - The job builds test levels with 32 objects each, one per screen at x = 16·i + 3, y = 12.
  - It runs the game's level load (`LevelEmulator.load`) and collects, per object, the Map16 offsets it wrote (`touched`, recorded by the `onWramWrite` hook, `src/core/levelemu.ts:286-312`).
  - The thumbnail is the bounding box of those tiles.
  - A batch whose load fails is split in halves. An object that fails alone gets no thumbnail (`thumbs.ts:86-89`), and so does an object that wrote no tile (`thumbs.ts:98`).
- **Guards.** One frame is limited to 2,000,000 CPU steps and throws past that (`src/core/snes.ts:544-571`). A level load must reach game mode 13 within 120 frames, 600 with the sound unit (`src/core/levelemu.ts:345-348`). An object that loops forever therefore costs one failed batch and then one failed load of its own; it cannot hang the editor.
- **Normal-object sizes and types** are found by emulation as well (`src/core/objkinds.ts:1-7`), but only for objects 01–3F with their 3-byte format.
- **In the level view**, an object that writes no tile has no visible mark. It can be selected only at its origin tile (`src/ui/app.ts:858-860`).
- **Insert by number** (`src/ui/tools.ts:228-274`, acts-like LM's Insert Manual) accepts extended objects 00–FF, so 98–FF can be placed today. Its normal objects are 01–3F with a 1-byte size and no extension bytes.
- **Object 2D is not supported.**
  - `parseObjects` reads every object other than Direct Map16 and structures as 3 bytes (`src/core/level.ts:372`).
  - `.mwl` import skips 2D as 5 bytes and leaves it out with a note (`src/core/mwl.ts:140`, `144`).
  - Once Retry's or ObjecTool's `$0DA415` hook is installed, the game reads 2D as 5 bytes while the editor would write 3.

### 3.1 Experiment: which of 98–FF the list finds

Method: `renderObjectThumbs` for extended objects 10–FF in level 105, on the editor ROM (clean game + editor patches), then again after installing the baserom.

| ROM | Extended objects with a thumbnail | Of 98–FF |
|---|---|---|
| Editor ROM | 240 | all 104, each 1×2 tiles (e.g. 98: Map16 000/008, D0: 049/04A) |
| With the baserom | 136 | none |

On the clean game, entries 98–FF of the pointer table all point to `CODE_0DA6D1`. That is the routine of extended objects 47/48, which indexes a 2-byte table with n − $47 (`bank_0D.asm:1660-1675`; table entries 152–255 in `bank_0D.asm:1062-1317`). That explains the door parts LM mentions. With ObjecTool they draw nothing, so they leave the list.

### 3.2 Experiment: what emulation can tell apart without tiles

Two more probes on the baserom ROM, one extended object at a time in level 105:

1. **WRAM after the level load, compared with an empty level** (map areas `$7EC800`/`$7FC800` excluded; two empty loads are byte-identical):
   - 98–DF each change one bit of `$7FA400`–`$7FA408` (e.g. 98 → `$7FA400`, A4 → `$7FA401`, DF → `$7FA408`).
   - E0–FF change only the object loader's own state (`$57`, `$59`, `$5A`, `$65`, `$1BA1`), the same as any object.
   - Some objects also act during the load, through the UberASM init in game mode 12. 99 (lock horizontal scroll) changes `$13FF`, `$1400`, `$1411` and `$142A`; D0 (status bar) changes `$7FA411` as well.
2. **Low RAM `$0000`–`$1FFF` after the load plus 90 frames of holding right**, compared with no object (two runs without the object are identical):
   - **A difference** for 99–A3, B0, B1, BA–BF, C0–C9 and D0.
   - **No difference** for 98, B2–B4, CA, D1–D7, and all of A4–AF, B5–B9, CB–CF, D8–DF and E0–FF.

   The second group mixes undefined numbers with documented objects whose effect needs a situation the run did not create: free vertical scroll needs vertical movement; B3/B4 matter only after a death; CA and B2 are already the default state; the D1–D7 toggles disable fixes for rare glitches.

So emulation separates three classes without any table:

- **no effect at all**: E0–FF here (an `RTS`);
- **side effect only**: a RAM write outside the level, here 98–DF;
- **draws tiles**: what the list shows today.

It cannot reliably separate "defined" from "undefined" inside the side-effect class. A short play probe gives positives but no proof of absence.

## 4. What the baserom defines

- **Custom extended objects 98–DF** are reserved for the "UberASM Objects System" (AmperSam, underway, MarioFanGamer; baserom `Credits.txt:385-386`). How they work:
  - Each object sets its flag at level load (§1.4).
  - The UberASM library walks a table of `db n-$98 : dw routine` and calls the routine when the flag bit is set: in game mode 12 init, 14 main or 14 end (baserom `tools/UberASMTool/library/uberasm_objects.asm:1-103`, `uberasm_objects_routines.asm:18-83`).
- **42 numbers have a routine**: 98–A3, B0–B4, BA–BF, C0–CA and D0–D7 (`uberasm_objects_routines.asm:25-83`). The other 30 numbers in 98–DF set a flag that nothing reads.
- **Names and descriptions exist only in side files**, all in `workspace/` of the repo and the release zip:
  - `RHRv5.mw0t`: 42 lines, `98\tEnable Free Vertical Scroll` … `D7\tToggle Spin Jump`.
  - `RHRv5.mw0`: the matching 42 groups, each one extended object at X=9, Y=1, e.g. `81 09 98`.
  - `RHRv5.osc`: one tooltip for each of the 42, e.g. `0  98  0  UberASM Object 98: Free Vertical Scroll\n-----\nMakes the camera follow Mario up and down.`, plus 2D 00–41, 50 and 51 as Retry's custom midway tapes.
  - The same table, with categories, is in baserom `docs/baserom_readme/UberASM Objects.html:27-93`.
  - The editor's package upload reads none of these files today: no reference to `.mw0`, `.mw0t` or `.osc` in `src/core/callisto.ts`, `pkgsamples.ts` or `packages.ts`.
- **Custom extended objects E0–FF**: none, all `RTS`.
- **Custom normal objects (2D)**: none of ObjecTool's own (all `RTS`). Retry draws its midway tape for 2D 00–1F, 40, 41, 50 and 51 by writing Map16 `$38`/`$35` (`custom_midway.asm:71-130`). The baserom reserves those numbers, and 20–3F, 42–4F and 52–FF are free for ObjecTool (baserom `docs/retry-system/objectool_info.html`).
- **Sample level 13B** (`export/levels/level 13B.mwl`, parsed with the layer 1 format of `src/core/mwl.ts`):
  - It uses extended objects B1, B3, BA, BB, BC and D0 (retry prompt and position, the sprite status bar parts, hiding the layer 3 status bar), one each, as 3-byte objects near the top of the first screen.
  - It uses no object 2D.

## Open questions and options for triage

1. **What does "list them" mean for objects that draw nothing?** Options:
   - (a) List extended objects whose emulated load has a side effect outside the level map (98–DF here), and keep dropping those with no effect (E0–FF).
   - (b) List all extended numbers whose dispatch leaves the game's own table (98–FF here), and mark those with no effect.
   - (c) Keep the list as is and rely on Insert by number.

   In each case, an object that draws nothing needs a mark in the level view, like LM's placeholder tile. Today it is invisible and can be selected only at its origin.
2. **Names and descriptions.** Emulation gives none. Should a package upload carry LM's `.mw0t`/`.osc` (and `.mw0` groups) as data, the way PIXI's list gives custom sprites their names? That would cover the baserom's 42 names and Retry's 2D tooltips. Without them the entries can only be "Extended object B1" plus what the probe found, e.g. "sets $7FA402 bit 1".
3. **Effect probe depth.** A load-only probe separates the three classes cheaply. A play probe (§3.2) adds "this flag is read by code", but it misses situational effects. Is "sets a flag nothing reads" (A4–AF here) worth telling apart from "used", and by which signal? One candidate is code that reads the flag byte and branches on the bit, found by tracing reads of the written address in later frames.
4. **The clean game's 98–FF.** On a ROM without ObjecTool the list shows 104 door-garbage entries today (§3.1). LM 3.60+ shows a placeholder for them instead. Should the editor hide them, for example by recognizing "same routine and same tiles as another extended number"? Decided in #110: an experiment (`tools/extcodeprobe.ts`) tried "the routine reads its table data from bytes the CPU also executes as code". It finds 98–C1 and D8–FF but not C2–D7, which read the table of `CODE_0DA760` (`DATA_0DA748`, data). So the list keeps all of them and shows a custom extended number whose load reads its entry of the game's own pointer table, where the entry leads to the routine of one of the game's own numbers (no handler of its own), as an object box, like LM's placeholder (`src/core/objthumbs.ts`).
5. **Object 2D.** Custom normal objects need the 5-byte format in `parseObjects`/`serializeObjects` (and through them `src/core/levelfile.ts`), which is only valid when a `$0DA415` hook is installed. They would also need an extension field in Insert by number and a probe over the 4th byte (00–FF) and the 5th (sizes, as `objkinds.ts` does for 01–3F). This affects Retry's midway tapes too. Is that part of #104 or a separate issue?
6. **Batching risk.** Side-effect objects share one load per batch of 32 in `thumbs.ts`. An object whose init changes global state (e.g. D0 hiding the status bar, Yoshi starts) could change what its batch neighbours draw. Should side-effect probing run one object per load (104 loads here)?
7. **Credits.** If any of this is built: ObjecTool (imamelia, 0x400), the UberASM Objects System (AmperSam, underway, MarioFanGamer), Retry's custom midway (worldpeace, kkevinm), and LM's `.mw0`/`.mw0t`/`.osc` formats (FuSoYa) belong in `docs/credits.md`.
