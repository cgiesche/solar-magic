# The event progress as a playthrough strip in the game's load order

The overworld editor showed and painted the map at an event progress (CONTEXT.md "Event progress") chosen in a "Map after" select in the context bar: the events sorted by the level exit running them, the event's number after the label. Which events come before the chosen one – which changes the map shown already holds – was not visible, and a select hides all but one entry (#343, #358).

We decided that the event progress is chosen in a **playthrough strip** under the map (core/owevents.ts `playthroughStrip`, ui/overworld.ts `buildStrip`), replacing the select – one control for one state:

- "Before events", then **every event in number order**, the order the game applies them when it loads a save – the same order the map is shown in, so what is left of the chosen entry is exactly what the map holds.
- Each event is **labelled by the level exit running it** in the player's words ("Yoshi's Island 2 · secret exit"), its number small after it; an event no level exit runs reads "Event 4F (run by no level exit)". Of several exits running one event the first (the one passed at the progress) names it, the others are in its tooltip.
- A click, `,` / `.` and Esc choose as before; painting goes into the chosen event as before. The chosen event's timeline (steps, reveals, destroys, ▶ Play) opens below the strip. The strip scrolls horizontally and keeps the chosen entry in view.
- "▶ Test play from here" sits right after the chosen entry: test play (as key T) from the selected tile with the save at the strip's progress.

## Considered options

- **The strip in play order** (the order a player can pass the levels in, from the map's paths): rejected. The game knows no play order: loading a save it applies the events passed in their number order, so a strip in another order would show maps the game never shows, and a second progress model would be needed beside the one test play and painting use. Where number order differs from the order the game can be played in, the World check says so; play order is reached by **renumbering the events** (#351), not by a second progress model.
- **Keeping the select, sorted by level** (as "Map after" was): rejected, the order of the list wasn't the order of the map, and only the chosen entry was visible.
- **Labels by event number first**: rejected, users think in levels and exits; the number is secondary.

## Consequences

The strip is the one place the event progress is chosen (it supersedes the "Map after" select ADR 0012 names); the hints and the tiles' properties point to it, and whatever else names an event jumps there by setting it (an event as a link). `eventList` (the select's order) is gone; `eventWords` / `exitWords` give the player's words for an event and a level exit, also in the badge on the map. Undo labels and the timeline's head keep the shorter "Level 105 · secret exit 1" (`eventTitle`).
