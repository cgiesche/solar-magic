# Wie Lunar Magic Overworld-Pfade und Links setzt – und ob wir sie "wissen" statt emulieren sollten

Recherche-Notiz, 2026-11-06. Die Frage des Nutzers: Wie setzt Lunar Magic Overworld-Pfade und Links (Stern-, Pipe-
und Exit-Path-Verbindungen zwischen Submaps)? Lohnt es sich, hier vom Grundsatz "emulieren statt wissen" abzuweichen,
weil Pfad-Tiles sehr statisch sind und kaum verändert werden?

Quellen:

- die Hilfe von Lunar Magic 3.71 (`Lunar Magic.chm` aus
  `https://fusoya.eludevisibility.org/lm/download/lm371.zip`, mit 7-Zip entpackt; die Seiten unten mit Dateinamen),
- die SMW-Disassembly SMWDisX (`https://github.com/IsoFrieze/SMWDisX/blob/master/bank_04.asm`, Labels mit Adresse),
- der Code dieses Repos (Datei:Zeile),
- ein Byte-Vergleich der Test-Hacks in `test/fixtures` mit dem sauberen Spiel und ein Lauf der Pfad-Probes auf ihnen
  (Skripte im Scratchpad, nicht im Repo; das Vorgehen steht unten).

SMW Central (ROM-Map, Patch-Sektion) war für den Abruf gesperrt (Copyright-Hinweisseite statt Inhalt). Was nur dort
stünde, ist unten als **unbelegt** markiert.

## Ergebnis

1. **Pfade sind in Lunar Magic Wissen des Editors, nicht etwas, das es aus dem ROM liest.** Lunar Magic zeichnet die
   Pfad-Tiles mit eigenen Bildern pro Tile-Nummer. Wer die Pfade im ROM per ASM ändert, muss Lunar Magic die neuen
   Bilder in zwei Dateien neben dem ROM selbst mitteilen (`.ovpathbmp`, `.ovpathtxt`). Laut Hilfe ändert das nur die
   Anzeige im Editor, nicht das Spiel. Lunar Magic simuliert keine Bewegung, prüft keine Wege und kann die 5
   hardcodierten Pfade weder anzeigen noch bearbeiten.
2. **Links sind Daten in Tabellen, die Lunar Magic vergrößert hat.** Es gibt die Stern/Pipe-Tabelle (0x100 Einträge
   seit LM 3.00, zugleich die "Location Teleports" der Sekundärausgänge) und die Exit-Path-Tabelle (0x80 Einträge seit
   LM 2.40, mit einem Hook bei `$049A35`). Verbunden werden zwei Tiles mit Alt+Klick und einem Dialog, in dem man
   Tabellen-Indizes wählt. Welche Tiles Sterne, Pipes oder Exit-Tiles *sind*, entscheidet der Spielcode, nicht eine
   Tabelle von Lunar Magic.
3. **In echten Hacks bleiben die Pfad-Tabellen des Spiels unverändert, der Bewegungscode aber nicht immer.** In allen
   vier LM-Hacks im Repo sind die Pose-Tabelle, die Exit-Tile-Liste, die hardcodierten Pfade und die
   Stern-/Pipe-Vergleiche Byte für Byte die des sauberen Spiels. Journey to Kaizo hängt aber sieben eigene JML/JSL
   in den Bewegungscode von Bank 04. teamshell hängt einen hinein. Die "No-Auto-Move"-Liste ist in 2 von 3 Hacks
   geändert, und Super Luigi Land 2 hat die hardcodierten Pfade abgeschaltet.
4. **Empfehlung (getrennt, unten):** Nicht vom Grundsatz abweichen. Das Projekt ist hier schon hybrid: Es emuliert
   das Verhalten pro Tile und kennt die Bewegungsregeln und die Tabellenformate. Ein Umstieg auf feste Tabellen spart
   rund 10–17 s einmalige Hintergrundarbeit pro Stand des Spielcodes und bricht genau bei den Hacks, die den Code
   ändern.

## 1. Pfade in Lunar Magic

### Was die Hilfe sagt

| Aussage | Quelle |
|---|---|
| Pfade sind "certain blank layer 1 tiles". Lunar Magic macht sie mit der Ansicht "Layer 1 Mario Paths" sichtbar: grün gehen, schwarze Linien klettern, blau schwimmen, rot Exit-Tile, schwarzes X Stopp ohne Level, 3 Tiles mit Fischsymbol. | `ov_view_layer1_paths.htm` |
| Ein Pfad entsteht, indem man Layer-1-Tiles wie andere Tiles setzt. Eine Prüfung gibt es nicht, nur die Warnung: "Make sure that the path doesn't lead to a dead end and doesn't have fragments missing … Mario's movements become erratic". | `ov_view_layer1_paths.htm` |
| Die 5 hardcodierten "default paths" zeigt Lunar Magic nicht an und kann sie nicht bearbeiten ("Currently LM does not support displaying or editing these"). Sie lassen sich nur über "Extra Options" abschalten. | `ov_view_layer1_paths.htm`, `ov_overworld_extra_options.htm` |
| Seit 3.50 kann man **eigene Pfadbilder** pro Layer-1-Tile angeben, in `<rom>.ovpathbmp` (Bitmap) und `<rom>.ovpathtxt` (Tile → Bildindex). Das gilt nur für den Editor: "note that this only affects the editor, not the actual game … useful if you've modified the ROM to change some of the paths". | `info_custom_ov_path.htm` |
| Die Tiles 0C und 13 zeigt Lunar Magic seit 2.40 anders als 10, obwohl "all 3 tiles do in fact act the same way". Grund sind Nintendos 8x8-Tile-Nummern. Eine Ansicht-Option stellt das alte Bild wieder her. | `ov_view_old_path_tiles.htm` |
| Pipe 82 lässt Mario in jede Richtung gehen, Pipe 5B nicht. Sterne brauchen eine eigene Levelnummer für ihre Richtungen. Wo ein normaler Pfad und ein hardcodierter Pfad am selben Ort beginnen, nimmt das Spiel den normalen. | `ov_overworld_modify_level.htm` |
| Die "No-Auto-Move"-Liste (6 Levelnummern: Switch Palaces, Yoshi's House, ein ungenutzter roter Palace) ist in Lunar Magic editierbar. | `ov_overworld_no_auto_move_level.htm` |
| Die Tile-Auswahl für Layer 1 ist "mostly blank", solange die Ansichten "Layer 1 Mario paths" und "Future layer 1 tiles" aus sind. | `ov_editor_16x16.htm` |

### Was daraus folgt (Schlussfolgerung, nicht wörtlich belegt)

- Lunar Magic **weiß**, welches Tile welche Pfadart ist. Das zeigt der Override-Mechanismus mit `.ovpathbmp`/`.ovpathtxt`
  für Hacks mit geänderten Pfaden. Würde Lunar Magic die Pfadarten aus den Tabellen des ROMs ableiten, bräuchte es
  ihn nicht.
- Eine Gegenprobe: Die Tabellen des Spiels (Pose-Tabelle `$049FEB`, Exit-Tiles `$049426`, die hardcodierten Pfade
  `$049078`/`$0490CA`, die Stern/Pipe-Tabelle `$048431`, die Exit-Path-Tabelle `$049964`) kommen in beiden
  `Lunar Magic.exe` (32 und 64 Bit, nicht gepackt: UI-Strings wie "Layer 1 Mario Paths" und "ovpathtxt" stehen im
  Klartext) nicht als Bytefolge vor. Lunar Magic hat also wohl eine eigene Darstellung, etwa Bilder pro Tile, und
  keine kopierten Tabellen. **Unbelegt:** ob Lunar Magic einzelne Tabellen aus dem ROM liest. Dafür müsste man
  `Lunar Magic.exe` disassemblieren.
- Welche Tiles Level-Tiles sind (der Dialog "Modify Level Tile Settings" öffnet sich "only if you select a single
  layer 1 level tile"), ist offenbar ebenfalls fest im Editor. **Unbelegt**, wie oben.

### Wie das Spiel Pfade auswertet (SMWDisX, Bank 04)

Pfad-Tiles sind **Tabellen und Vergleiche im Code** zugleich. Ein Hack kann also an beiden Stellen ansetzen:

| Was | Wo | Art |
|---|---|---|
| Pose pro Tile 01–55 (gehen, schwimmen Bit 3, klettern Bit 4) | `DATA_049FEB`, gelesen bei `CODE_04945D` ff. (`LDA.W DATA_049FEB,X`); Tiles ab 87 gelten als "kein Pfad" (`CMP.W #$0087`) | Tabelle + Konstante im Code |
| Exit-Tiles (44 43 45 46 47 48 25 40 42 4D) | `DATA_049426`, Schleife `CODE_049616` | Tabelle |
| Vektor pro Tile, um den Mario bewegt wird (die "Pfadform") | `DATA_049EA7`/`DATA_049F49`, `CODE_04971D`; Sonderfälle `DATA_049430`/`DATA_049431`/`DATA_04944E` | Tabellen |
| Kurven-Tiles und ihre Versätze (24 Tiles) | `DATA_04A03C` mit `DATA_04A054`/`DATA_04A0E4`, `CODE_049384`, `CODE_0496F2` | Tabellen |
| Stern = Tile 5F, Pipes = 82 und 5B | `CMP.B #$5F`, `CMP.B #$82`, `CMP.B #$5B` in `OWPU_*` (`$04915E` ff.) | Konstanten im Code |
| Level-Tile = A auf einem Tile unter 81 (nachdem Stern und Pipe ausgeschlossen sind) | `OWPU_NotOnPipe`: `CMP.B #$81` / `BCS` | Konstante im Code |
| 5 hardcodierte Pfade (DP2–DP1, CI3–CF, FoI4–FoI2, CI2–Pipe, Star–FD) | `HardCodedOWPaths` (`$049078`), `OWHardCodedTiles`, `OWHardCodedDirs`, `DATA_04910E` | Tabellen |
| No-Auto-Move-Translevels (28 08 14 36 3F 45) | `DATA_04906C`, Schleife `CODE_04922A` | Tabelle (in Lunar Magic editierbar) |

Die Notiz [star-tile-translevels.md](star-tile-translevels.md) belegt dieselben Stellen zum Teil schon durch Emulation
(`$049161`/`$049184` für den Sprung, `$049299` für die Richtungen).

## 2. Links in Lunar Magic

| Aussage | Quelle |
|---|---|
| Stern-, Pipe- und Exit-Tiles brauchen "it's own index number" in der Stern/Pipe-Liste bzw. der Exit-Tile-Liste. Der Editor "can track the tiles and automatically update the warp coordinates in the list if you move them". | `ov_overworld_exitstar_link.htm` |
| Verbunden wird mit "Link Star/Pipe/Exit Tiles Together": zwei Tiles mit Alt+Linksklick wählen, dann im Dialog zwei Indizes. Bei Exit-Tiles wählt man zusätzlich die Seite, von der Mario das Tile betritt. Einwegverbindungen sind möglich ("Create a one-way link"), auch Ketten A→B→C→A. | `ov_overworld_exitstar_link.htm`, `ov_mouse.htm` |
| Die alten Dialoge "Star and Pipe Tile Settings" und "Exit Path Tile Settings" sind "obsolete" (drei Schritte mit Index und Ziel-Index). | `ov_overworld_star_level.htm`, `ov_overworld_exit_level.htm` |
| Ein Exit-Tile funktioniert nur, wenn Mario es pixelgenau trifft ("off by even a single pixel … Mario will end up right back"). Bei einem Fehler soll man die Pfade vereinfachen. | `ov_overworld_exitstar_link.htm` |
| Kein Stern und keine Pipe bei X=0 mit Y≥0x20 (wegen einer Tabelle des Spiels). Lunar Magic warnt davor. | `ov_overworld_exitstar_link.htm` |
| "Location Teleports" der Sekundärausgänge nutzen dieselbe Tabelle wie Sterne und Pipes (ein Index, der auf sich selbst zeigt). | `ov_overworld_locationteleport.htm`, `ov_view_starpipe_number.htm` |
| Ein Index ohne passendes Tile auf Layer 1 teleportiert nicht. | `ov_view_starpipe_number.htm`, `ov_view_exitpath_number.htm` |

Was LM an der ROM-Seite tut (im Repo schon belegt):

- Die Stern/Pipe-Tabelle hat 0x100 Einträge (LM 3.00) und liegt in Free Space. Der gefundene Eintrag steht in `$1DF6`
  als Nummer, nicht als Wort-Offset (`src/core/owteleport.ts:1-12`; `docs/credits.md`; belegt an einem ROM, das
  Lunar Magic 3.71 gespeichert hat).
- Die Exit-Path-Tabelle hat 0x80 Einträge (LM 2.40) mit einem JSL bei `$049A35`. Die Adressen der Tabellen stehen bei
  +$11/+$2C/+$48 der Routine (`src/core/owteleport.ts:14-19`; laut `docs/credits.md` aus der Hijack-Map von SMW
  Central).
- Das Repo schreibt beide Tabellen im Format von Lunar Magic (ADR 0005) und macht einen Link durch Ziehen statt mit
  Alt+Klick und Indexdialog (`src/core/owlinks.ts:1-13`).

Links sind also **Daten in einem festen Format**. Hier "wissen" alle Editoren (Lunar Magic, BOWSIE,
Ankounos `OverworldTables.asm`), und das Repo tut das nach ADR 0005 ebenfalls. Die Frage "emulieren oder wissen"
stellt sich für Links nur bei ihrem **Verhalten**: welche Tiles Sterne, Pipes oder Exits sind, wo Mario ankommt und
in welche Richtung er weitergeht.

## 3. Die Test-Hacks

### Byte-Vergleich (Python, ROM ohne Header, LoROM)

Verglichen wurde `$049000–$04A0FF` (Bewegungscode und Pfad-Tabellen) mit `test/fixtures/smw.smc`:

| | Kaizo | Nemesis | Super Luigi Land 2 | teamshell |
|---|---|---|---|---|
| Pose `$049FEB`, Exit-Tiles `$049426`, hardcodierte Pfade `$049078`, Stern-Vergleich `$04915E`, 82-Vergleich `$049268` | gleich | gleich | gleich | gleich |
| Option "hardcoded paths" `$049307` | an | an | **aus** (`80 71`) | an |
| No-Auto-Move `DATA_04906C` | **4B 4C 4D …** | **53 27 46 …** | **0A 14 1C …** | wie das Spiel |
| LMs übliche Hooks (`$049199` JSL `$03BA50`, `$049549` JSL `$03BB20`, `$049882`, `$049AC2`, `$049DFE`, Exit-Path-Tabelle `$049964` ff.) | ja | ja | ja | ja |
| Eigene Hooks im Bewegungscode | **7**: `$0491DC` JML `$C0FE37`, `$049313` JML `$90DAFA`, `$04945E` JML `$90DD51`, `$04952E` JML `$90DB96`, `$0495C4` JSL `$90DB61`, `$049799` JSL `$90DB78`, `$049861` JML `$90DEF6`; dazu BRA bei `$0495B6`/`$049625` | – (nur ein eigener JSL bei `$049DD7`, außerhalb der Bewegung; Zweck nicht geprüft) | Code `$04903A–$049053` geändert | **1**: `$049861` JML `$92A08C` |

Kaizos Hook bei `$049313` liegt am Eingang der hardcodierten Pfade, der bei `$04945E` am Lesen der Pose-Tabelle und
der bei `$049799` an der Vektorberechnung (`CODE_04971D` ff.). Welcher Patch das ist, ließ sich nicht klären (keine
Strings im RATS-Block) – **unbelegt**.

### Die Pfad-Probes auf den Hacks

`pathKindsJob`/`pathShapesJob` (`src/core/owpaths.ts:34`, `:123`) liefen direkt auf einem `LevelEmulator` des
ungepatchten LM-ROMs. Der Editor öffnet solche ROMs nicht (ADR 0005), die Ergebnisse sind daher nur Hinweise:

- **Sauberes Spiel:** Pfadarten 5,7–9,5 s, Pfadformen 4,1–7,4 s (Node 24 im Docker-Container, ein Thread, mehrere
  Läufe; `tools/testowpaths.ts` meldet 9,2 s).
- **Super Luigi Land 2:** Arten wie im sauberen Spiel. Die Formen weichen bei 4D, 55, 14D und 155 ab – **unbelegt**,
  ob echt.
- **Kaizo:** Die Tiles 29/37 (und 129/137) gelten dort als Level-Tile statt als Schwimm-Tile. Ob das echt ist, ist
  **unbelegt**; es passt aber zum Hook bei `$0491DC`. Die Form-Probe fand für kein Tile einen Vektor. Das ist ein
  Versagen der Probe auf diesem ROM, kein Befund.
- **Nemesis, teamshell:** "boot did not reach title screen" (ohne Editor-Patches; nicht weiter untersucht).

## 4. Was das Projekt heute emuliert und was es schon weiß

Emuliert, das heißt aus dem Spielcode gelernt:

- die Art jedes Layer-1-Tiles 000–1FF (`owpaths.ts:1-8`, `:34`)
- die Pfadform: Vektor und Abbiegen pro Tile und Richtung (`owpaths.ts:105-123`)
- die Überspringungen beim Reveal Walk, statt der No-Auto-Move-Liste (CONTEXT.md "Reveal walk": "learned by emulation,
  not from the game's list or code")
- Fortschritt und Saves pro Event (`owprogress.ts`), die Teleports eines Exits zum Overworld (ADR 0005)

Das Ergebnis hängt nur am Spielcode: `maskOverworldData` (`owpaths.ts:39`) nimmt die Overworld-Daten aus den gelesenen
Bytes, Malen erhält es also. Es wird einmal im Probe-Worker gelernt und gehalten, solange sich der Spielcode nicht
ändert (`src/ui/app.ts:1117-1132`).

Schon "gewusst", das heißt fest im Code:

- Stern-/Pipe-Tiles `[5B, 5F, 82]` (`overworld.ts:217`), `isStar` (`owstars.ts:22`)
- 82 erlaubt jede Richtung (`owreach.ts:38`), die Reihenfolge, in der Mario andere Wege versucht (`owreach.ts:37`)
- Formen nur für Tiles unter 56 (`owpaths.ts:121`)
- die hardcodierten Pfade, aus festen Adressen gelesen (`owreach.ts:46-60`)
- die Regeln der Wegsuche selbst (`owreach.ts:1-20`, durch Emulation geprüft in `tools/testowreach.ts`)
- Formate und Größen der Link-Tabellen (`owteleport.ts`)

Das Projekt ist also schon hybrid. Gelernt wird das **Verhalten pro Tile** (512 Tiles × Richtungen), gewusst werden
die **Regeln** der Bewegung und die **Datenformate**.

## 5. Abwägung

Was "wissen" (feste Tabellen der Pfadarten und -formen des sauberen Spiels) bringen würde:

- **Zeit:** einmalig etwa 10–17 s Hintergrundarbeit (Arten + Formen, gemessen wie oben) pro Stand des Spielcodes. Bis
  dahin fehlen Overlay-Linien, Wegprüfung und Route-Brush teilweise (`SHAPES_LEARNING`, "shapes not known: the shape
  is being learned" in `tools/testowpathshape.ts`). Malen löst kein neues Lernen aus.
- **Einfachheit:** zwei Jobs, ihre Lanes und der Zustand "noch unbekannt" in der UI fielen weg.
- **Robustheit:** keine Abhängigkeit davon, dass die Probe auf einem fremden ROM bootet. Auf Nemesis und teamshell
  bootete sie ohne Editor-Patches nicht; im Editor ist das heute ohnehin kein Fall, er öffnet nur das saubere Spiel und
  eigene ROMs.

Was es kosten würde:

- **Hacks, die den Bewegungscode ändern, würden falsch dargestellt.** Kaizo hängt sich an genau die Stellen, an denen
  die Pose gelesen, der Vektor gerechnet und das Level betreten wird. Auch die Probe sieht dort Abweichungen (29/37 als
  Level-Tile). Feste Tabellen sähen nichts davon. Lunar Magic löst das, indem der Autor `.ovpathtxt` von Hand pflegt.
  `tools/testowpaths.ts` prüft schon, dass ein gepatchtes Tile (05 → schwimmen, 81 → Level) richtig gelernt wird.
- **Folgefehler in allem, was auf Arten und Formen aufbaut:** Level-Tile-Test (`levelTileTest`, `owpaths.ts:22`),
  Wegsuche und World Check, Exit-Pfeile, Route-Brush, Sterne. Ein falscher Level-Tile-Test verschiebt etwa die
  Translevel-Vergabe.
- **Widerspruch zu CONTEXT.md und den ADRs:** "Level tile … as emulation shows …, not a range of tile numbers" und
  "Path shape … Learned by emulation". Das wäre eine neue ADR wert, keine stille Ausnahme.
- **Wenig gespart:** Die Kosten fallen einmal pro Spielcode-Stand an, im Hintergrund. Die teuren Overworld-Jobs sind
  andere (World Check ca. 1 s pro Layer-1-Edit, der Fortschritt pro Event; Commit `b74c5ab`).

"Statisch" stimmt für die **Tabellen** (in allen vier Hacks unverändert), aber nicht für den **Code**, der sie liest
(Kaizo, teamshell), und nicht für die benachbarten Listen (No-Auto-Move in 3 von 4 Hacks geändert, hardcodierte Pfade
in SLL2 aus). Wie häufig Patches für eigene Pfad-Tiles oder geänderte Overworld-Bewegung auf SMW Central sind, ließ
sich nicht abrufen – **unbelegt**. Lunar Magic hat für diesen Fall aber eigens `.ovpathbmp`/`.ovpathtxt` eingeführt
(3.50), und 1 bis 2 der 4 Hacks im Repo greifen in den Bewegungscode ein. Selten ist der Fall also nicht.

## Empfehlung (Meinung, keine Quelle)

**Nicht abweichen.** Behaltet die Emulation für das Verhalten pro Tile (Arten, Formen, Reveal Walk). Behaltet das
Wissen dort, wo es heute ist: bei den Regeln der Wegsuche und bei den Datenformaten der Links (ADR 0005). Sinnvoller
als ein Umstieg:

1. **Die Wartezeit verdecken statt die Emulation streichen.** Die Tabellen des sauberen Spiels können als
   *Platzhalter* dienen, solange gelernt wird, für einen ROM, dessen Bytes in Bank 04 `$049000–$04A0FF` dem sauberen
   Spiel gleichen. Das gelernte Ergebnis ersetzt sie dann. Das entspricht dem Muster der "partial kinds" in `cba1c95`
   und ändert nichts Gelerntes.
2. **Den Wissensanteil benennen.** Die heute festen Konstanten (`STAR_PIPE_TILES`, `ANY_WAY_TILE`, `PATH_TILES_END`,
   die Adressen der hardcodierten Pfade) setzen voraus, dass der Code an diesen Stellen nicht geändert ist. Eine Zeile
   in CONTEXT.md "Path shape"/"Reached tile" oder eine kurze ADR würde festhalten, *dass* hier gewusst wird und warum
   (Regeln statt Tabellen, durch Emulation geprüft).
3. Falls der Editor eines Tages fremde LM-ROMs öffnet: Die Probe muss dort booten (Nemesis, teamshell). Kaizos
   Abweichungen sind dann echte Testfälle dafür, dass Emulation hier etwas bringt.

## Unbelegt / offen

- Ob Lunar Magic Pfadarten oder Level-Tiles aus dem ROM liest oder nur fest kennt. Die Hilfe legt "fest" nahe, der
  Code von `Lunar Magic.exe` wurde nicht untersucht.
- Welcher Patch hinter Kaizos sieben Hooks und teamshells Hook steht, und ob die Abweichungen der Probe dort (29/37
  als Level-Tile) dem Spiel entsprechen.
- Ob die Formabweichung in SLL2 (4D, 55) echt ist.
- Wie verbreitet Patches für eigene Pfad-Tiles oder geänderte Overworld-Bewegung sind (SMW Central nicht abrufbar).
