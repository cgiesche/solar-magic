# Event progress as a set of passed events

_Supersedes ADR 0013 (the playthrough strip)._

The overworld editor showed the map at an event progress chosen in the playthrough strip under the map (ADR 0013): "Before events", then every event in number order, the map shown with the events up to the chosen one passed. But the events aren't linear: a player passes them in many orders, and a hack's numbering rarely is its play order. To see the map as after Yoshi's Island 2's secret exit without the events numbered below it, or to look at one submap's events alone, the strip had no way; it also scrolled sideways through 0x78 chips (#408).

We decided that the **event progress is a set of passed events** – any set, applied in number order as the game does when it loads a save (core/eventset.ts) – chosen in an **event list** in the left panel, and that one event is **edited** apart from the set (CONTEXT.md "Event progress", "Event list"; #423, #425–#427):

- **The model**: the events checked are the progress; the map shows the checked events plus the edited one. Sets that can't occur in play are allowed (the World check may warn), not prevented. A prefix (the events up to one) is the same progress given as a count: what the World check and the exits' edges walk through, and the cache hit for everything kept per progress.
- **Editing**: a click on an event's text makes it the edited one – painted into, its timeline (steps, reveals, destroys, ▶ Play) open under the map; none edited (Esc), painting goes into the map before events. Its steps are still found against the map before it in number order, as the game stores them: what is painted goes into the event whatever else is checked. Where the map shown differs from that (an event below it not checked) the badge on the map says so, and a click there checks them.
- **The list** replaces the level list and the strip: grouped by the submap of the level running the event, number order within, each labelled by the level exit running it ("Yoshi's Island 2 · secret exit", the number small after it, other exits running it in the tooltip); the events no level exit runs collapsed at the end. Group checkboxes (partly checked shown so), All / None, ▶ Test play (T), "Up to here" (the prefix up to an event) in a row's context menu. Keys: `,` / `.` the edited event one row up / down, Space checks or unchecks it, Esc ends editing. The checks and the edited event are kept per ROM in the browser.
- **One "save shown" for everything**: the map, the sprites, the custom sprites, the music, reach, the link warnings, the graphics workspace and the Map16 tab follow the set. A set that isn't a prefix is shown at once as built from the event data (as the World check's maps), the emulated map after it ("Loading…" in the badge).
- **Test play** starts with a save of exactly the checked set, learned by emulation (the checked events' levels left in number order, cached per set) – never a save put together by rules.
- **The level list's functions** moved: "Without level tile" (dragged onto the map) into the layer 1 picker's Levels section; a level is opened from the map (double click, the menu's Open level); the warning for level tiles sharing a level or entering none is the World check's; in the layer 2 mode tiles are selected by Alt/Ctrl+click.

## Considered options

- **Keeping the strip, the set as a second control**: rejected – two controls for one state, and the strip's order suggested a linearity the events don't have.
- **Play order instead of number order**: rejected as in ADR 0013 – the game knows no play order; renumbering the events (#351) is how play order is reached.
- **Preventing sets that can't occur in play**: rejected – which sets occur depends on the map being edited; the World check says what it finds instead.
- **Steps found against the map shown**: rejected – the game stores an event's steps against the map before it in number order; finding them against another map would store changes the game never draws so.

## Consequences

Everything that names an event acts on the edited event and keeps the checks (an event as a link: "When beaten…", reveals, destroys, a cell history's entries – its "before events" entry ends editing); Show of a World check problem checks exactly the prefix it was found at and edits its last event (or the event it names to show it in; one found at the set shown keeps the checks), Show of a budget beside an event's actions checks the events up to it and edits it (the edited event's own gauge keeps the checks) – core/worldcheck.ts problemShow, budgetShow (#427). `playthroughStrip` and `stepEvent` are gone; `eventList`, `eventListOrder` and `stepInList` (core/owevents.ts) give the list and its order. The World check searches every prefix as before and the set shown instead of "the progress shown".
