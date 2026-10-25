# A Callisto project's configuration decides over per-file detection

ADR 0002 classifies every file on its own and allows one patch per package. A Callisto project (CONTEXT.md), such as the Romhack Races baserom, already says what each file is: `patches.toml` lists 88 patches and the order they are applied in, `tools.toml` names the UberASM Tool, GPS and PIXI folders, and the code includes a header (`callisto.asm`) that Callisto generates and that is not in the upload. Per-file detection would get it wrong. It would make one patch to choose out of 88. It would turn shared headers and unlisted helper files into UberASM code or patches, take a `setup/tools.json` for a PIXI sprite and Retry's prompt graphics for ExGFX. And it would put a GPS folder's includes in as blocks of their own.

We decided that when an upload has `tools/Callisto/*.toml`, its configuration decides for the code:
- the patches are exactly those of `patches.toml`, applied in that order;
- the UberASM, GPS and PIXI parts are those of the tool folders that `tools.toml` names. A list missing from a folder is the upload's only list of that tool elsewhere. Only the blocks that list names are blocks. Graphics inside a tool folder are that tool's data;
- the other `.asm` files are shared code. They go with the UberASM and block projects under `callisto/`, next to the generated `callisto.asm`, so those projects build again later;
- everything else (graphics, songs, sample levels) is detected per file as in ADR 0002.

To build the baserom's blocks, the editor's GPS now builds as GPS does. Each block is assembled on its own. A shared routine is put in where the first block using it is assembled, then called there by later blocks. Two patches writing the same bytes are no conflict.

## Considered options

- Per-file detection with exceptions for the baserom's layout (`setup/lists/`, `shared/`): rejected, because it fixes one project's paths instead of reading what every Callisto project states.
- One package per patch: rejected (#96: one upload, one package; users who want only some parts upload single patches).
- Callisto patches keeping their own source archive: rejected. Each would hold the whole project, and the package's archive already keeps it. Their settings are the project's files.

## Consequences

The patch adapter has a second mode (all listed patches, in order, without settings), and the preview shows a note for each part of the project that is not part of the package. The patch registry is deflated so that a package of ~90 patches fits.
