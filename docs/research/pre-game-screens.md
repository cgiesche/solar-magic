# Everything before the first overworld: terms, data, community content, and how to edit it

Research note, 2026-11-18. The question: everything the game shows before the player first sees the overworld should
become editable – asked as "player select, save file select, demo gameplay, welcome screen". What are these things
called, where do they live, what does Lunar Magic cover, which community content touches them, and how could the
editor make them editable? The editor so far edits the title screen's layer 3 (`src/core/titlescreen.ts`, #92) and
the start position; that commit left "the title screen demo" for its own ticket.

## Sources

- **SMWDisX**, local clone `~/sources/SMWDisX`, commit `3390ee1` (https://github.com/IsoFrieze/SMWDisX): `bank_00.asm`,
  `bank_05.asm`, `rammap.asm`, `constants.asm`, `SMW_U.sym` (US addresses). Cited as file and label.
- **Lunar Magic 3.71 help** (FuSoYa), `~/tools/lunarmagic/Lunar Magic.chm`, cited as `html/x.htm`.
- **SMW Central hijack map**, local export `resources_local/hijack-list.csv`, cited as "hijack map `$addr`". It names
  each resource and its author; it is the only SMW Central source that could be read (see "Not reached").
- **UberASM Tool 2.1 readme** (Vitor Vilela, Fernap): https://fernap.github.io/UberASMTool/readme_2_1.html
- **Retry System docs** (Kevin): https://kkevinm.github.io/retry-system/
- **Romhack Races baserom**, branch RHRv5: https://github.com/romhackraces/baserom (`resources/patches/tweaks.asm`,
  `setup/lists/list_uberasm.txt`, `Credits.txt`).
- **VWF Dialogues manual** (RPG Hacker): https://rpghacker.github.io/SMW-Workspace/vwf/manual
- **Emulation**: `node tools/boot.ts 2600` on the clean game (`test/fixtures/smw.smc`) for the mode sequence.
- Repo files as `path:line`.

**Not reached:** smwcentral.net itself. Its pages answer automated requests with a human-verification question, which
was not answered. So the resource pages (descriptions, download counts, featured marks), the ROM/RAM map pages and
the hack submission guidelines are not sources of this note. Everything that would need them is marked *unverified*.
Read by the disassembly, the data and code facts below don't depend on them.

## Result

### Terms

| Described as | Term | Aliases, to avoid | Game modes `$0100` |
|---|---|---|---|
| the logo at power-on | **Nintendo Presents** | "intro logo", "presents screen" | 00 load, 01 show |
| welcome screen | **Title screen**: the title screen level (C7 in the clean game), its layer 3 picture and its colours | "welcome screen", "start screen" | 02 fade, 03 load, 04 prepare, 05 fade in, 06 spotlight, 07 |
| demo gameplay | **Title screen movement** (SMWDisX), Lunar Magic: **Title Moves** | "demo", "attract mode" | runs in 07 |
| save file select | **File select** | "save select", "file menu" | 08 |
| – | **File erase** (SMWDisX: file delete; on screen "ERASE DATA") | | 09 |
| player select | **Player select** ("1 PLAYER GAME / 2 PLAYER GAME") | "player count" | 0A |
| "Welcome to Dinosaur Land" | **Intro**: the intro level (C5) showing the intro message (level 0's message 1) | "intro cutscene", "welcome message" | 10–14, on a new file only |
| – | **Save file** (one of three in SRAM), **new file data** (what an empty file starts with) | "savegame" | – |

The whole is proposed as the **pre-game**: everything from reset to the first overworld (game mode 0E). None of
these terms is in `CONTEXT.md` yet, except "Title screen", which there means only the layer 3 picture and asks to
avoid "title screen level" – that needs widening once this is decided.

`src/core/ram.ts:11` names `0x0A` `GM.fileSelect`; it is player select, file select is `08` (`rammap.asm`
`!GameMode_FileSelect = 8`, `!GameMode_PlayerSelect = 10`). Issue filed.

### What is where, who edits it today

| Piece | Data (US) | Lunar Magic | The editor today |
|---|---|---|---|
| Nintendo Presents | 4 OBJ: `NintendoPos` `$009389`, `NintendoTile` `$00938D`; timer 64 frames; coin sound | – | – |
| Title screen level | level C7, loaded through `$0109` = `$24+$C7` | level editor | level editor; found by emulation (`titleScreenLevel`, `levelemu.ts:625`) |
| Title screen picture | stripe image 03 `TitleScreenStripe` `$05B375`, 905 bytes | "Load/Save Title Screen" | Game workspace (#92) |
| Title screen colours | `TitleScreenColors` `$00B62C` → palettes 0–1, colours 8–F | palette editor | *not checked* |
| Title screen movement | `TitleScreenInputSeq` `$009C1F`, 69 bytes | recording ASM + savestate, own playback code | – |
| File select / erase / player select text | stripes `$05B7C9` (169) / `$05B6FE` (203) / `$05B872` (85) | – | – |
| Menu cursor | `CursorCoords` `$009E74`, `CursorOptCount` `$009E6A`, tile `$3D2E` | – | – |
| Exit count on a file | drawn into the stripe; star tiles at ≥ 96 | – | – |
| Intro level | `$009CB1` = `$E9` (`$24+$C5`) | level editor (C5) | level editor; play always skips it |
| Intro message | level 0 message 1 | message editor; "Save game after intro message" | message editor |
| New file: start position | `InitPlayerOverworldData` `$009EF0`, 22 bytes | overworld sprite mode | yes (`owsprites.ts`) |
| New file: level flags | `$009EE0` (8 pairs); Lunar Magic `$05DDA0` | yes | yes |
| New file: lives | `LDA #4` in `LoadSaveAndFadeToOW`, operand `$009E25` | – | – |
| Save file layout | 3 × 143 bytes at `$700000` + backup at `$7001AD` | – | written for event progress |

### Recommendation in short

1. **Show every pre-game screen in the Game workspace by emulation** – Nintendo Presents, title screen, file select,
   file erase, player select – as the title screen already is: boot, drive the game into the mode, take the picture.
   A patch that redraws a screen then shows as it is, without the editor knowing the patch.
2. **Edit the three menu texts as layer 3 tilemaps** with what `titlescreen.ts` has (stripe → tilemap → stripe, RATS
   block, repoint). Lunar Magic can't do this.
3. **Record title screen movement in the editor's own play session**, replay it after every change that could move
   it out of sync, and say so. Lunar Magic needs an external emulator, a savestate and an ASM installed and removed
   by hand, and only warns in its help that changes break the recording.
4. **A "Start of game" page**: intro on/off and its level, lives, start position, initial flags in one place.
5. **Play from power-on** as a `PlaySession` start, to see all of it in sequence.
6. **Recognize, don't replace, the community's save and menu patches** (Retry System first).

Details and open points per piece in section 5.

## 1. The sequence from reset to the first overworld

Emulated on the clean game (`tools/boot.ts`): mode 00 at frame 0, 01 at 51, 02 at 158, 03 at 186, 04 at 202, 05 at
257, 06 at 290, 07 at 365. Without input the title screen movement ends at frame 1792 (1427 frames of mode 07), the
game goes to 02 and loads the title screen again; 07 is back at frame 1996.

From `bank_00.asm`:

1. **00/01** `GM00LoadPresents`, `GM01Presents`: draws the logo, waits `!NintendoPresentsTimer` (64) frames.
2. **03** `GM03LoadTitleScreen` puts `!MainMapLvls+!TitleScreenLevel` (`$24+$C7`) into `$0109` (`OverworldOverride`)
   and runs the normal level load (`GM11LoadLevel`). **04** runs the level's preparation and uploads stripe image 03.
3. **07** `GM07TitleScreen` runs the level (`GM14Level`) every frame with input taken from `TitleScreenInputSeq`.
   A/B/X/Y/Start/Select in 06 or 07 leads to `PrepareFileSelect` (`$009C9F`).
4. `EnterFileSelect` (`$009CB0`): `LDA #$E9 : STA $0109` – the intro is armed – then `InitSaveData` fills the save
   buffer with a new file's data and the file select is drawn. Mode **08**.
5. Choosing a file whose checksum holds copies it from SRAM over the buffer and clears `$0109`. An empty file keeps
   the new file data and the armed intro. "ERASE DATA" leads to **09**.
6. **0A** player select, then `LoadSaveAndFadeToOW` (`$009E17`): lives 4, coins, power-up and item box cleared. **0B**.
7. **0C** `GM0CLoadOverworld` (`$00A087`): if `$0109` is not zero, the overworld is skipped – submap 0, mode `$10` –
   and the level `$0109 − $24` loads: C5.
8. Level C5 holds one sprite, `$19`, which shows the level's message 1. When the message closes, the game clears
   `$0109` and sets mode `0B`: the overworld appears for the first time.

So the intro shows exactly when a file is new, and the intro level is whatever `$009CB1` says.

## 2. The data

### 2.1 Nintendo Presents

Four 16×16 OBJ at Y `$70`, X from `NintendoPos` (`$60,$70,$80,$90`), tiles from `NintendoTile`
(`$02,$04,$06,$08`), attribute `%00110000`. The timer's operand is at `$0093C6` (hijack map). *Not checked:* which
graphics file the four tiles come from, and the logo's colours.

### 2.2 Title screen movement

`TitleScreenInputSeq` `$009C1F`–`$009C63`: 34 pairs of (buttons, frames) and `$FF`. PAL has its own table. The
button byte is the joypad's `byetUDLR` (B, Y, Select, Start, Up, Down, Left, Right); Select is not passed on as held
but marks "Y newly pressed this frame". At `$FF`, `FadeOutBackToTitle` (`$009C89`) sets mode 02. Index `$1DF4`.

69 bytes in place; a longer recording needs other code. Lunar Magic replaces the playback (`$009C6F`, 17 bytes,
hijack map) and installs a recording hijack (`$00A1DA`, 10 bytes) that writes WRAM "starting with the overworld
event tiles" (`html/ov_file_install_recording.htm`). *Unknown:* where and in which format Lunar Magic stores its
playback data and how long it may be. The help says nothing; it would have to be learned from a ROM Lunar Magic
saved (`tools/_lmdis.ts`, `tools/lmctl.c`).

### 2.3 The menus

All are stripe images on layer 3 (BG3 only, no Mode 7), bank 05:

| Stripe | Address | Bytes |
|---|---|---|
| `EraseFileStripe` | `$05B6FE` | 203 |
| `FileSelectStripe` | `$05B7C9` | 169 |
| `PlayerSelectStripe` | `$05B872` | 85 |
| `ContinueSaveStripe` (the save prompt) | `$05B8C7` | 85 |
| `ContinueEndStripe` (after game over) | `$05B91C` | – |

Stripe format: VRAM address (2 bytes, high first), length − 1 (2 bytes, high first; `$40` in the high byte =
run-length), tile words (tile, `YXPCCCTT`), `$FF` at the end. The same format as the title screen's stripe 03.

What the game draws on top, which an editor of these texts has to respect:

- The chosen stripe is copied to the stripe buffer (`$7F837D`) and each file's **exit count** is written into it as
  decimal digits; at `!TotalExitCount` (96) and above, two fixed tiles (`$87/$88`, the star) instead. An empty or
  broken file gets the rest of "EMPTY" blanked with `!EmptyTile` (`$38FC`). The positions written to are constants
  in the code (hijack map `$009D7C`, `$009D96`, `$009D9B`: the "100 Exits" patch moves them).
- The **cursor** is tile `$3D2E` at a VRAM address per menu from `CursorCoords` `$009E74` (continue/end `$51CB`,
  file select `$51E8`, player select `$5208`, save prompt `$51C4`, file erase `$51E5`), rows 64 apart, the number of
  options from `CursorOptCount` (2, 4, 2, 2, 4).

So text and layout can move freely only together with the cursor's place and the exit count's place.

### 2.4 Save files

`!SaveFileSize` 143 bytes; files at `$700000`, `$70008F`, `$70011E`, a backup of all three from `$7001AD`. Checksum
2 bytes at offset `$8D` (`$5A5A −` sum), exit count at `$8C`. `VerifySaveFile` (`$009DB5`) falls back to the backup.
The buffer in WRAM is `$1F49` (`RAM.fileLevelFlags` on). Lives are not saved.

## 3. Lunar Magic

Edits: the title screen picture ("Load Title Screen" / "Save Title Screen", overworld editor's File menu), the
title screen level and the intro level in the level editor, the intro message ("Level 0 message 1 is used for the
intro"), "Save game after intro message" (Extra Options), the start position, and the Title Moves:

- "Install Title Moves Recording ASM" → play the level in ZSNES or Snes9x, make a savestate where the demo should
  end → "Insert Title Moves Playback ASM & Data" reads the savestate → "Uninstall Title Moves Recording ASM".
  "Export Title Moves Playback Data" writes the data out as a fake ZSNES savestate.
- Its warnings (`html/ov_file_install_recording.htm`): a change to the level or to custom block ASM after recording
  changes the timing; if Mario dies in playback the player is put in control and the level repeats forever; green
  berries, leaving the level, Yoshi's greeting message and a passed Special World break the recording; forgetting
  to uninstall the recording ASM overwrites RAM in play.
- It also fixes the title screen level's background colour under the file select and file erase menus (hijack map
  `$009CD3`, `$009B1C`).

Doesn't edit: Nintendo Presents, the three menus' text, the cursor, the lives, whether there is an intro.

## 4. Community content

From the hijack map unless noted. "Detect" means the editor must notice it and leave its bytes alone; "host" means
it installs as a package and the editor's pre-game pages must still show the truth.

| Resource | Author | What it changes | For the editor |
|---|---|---|---|
| Retry System | Kevin | save `$009BCB`, load and new file `$009CF5`, lives `$009E25` (`!initial_lives`), own SRAM table and size `$00FFD8`; death on the title screen (`!title_death_behavior`) (docs) | detect: lives and what is saved belong to Retry's settings then. In the RHR baserom |
| BW-RAM Plus, SRAM Plus | *unverified* | save `$009BD2`, new files `$009CF5` (BW-RAM Plus); exclude Retry's saving (Retry docs) | detect |
| UberASM Tool game mode code | Vitor Vilela, Fernap | hook `$009322`; `init`/`main`/`end`/`nmi` per `$0100`; level NMI also in modes 05–07 since 2.1 (readme) | hosted already (`uberasm.ts`); the pre-game modes need names in the UI |
| One File, One Player | Kevin | 9 places from `$009CB8`, rewrites `PlayerSelectStripe` | host; file and player select then don't exist |
| "No Title, No Intro, No Problems" | Kevin | 6 places from `$009391` | host; most of the pre-game doesn't exist then |
| Sprite Title Screen Menus | Kevin | `$009AC2`, `$009D22`, `$009D3C`, `$009EDB`: menus as sprites, stripes cleared | host; menu text is not a stripe then |
| File Select Sprite Cursor | MarioFanGamer | 10 places, replaces `$009E6A` (118 bytes, incl. `CursorCoords`) | host; cursor table gone |
| Playable Title Screen | Kevin | `$00942B`, `$0096BE`, `$009C67` | host; no title screen movement then |
| Multiple Title Screen Demos | Arinsu | 14 places incl. `$009C6C`, `$009CB1` | host; several levels and recordings |
| Exit Percentage on File Select | KevinM | `$009D6C`–`$009D9B` | host; conflicts with 100 Exits |
| 100 Exits | Alcaro | same places: exit count threshold and digit positions | host |
| 128x128 Nintendo Presents Logo | Kevin | `$00939A`, `$0093C6`, `$0093D4` | host |
| Nintendo Presents Logo Expansion | Roy, ghettoyouth | `$00939A`, `$0093B4` | host |
| Intro Logo Patch; Nintendo Presents Custom Palette | Roy | `$009394`, `$00940F`; `$0093D7` | host |
| Mode 3/8bpp Nintendo Presents Screen | Arinsu | 6 places from `$0081CE` | host |
| Random Intro Level | Arinsu | `$009CB0` | host; intro level is not one number then |
| Automatic Intro Message Dismiss | KevinM | `$05B16E` | host |
| Restore and Customize Overworld Intro March | Kevin | `$009F1D` | host |
| Return to Title | MarioFanGamer | `$048284` | host |
| Title Window Cleaner | Alcaro | garbage tiles on the title screen from overworld sprites (RHR docs) | in the RHR baserom |
| VWF Dialogues | RPG Hacker | can replace message boxes; SRAM to 128 KB without SA-1 (manual) | the intro message is then not the game's |
| Individual Dragon Coin Save | worldpeace, JackTheSpades, lx5 | `$0096B4` and others | in the RHR baserom; adds saved data |
| Overworld Indicators | *not named* | save, load, erase (`$009BCC`, `$009CFB`, `$009B43`), SRAM size | detect |

The Romhack Races baserom leaves the pre-game's flow as the game has it. Its `tweaks.asm` holds three small edits
of it: `$00A09C = $04` (shorter wait before the intro message can be closed), `$009D30` five NOPs (no dark palette on
the file erase screen), `$00913F`/`$009170` (the "S" of "MARIO START"). Its `list_uberasm.txt` uses no pre-game
mode and names 01 "Nintendo Presents", 07 title screen, 08 file select.

Three things follow:

- **Kevin's patches and Retry dominate** this area. Retry is the one a normal hack has.
- **Almost every byte of `$009389`–`$009F20` is somebody's hijack.** An editor that writes these addresses from
  tables would collide. Reading by emulation and writing only data the game was seen to read is what keeps it safe.
- **Several patches remove a screen altogether.** The pages must come from what the game does, not from a fixed
  list.

*Unverified, not found at any reachable source:* a stripe image editor "Terra Stripe" and its author; the authors of
SRAM Plus and BW-RAM Plus; UberASM resources written for the pre-game modes; what SMW Central's hack submission
guidelines ask of a title screen.

## 5. Making it editable

What exists: `LevelEmulator.boot` (`levelemu.ts:152`) runs from reset to mode 07 and keeps that state;
`untilOverworld` (`:518`) presses its way through file and player select and zeroes `$0109`; `titlescreen.ts` reads
the title picture from VRAM after boot, finds stripe 03 through its pointer and writes a new stripe as a RATS block;
`PlaySession` (`playsession.ts`) starts every play after the file select; UberASM game mode code installs.

### 5.1 Pages by emulation

Each pre-game screen is a state the emulated game reaches from boot by a known input: nothing (Nintendo Presents,
title screen), a button (file select), choosing ERASE DATA (file erase), choosing a file (player select). The Game
workspace lists the screens the game actually reached, each with its picture. A ROM with One File, One Player shows
no player select because mode 0A never comes. This costs a few hundred frames once per ROM change, as boot does.

### 5.2 Menu texts

For each menu: watch which ROM bytes the game copies to the stripe buffer on entering the mode. If they are a stripe
in the format above, the page edits it as a tilemap with the title screen's editor. Shown on the tilemap, read from
the emulated screen rather than from tables: the cursor's positions (the cells where the cursor tile appears as the
selection moves) and the cells the game overwrites (compare the stripe with the screen for an empty file, one with
some exits, one with all). Moving those – cursor table, digit positions – is a second step; the first is text and
tiles around them, with a warning when an edit covers a cell the game overwrites. If the bytes are not a stripe
(Sprite Title Screen Menus), the page shows the picture and says what draws it.

A new stripe that is longer than the old one goes to free space; unlike stripe 03, these are found through code
(`DrawFileSelect`'s index), not through the `StripeImages` pointer table. *Open:* whether they can be repointed
without a hijack. In place, with the same length, always works.

### 5.3 Title screen movement

Recording in the editor: a play session of the title screen level from the title screen's own state (mode 07, the
game's own setup of the level, not a play entered from the overworld as Lunar Magic's recording is – so what the
help warns of, a passed Special World or Yoshi's greeting, can't differ between recording and playback), the pad logged per frame, run-length encoded into pairs. Stop ends the recording.

- Up to 34 pairs fit the game's table in place, with no code changed. The clean game's demo is 1427 frames.
- Longer needs playback code. *To decide after learning Lunar Magic's format:* write that format (a hack recorded
  in Lunar Magic stays editable, and the reverse), or the game's own format at another address.
- **Sync check:** the editor replays the recording after a change to the level, its sprites, blocks or code and
  compares it with the run recorded (Mario's position at the end, whether he died, whether the level was left). Out
  of sync shows as a problem on the title screen page instead of being found by players.
- The page shows the recording as a timeline of buttons over the level, with the picture at the playhead.

### 5.4 Nintendo Presents

The picture by emulation; the four tiles' positions and numbers and the time as fields, found by watching what the
mode reads. Anything bigger is what the community's patches are for (section 4); the editor hosts them and shows the
result.

### 5.5 Start of game

One page: the intro (on or off, its level, its message with a link to the message editor, whether the game saves
after it), lives, start position, initial flags. The intro level is found as the title screen level is: by which
level a new file loads. *Inferred from the code, not tried:* `$009CB1 = $00` leaves `$0109` zero and so skips the
intro; to be tried by emulation before it becomes the editor's "no intro". Lives are a field only while the operand
at `$009E25` is what the game reads; with Retry installed the page names Retry's `!initial_lives` instead.

### 5.6 Play from power-on

`PlaySession.start` gets a start at reset, with the SRAM the user chooses: empty (the intro plays) or the save of an
event progress (the file shows its exit count). Level test play keeps skipping the intro.

### 5.7 Save scheme

Before the editor writes a save file for event progress, it should know whose layout it is: the game's 143 bytes, or
a patch's. Today it assumes the game's. Detection by what the save routine does in emulation (which SRAM bytes a
save writes), not by patch names.

## Open questions

1. Lunar Magic's Title Moves playback: where is the data, which format, which limit? Needed for 5.3.
2. Can the menu stripes move to free space without a hijack (5.2)?
3. Which graphics file and palette draw the Nintendo Presents logo (2.1)?
4. Is the status bar hidden on the title screen by the mode or by the level, and what does death do there in the
   clean game (Lunar Magic's help describes it only for its own playback)?
5. Do the save prompts ("CONTINUE AND SAVE", "CONTINUE / END") belong to the same pages? Same stripes and cursor
   table, but they are not pre-game.
6. The SMW Central items marked unverified in section 4, to be read by a person.
7. Japanese and PAL ROMs differ here (own demo table, `DrawFileSelect` differs in J). Out of scope while only the
   US game and hacks of it are supported?
