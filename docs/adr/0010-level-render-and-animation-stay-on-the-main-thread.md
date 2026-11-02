# The level render and the level animation stay on the main thread

The level view's render emulates the level's load and draws it at once on the main thread (App.refresh), and the level editing model and the UI read it synchronously (the render query, #275: the object at a tile, the tiles an object covers, the BG and layer 3 tilemaps). The level animation runs on from the loaded state on the same emulator, one step per background slice (App.startAnimation: 8 game frames emulated, then drawn as the pixels the step changes); what it reads counts for the render. The question (#186) was whether the render, or only the animation's steps, move to a worker.

The render stays synchronous (triage, #186): moving it would make every reader of the render query wait for a reply, and a drag show stale objects until the new render arrives. For the animation, the decision was to measure first. tools/animcost.ts measured all 236 levels with content of the editor's ROM (Node 24, the V8 the browsers use): 1888 slices, 4.7 ms median, 13.5 ms at the 95th percentile, 52 above a display frame (16.7 ms), 2 above 50 ms (a long task). The slow slices have two causes, neither of them the steps' emulation (3.5 ms median):

- a level's first step also emulates the fade-in after the load until the level's game mode, 28–38 frames (15–55 ms; 9B, 199, CC, 99);
- drawing a step that changes many cells of a large level, each cell composed on its own (F7: 25–48 ms per step).

We decided that the animation stays on the main thread too; the two causes are fixed there: the fade-in is emulated in slices of a step's size, and drawing a step is split over slices by a time budget (or made cheaper per cell).

## Considered options

- Render in a worker, the latest request winning, a drag showing the moved objects until the new render comes: rejected. The render's synchronous readers (the level editing model's clamping, selections, prefabs from a selection, the hover) would all become asynchronous for 18–35 ms of render per edit, which today gives immediate feedback.
- Only the animation's steps in the probe worker, the level's state after the load handed over as a snapshot (a few hundred KB): rejected. It moves the emulation, which is not what is slow (3.5 ms per step), except for the fade-in, which a split on the main thread removes as well. The slow drawing would stay on the main thread unless the worker also had the level's images (megabytes for a large level) and the view's settings (layers shown, ghosting), drawn again there on every change of them. The step's reads would have to come back to count for the render.
- Leaving both as they are: rejected, the measured long tasks are real; they are cheap to remove where they are.

## Consequences

The slices stay short as long as each emulates at most one step and draws within a budget; a level whose animation takes 64 steps (ExAnimation) has more slices, not longer ones. tools/animcost.ts measures it again (`--each`: every step's emulation and drawing). If a change makes the steps' emulation itself slow (e.g. heavy UberASM code running every frame), the worker is the option to reopen.
