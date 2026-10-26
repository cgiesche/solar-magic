# Lunar Magic's extended object `$03` and the editor's structures

Research note, 2026-10-26 (issue #117). The question: structures were extended object `$03` with a 4th byte
(the structure number). Lunar Magic uses `$03` itself, as its "swapped screen jump" (level height 1C). Do the
two collide?

Short answer: yes. In ROMs saved by Lunar Magic 3.40, the level load takes `$03` as a 3-byte object. A
structure there puts the level data out of step: the structure number is read as the first byte of the next
object. Structures are now extended object `$04`. It has no handler in the clean game or in Lunar Magic
(empty pointer), so the level load takes it as 4 bytes only where the editor's patch installs it.

## Method

1. **The dispatcher.** In the clean game, `$0DA106` dispatches extended objects through a table of long
   pointers at `$0DA10F` (`LDA $59 : TAX : JSL $0086FA`). In the Lunar Magic 3.40 ROMs (*Journey to Kaizo*,
   *celery*), `$0DA106` is `JML $10A824` (`$10A866` in the other ROM). Numbers below `$98` jump back to
   `$0DA10A`, so they still go through the game's table. Lunar Magic fills its entries `$01` (`$0DE1D0`),
   `$02` (`$0DE1B0`) and `$03` (`$0DE1E0`). Entries `$04–$0F` are empty, as in the clean game. The
   2.53 ROM (*QW2*) fills `$02` only. Read with `tools/dis.ts`.
2. **Lunar Magic's `$03` code.** `$0DE1E0`: `LDA $0A : AND #$1F : ASL : STA $8B : LDA $0B`, then the
   screen jump's `STA $1928 : STA $1BA1`. It reads nothing past the 3 object bytes. This is the screen jump
   (`$01`, `$0DE1D0`: screen from byte 1, subscreen from byte 2) with the bytes swapped: a subscreen of 5
   bits in byte 1, the screen in byte 2.
3. **Emulation** (`tools/extobjprobe.ts`). For every number 00–97, level 105 is loaded in the editor's
   emulator with a marker object, then with the extended object in front of it as 3, 4, 5 and 6 bytes. The
   length whose map equals the marker's alone is the length the level load takes.

## Outcome

| ROM | 3 bytes | 4 bytes | 5 bytes | no handler |
|---|---|---|---|---|
| Clean game | 01 | 00 | – | 02–0F (load fails) |
| Editor ROM with structures, before #117 | 01 | 00, 03 | – | 04–0F |
| Editor ROM with structures, after #117 | 01 | 00, 04 | – | 03, 05–0F |
| *Journey to Kaizo* (Lunar Magic 3.40) | 01, **03** | 00 | 02 | 04–0F (runs whatever is at `$00:0000`) |

Numbers 10–97 are the game's extended objects (they place tiles) in every ROM. The Lunar Magic 3.31 and 2.53
ROMs at hand don't reach the title screen in the emulator, so they were only read (step 1).

So `$03` collides:

- Lunar Magic's level load takes `$03` as 3 bytes. A level with a structure would load out of step in a
  ROM where Lunar Magic installed its code. (Opening a ROM the editor saved is not supported by Lunar Magic
  anyway. Its editor takes every extended object it doesn't know as 3 bytes.)
- A level of height 1C needs `$03` as Lunar Magic's swapped screen jump. With structures there, the two
  couldn't exist in one ROM.

`$04` is the first number that is empty in both the clean game and Lunar Magic. No migration: levels saved
with structures at `$03` load out of step (early development, see `docs/patches.md`).

## Height 1C

1C is still not offered. The collision is gone, but 1C (one screen of 0x3800 pixels, 28 subscreens) also
needs the swapped screen jump itself. The level height patch would need a handler for `$03` (screen `$1928`
from byte 2), its object hook would have to read the 5-bit subscreen, and the editor's object
parser/serializer would have to write the swapped form below subscreen 15. That is a separate change.

## Side finding: extended object `$02`

Lunar Magic's `$02` (`$0DE1B0`) is a 5-byte object. It stores 2 bytes in `$19B8,x`/`$19D8,x` (the screen's
exit) for the screen in byte 1. The editor's Direct Map16 is `$02` with 6 or 7 bytes. It collides the same
way, but this note does not change it.
