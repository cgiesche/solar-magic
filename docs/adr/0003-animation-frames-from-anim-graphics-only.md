# Animation frames come from the Anim graphics only

Tile animations (ExAnimation) had two places to take frames from. The Anim graphics A–D (Lunar Magic's ExGFX 60–63) are shared by the whole ROM, one per list, and the Animations tab edits them. AN2 was a 4 KB ExGFX file per level, copied by an editor patch to $7EAD00, where a slot's RAM frames pointed. We added AN2 so that packages and level files made with Lunar Magic (On-Off Blocks) keep their animations. For the user it was the same idea twice, with different rules. AN2 was set on a card in the Graphics tab, and the Animations tab did not know about it: its slots read "from RAM", had no picker, and the only button reset their frames. Only 96 of its 128 tiles were loaded, because the level's BG tilemap follows at $7EB900. A global slot reading AN2 showed something different in every level. And a package slot using the package's own ExGFX 60–63 was dropped.

We decided that frames come only from the Anim graphics. When a package or level file is imported, the frames its slots use are copied into the Anim graphic of the target level's list, and the slots point there. A frame already in the graphic is used again. The frames can come from its AN2 file, from its own ExGFX 60–63, and, for a slot that also reads the game's graphics in RAM, from the level's WRAM after its load. The AN2 file is no ExGFX of the package. A ROM opened with the former AN2 patch gets its levels' AN2 frames moved the same way, and the patch is removed. A slot that reads RAM (from a Lunar Magic ROM) can have its frames copied in from the Animations tab.

## Considered options

- AN2 as a full second source, with a per-slot choice and a picker of its 96 tiles in the Animations tab: rejected. Two concepts with different scope (ROM-wide vs. per level), size and place in the UI stay to be explained, and the BG tilemap limit and the global-list case remain.
- Keep Lunar Magic's layout as it is: rejected for the same confusion. Lunar Magic users know AN2, but the editor's users meet it only through imports.

## Consequences

An import writes into a graphic other levels may share. The Animations tab therefore names the other lists using it, and the import dialogs name the graphic the frames go into. An Anim graphic holds at most 1023 tiles (one RAM bank less the RATS tag); a slot whose frames no longer fit is left out with a note. Frames copied from the game's graphics in RAM are a snapshot: editing GFX33 later does not change them. The AN2 file of a package is not stored; a package without level setup brings no frames. A submap's list follows the same rule: the editor offers no AN2 per submap either (#263, [research](../research/lunar-magic-submap-graphics.md), "FG5/FG6 and AN2").
