# The overworld is stored in Lunar Magic's formats, edited as ROM edits, and its event steps are computed

The overworld editor painted layer 1 and layer 2 into a working copy with its own undo and a save button, numbered translevels by scanning the map as the game does (placing a level tile shifted every later level's number, and with it its name, events and flags), and could not edit events, sprites, links or names. Lunar Magic, the tool the community builds with, stores most of the overworld in its own expanded formats (translevel table, event steps, silent events, custom overworld sprites, level names, submap graphics and palettes, overworld links up to 0x100), and community tools read them (BOWSIE reads Lunar Magic's overworld sprite table, AddmusicK the submap music table).

We decided:

- The overworld's data follows Lunar Magic's formats wherever Lunar Magic or community content has one (as ADR 0004 asks of the editor patches); the editor still opens only the clean game and its own ROMs. Lunar Magic's small overworld options become editor patches a package-like switch turns on and off, only those the community uses.
- The translevel is stored per tile in Lunar Magic's table instead of being found by scanning, so placing a level tile changes no other level.
- Every overworld change is a ROM edit (one undo history, no save button); a paint stroke is one ROM edit, written when the mouse is released, layer 1 only where it changed, layer 2 in place when it fits.
- A ROM edit must not restart background analyses (probes, object kinds, level scan) whose bytes it did not change: the ROM knows the ranges a write changed, the worker gets those, running tasks go on unless they read them.
- The user paints an event as the map looks after it; the editor finds its steps (animated on the event's submap, silent on others, in an order the user can change) and checks the result by emulation, instead of Lunar Magic's 6x6/2x2 piece storage and numbered steps.
- A package that replaces the overworld (Overworld Revolution's `YFOR` signature) locks the overworld workspace.
- The editor writes Lunar Magic's hijacks and their routines byte for byte as Lunar Magic does, so community tools and patches that look for them find them. Where a layout, a place or a byte value isn't documented, it may be read from `Lunar Magic.exe`, but only counts once a ROM Lunar Magic saved confirms it (made in the tools, Lunar Magic run under wine).

## Considered options

- Own formats: rejected, community tools that read Lunar Magic's tables (BOWSIE, AddmusicK) would not work.
- Keep the translevel scan and fix up the per-translevel tables when a level tile is placed: rejected, Lunar Magic's table already avoids it and is what the community knows.
- Keep the overworld's own undo and save: rejected, it is the one editor with a different model; ADR 0001 applies changes at once.
- Throttle the worker's ROM updates instead of tracking changed ranges: rejected, analyses would still restart, only less often.
- Lunar Magic's event piece editing: rejected, it exposes the storage format; kept only as the order of steps on a timeline.

## Consequences

Overworld edits go through the ROM history like every other change, and the background analyses survive them, which every other edit gains too. The editor writes Lunar Magic's overworld hijacks into its ROMs; their layouts that are not documented (level names) are learned from a ROM Lunar Magic saved, in the tools, not by opening it in the editor. What so far rests on `Lunar Magic.exe` alone (two overworld options, the level names' character table) is checked against such a ROM (done in #254: both agree, [research](../research/lunar-magic-overworld-options.md)).
