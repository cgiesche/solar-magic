# Grafik-Editor: Bedienung passend zum Rest des Editors, ohne versehentliches Malen

Research note, 2026-10-23. Die Frage: Der Grafik-Editor (Tab „Graphics" im Grafik-Arbeitsbereich) verhält sich bei Links-/Rechtsklick anders als alle anderen Editoren und lädt zum versehentlichen Bearbeiten ein. Wäre „Bereich auswählen → in einem Mal-Editor öffnen" klarer? Welche Varianten passen zum bestehenden Bedienkonzept und sind besser bedienbar als die heutige?

Kurze Antwort: Ja. Das Bedienkonzept des Editors heißt überall **„links = auswählen/aufnehmen (zerstörungsfrei), rechts (oder Shift+links) = einsetzen/malen"**. Lunar Magic folgt derselben Regel ausdrücklich, auch in seinem eigenen 8x8-Grafikeditor. Nur der Graphics-Tab malt mit dem **linken** Klick, und zwar standardmäßig, auf der ganzen Datei, auch direkt nach einem Sprung „zum Ansehen" dorthin. Empfohlen wird die Variante E unten: Das Grafikblatt wird ein Navigator nach den Regeln der anderen Editoren (links wählt 8x8-Tiles, rechts setzt kopierte Tiles ein), und gemalt wird nur in einem **angedockten, vergrößerten Pixel-Editor** für die Auswahl. Das ist die Idee des Nutzers, aber ohne modalen Dialog, so wie Lunar Magics „8x8 Tile Editor" es macht. Dazu kommen einige kleine Sicherheitskorrekturen (Variante A), die auch für sich allein sinnvoll sind.

## Sources

- **This repo** at commit `40a3e7c`, cited as `path:line`: `src/ui/gfx/gfxtab.ts` (Graphics-Tab), `src/ui/gfx/map16tab.ts`, `src/ui/gfx/palettetab.ts`, `src/ui/gfx/animtab.ts`, `src/ui/gfxworkspace.ts`, `src/ui/levelview.ts`, `src/ui/overworld.ts`, `src/ui/dom.ts`, `src/main.ts` (Tastenkürzel-Hilfe), `src/style.css`, `CONTEXT.md`, `docs/adr/0001-immediate-apply-for-packages.md`.
- **Lunar Magic 3.71 help** (FuSoYa), `Lunar Magic.chm` aus `lm371.zip` (https://fusoya.eludevisibility.org/lm/download/lm371.zip). Zitiert als „LM help: `html/x.htm`". Seiten: `mouse_behavior.htm`, `editor_8x8.htm`, `editor_16x16.htm`, `ov_editor_8x8.htm`, `faq_gfx.htm`, `file_tile_editor_setup.htm`.
- **Tiled Map Editor** manual (Thorbjørn Lindeijer and contributors), „Editing Tile Layers": https://doc.mapeditor.org/en/stable/manual/editing-tile-layers/
- **Aseprite** docs (Igara Studio, David Capello and contributors): „Drawing" https://www.aseprite.org/docs/drawing/, „Keyboard Shortcuts" https://www.aseprite.org/docs/keyboard-shortcuts/, „Tilemap" https://www.aseprite.org/docs/tilemap/
- **YY-CHR** (von YY): Es ließ sich keine erreichbare Primärdokumentation finden (das YY-CHR @wiki antwortete mit 403). Sekundär: NESdev Wiki https://www.nesdev.org/wiki/YY-CHR, NeoGeoDev Wiki https://wiki.neogeodev.org/index.php/YY-CHR, ein Nutzer-Review auf https://aeongenesis.net/static/docs/tnrb/tools.html. Aussagen daraus sind mit **[sekundär]** markiert.

## 1. Das bestehende Bedienkonzept

### 1.1 Level-Editor (`src/ui/levelview.ts`)

- **Linksklick** wählt aus: das oberste Element unter der Maus, ein schon ausgewähltes hat Vorrang. Ziehen verschiebt die Auswahl, auf leerer Fläche zieht man ein Auswahlrechteck auf (`levelview.ts:876-893`).
- **Strg+Klick** fügt zur Auswahl hinzu oder nimmt heraus (`levelview.ts:866-875`). **Alt+Klick** wählt das nächste Element darunter (`levelview.ts:877-879`).
- **Rechtsklick oder Shift+Linksklick** setzt das in „Insert" gewählte Element ein (`levelview.ts:819-829`).
- **Pinsel-Modi BG und Layer 3** (`isBrushMode`, `src/ui/app.ts:56`): Links/Ziehen **nimmt Tiles in den Pinsel auf** (`levelview.ts:848-853`), Rechts/Shift+links **malt**, Ziehen malt weiter (`levelview.ts:822-826`).
- **Mittlere Taste** schiebt die Ansicht, **Strg+Mausrad** zoomt (`dom.ts:200-233`, für alle Ansichten gleich).
- **Tastatur** (`src/main.ts:523-544`): Esc hebt die Auswahl auf, Entf löscht, Strg+C/V/D, Pfeiltasten verschieben.

### 1.2 Overworld (`src/ui/overworld.ts`)

Hier gelten „die gleichen Tasten wie im Level-Editor" (Kommentar `overworld.ts:351`):
- Rechts oder Shift+links malt (`overworld.ts:357-361`).
- Alt+Klick (oder Strg+Klick auf Layer 1) zeigt Infos zum Level-Tile (`overworld.ts:363`).
- Links/Ziehen nimmt Tiles in den Pinsel auf (`overworld.ts:364`, `386-388`).
- Ein Malstrich ist eine ROM-Änderung, geschrieben beim Loslassen (`overworld.ts:399-400`).

### 1.3 Grafik-Arbeitsbereich (`src/ui/gfxworkspace.ts`)

- Der Arbeitsbereich ist ausdrücklich **kein Modal**: Die Level-Liste bleibt bedienbar, und Änderungen erscheinen sofort in der Vorschau (`gfxworkspace.ts:1-2`). Er zeigt den Hinweis „Changes go straight into the ROM · Ctrl+Z / Ctrl+Y" (`gfxworkspace.ts:191`).
- Das passt zu ADR 0001: Jede Änderung schreibt sofort, und die Undo-Funktion ersetzt Apply/Discard (`docs/adr/0001-immediate-apply-for-packages.md`). `CONTEXT.md` legt fest: „ROM edit: one labelled change … one undo step".
- **Strg+Klick ist im ganzen Arbeitsbereich „go to definition"** (`main.ts:555`, Commit `ee81512`): auf ein Map16-Viertel → sein 8x8-Tile, auf eine Farbe → ihre Animation und so weiter.
- **Klick in die Level-Vorschau** springt je nach Tab zum Ding unter der Maus (`gfxworkspace.ts:195`, `WsPanel.previewClick`).

### 1.4 Map16-Tab (`src/ui/gfx/map16tab.ts`)

- **Tile-Blatt:** Links/Ziehen wählt einen Bereich von Tiles (`map16tab.ts:435-452`).
- **Builder (vergrößerte Auswahl):** Links/Ziehen **markiert Viertel**. Strg fügt hinzu oder nimmt heraus, Shift nimmt ganze 16x16-Tiles (`map16tab.ts:700-719`). Markieren ändert nichts.
- **Rechtsklick** setzt die gewählten 8x8-Tiles ein, Rechts-Ziehen malt sie, ein Strich ist ein Undo-Schritt (`map16tab.ts:721-738`). Enter setzt sie in die markierten Viertel (`map16tab.ts:1311-1318`).
- **Doppelklick** auf ein Viertel öffnet sein 8x8-Tile im Graphics-Tab (`map16tab.ts:720`, `832-837`).
- **8x8-Grafikansicht:** Links/Ziehen wählt 8x8-Tiles, Loslassen über dem Builder setzt sie ein (`map16tab.ts:1341-1367`). Links ist dort also auch „auswählen".
- **Tasten:** Esc hebt die Markierung auf (also zerstörungsfrei), X/Y spiegeln, 1–8 setzen die Palette (`map16tab.ts:1465-1497`).

### 1.5 Palettes und Animations

- **Palettes:** Ein Klick wählt eine Farbe, Shift+Klick einen Bereich, Strg+Klick springt zur Animation (`palettetab.ts:288-294`). Geändert wird erst im Farbeditor daneben (Regler, HTML-Farbe, Farbwähler, `palettetab.ts:359-375`). Das Muster ist also **auswählen, dann in einem eigenen Bedienelement ändern**.
- **Animations:** Ein Klick auf das Quellblatt setzt den Frame des gewählten Slots (`animtab.ts:917-922`). Das ist eine Zuweisung, kein Malen. Der Link „draw" öffnet die Datei im Graphics-Tab (`animtab.ts:923`).

### 1.6 Die gemeinsame Regel

Lunar Magic formuliert dieselbe Regel für das ganze Programm: „In general, a right click is used to paste and a left click is used to select. This tends to hold true for all the windows" (LM help: `mouse_behavior.htm`). Für den Map16-Editor: „a right click will paste the currently selected tiles to the mouse position, while left click can be used to select multiple tiles" (LM help: `editor_16x16.htm`). Tiled nutzt die rechte Taste ebenfalls zum Aufnehmen und nicht zum Zerstören: „Using the right mouse button, it can also quickly capture tile stamps" (Tiled manual, Stamp Brush).

**Im Editor heißt das: Ein einfacher Linksklick ändert nie die ROM**, außer beim Ziehen einer schon ausgewählten Sache (Verschieben). Schreiben ist immer eine eigene Geste (rechts, Shift+links, Enter, ein Button oder ein eigener Editor wie der Farbeditor).

## 2. Der Graphics-Tab heute und wo er abweicht

Aufbau: Eine Leinwand zeigt die ganze Datei (128 Pixel breit). Sie ist zugleich Übersicht und Malfläche (`gfxtab.ts:75-76`, `87-94`). Es gibt die Werkzeuge Pen/Fill/Eyedropper/Select (`gfxtab.ts:44`, `479-486`).

| Geste | Graphics-Tab | Rest des Editors |
|---|---|---|
| Linksklick | **malt** mit dem Pen (Standardwerkzeug, `gfxtab.ts:58`; `832-836`) oder **füllt** (`828`) | auswählen / aufnehmen |
| Rechtsklick | **malt transparent** (`gfxtab.ts:826`) | einsetzen / malen |
| Shift+links | nichts Eigenes | wie rechts (einsetzen) |
| Alt+Klick | Farbe aufnehmen (`gfxtab.ts:810`) | nächstes Element darunter (Level), Infos (Overworld) |
| Strg+Klick | zur Animation des Tiles (`gfxtab.ts:809`) | gleich (go to definition) |
| Esc | **legt die schwebende Auswahl ab und schreibt sie** (`gfxtab.ts:1136` → `dropFloat` `906-917` → `commit`) | Auswahl aufheben, ohne zu schreiben (`map16tab.ts:1474`, `main.ts:537`) |
| Kachel „ansehen"/Nutzung zeigen | nur mit Eyedropper oder Alt+Klick (`gfxtab.ts:588`, `811-815`) | einfacher Klick |

Was versehentliches Bearbeiten leicht macht (jeweils mit Beleg):

1. **Malen ist der Normalzustand.** Das Werkzeug steht beim Start auf `pen` (`gfxtab.ts:58`) und bleibt beim Dateiwechsel und bei Sprüngen erhalten. `select()` setzt Datei, Kachel und Zoom, aber nicht das Werkzeug (`gfxtab.ts:134-146`).
2. **Sprünge „zum Ansehen" landen im Malmodus.** Mehrere Wege führen in den Tab, und jedes Mal wird die Kachel 8x8 ausgewählt und auf mindestens 12x gezoomt (`gfxtab.ts:139-142`). Der erste Klick, mit dem man sie „anfassen" will, malt dann ein Pixel. Die Wege sind:
   - der Doppelklick auf ein Map16-Viertel („Edit quarter in Graphics", `map16tab.ts:720`, `main.ts:558`),
   - der Klick in die Level-Vorschau (`gfxtab.ts:111-119`),
   - der Link „draw" im Animations-Tab (`animtab.ts:923`),
   - der Dateilink im Map16-Tab (`map16tab.ts:1250`).
3. **Ein Klick ist sofort eine ROM-Änderung.** Jeder Strich wird beim Loslassen als ROM-Edit geschrieben (`gfxtab.ts:868-871`, `commit` `769-777`), Fill sofort (`gfxtab.ts:828`). Ein einzelnes falsches Pixel fällt in einer 128x… Pixel großen Ansicht kaum auf. Grafikdateien teilen sich viele Level (der Tab listet sie, `gfxtab.ts:546`), also wirkt der Fehler auch anderswo. Undo hilft nur, wenn man den Fehler bemerkt.
4. **Fill kennt keine Kachelgrenzen.** Der Flood-Fill läuft über das ganze Blatt (`gfxtab.ts:779-790`, Grenzen sind nur `W()`/`H()`). Ein Fehlklick auf Farbe 0 kann also große Teile benachbarter, fremder Kacheln füllen.
5. **Die Auswahl schreibt bei vielen Nebenwegen.** Diese Aktionen legen eine schwebende Auswahl ab und schreiben sie in die ROM: Esc (`1136`), ein Klick außerhalb (`850`), ein Werkzeugwechsel (`512`), ein Dateiwechsel (`135`), das Verlassen des Tabs (`127`), Flip/Rotate (`950`). Nirgends kann man eine Verschiebung abbrechen.
6. **Rechts heißt hier „löschen".** Im Rest des Editors heißt Rechts „das Gewählte einsetzen". Wer gewohnheitsmäßig rechts klickt, um etwas einzusetzen, radiert hier stattdessen (`gfxtab.ts:826`). Die Hilfe nennt das als Sonderfall (`main.ts:560`).
7. **Wenig Rückmeldung über den Zustand.** Nur der Cursor unterscheidet die Werkzeuge (`style.css:427-429`, Fadenkreuz für Pen und Fill). Die einzige Rückfrage vor dem Schreiben betrifft ein abweichendes bpp-Format (`gfxtab.ts:818-825`).

Warum das so ist: Der Tab ist nach dem Vorbild klassischer Malprogramme gebaut. In Aseprite malt Links mit der Vordergrundfarbe und Rechts mit der Hintergrundfarbe („true for almost all painting tools", Aseprite: Drawing), und Alt wählt vorübergehend die Pipette (Aseprite: Keyboard Shortcuts). Das ist in einem reinen Malprogramm richtig. Hier ist das Grafikblatt aber zugleich die **Übersicht**, von der man Kacheln ansieht, findet und anspringt. Genau diese Doppelrolle beißt sich mit der Regel aus 1.6.

## 3. Was Lunar Magic (und YY-CHR) machen

**LM „8x8 Tile Editor"** (LM help: `editor_8x8.htm`) trennt Übersicht und Malfläche:
- Auf der Seite mit allen Kacheln gilt: „A right click will paste the currently selected tile to the mouse position, while a left click will select a tile. A control left click will copy a tile to the Windows clipboard, and a control right click will paste it."
- Gemalt wird nur in einer eigenen, vergrößerten Ansicht der gewählten Kachel: „When you select an 8x8 tile, it will be displayed below the current page at 16x the normal size (the other tiles in the page are displayed at 2x …). Left or right clicking on one of the 'pixels' of the 8x8 tile will replace the pixel with the currently selected FG or BG color." Farben nimmt man dort mit „control left or right click on a pixel".
- Flip X/Y, Rotate 90° und eine Farbumsetzung („Map colors") wirken auf die gewählte Kachel. Shift+Pfeiltasten verschieben ihren Inhalt um ein Pixel.
- Animierte Kacheln lassen sich dort nicht überschreiben („you cannot paste over the animated tile area").

LM selbst nennt den Editor „fairly basic" und empfiehlt für größere Arbeiten ein externes Programm (LM help: `editor_8x8.htm`, `faq_gfx.htm`). „Setup Tile Editor" startet dafür YY-CHR mit der Palette des Levels (LM help: `file_tile_editor_setup.htm`).

**YY-CHR** (von YY) **[sekundär]**:
- Eine Ansicht der Datei und ein eigener „128*128 editing canvas" (NeoGeoDev Wiki).
- Flip/Rotate/Shift in fünf Kachelgrößen, „Zone cut/copy/paste" (NeoGeoDev Wiki).
- Ein Nutzer-Review meldet: „Right-click acts as an eyedrop tool" (aeongenesis.net).

Das Grundmuster ist bei beiden gleich: **Die Übersicht dient der Navigation, und gemalt wird in einem eigenen vergrößerten Ausschnitt.** Eine Primärquelle zur genauen Mausbelegung von YY-CHR war nicht erreichbar.

**Aseprite, Tilemap-Ebenen:** Hier trennt ein ausdrücklicher Modus das Bearbeiten der Kacheln vom Platzieren: „Draw Pixels … modifies the tile content/pixels" gegenüber „Draw Tiles … puts/gets tiles directly", umgeschaltet mit Space+Tab (Aseprite: Tilemap). Das ist der Beleg dafür, dass auch Malprogramme zwischen „Kacheln handhaben" und „Pixel malen" unterscheiden.

## 4. Optionen

Gemeinsam für alle: Jeder Strich bleibt eine ROM-Änderung mit Undo (ADR 0001, `CONTEXT.md` „ROM edit"). Ein Apply/Cancel wird nicht eingeführt (siehe Variante D).

### A. Sicherheitskorrekturen am bestehenden Tab (klein)

- Nach jedem Sprung in den Tab (`select()` mit Kachel) und bei jedem Dateiwechsel steht das Werkzeug auf **Select**. Standardwerkzeug ist Select statt Pen (`gfxtab.ts:58`, `134-146`).
- **Esc bricht** eine schwebende Auswahl **ab** (Pixel zurück, nichts geschrieben). Nur Enter oder ein Klick daneben legen sie ab (`gfxtab.ts:1136`, `906-917`).
- **Fill nur innerhalb der Kachel** (oder der Auswahl, wenn eine besteht) statt über das ganze Blatt (`gfxtab.ts:779-790`).
- Ein einfacher Klick mit Select wählt die Kachel und zeigt ihre Nutzung, ohne Eyedropper (`gfxtab.ts:586-605`).

Zum Konzept: Das behebt die schlimmsten Fallen, aber Links malt weiterhin, sobald Pen aktiv ist. Kosten: nur `src/ui/gfx/gfxtab.ts` und die Hilfe (`src/main.ts:559-561`), wenige Stunden. Nachteil: Die Abweichung in der Mausbelegung bleibt. Es entsteht ein Moduszustand, den man vergessen kann.

### B. Pinsel-Grammatik direkt auf dem Blatt (wie BG/Overworld)

Die Regel aus 1.6 gilt wörtlich auch auf der Pixelfläche:
- Links/Ziehen **nimmt auf**: eine Farbe (Klick) oder einen Pixelbereich als Pinsel (Ziehen).
- Rechts oder Shift+links **malt** mit Farbe oder Pinsel, Rechts auf Fill füllt.
- Transparent malt man mit gewählter Farbe 0.

Zum Konzept: Das ist die konsequenteste Übertragung, genau wie BG-Modus und Overworld (`levelview.ts:848-853`, `overworld.ts:357-364`). Schutz: Ein normaler Klick schreibt nie. Kosten: klein bis mittel, nur die Maus-Logik in `gfxtab.ts:797-894` und die Hilfe. Nachteile:
- Es widerspricht jeder Malprogramm-Gewohnheit (Aseprite, LMs eigener 8x8-Editor: links malt).
- Pixelgenaues Zeichnen mit gedrückter rechter Taste ist ungewohnt, auf Touchpads umständlich. Shift+links mildert das ab.
- Die Doppelrolle Übersicht/Malfläche bleibt, nur mit vertauschten Tasten.

### C. Ausdrücklicher Ansichts-/Malmodus („View" / „Draw")

- Ein Umschalter in der Werkzeugleiste. Im **View**-Modus verhält sich das Blatt wie die 8x8-Ansicht des Map16-Tabs: Kacheln wählen, kopieren/einfügen, Strg+Klick zur Definition.
- Im **Draw**-Modus gilt das heutige Verhalten.
- Sprünge in den Tab setzen immer auf View. Draw wird sichtbar markiert (Rahmenfarbe).

Zum Konzept: Das entspricht Aseprites „Draw Pixels / Draw Tiles". Schutz: gut, solange man im View-Modus ist. Kosten: mittel (`gfxtab.ts`, `style.css`, Hilfe). Nachteile:
- Es ist ein klassischer Modus mit Modusfehlern: Man vergisst, dass Draw an ist.
- Im Draw-Modus malt Links weiterhin auf der ganzen Datei.
- Im Editor gibt es sonst keinen globalen Ansicht/Bearbeiten-Schalter.

### D. „Bereich wählen → Mal-Dialog" (die Idee des Nutzers, wörtlich als Modal)

Das Blatt wählt nur aus. Enter, ein Doppelklick oder „Edit pixels …" öffnet ein modales Fenster mit dem vergrößerten Bereich, den Werkzeugen und **Apply/Cancel**. Erst Apply schreibt einen ROM-Edit.

Zum Konzept: Malen wird eine ausdrückliche, abgegrenzte Handlung, der Schutz ist maximal. Kosten: mittel. Der Dialog nutzt `modal` (`dom.ts`), die Pixel-Logik zieht aus `gfxtab.ts` in einen eigenen Baustein. Nachteile:
- Es **widerspricht ADR 0001**: Apply/Discard-Staging wurde dort bewusst abgeschafft.
- Es widerspricht dem Grundsatz des Arbeitsbereichs „Not a modal … edits show up in the preview right away" (`gfxworkspace.ts:1-2`). Ein Modal verdeckt die Level-Vorschau und das Blatt, man sieht die Kachel nicht im Zusammenhang.
- Ohne Apply/Cancel (sofort schreiben) bringt das Modal gegenüber E nichts außer dem Verdecken.

### E. Angedockter Pixel-Editor: Blatt = Navigator, Malen nur im vergrößerten Ausschnitt (empfohlen)

Die Idee des Nutzers ohne Modal, nach dem Vorbild von LMs 8x8 Tile Editor (LM help: `editor_8x8.htm`) und YY-CHR **[sekundär]**.

**Grafikblatt (links, kleiner Zoom wie LMs 2x)**, nach den Regeln der übrigen Editoren:
- Links/Ziehen wählt **8x8-Kacheln** (auf das Kachelraster eingerastet). `attachRectPick` (`dom.ts:236-268`) tut genau das schon, Strg+Klick als „jump" eingeschlossen.
- **Rechts** setzt die kopierten Kacheln an der Maus ein, Rechts-Ziehen malt sie, ein Strich ist ein Undo-Schritt. So machen es der Map16-Builder (`map16tab.ts:721-738`) und LMs 8x8-Editor („A right click will paste the currently selected tile").
- Strg+C/V kopiert Kacheln. Strg+Klick geht zur Animation (wie heute).
- Esc hebt die Auswahl auf, ohne zu schreiben. Ein Klick zeigt die Nutzung der Kachel (heute nur mit Eyedropper, `gfxtab.ts:588`).

**Pixel-Editor (rechts daneben, groß, „Pixels" o. ä.)** zeigt die Auswahl des Blattes vergrößert:
- Standard ist eine Kachel. Nach einem Sprung aus dem Map16-Tab ist es das Viertel. Größere Auswahlen sind möglich, mit einer Obergrenze von z. B. 8x8 Kacheln = 64x64 Pixel. Das ist **besser als LM**, dessen Editor nur eine einzelne 8x8-Kachel zeigt.
- Nur hier wird gemalt: Pen/Fill/Eyedropper/Select wie heute. Links malt mit der Farbe, Rechts transparent, Alt nimmt die Farbe auf (Aseprite, LM: links/rechts = Vorder-/Hintergrundfarbe).
- **Fill und die Pixelauswahl wirken nur innerhalb des Ausschnitts.** Flip/Rotate wirken auf die Auswahl im Blatt (Kacheln) oder im Ausschnitt (Pixel).
- Das Blatt und die Level-Vorschau zeigen jede Änderung live, wie heute (`gfxtab.ts:625`, `100-101`).

Sprünge (Map16-Doppelklick, Level-Vorschau, „draw" in Animations) wählen die Kachel im Blatt und zeigen sie im Pixel-Editor. „Edit quarter in Graphics" (`main.ts:558`) bedeutet dann wörtlich, das Viertel zu bearbeiten, und nicht mehr, auf einer Leinwand zu landen, die beim ersten Klick malt.

Zum Konzept:
- **Links wählt, rechts setzt ein**, auf dem Blatt genau wie überall sonst.
- Die vergrößerte Bearbeitungsfläche entspricht dem Map16-Builder, der die Auswahl des Blattes groß zeigt und nur dort bearbeitet (`map16tab.ts:1-8`).
- Kein Modal, Sofort-Schreiben mit Undo (ADR 0001, `gfxworkspace.ts:1-2`).

Schutz vor Fehlern:
- Auf der Übersicht ändert ein Linksklick nie etwas.
- Gemalt wird nur in einer Fläche, die ausdrücklich dafür da ist und nur den gewählten Ausschnitt zeigt. Ein Fehlklick trifft also nur, was man gerade bearbeiten will, und ist dort groß sichtbar.
- Fill kann nicht mehr über fremde Kacheln laufen.
- Es gibt keinen Moduszustand, den man vergessen kann: Die Rolle hängt an der Fläche, nicht an einem Schalter.

Kosten (mittel):
- `src/ui/gfx/gfxtab.ts`: `attachCanvas` (`797-894`) teilt sich in ein Blatt mit `attachRectPick` und Rechts-Stempel und in den Pixel-Editor. Dieser übernimmt die heutige Mal-Logik mit Koordinaten relativ zum Ausschnitt; `get`/`set`/`idx` (`608-626`) bleiben. Dazu kommen ein zweites Canvas mit `draw`/`present`, eine Kachel-Zwischenablage neben der Pixel-Zwischenablage (`clip`, `66`) und Anpassungen an `select()` und `key()`.
- `src/style.css`: Layout von `.gt-main`/`.gt-view` (`style.css:420-430`).
- `src/main.ts:559-561`: Hilfezeilen. `src/ui/gfx/map16tab.ts:1250`: Tooltip „to edit/draw".
- Neuer Begriff in `CONTEXT.md` (z. B. **Pixel editor** mit dem Hinweis _Avoid_: canvas, paint dialog).
- Beim Umsetzen in `docs/credits.md` LMs 8x8 Tile Editor als Vorbild nennen (FuSoYa).
- Der Core ist nicht betroffen (`core/gfxfiles.ts`, `writeGfx` bleiben).

Nachteile:
- Mehr Bildschirmfläche: Zwei Ansichten plus Seitenleiste werden auf schmalen Fenstern eng. Abhilfe: Das Blatt schrumpft auf 2x, die Seitenleiste ist ohnehin 270 px (`style.css:430`).
- Malen über große Bereiche (z. B. eine ganze 128x64-Grafik neu zeichnen) geht nur über eine große Auswahl. Dafür bleibt Import/Export PNG/.bin (`gfxtab.ts:500-507`). LM schickt solche Arbeiten ohnehin in ein externes Programm (LM help: `editor_8x8.htm`).
- Rechts-Stempel auf dem Blatt überschreibt Kacheln, die Map16-Tiles benutzen. Der Tab zeigt die Nutzung schon (`gfxtab.ts:586-605`), und ein Toast kann vor genutzten Kacheln warnen, wie `warnAnimated` (`gfxtab.ts:761-767`).

## 5. Empfehlung

**Variante E umsetzen, Variante A gleich mitnehmen** (A ist ein Teil von E: Esc bricht ab, Fill begrenzt, Sprünge malen nicht). Variante A eignet sich als erster, sofort lieferbarer Schritt, wenn E später kommt.

Begründung:
1. E ist die einzige Variante, die **beide** Ziele erfüllt. Das Blatt folgt der Regel „links wählt, rechts setzt ein" des ganzen Editors und von Lunar Magic (LM help: `mouse_behavior.htm`, `editor_8x8.htm`). Gemalt wird nach der Gewohnheit von Malprogrammen (links Farbe, rechts transparent, Alt Pipette), aber nur dort, wo es ausdrücklich darum geht.
2. Sie setzt die Idee des Nutzers um („Bereich wählen, dann im Mal-Editor bearbeiten"), ohne den Grundsatz des Arbeitsbereichs (kein Modal, Live-Vorschau) und ohne ADR 0001 (kein Apply/Cancel) zu brechen. D tut beides.
3. Sie verzichtet auf einen globalen Modus (C) und auf eine für Pixelarbeit ungewohnte Tastenbelegung (B).
4. **LM ist die Untergrenze, E geht darüber hinaus:**
   - beliebige Auswahlgröße statt einer 8x8-Kachel,
   - Live-Vorschau im Level,
   - Nutzung und Animation der Kachel direkt daneben,
   - Undo pro Strich und direktes Schreiben in die ROM statt Extrahieren und Einfügen.

Offene Punkte für die Umsetzung (vom Nutzer zu entscheiden):
- Rechte Taste im Pixel-Editor: transparent (wie heute) oder eine zweite wählbare Farbe (wie LM/Aseprite)?
- Obergrenze des Ausschnitts (Vorschlag: 8x8 Kacheln).
- Soll Links-Ziehen innerhalb einer Blatt-Auswahl die Kacheln verschieben, wie „Drag: move selection" im Level (`main.ts:526`)? Wenn ja, sollte der vorhandene Remap angeboten werden, weil Map16-Tiles auf die alten Nummern zeigen (`gfxworkspace.ts:241-246`, `showRemap`). Vorschlag: zunächst nicht. Verschieben bleibt Kopieren/Einsetzen.
