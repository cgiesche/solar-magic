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
