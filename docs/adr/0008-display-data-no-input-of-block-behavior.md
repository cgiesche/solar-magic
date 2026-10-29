# What blocks look like is no input of what they do

Probes (CONTEXT.md) stay valid as long as the ROM bytes they read are unchanged. The emulated game also reads what it only draws: the Map16 tiles' 8x8 tile words (boot, the probe level, a block changing into another tile) and the colors (every level load uploads the palettes). Those bytes lie on pages that the title screen and the probe level read, so drawing a Map16 tile of the shared pages, or changing a shared color, dropped every block, collision and sprite probe in every tileset, and the probe worker learned them all again (about 512 tiles and 200 sprites per tileset), although only acts-like and the blocks' code can change behavior.

We decided that the probe worker (core/probehost.ts) does not record reads of display data, as it already did for GFX file data and ExAnimation data: the FG Map16 quarters (tiles 000–1FF where each tileset's pointers lead, learned by emulation as for the tileset sharing; the extended tiles' table), the BG Map16 quarters, the shared palettes and the levels' own palettes with their pointers (core/gfxpages.ts, displaySkipMask). Acts-like, the custom block table and code, patches and the game's code stay what they read, so changing them still drops the results that read them, found by emulation as before. The worker's other results (object kinds, level scans, the camera at a place) leave the display data out as well: none of them is a picture. Where the tables lie is the ROM layout the editor already writes them by (the vanilla BG table and shared palettes, the extended tables and level palettes by their patches' pointers); which tile data a tileset uses is learned by emulation.

## Considered options

- Probing again only when acts-like changes: rejected. It is an SMW rule written into the editor instead of what the emulation reads: a GPS block with new code and the same acts-like would keep its old result.
- Recording the Map16 tables by byte instead of by page: rejected, it only helps partly. The title screen's tiles are read at boot, which every result counts, so drawing those would still drop everything.
- Leaving out the display data for every emulated result: rejected. Object thumbnails show the tiles, and the editor's other results share its mask, so only the probe worker leaves it out.

## Consequences

Drawing tiles and changing colors keep the behavior shown; a block's result is learned again only when what it does may have changed. A custom block whose code reads Map16 tile words or colors and acts on them would keep a stale result after such an edit; no such block is known. The worker learns the tilesets' pointers once (about 0.75 s on its first probe of a session; kept in the result cache with the bytes they read, which leave out the tile data and the colors).
