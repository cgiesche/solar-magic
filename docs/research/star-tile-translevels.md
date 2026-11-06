# What the game uses the star tiles' translevels for

Research note, 2026-11-05 (issue #288). The question: the six star tiles (5F) of the clean game's map hold translevels
(4D, 52, 53, 57, 5B, 5C, which are levels 129, 12E, 12F, 133, 137, 138), but A on a star enters no level (#94). What
does the game use these translevels for? And how should the editor show and edit them?

All findings were learned by emulation on the editor's image of the clean game (Lunar Magic's translevel table, filled
as the game's scan fills it) and are checked by `tools/teststartiles.ts`. The addresses come from read and write
watches on WRAM: the instruction that read or wrote the byte. The code at those addresses was then read with
`tools/dis.ts`.

## Result

A star is a **stop tile with a warp**. Its translevel is used the way a stop tile's (81) is: its **level flags** say
which ways Mario may walk off the star, and its **name** is shown in the status bar. The warp doesn't use the
translevel. Nothing sets the star's "passed" flag, and nothing enters a level through it.

| Use | Where | How it was checked |
|---|---|---|
| The ways Mario walks off the star | `$049299` `LDA $7ED000,x` (translevel of Mario's tile), `$0492A2` reads `$1EA2,x` | Mario was put on each star and walked off in the direction its flags open. He walks. With `$1EA2 + tl` zeroed he stays. With the tile given an unused translevel (5D) he stays, and once 5D's initial flags open that direction he walks. |
| A new file's flags for them | the game's list `$009EE0`: `28=03 4D=01 52=01 53=01 5B=08 5C=02 57=04 30=01`. With Lunar Magic's initial flags, `$05DDA0 + tl` | 6 of the list's 8 entries are the six stars. The other two are Yoshi's House (28) and 30, the Vanilla Dome star that an event reveals. A new game emulated has these flags, and the editor's initial flags hold the same values. |
| The way back when Mario arrives by walking | `$0496C0` `LDA $7ED000,x`, then `$0496CB`/`$0496CE` `ORA`/`STA $1EA2,x` | Mario walked onto each star from a neighbouring stop with the star's flags zeroed. Afterwards they hold the direction back, the same as on a level tile. |
| The way back after the reveal walk | the same code (`revealwalk.ts`) | Each Star World level was passed with the exit whose path leads to a star (SW1–SW4 secret, SW5 normal). Only that star's flags change, and it gains a direction (for example `53 01→05`). No star ever gets bit 7 (passed). |
| The name in the status bar | Lunar Magic's name routine `$03BB20`, called from `$048E81` (overworld load; the tile's translevel is read at `$048E7A`) and from `$049549` (Mario stops on a tile) | Every star shows "STAR ROAD", its translevel's name. Renaming 4D changes what its star shows and leaves the others alone. With the tile's translevel zeroed, the status bar shows translevel 0's blank name. Walking onto a star shows its name too. |
| **Not** the warp | `$049161`/`$049184` look up Mario's position in the star/pipe table | After A on each star, Mario lands in the same place whether the tile's translevel is its own, zeroed, or 5D. While the overworld runs, the game reads neither `$7ED000 + tile` nor `$13BF`, and `$13BF` is never written. The only reads are by the overworld's reload after the warp, which reads every tile's translevel. |
| **Not** the save as such | `$1EA2` (0x60 bytes) is saved as a whole (`$1F49`) | Nothing writes a star's flags other than a new file, an arrival and the reveal walk. The save carries whatever directions those opened. |

A note on `$7ED800`: it holds a byte per **tile**, not per translevel. That byte is the exit-reveal directions of
the tile's translevel (`$04D678`), which the overworld load copies there. The level flags per translevel are at
`$1EA2`, and those are what the game reads and writes for the stars. The game never reads `$7ED800` for a star.

Two follow-ups for the editor:

- **The editor counts the stars as event runners.** The stars' translevels have base events: 64, 56, 53, 59, 50
  and 5C. No other level's exit runs those events, and they change nothing (no pieces, no layer 1 tiles, no reveal,
  no destroy). Because `eventRunners` reads the table, it still lists the stars as their runners ("STAR ROAD · normal
  exit"). So `progressSaves` "passes" each star. The flags of the all-events save get bit 7 and an exit direction
  (for example `4D: 89`), and the events-triggered count includes these six events (110 at every event passed). The
  game can't do this, because A on a star warps. Fixed in #390: `eventRunners` skips the cells that are a star or
  pipe at any progress (before events, by the reveal list or an event's layer 1 change), so also the four revealed
  stars below with a base event (36 44 6D 5F, which change nothing either); the all-events save counts 100 events.
- **A 5F painted today has translevel 0.** Mario then walks off it only in the directions of translevel 0's flags.
  Every tile without a translevel shares those flags (CONTEXT.md "Route": "a stop of translevel 0 sharing them with
  every other"). The status bar shows a blank name there. `owreach.ts` already models the flags (`flags[tls[s]]` for
  any stop it walks off, stars included).

Events turn seven more cells into 5F: the stars that are revealed when a Star Road is opened. Before the event the
ROM's layer 1 has 5A at those cells. They hold translevels 12, 16, 1E, 2C, 30, 48 and 55, all named "STAR ROAD".
Four of them have a base event (1E, 30, 48, 55). They work the same way as the six stars.

## Lunar Magic

The translevel table in a ROM that Lunar Magic saved (the RHR baserom's `overworld.bps`, issue #288) gives the six
5F tiles the same translevels as the game's scan. The scan (`$04D7F2`) numbers every layer 1 tile in 56–80, star
tiles included (ADR 0005). This research did not check what Lunar Magic does when a 5F is painted or its level
number edited. That would need Lunar Magic driven under wine, as in
[lunar-magic-overworld-options.md](lunar-magic-overworld-options.md). Its translevel table holds one number per tile
without regard to the tile's kind, so the editor can store whatever it decides without departing from the format.

## Options for the editor

**A. Stars are stop tiles with a translevel (recommended).** A star keeps its translevel the way a stop tile a route
puts does (CONTEXT.md "Route"):

- Painting a 5F gives it a free translevel that has no name, base event or messages. Its initial flags are the ways
  its paths have, as `owroute.ts` sets them for a stop.
- A star painted over with another star or stop keeps its translevel. Painted over with a path, it frees the
  translevel.
- Selecting a star shows only what the game uses:
  - "Mario walks off: ↑ ↓ ← →", the initial flags as switches. A switch that is closed but has a path stays a World
    check dead end.
  - "Status bar: STAR ROAD", the name, typed in place the same way as a level tile's label.
- A note says when other tiles share the translevel.
- No base event, exit directions, messages, save prompt or "no entry if passed".
- `eventRunners` skips them.

This matches the game: it treats stars exactly as it treats stop tiles, plus a warp that ignores the translevel.

**B. Stars back in the Levels mode, marked "enters no level".** Stars get a label, the level tile settings and a
place in the list, as before #94.

- Cheap to build.
- Misleading: base event, exit directions, messages, midway and save prompt do nothing on a star, and a base event
  keeps the false runner above.

**C. Managed without UI.** The editor keeps a star's translevel and gives a new star a free one with the ways its paths
open. Nothing is shown.

- Least UI.
- The name can't be edited: a new star shows a blank status bar, unless the editor copies "STAR ROAD" from another
  star.
- A star that should block a way it has a path for (for example a one-way star exit) can't be set up.

**Recommendation:** A, with C's automatic part as its default. Painting a star gives or keeps a translevel with the
ways its paths open, and its name and directions can be changed in the tile's properties. Fix `eventRunners`
separately, so that it lists only tiles that enter a level.

**Decided and implemented (#288): A.** `src/core/owstars.ts` (paintStars from the layer 1 stroke, starDirs, the World
check's starsWithoutTranslevel), the star's properties in the layer 1 mode, CONTEXT.md "Star". Checked by
`tools/teststartiles.ts` (a star painted on a pipe: Mario walks off it in the ways it was given, emulated) and
`tools/testeventpaint.ts` (painted as after an event).

**Extended to pipes 5B (#407).** The game's star/pipe tiles are 5B, 5F and 82 (`$04915E`, by the tile's low byte).
Standing on an 82 Mario walks off any way (`$049268`); on 5B, as on 5F, only the ways his tile's translevel's flags open:
a 5B painted on Vanilla Dome 05,14 on translevel 0 leaves him stuck after a warp (#405), one given translevel 5D with
its path's way up lets him walk up off it, and a 5B on the main map's 0A,03 given 5D with flags 01 he walks off right and
no other way (`tools/testowlinks.ts`, `tools/teststartiles.ts`). So a pipe 5B takes a translevel as a star does
(`owstars.ts` ownsTranslevel); an 82 takes none. The clean game has no 5B on any map: its 12 pipes are 82s, all on
translevel 0, and no World check warning comes of them.
