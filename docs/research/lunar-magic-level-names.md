# Lunar Magic's level names

Research note, 2026-11-01 (issue #82). The question: how does Lunar Magic store the overworld's level names,
which it recodes so that every translevel has a name of its own? Its help (`ov_overworld_level_names.htm`)
describes the dialog, not the layout. The editor writes the same layout (ADR 0005), so tools and patches that
read Lunar Magic's names find the editor's.

## Method

1. **ROMs Lunar Magic saved**, read in the tools only (the editor refuses them, ADR 0004): *QW2* (2.53),
   *celery* and *Journey to Kaizo* (3.40), *Bluerio's Adventure*. `tools/lmlevelnames.ts <rom>` prints their
   hooks, compares the routine with the editor's, and lists every name as the editor reads it.
   `tools/dis.ts` disassembles the code.
2. **The game's code.** The clean game draws a name in two places. When the overworld loads, `$048E81` looks
   up the translevel's name code (`ASL : TAX : LDA $A0FC,x : STA $00`) and calls `$049D07`, which writes
   the three words as a stripe. When Mario stops on a tile, `$049549` does the same. Both start with the
   translevel in A (16 bit), read from `$7ED000`.
3. **Lunar Magic's text table**, from `Lunar Magic.exe` 3.71: the built-in table it uses for the "Edit Level
   Names" dialog, in the format of its custom table files (help `info_table_file.htm`).
4. **Emulation** (`tools/testlevelnames.ts`). The editor runs the game's code from `$049549` for every
   translevel, on the clean game and on the patched game, and compares the stripes. It also loads the
   overworld and reads the name from VRAM.

## Layout

| Place | Contents |
|---|---|
| `$048E81`, `$049549` | `JSL $03BB20`, then 6 × `NOP`: 10 bytes each, up to the game's next instruction (`$048E8B`, `$049553`). Lunar Magic writes bank `$03` or `$83`. |
| `$03BB20–$03BB71` | The routine. It is the same in all four ROMs, apart from the table's address. The exception is *Journey to Kaizo*, where another patch hijacks the routine's start. |
| `$03BB57` | The table's address: the operand of `LDA.l table,x` at `$03BB56` (long, any bank). |
| table | `0x60` translevels × 19 bytes, in a RATS block of `0x720` bytes. Translevel `t` starts at `t × 19`. |

The routine takes the translevel in A (16 bit) and computes `X = t × 19`. It appends a stripe to the buffer
at `$7F837D`, at the offset in `$7F837B`. The stripe's header is VRAM `$508B` (layer 3's tilemap, row 4 from
column 11), followed by length `$25`, meaning 38 bytes. Next come the 19 tiles, each with attribute `$39`
(BG3 tile `$100 +` the byte, palette 6, priority), and then the end mark `$FF`. Like the game's routine, it
overwrites `$00` and `$02`. A name is always 19 tiles long; space (`$1F`) fills the rest.

Each byte is a tile number of the overworld's layer 3 font. Lunar Magic's built-in table maps them to text:

| Tiles | Characters |
|---|---|
| `00–19` | `A–Z` |
| `1A–1F` | `! . - , ?` and space |
| `40–59` | `a–z` |
| `5A–5D` | `# ( ) '` |
| `64–6A`, `6B`, `AE`, `AF` | `1–7`, `0`, `8`, `9` |
| `32 33 34 35 36 37` | ` ILLUSI` (MultiChar) |
| `38 39 3A 3B 3C` | `YELLOW` (MultiChar) |

The MultiChar entries are the game's squished tiles, used in "YELLOW SWITCH PALACE" and "FOREST OF
ILLUSION". Lunar Magic uses them for new names only while "Use MultiChar Tiles" is on. Without them, it shows
the tiles as `\XX`. `\XX` stands for any tile without a character.

## The game's names

When the editor installs the patch, it emulates the game's code (`$049549` up to `$049553`) to get every
translevel's name. The 19 tiles of each name's stripe become that translevel's entry. The game leaves no tile
out: the squished tiles are copied as they are. Name code `$0000` writes spaces. The unused translevels
5D–5F have `$FFFF`, for which the game shows RAM as letters, so they get a blank name. Lunar Magic does the
same, as the clean names in *celery* show. In the test, the patched game writes the same stripe as the clean
game for all 93 translevels that have names.
