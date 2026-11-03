# Level tiles as objects on top of layer 1

A level tile (CONTEXT.md) is a layer 1 tile entering a level, its translevel moving with it. It could only be painted: moving one meant picking it up (the brush carries its translevel), painting it elsewhere and painting over the old one, which only a toast hinted at; placing one meant knowing which tile numbers are level tiles (56–80 in the clean game). For users level tiles are objects, as overworld links and sprites are, which have modes of their own (#335).

We decided that the overworld editor has a **Levels mode** (key 3, between the layers and the overworld links; no layer dimmed) in which level tiles are objects on top of layer 1, each change one ROM edit of layer 1 and the translevel table on the map before events (core/owleveltiles.ts):

- **Select**: a click on a level tile (or in the list); the Properties panel shows its settings as in the layer 1 mode.
- **Move**: dragging a level tile to another layer 1 cell **swaps** the two cells (tiles and translevels). A level moved along a path leaves the path whole; dropped on another level tile, the two levels swap. Esc cancels the drag.
- **Remove** (Delete): the cell gets the **stop tile** 81 – Mario stops there and enters no level, so the path stays walkable. The translevel's settings stay with the translevel; the level is listed under "Without level tile" (the translevels no tile on any map holds – a tile an event reveals as a level tile holds its translevel before, as the game's 5F cells do, and counts).
- **Place**: right click → "Place level here…" (the level, a free translevel proposed, and the look), or a level dragged from "Without level tile" onto the map (the default look 56).
- **Look**: the looks are the visible tiles the path kinds call "level" (56–80 without the invisible ones in the clean game) and one invisible level tile for a level drawn on layer 2; choosing one replaces the tile and keeps the translevel.

Which tiles are level tiles and which tile Mario stops on are the path kinds' (learned by emulation, owpaths.ts): 81 while it is a stop tile, else the first one. Edits wait for the path kinds and the submaps' views, as layer 1 painting does. Painting level tiles on layer 1 stays possible.

## Considered options

- **Move as "paint here, old cell becomes path"**: rejected, which path tile the old cell should get depends on its neighbours; swapping keeps whatever was at the target, which along a path is the path.
- **Remove leaves tile 000 or the tile before the level was placed**: rejected, 000 cuts the path; no history of the cell is kept. The stop tile keeps the path walkable with nothing to enter.
- **Edits into the event chosen in "Map after"**: rejected for now, a level tile's translevel is per cell of the map before events; while an event is chosen the Levels mode selects but does not change, and says so.

## Consequences

The reveal and destroy settings are per cell: they stay where they are when a level tile moves (an event destroying or revealing the old cell then acts on the tile swapped there). Level tiles changed by events (layer 1 changes) are still edited by painting layer 1 as after the event.
