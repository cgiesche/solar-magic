# One way to paint with a brush

Several editors paint with a brush of cells: the level's BG and layer 3 modes (levelview.ts), the overworld's layers 1 and 2 (overworld.ts), the Game workspace's title screen and overworld border (gameview.ts, owborder.ts), the graphics tab's stamp (gfxtab.ts). The Game workspace was operated the other way round – left painted, right drag picked – and drew its frames differently (one outline per cell, one picture pixel wide so that it grew with the zoom, the pick rectangle without fill); Esc in the middle of a stroke left the workspace (#331). Someone switching between editors had to remember which button does what where.

We decided that every editor painting with a brush is operated the same way, the level and overworld editors' way, which most of them already had:

- **Left click or drag picks** cells into the brush (a rectangle from the first cell to the last).
- **Right click or Shift+click paints**; a right drag paints on on the brush's grid from the first cell (a 4x2 brush steps by 4 and 2, it doesn't smear).
- **Hover frame**: `rgba(255,255,0,0.9)`, one rectangle around the whole brush. **Pick rectangle**: `#4cc2ff` with a `rgba(76,194,255,0.15)` fill. Both one screen pixel wide, whatever the zoom.
- **Esc** cancels a stroke or a pick in progress: nothing of it is saved. Only when none is in progress does Esc do what the editor does otherwise.
- **Ctrl+wheel** zooms about the mouse, the **middle button** pans (dom.ts attachPanZoom).
- The hints say it in the same words: "Click/drag picks up tiles · Right click/Shift+click paints".

ui/brushsurface.ts holds the convention: BrushDrag is the drag without the DOM (a stroke on the brush's grid, a pick, Esc cancelling either), drawBrushFrame the frames, paintButton the buttons that paint. The level's BG and layer 3 modes and the overworld's layers 1 and 2 drive a BrushDrag from their own mouse handlers, since their scrolled maps drag other things too (objects, markers, links, sprites) and are drawn with them (#332); BrushSurface puts one on a picture canvas with an overlay for the frames (the Game workspace). A stroke cancelled by Esc puts back what it painted: the level's edit is cancelled, the overworld's stroke restores its maps (OverworldStroke.cancel).

## Exceptions

- **The Map16 builder** marks quarters with the left button (Ctrl adds, Shift takes the whole tile) and puts 8x8 tiles with the right: what it selects are the quarters an edit changes, not a brush.
- **The graphics tab's pixel pane** draws with the foreground color on the left and the background color on the right, as pixel editors do; Alt picks a color.
- **Objects and sprites in the level** are selected, moved and box-selected with the left button; the right inserts the chosen item. They are items, not cells of a brush.
- **Tile sheets** (pickers) only pick (dom.ts attachRectPick); Ctrl+click goes to a tile's definition.

## Considered options

- Each editor its own way, documented in its hints: rejected, the hints are read once, the buttons are used all the time.
- The Game workspace's way (left paints) everywhere: rejected, it would change the editors used most, and left-to-paint makes a stray click a ROM edit.

## Consequences

A new editor painting with a brush uses brushsurface.ts: BrushSurface for a picture of its own, BrushDrag and drawBrushFrame where the brush is one of several things dragged on a map.
