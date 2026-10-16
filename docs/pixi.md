# Custom Sprites (PIXI format)

The editor inserts custom sprites in the format of [PIXI](https://github.com/JackTheSpades/SpriteToolSuperDelux)
1.4x. Resources from SMWCentral work unchanged. PIXI itself is not used: the
runtime (loader, dispatcher, shared routines) is a separate implementation of the same interface and
is put into the ROM with the built-in Asar as **one** patch, like the custom blocks.

This page describes the interface that resources see and how the editor implements it.

## In the editor

- **Upload:** *ROM → Packages … → Upload package …* with a download (`.zip` or `.asm`, also a whole
  PIXI folder). The editor recognizes
  sprites (by `.json`/`.cfg`) and misc sprites (`.asm` with `print "MAIN ",pc` in a folder of their type);
  custom blocks in the same upload are block parts of their own ([patches.md](patches.md)). Each sprite gets
  the next free number of its type. Defines in any file of the package that refer to one of its sprites are set to its number,
  recognized by the file name in the comment (`!Sprite = $18 ; Sprite number of BrutalBill.json`)
  or by a misc type in the name (`!bounce_sprite`).
- **Configure:** *Sprites* tab in the Packages dialog, a configuration view: assign and unassign entries of
  the `list.txt` (sprite → number), each with the package it comes from; settings of the files;
  export of a PIXI folder as `.zip`. Sprites are only added by uploading a package and removed with the
  package; an unassigned entry leaves the files in the project. Everything is recorded in the ROM as one patch
  with its sources.
- **Place:** under *Sprites*, the palette shows a section "Custom Sprites (PIXI)" with the names from
  `Collection` and the graphics the game draws – like Lunar Magic, only the variants (extra bit
  clear/set) that `Collection` lists; without `Collection` (`.cfg`) the one without the extra bit. The
  properties show the extra bytes; sprites with extra bytes other than 0 get their own image. When
  inserting by number, extra bits 2/3 count as a custom sprite.

## Types and folders

| Type | Folder | Numbers | File in `list.txt` |
|---|---|---|---|
| Sprite | `sprites/` | 00–BF | `.json` or `.cfg` (points to the `.asm`) |
| Shooter | `shooters/` | C0–CF | `.json` or `.cfg` |
| Generator | `generators/` | D0–DF | `.json` or `.cfg` |
| Cluster | `cluster/` | 00–7F | `.asm` |
| Extended | `extended/` | 00–7F | `.asm` |
| Minor Extended | `misc_sprites/minorextended/` | 00–3F | `.asm` |
| Bounce | `misc_sprites/bounce/` | 00–3F | `.asm` |
| Smoke | `misc_sprites/smoke/` | 00–1F | `.asm` |
| Spinning Coin | `misc_sprites/spinningcoin/` | 00–1F | `.asm` |
| Score | `misc_sprites/score/` | 00–1F | `.asm` |

Each folder may have a `_header.asm`; it is included in every file of that type.

### `list.txt`

```
00 Blue.json
C0 BrutalBillShooter.json
D0 Generator.cfg

CLUSTER:
00 flower.asm

BOUNCE:
01 shatter_aftertouch_bounce.asm
```

Sections: `SPRITE:` (default), `CLUSTER:`, `EXTENDED:`, `MINOREXTENDED:`, `BOUNCE:`, `SMOKE:`,
`SPINNINGCOIN:`, `SCORE:`. Additions such as `display`/`nodisplay` (only for Lunar Magic) are ignored.

**Not supported:** per-level sprites (`105:B0 file.cfg`, PIXI option `-pl`). B0–BF are normal
sprites.

### Numbers in the game

The misc sprites share their numbers with the original sprites of their type. Custom sprite *n* has
the number *n* + offset in the game:

| Type | Offset (`!…Offset`) |
|---|---|
| Cluster | `$09` |
| Extended | `$13` |
| Minor Extended | `$0C` |
| Smoke | `$06` |
| Spinning Coin | `$02` |
| Bounce | `$08` |
| Score | `$16` |

So a block that spawns bounce sprite 01 writes `!bounce_sprite+$08` = `$09` to `!bounce_num`.

## Sprites in the level data

An entry consists of 3 bytes plus the sprite's extra bytes:

```
Byte 0: YYYYEEsy   Y = row, EE = extra bits, s = screen bit 4, y = row bit 4
Byte 1: XXXXSSSS   X = column, S = screen bits 0–3
Byte 2: number
Byte 3…: extra bytes (0–12)
```

- `EE` bit 1 (`$08` in byte 0) is the **custom flag**, bit 0 (`$04`) the **extra bit**. Values 0/1 are
  original sprites, 2/3 custom sprites without/with extra bit.
- The length of an entry comes from a size table of `$400` bytes: index
  `EE × $100 + number`, value = 3 + number of extra bytes. The count is in the cfg/json, separately for
  extra bit clear and set. Its address is at `$0EF30C`, as with Lunar Magic and PIXI,
  valid with `$42` at `$0EF30F`.
- The game's loader reads the list with an 8-bit index. When the index exceeds `$80`, the runtime advances the
  pointer `$CE` and resets it at the end of the loop. That way long lists with extra bytes fit too.
- `.smwlevel` files contain the size table their sprite data was written with.
- If the count changes for a sprite that is already placed in levels, the editor rewrites those levels
  right away along with the change, like PIXI's MeiMei.

## Runtime RAM

| Define | Address | Contents |
|---|---|---|
| `!extra_bits` / `!7FAB10` | `$7FAB10,x` | Extra bits: `$08` = custom, `$04` = extra bit |
| `!new_code_flag` / `!7FAB1C` | `$7FAB1C,x` | Custom code active |
| `!extra_prop_1/2` / `!7FAB28/34` | `$7FAB28,x` / `$7FAB34,x` | Extra property bytes from the cfg/json |
| `!new_sprite_num` / `!7FAB9E` | `$7FAB9E,x` | Custom number |
| `!extra_byte_1…4` | `$7FAB40/4C/58/64,x` | Extra bytes; from 5 bytes on, a 24-bit pointer to the bytes in `extra_byte_1…3` |
| `!shooter_extra_byte_1…3` | `$7FAC00/08/10,x` | Extra bytes of shooters; from 4 bytes on, a pointer |

`!extra_prop_2` bit 7: MAIN runs in every status instead of the original code; bit 6: MAIN runs in every
status in addition.

## Code entry points

- **Sprite:** `print "INIT ",pc` (status `$01`) and `print "MAIN ",pc` (status `$08`), both with `RTL`.
  Optionally `CARRIABLE` (`$09`), `KICKED` (`$0A`), `CARRIED` (`$0B`), `MOUTH` (`$07`), `GOAL` (`$0C`); they
  replace the original code of that status, the DBR is set.
- **Shooter, generator:** `MAIN`, every frame (shooters after their timer, generators not during `$9D`).
  `!shoot_num` and `$18B9` respectively contain `$80` (custom), the extra bit as `$40`, and number − `$BF` or − `$CF`.
- **Extended:** additionally `print "CAPE",pc` for contact with the cape.
- **Misc sprites:** `MAIN`, with X = slot and the DBR set to the routine's bank.
- Public entry points as in PIXI: `JSL $0187A7` sets up the custom sprite in slot X (number in
  `!new_sprite_num`, `$00-$02` = INIT), `JSL $01D43E` runs the original code of the status in A.
- `print "VERG<version>"`: minimum PIXI version. The editor counts as 1.43.

## cfg and json

**cfg:**
```
<type>
<acts like>
<$1656> <$1662> <$166E> <$167A> <$1686> <$190F>
<extra property 1> <extra property 2>
<asm file>
<bytes without extra bit>:<bytes with extra bit>
```
All values are hexadecimal. If the colon in the last line is missing (old format), both counts are 0.

**json:** `Type`, `ActLike`, `AsmFile`, `Extra Property Byte 1/2`,
`Additional Byte Count (extra bit clear/set)` (decimal, at most 12), the tweakers as objects `"$1656"`
… `"$190F"` with named bits, plus `Collection` (names) and `Displays` (description). `Map16`,
`GFXInfo` and the tile data in `Displays` are meant for Lunar Magic and are ignored, because the
editor shows sprites via emulation.

**Type:** 0 = "tweak" (original sprite `acts like` with changed tweakers, no code of its own),
1 = custom sprite. Shooters and generators are recognized by their number range.

## Shared routines

Called as `%Name()`. Subfolders are prepended without a separator (`routines/Bounce/GetDrawInfo.asm`
→ `%BounceGetDrawInfo()`). Each routine is only inserted if it is used. Your own files in
`routines/` take precedence over the built-in ones.

Built in are the routines of PIXI 1.43 with the same inputs and outputs. They are written after the game's
routines; their tables (sine, OAM indices, speeds) are read from the ROM, and where
the game has a suitable routine, it is called (e.g. `FinishOAMWrite` = `$01B7B3`):

- **General:** `Aiming`, `CapeContact`, `ChangeMap16`, `CheckForContactAlternate`, `CircleX`,
  `CircleXY`, `CircleY`, `FinishOAMWrite`, `FireballContact`, `GetDrawInfo`, `GetMap16`, `LoseYoshi`,
  `Random`, `ReplaceSelf`, `SetPlayerClippingAlternate`, `SetSpriteClippingAlternate`, `ShooterMain`,
  `Star`, `SubHorzPos`, `SubOffScreen`, `SubVertPos`.
- **Spawn:** `SpawnSprite`, `SpawnSpriteSafe`, `SpawnSmoke`, `SpawnSmokeGeneric`, `SpawnExtended`,
  `SpawnExtendedGeneric`, `SpawnClusterGeneric`, `SpawnMinorExtendedGeneric`,
  `SpawnMinorExtendedOverwriteGeneric`, `SpawnScoreGeneric`, `SpawnSpinningCoinGeneric`.
- **Bounce:** `GenericDraw`, `GetDrawInfo`, `SetMarioSpeed`, `SetSpeed`, `SetSpriteSpeed`, `SetupMap16`,
  `UpdatePos`.
- **Cluster:** `GetDrawInfo`, `Speed`.
- **Extended:** `CapeClipping`, `GetDrawInfo`, `Hurt`, `Speed`.
- **MinorExtended:** `GetDrawInfo`, `Speed`.
- **Score:** `GenericDraw`, `GetDrawInfo`, `UpdateYPos`.
- **Smoke:** `GenericDraw`, `GetDrawInfo`.
- **SpinningCoin:** `GetDrawInfo`, `UpdateYPos`.

## Defines

Every file sees the defines of PIXI's `sa1def.asm` for a ROM without SA-1:

- `!sa1 = 0`, `!SA1`, `!SA_1`, `!Base1 = $0000`, `!Base2 = $0000`, `!dp`, `!addr`, `!bank`, `!BankA`,
  `!BankB`, `!bank8`, `!SprSize = $0C`, `!CustomBit = $08`, `!GenStart = $D0`.
- `!…Offset` (see above) and `!…Size` for each misc type.
- The sprite tables (`!sprite_num`, `!9E` …), plus `!shoot_…`, `!cluster_…`, `!extended_…`,
  `!minor_extended_…`, `!smoke_…`, `!spinning_coin_…`, `!score_…`, `!bounce_…`.
- `!sprite_load_table` / `!1938` = `$1938`. PIXI's relocation to `$7FAF00` for 255 sprites per level does
  not exist in the editor.
- Macros `%BES()`, `%BEC()`, `%Between()`, `%debugmsg()`.

## Implementation

Assembly happens in several Asar runs that are recorded together as one patch:

1. the shared routines in use, each once (routines that call others pull those in);
2. each sprite on its own, with the defines, the routines as `%Name()` → `JSL` and the `_header.asm` of its
   type (one of your own in the project takes precedence). That way labels and macros of different sprites don't interfere.
3. the runtime with the tables, filled from the cfg/json and the sprites' `print` output.

The runtime's hooks (all in bank 01/02/07; for misc types only if the project uses them):
load loop `$02A82A`/`$02A846`/`$02A936`/`$02A9D7`/`$02ABE9`, extra bits `$02A94B`/`$02A963`, spawn
`$02A9C9`, shooters/generators `$02A866`/`$02ABA0`/`$02B395`/`$02AFFE`, status `$018127`/`$018151`/
`$018172`/`$0185C3`, tables `$07F785`, public `$0187A7`/`$01D43E`; misc dispatchers `$029052` (bounce),
`$02F818`/`$00A686` (cluster), `$029B1B`/`$029633` (extended), `$028B6C` (minor extended), `$0296C0`
(smoke), `$0299D4`/`$028A7D` (spinning coin), `$02ADBA` (score). Free RAM: the sprite tables (above) and `$7FAC18-$7FAC19`, claimed in the patch registry (see
[Free RAM](patches.md#applying-patches)).

If the number of extra bytes changes for a sprite that is placed in levels, the editor rewrites those levels
right away with the new size along with the change (extra bytes are kept as far as they fit), like PIXI's MeiMei. On
removal, the extra bytes are dropped.

## Limitations

- No SA-1, no per-level sprites, no relocation of `$1938` (255 sprites per level), no "run-once"
  sprites beyond DF.
- `asm/ExtraDefines` and `asm/ExtraHijacks` are not evaluated. Custom hijacks belong in a
  normal patch.
- ROMs into which sprites have already been inserted with PIXI are not recognized.
