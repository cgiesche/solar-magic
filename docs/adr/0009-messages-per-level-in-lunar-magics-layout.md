# Messages per level in Lunar Magic's layout, installed at load

The game shows a message only in the 22 translevels its table at `$05A590` names; in any other level its lookup falls through to the yellow switch palace's message, presses the yellow switch and ends the level. A message box sprite placed in a user's own level (or a package's sample level, as the Romhack Races baserom's 13B) therefore ended the level. Lunar Magic gives every translevel two messages, and community code relies on its routine: the Retry System hijacks its copy of the switch palace routine at `$03BC72`.

We decided that SMWM is the messages per level, installed into the clean ROM with the other editor patches: the lookup at `$05B1A3` jumps to `$03BB90` as in Lunar Magic, pointers at `$03BE80` (translevel × 2 + message − 1), the text in free space. From `$03BBC9` on the code is Lunar Magic's byte for byte, so hijacks of it land where they expect. Which translevels are the switch palaces and Yoshi's house is read from the game's table at run time, not written into the code. The game's messages move to the levels that showed them when the patch is installed. The old SMWM (the 25 texts moved to free space when they no longer fit) is gone.

## Considered options

- Keep the 25 slots and let the user assign them: rejected, Lunar Magic (the floor) has two per level and code written for its ROMs expects its routine.
- Keep SMWM on demand because of VWF dialog patches (ADR 0004): rejected; those are made for Lunar Magic ROMs, which all have this routine.
- Lunar Magic's switch palace translevels as constants: rejected, the game's table says which they are.

## Consequences

A patch writing over `$05B1A3` is rejected; one hijacking Lunar Magic's routine (`$03BB90–$03BC8E`) changes the editor's. Bank 03 from `$03BB90` and the pointers at `$03BE80` are taken.
