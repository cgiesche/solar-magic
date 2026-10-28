# FastROM's jump targets are found by emulating the clean game

The editor's ROM becomes FastROM (CONTEXT.md), an editor patch installed when the clean game is opened (ADR 0004). Setting the header bit, writing `$420D` and entering the game in bank `$80` is enough for correctness, but every `JSL $0xxxxx` in the game's code drops back into the slow banks until its `RTL`. Most of a frame's work, the sprite code in banks `$01`/`$02` among it, is reached that way, so FastROM pays off only when those jump targets are moved to `$8x` too. Lunar Magic's FastROM (Callisto's `fastrom.bps`, LM 3.63) rewrites about 900 JSL operands, about 700 bank bytes of 24-bit pointer tables and 24 data-bank setups.

We decided that the sites are found by a tool that emulates the clean game (boot, title screen, overworld and every level, as the tests play them) and records each long jump and each long indirect jump through a table that goes into a bank `$00`–`$3F`. Its result is checked in as generated data that the patch applies when the clean game is opened. Data accesses and data-bank setups stay in the slow banks: they are correct there and not worth the effort. A site the tool never runs stays slow and correct. The rewritten bank bytes are not hooks of the editor (a third-party patch may overwrite them), and the clean game's fingerprint (SMWF) compares its blocks with them reverted, so a BPS against the clean game still finds the clean game's bytes.

## Considered options

- Only the header, `$420D` and the vector stubs: rejected, most of the game would still run slow.
- Lunar Magic's list, taken from the diff of `fastrom.bps`: rejected. It is knowledge copied from another tool rather than derived from the game, and it misses sites (`$00:F277`).
- A hand-written list of addresses: rejected for the same reason.
- Tracing when a ROM is opened: rejected, the result is the same for every clean game and the emulation run is too slow to do at load.

## Consequences

The data depends only on the clean game, so it is generated once; a site in game code that an editor patch replaces is left to that patch. Memory timing (fast vs slow ROM cycles) is not emulated yet, so the editor cannot show what FastROM gains; that is a separate issue.
