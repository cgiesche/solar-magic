# Editor patches are installed when a ROM is opened

The editor has its own patches: the editor patch (SMWE), the VRAM layout (SMWV) with the BG2/BG3 slots (SMWG), level palettes (SMWP), BG tilemap banks (SMWB), music per level (SMWU), the extended FG and BG Map16 (SMWX with custom blocks, SMWH), structures (SMWS), the ExAnimation engine and the message relocation (SMWM). Each was installed the first time a feature needed it. So every accessor had a second path for the clean game (vanilla GFX tables, sprite bank 7, "acts like" as identity …). Extended object $03 was 3 or 4 bytes depending on SMWS. The UI had confirm dialogs and "Enable …" cards, packages installed patches on the way, and a third-party patch on a hook only got a warning that a feature could no longer be installed. All this kept the door open for ROMs edited with Lunar Magic or other tools, which the editor does not support anyway.

We decided that the editor opens only two kinds of ROMs: the clean game (CRC of the headerless US ROM), which gets every editor patch except SMWM right away, and ROMs the editor made (editor patch present, "Solar Magic" mark at $0FF0A0), which are opened as they are. Anything else – Lunar Magic ROMs, ROMs edited with other tools – is refused. While the editor is in early development there are no migrations for ROMs of older editor versions either. The accessors assume the patches; the vanilla paths, the dialogs and the VRAM patch's removal are gone. SMWM stays on demand: VWF dialog patches replace the message routine and do not get along with relocated texts, so the texts move only when they no longer fit in place.

## Considered options

- Keep installing on demand: rejected. It doubles most accessors and the level format for a compatibility the editor does not offer.
- Open any ROM whose hooks are free and install the patches there: rejected. Every hook check, every "already modified" case and every older layout of the editor's own patches would need a path, for ROMs the editor cannot reason about anyway.
- Open conflicting ROMs with the features whose patch is missing turned off: rejected for the same reason; every feature would keep its "not installed" path.
- Install SMWM too: rejected, it would make VWF dialog patches unusable.

## Consequences

A clean ROM grows by the patches' code and tables (it is expanded to 1 MB) and every level loads through them; the tests compare all levels with the clean game. The VRAM patch costs a little CPU time in every ROM (about 0.1 % of frames get one more lag frame, docs/patches.md). A third-party patch that changes an editor hook is rejected instead of warned about. The editor's own patches should therefore stay clear of hooks that popular community patches use, and follow established formats (Lunar Magic's ExAnimation layout, $7E010B) where community content relies on them. A ROM made by an older editor version may no longer open; while in early development that is accepted.
