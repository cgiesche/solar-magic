# The side panel holds the tool and the selection

The overworld editor's right side panel stacked everything under each other: in the layer 1 mode the Paint panel (the sheet, "Path (auto)", the level looks with the budget, "Without level tile"), the Properties (a level tile's settings with its name and the map font's character table, the link properties), the link legend, the **Map** section (the shown map's music, "Edit graphics", "Edit border") and the **Overworld** section (the overworld options, the reveal list). Each is needed for some task, but rarely all at once: what is painted with and what is selected scrolled away under settings changed once per hack and a legend read once. #421 hid Paint while a level tile, star or pipe is selected – one case of a general crowding.

We decided that **the side panel holds what the user works with now – the tool and the selection – and nothing else**. The rule is for every editor; the overworld follows it first (the others are measured against it in their own tickets):

- **Tool and selection as tabs**: the side panel has two tabs, "Paint | Properties" (in the sprite mode "Sprites | Sprite"), one shown. A selection switches to Properties; when it ends (Esc, a click beside it) Paint comes back. The tab can be clicked back to Paint with the selection kept (a right click paints with it meanwhile, as before). Nothing selected: Properties is disabled, its tooltip says how to select. In the layer 2 mode Properties shows the tile info of an Alt+click. This replaces #421's hiding of Paint.
- **Properties in one fixed order**: the most used first (a level tile: name, open level / look, the switches), the links and the other tiles entering the same level below; no collapsible sub-sections.
- **What concerns the whole map or overworld leaves the side panel**, kept where it is chosen:
  - the shown map's settings (music, Edit graphics, Edit border): a popover from a "⚙" button beside the map select in the context bar;
  - the overworld options and the reveal list: an "Overworld options…" dialog (tabs Options, Reveal list), opened from a button at the right of the context bar and from a menu; picking a reveal's new tile links to the dialog's Reveal list.
- **Reference stays out of the way until asked**: the meaning of a mark on the map is said in the status bar while it is hovered; the whole legend is a popover from a "?" button in the context bar beside View and zoom. The map font's character table shows as a popover at the level name field only while it has the focus (a click inserts the character).
- Popovers close on a click outside them or Esc.

Why: a panel that always shows everything shows nothing well – the user has to look for the part that matters and scroll past the rest. What is worked with now changes with each click; settings and reference don't, and are found where they belong (the map's beside the map select, the overworld's in one dialog as Lunar Magic's Extra Options are).

## Considered options

- **Tidying the side panel** (one accordion section open at a time, or tabs for all five parts): rejected – the global parts still compete with the tool, and the user has to switch away from painting to change them.
- **Paint and Properties stacked, Paint hidden only for some selections (#421)**: rejected as the rule – the user doesn't see where Paint went, and other selections (link ends, a tile's info) still crowd it.
- **Only switching automatically between Paint and Properties, without tabs**: rejected – a brush can't be taken while something stays selected, and the switch is invisible.
- **The legend as a map overlay toggled in View, or only as hover tooltips**: rejected – an overlay covers the map; tooltips alone give no overview.

## Amendment (#478, #482): the same tabs in every editor

The UI concept (#472) applies the rule to the level editor and names the tabs the same everywhere: **"Picker | Properties"** (the overworld's "Paint | Properties" and "Sprites | Sprite" renamed). In the Graphics workspace the side panel keeps the preview pinned on top with the open view's properties below it (#478's decision). One difference in the level editor: its Properties tab is never disabled – with nothing selected it holds the level's entrances and exits (the Entrances/Exits mode) and, while open, the message panel, both the level's and not a selection's. Ctrl+click no longer shows a tile's info (#482: Ctrl+click adds to the selection everywhere); Alt+click does.

## Amendment: the level editor stacks the picker and the properties

On the user's request the level editor's side panel shows both again, without tabs: the picker on top, the properties of what is selected below it (at most 40 % of the panel's height, scrolling beyond that). Placing and adjusting alternate with every click there, and switching tabs hid the one just needed. The message panel takes the place of both while it is open. To keep the properties short, the reference part in them – "Used in levels" – is folded: its title says how many levels, a click opens the list, and it stays open or closed as left (an exception to "no collapsible sub-sections", in line with "reference stays out of the way until asked"). The overworld keeps its tabs.
