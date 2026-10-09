# Uploads are detected per file and linked, not by upload style

Upload detection used to be a chain of upload styles (patch, Lunar Magic level, UberASM folder, PIXI, block pack, loose .asm), each taking over the whole upload or skipping once another had claimed files. Each style also carried its own handling of graphics: the block pack took .map16 and ExGFX only with a list.txt, the level import took .map16, ExGFX slots and .pal/.palmask only as a level import, the PIXI path took none. Real uploads mix styles: "On-Off Block" (MarioFanGamer) holds a GPS block, a PIXI bounce sprite, a .map16, an ExGFX file, a palette and a sample level, and was taken for a level import because it contains a .mwl; without that, the tiles, graphics and palette were silently dropped.

We decided that every file is classified on its own (folder, then content, then extension) into exactly one part, with shared code (routines/, library/) going with the parts that include it, and that a separate step works out the links between parts. Map16 tiles, ExGFX and palettes are graphics parts of their own instead of belonging to one style.

- A level import is only an upload with a .mwl and no code or songs. In a package the .mwl is its sample level, offered unchecked: it replaces the current level, with Map16 tiles, ExGFX and sprite numbers rewritten; a custom sprite only when the mapping is certain (otherwise left out with a note); exits (those on screens the sample level has) and secondary entrances stay those of the current level. Graphics without code and without a .mwl are a package.
- A patch with a patch.json stays one patch: the manifest describes the whole upload.
- Map16 tiles and ExGFX keep the author's position or number if free, else the next free one, and everything referring to them is rewritten; a list.txt decides block tiles and the .map16 is placed to fit them.
- Links (block ↔ tiles, sprite ↔ define, ExGFX ↔ slot) are guessed and shown in the preview; tile → block and ExGFX → slot can be changed there. One block may sit on several tiles.
- Level setup (ExGFX into the slots its tiles use, masked colors into the level's palette) is on by default for the current level. It and the sample level are level edits: undo reverts them, removing the package does not. The package records only what it brought (code, ExGFX, Map16 tiles).
- Files no part claims are listed in the preview as not installed; the readme can be opened.

## Considered options

- Keep the style chain and add a combined style for each new mix: rejected, every mix needs its own special case and graphics handling stays duplicated per style.
- First detector to claim a file wins, in a fixed order: rejected, the result depends on the order and is hard to test per file.
- Every upload a package, the .mwl a part even for graphics submissions: rejected, a graphics submission changes a level and brings nothing worth removing as a whole.
- Record level setup in the package and revert it on removal: rejected, the level may have been edited since.

## Consequences

The preview grows a links section and checkboxes for level setup and sample level. Importing a sample level needs rewriting of tile, ExGFX and sprite numbers, which the current level import does not do. Existing installed packages are unaffected: the registry already records ExGFX numbers and Map16 tiles.
