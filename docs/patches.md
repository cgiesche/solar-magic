# ASM-Patches, UberASM und Custom Blocks

Der Editor enthält [Asar](https://github.com/RPGHacker/asar) 1.91 (LGPL-3.0) als WebAssembly. Damit lassen
sich drei Arten von ASM-Code direkt im Browser in die ROM bringen:

| Art | Format | Wo |
|---|---|---|
| **Patches** | beliebige Asar-Patches (`.asm` oder `.zip`), z. B. von SMWCentral | Menü *ROM → Patches …*, Tab *Pakete* |
| **UberASM** | Code pro Level, Overworld-Karte und Game Mode im Format von UberASM Tool 2.x | Tab *UberASM* (auch *ROM → UberASM …*) |
| **Custom Blocks** | Blöcke im GPS-Format | Tab *Custom Blocks* (auch *ROM → Custom Blocks …* oder im Map16-Editor) |

Alles liegt in einem Dialog: der Tab *Pakete* (siehe [Pakete](#pakete)) und je ein Tab für UberASM,
Custom Blocks und Custom Sprites (PIXI, siehe [pixi.md](pixi.md)) mit dem ganzen Projekt. **Hinzufügen …**
oben im Dialog nimmt jeden Download und erkennt, was er ist (Patch, UberASM-Code, Custom Block,
Block-Paket, Custom Sprite, Lunar-Magic-Hintergrund); danach steht er im Tab *Pakete*. Was im aktuellen Tab gewählt ist, gibt die Vorauswahl: im UberASM-Tab Level/Overworld/Game Mode,
im Blocks-Tab das Tile. Patches und Hinzugefügtes gehen sofort in die ROM; Änderungen in den Tabs UberASM,
Custom Blocks und Custom Sprites (Zuordnungen, Dateien, Einstellungen) sammeln sich, bis man sie mit
*Übernehmen* anwendet oder *Verwirft* – beim Schließen fragt der Dialog nach.

Alle drei werden in einem **Patch-Verzeichnis in der ROM** geführt (RATS-Block „SMWA“). Für jeden Patch
sind dort gespeichert:
- die Bytes, die er außerhalb seines eigenen freien Speichers geändert hat, **mit den Originalbytes**;
- die RATS-Blöcke, die er angelegt hat;
- die gewählten Einstellungen;
- die Quelldateien (komprimiert, bis 256 KB; größere nur im Browser).

Deshalb lässt sich jeder Patch später wieder **vollständig entfernen** oder mit anderen Einstellungen
**neu anwenden**, auch nach einem Export der ROM oder auf einem anderen Rechner.

Da der Editor Levels durch Emulation des Spiels lädt, sieht man die Wirkung eines Patches sofort. Das gilt
für geänderte Level-Lade-Routinen, Level-`init`/`load`-Code aus UberASM, Paletten usw. Im Testmodus (▶)
läuft der gesamte Code.

## Pakete

Jeder hinzugefügte Download ist danach ein **Paket**: links die Liste, rechts das gewählte mit allem, was es
mitgebracht hat –
* sein **Patch** mit den Einstellungen und *Neu anwenden*;
* sein **UberASM-Code**: wo er läuft (✕ nimmt eine Zuordnung heraus), *Einstellungen …*/*Bearbeiten …*
  der Dateien, darunter die übrigen Dateien (Bibliotheken, Konfiguration);
* seine **Custom Blocks** (Tile, Datei, acts like; das Tile öffnet den Map16-Editor) und **Custom Sprites**
  (Art, Nummer, Name) mit den Einstellungen ihrer Dateien;
* die **ExGFX-Dateien**, die es angelegt hat;
* **Grafiken im Paket**: `.bin`-Grafikdateien und 128 Pixel breite `.png`. *Als Grafik importieren …*
  wechselt in den Grafik-Bereich und legt die Datei in die erste freie ExGFX-Nummer (eine `.bin`, deren Name
  eine Nummer nennt, wahlweise dorthin; PNG-Farben werden auf die dort gewählte Palette abgebildet);
* **Dateien des Pakets**: alle Dateien des Downloads – lesen (Anleitungen), herunterladen und, für `.asm`,
  *Hinzufügen …* als weiteren Teil (wie unter *Weitere Schritte*, auch später noch).

Was ein Paket bringt, wird nicht von den Dialogen gemeldet, sondern beobachtet: Der Editor vergleicht die
Projekte der ROM (Patches, UberASM, Blöcke, Sprites, ExGFX) vor und nach jedem Schritt. Teile, die später
hinzukommen (*Weitere Schritte*, *Hinzufügen …* eines Teils, importierte Grafiken, neue Einstellungen),
gehören zum selben Paket. Das Verzeichnis liegt in der ROM (RATS-Block „SMWK“), die Dateien des Downloads
auch (komprimiert, bis 256 KB; größere nur im Browser).

**Entfernen …** nimmt das ganze Paket heraus: Patches (spätere zuerst), UberASM-Dateien und
-Zuordnungen, Blöcke, Sprites, angelegte ExGFX-Dateien. Dateien, die auch ein anderes Paket mitgebracht hat
(eine gemeinsame Bibliothek), bleiben; was im Level platziert ist, auch. Schlägt ein Schritt fehl, bleibt
die ROM unverändert.

Patches, die vor dieser Verwaltung angewendet wurden, stehen als eigene Pakete in der Liste. Was in den
Projekten zu keinem Paket gehört (früher oder von Hand hinzugefügt), nennt die Liste unten mit Link zum Tab.
Hintergrund-Pakete gehen ins Level und werden kein Paket.

## Was „Hinzufügen“ erkennt

Viele Downloads auf SMWCentral sind keine eigenständigen Patches, sondern Ressourcen für andere Werkzeuge.
*Hinzufügen …* erkennt das am Code und führt jeweils weiter:

| Erkannt an | Art | Was passiert |
|---|---|---|
| `init:`/`main:`/…-Labels ohne `org` | UberASM-Ressource | Abfrage, wo der Code läuft (ein Level, alle Level, Game Mode, Overworld-Karte), dann Aufnahme ins UberASM-Projekt |
| beginnt mit `db $42`/`db $37` | Custom Block (GPS) | Abfrage von Map16-Tile, „acts like“ (aus der Beschreibung übernommen, z. B. „Act like 130“) und Grafik |
| `list.txt` mit Blöcken, oft `.map16` und `ExGFX…bin` | Block-Paket | alles in einem Schritt, siehe [Block-Pakete](#block-pakete) |
| `.mwl` (meist mit `.map16`, `ExGFX…bin`, `.pal`, `.palmask`) | Hintergrund (Lunar Magic) | der Hintergrund kommt ins aktuelle Level, siehe [Hintergrund-Pakete](#hintergrund-pakete) |
| `print "INIT ",pc` / `print "MAIN ",pc` | Custom Sprite (PIXI) | die Sprites bekommen die nächsten freien Nummern, enthaltene Blöcke die nächsten freien Map16-Tiles, siehe [pixi.md](pixi.md) |
| `.txt` mit `#0` und `#amk`/`#samples` (MML), dazu `.brr`, kein `.asm` | Song (AddmusicK) | Dialog *Add music*: anhören, Nummer, Level; AddmusicK fügt die Musik ein, siehe README → Musik und Tab *Music* |
| alles andere | Patch | wie unten beschrieben |
| UberASM-Tool-Ordner (`library/`, `gamemode/` …) in einem Unterordner, daneben eingebundene Ordner | Paket aus mehreren Teilen | Zuordnen von Hand mit Vorschlag, siehe [Pakete aus mehreren Teilen](#pakete-aus-mehreren-teilen) |

Jedes Hinzufügen-Fenster hat *Anleitung …*, wenn das Paket eine Readme oder ein HTML-Handbuch enthält. Es
wird im Editor angezeigt, mit Bildern und Links zwischen den Seiten; Skripte der Seiten laufen nicht.
Anleitungen von Paketen in UberASM, Blöcken und Sprites bleiben im Browser gespeichert und stehen im
jeweiligen Tab unter *Anleitungen*.

## Pakete aus mehreren Teilen

Manche Downloads lassen sich nicht in einem Schritt einordnen, z. B. Retry System: UberASM-Code in
`src/library` und `src/gamemode`, dazu ein Konfigurationsordner `src/retry_config`, der laut Readme in den
obersten Ordner von UberASM Tool gehört, außerdem Beispiele, AddmusicK-Dateien und ein Handbuch. Solche
Pakete öffnen *Paket zuordnen* (für jedes andere Paket: *Manuell zuordnen …*):

* Der Paketbaum mit einer Auswahl je Ordner und Datei: ein Ordner des UberASM-Projekts (`level/`,
  `gamemode/`, `library/` …, der oberste Ordner oder ein eigener Ordner mit dem Namen) oder *nicht
  übernehmen*. Ein Ordner gibt seine Zuordnung an alles darin weiter; rechts steht, wo jede Datei landet.
* **Vorschlag:** Ordner, die wie die von UberASM Tool heißen und `.asm` enthalten, kommen in ihren Ordner;
  Ordner daneben, die deren Code einbindet (`incsrc "../retry_config/…"`), in den obersten Ordner. Der Rest
  bleibt draußen.
* **list.txt:** Für Dateien in `level/`, `gamemode/` und `overworld/` je eine Zeile mit Nummer oder `*`.
  Steht in der Anleitung eine passende Zeile (`* retry_gm.asm`), wird sie übernommen; vorhandene Einträge
  derselben Nummer bleiben (wie `* a.asm,retry_gm.asm`).
* **Weitere Schritte:** Nach *Übernehmen* listet ein Fenster, was nicht übernommen wurde. Jede `.asm`-Datei
  lässt sich einzeln hinzufügen (erkannt wie oben); Dateien, die sie einbindet und die neben ihr fehlen,
  kommen aus dem Paket mit (Retrys Beispielblöcke bekommen `ram.asm`). Dateien für andere Werkzeuge
  (AddmusicK, Lunar Magic) lassen sich herunterladen.

Danach ist alles im Tab UberASM: Zuordnungen ändern, *Einstellungen …* einer Datei (Defines nach den
Abschnitten der Datei gruppiert, mit den Kommentaren darüber als Hilfe und einem Suchfeld) oder
*Bearbeiten …* als Text für alles, was keine Define-Zeile ist (Makrolisten, Tabellen).

Was nur in Lunar Magic oder im Spiel geht (Objekte mit Extension setzen, neuen Spielstand anlegen),
steht in der Anleitung.

**„Save at least one level in Lunar Magic“:** Manche Patches (z. B. Retry System) prüfen `$0FF0A0 != $FF`.
Dort schreibt Lunar Magic beim ersten Speichern seinen Versionstext, zusammen mit seinen Level-Hacks. Was
Retry davon braucht, ist die aktuelle Levelnummer in `$7E010B`; die liefert der Editor-Patch. Er markiert
die ROM deshalb ebenso (`Solar Magic`, `$0FF0B4` = 0, also keine LM-Version: Code nur für LM 3 wird nicht
gewählt). Eine vorhandene Lunar-Magic-Kennung bleibt unangetastet.

## Patches anwenden

1. *ROM → Patches …* → *Hinzufügen …* und eine `.asm`- oder `.zip`-Datei wählen. Aus einem Archiv wird ein
   gemeinsamer oberster Ordner entfernt; Includes und Binärdateien (`incsrc`/`incbin`) bleiben mit ihren
   relativen Pfaden erhalten.
2. Enthält das Archiv mehrere `.asm`-Dateien, wird die Hauptdatei ausgewählt (siehe Readme des Patches).
3. **Einstellungen:**
   - Ohne `patch.json` zeigt der Dialog alle Define-Zuweisungen (`!name = wert`) auf oberster Ebene der
     Hauptdatei. Geänderte Werte werden direkt in diese Zeilen eingesetzt. So lassen sich auch die
     Konfigurations-Defines gewöhnlicher Patches ändern, ohne die Datei zu bearbeiten.
   - Mit `patch.json` erscheinen stattdessen die dort beschriebenen Optionen.
4. *Anwenden*. Asar-Fehler, Warnungen und `print`-Ausgaben werden angezeigt.

**Konflikte** werden vor dem Übernehmen geprüft; im Fehlerfall bleibt die ROM unverändert. Abgelehnt wird
ein Patch, wenn er
- Bytes ändert, die ein anderer Patch geändert hat, oder in dessen Code schreibt;
- eine Einsprungstelle eines installierten Editor-Patches überschreibt (siehe [Hooks](#hooks-des-editors));
- geschützte Daten überschreibt (bestehende RATS-Blöcke: Level, Grafiken, Paletten …);
- die Banks `$7E/$7F` belegt (bei 4-MB-ROMs für die Emulation reserviert; Asars Freespace-Suche wird
  automatisch davon ferngehalten).

Das gilt für alle Arten gleich: externe Patches, UberASM, Custom Sprites, Custom Blocks, VRAM-Layout und
ExAnimation sind alle im Patch-Verzeichnis eingetragen und werden gegeneinander geprüft, gleich in welcher
Reihenfolge sie angewendet werden (`tools/testconflicts.ts`).

**Free RAM.** Jeder Eintrag im Verzeichnis kann RAM belegen. Die eigenen Komponenten tragen ihre Bereiche
selbst ein, externe Patches über `ram` in der `patch.json` (siehe unten):

| Komponente | RAM |
|---|---|
| UberASM | `freeram` aus der `list.txt` (2 Bytes, Standard `$7FAC80`) |
| Custom Sprites | Sprite-Tabellen `$7FAB10-$7FAB6F`, `$7FAB9E-$7FABA9`, `$7FAC00-$7FAC17` (Schnittstelle, siehe unten), `$7FAC18-$7FAC19` |
| VRAM-Layout | `$7F0000-$7F3653` |
| ExAnimation | `$7FC003-$7FC0FF` |

- Belegen zwei Einträge dasselbe RAM, wird der zweite abgelehnt („RAM-Konflikt mit …“).
- Zusätzlich sucht der Editor im Code jedes Patches nach Long-Schreibzugriffen (`STA $7Fxxxx`,
  `STA $7Fxxxx,x`) und merkt sich die Adressen. Schreibt ein Patch so in RAM, das ein anderer belegt hat (oder
  belegt er RAM, in das ein anderer schreibt), gibt es eine **Warnung**. Die Suche findet nicht alles
  (indirekte Zugriffe, `DB = $7F`), deshalb ist es kein Fehler.
- Bereiche, die eine **Schnittstelle** sind, warnen nicht: In die Sprite-Tabellen schreiben auch Blocks und
  UberASM-Code, etwa beim Erzeugen eines Custom Sprites.
- RAM des Original-Spiels (z. B. `$7F837B`) gehört niemandem und wird nicht geprüft.
- Adressen im Low-RAM-Spiegel (`$0DC4`) werden als `$7E0DC4` verglichen.

Belegt ein Patch die Einsprungstelle eines Editor-Patches, der noch **nicht** installiert ist, gibt es nur
eine Warnung. Die entsprechende Editor-Funktion (z. B. eigene Level-Paletten) lässt sich danach nicht mehr
aktivieren, und ihre Fehlermeldung nennt den Patch.

**Entfernen** setzt die geänderten Bytes auf den Originalzustand zurück und gibt den freien Speicher des
Patches frei. Hat ein später angewendeter Patch Code dieses Patches verändert, muss zuerst jener entfernt
werden.

### Einschränkungen

* **Nur LoROM, kein SA-1.** Patches sehen `!sa1 = 0`. Patches, die ausschließlich für SA-1 gedacht sind,
  funktionieren nicht.
* **Patches, die Lunar Magic voraussetzen, funktionieren nicht.** Solche Patches lesen etwa die
  LM-Versionskennung bei `$0FF0B4` oder bauen auf LMs eigenen Hooks für ExGFX, Map16 oder Level-Daten auf.
  Der Editor stellt dafür eigene Schnittstellen bereit (siehe `smwe.asm`). Die Levelnummer in `$7E010B`
  gibt es wie bei LM.
* Die Prüfsumme setzt der Editor beim Export; Patches müssen sich nicht darum kümmern.

## Eigene Patches schreiben

Patches sind normale Asar-Patches. Für den Editor gilt zusätzlich:

* `!smwe` ist als 1 definiert, `!sa1` als 0.
* Code und Daten gehören mit `freecode`/`freedata` in freien Speicher. Hijacks im Original-Code per `org`.
  Beides erkennt der Editor automatisch; `autoclean` ist nicht nötig, schadet aber nicht.
* Einstellbare Werte als **`!name ?= wert`** schreiben (nur setzen, wenn nicht schon definiert), dann
  werden sie über `patch.json` als Asar-Defines übergeben. `!name = wert` auf oberster Ebene der
  Hauptdatei funktioniert ebenfalls: Der Editor schreibt den Wert direkt in diese Zeile.
* `incsrc "smwe.asm"` bindet die Schnittstellen des Editors ein (siehe unten).

### `patch.json`

Optional, im Wurzelverzeichnis des Archivs:

```json
{
  "name": "Start-Powerup",
  "author": "jemand",
  "version": "1.0",
  "description": "Mario beginnt jedes Level mit dem gewählten Powerup.",
  "main": "startpowerup.asm",
  "requires": ["smwe"],
  "smwc": "https://www.smwcentral.net/?p=section&a=details&id=…",
  "options": [
    { "define": "powerup", "label": "Powerup", "type": "enum", "default": "1",
      "values": [ { "value": "0", "label": "klein" }, { "value": "1", "label": "groß" },
                  { "value": "2", "label": "Cape" }, { "value": "3", "label": "Feuer" } ] },
    { "define": "keep_yoshi", "label": "Yoshi behalten", "type": "bool", "default": true },
    { "define": "timer", "label": "Zeit", "type": "number", "default": 300, "hint": "dezimal" },
    { "define": "freeram", "label": "Free RAM", "type": "hex", "default": "$7FB000" }
  ],
  "ram": [ { "define": "freeram", "size": 1 } ]
}
```

| Feld | Bedeutung |
|---|---|
| `name`, `main` | Pflicht. `main` ist die Hauptdatei (Pfad im Archiv) |
| `options[]` | Formularfelder; `define` ohne `!`. Typen: `bool` (1/0), `number`, `hex` (`$…`), `enum` (`values`), `text` |
| `ram[]` | Free RAM, das der Patch benutzt: `{ "define": "freeram", "size": 4 }` (Adresse = Wert der Einstellung bzw. der Zuweisung in der Hauptdatei) oder `{ "addr": "$7FB000", "size": 4 }`; `"shared": true` für Bereiche, in die andere schreiben dürfen |
| `requires` | Editor-Patches, die vorher installiert werden: `"smwe"` (Editor-Patch), `"smwx"` (Map16-Erweiterung) |
| `author`, `version`, `description`, `smwc` | Anzeige im Dialog |

### `smwe.asm`

Wird für jeden Patch aus dem aktuellen Stand der ROM erzeugt; eine eigene Datei gleichen Namens im
Patch hat Vorrang. Adressen sind 0, wenn der jeweilige Editor-Patch nicht installiert ist.

| Define | Inhalt |
|---|---|
| `!SMWE_LEVEL` | `$7E010B`: aktuelle Levelnummer (16 Bit), gesetzt beim Laden eines Levels |
| `!SMWE_PATCH` | 1, wenn der Editor-Patch (SMWE) installiert ist |
| `!SMWE_SPRITE_BANKS` | 512 Bytes: Bank der Sprite-Daten jedes Levels |
| `!SMWE_GFX_LO/HI/BANK`, `!SMWE_GFX_FLAGS` | 256 Einträge: Zeiger auf GFX-/ExGFX-Dateien, Format (1 = 4bpp roh) |
| `!SMWE_LEVEL_GFX` | 512 × 8 Bytes: Grafik-Bypass pro Level (SP4…SP1, FG3, BG1, FG2, FG1; `$FF` = Standard) |
| `!SMWE_PALETTES` | 512 × 3 Bytes: Zeiger auf die 256-Farben-Palette eines Levels (0 = keine) |
| `!SMWE_BG_BANKS` | 512 Bytes: Bank der BG-Tilemap eines Levels (0 = Original) |
| `!SMWE_LEVEL_MUSIC` | 512 Bytes: Song eines Levels statt seiner Header-Einstellung, 0 = Header (Musik pro Level, SMWU) |
| `!SMWE_EXT_GFX` | 512 × 2 Bytes: BG2/BG3-Grafikdatei eines Levels (Tiles 200–27F/280–2FF), `$FF` = keine |
| `!SMWE_MAP16X` | 1, wenn die Map16-Erweiterung (SMWX) installiert ist |
| `!SMWE_BG_MAP16_GFX` | 8 Bytes (4 Tile-Wörter) je BG-Tile 200–FFF (SMWH), 0 = nicht installiert |
| `!SMWE_ACTS_LIKE` | `$1000` × 2 Bytes: „acts like“ der Map16-Tiles 000–FFF |
| `!SMWE_MAP16_GFX` | 8 Bytes (4 Tile-Wörter) je Tile 200–FFF |
| `!SMWE_BLOCKS` | `$1000` × 4 Bytes: Custom Block je Tile (Adresse der JMP-Tabelle, Flags) |
| `%smwe_require(X)` | bricht mit einer Meldung ab, wenn `!SMWE_X` 0 ist, z. B. `%smwe_require(MAP16X)` |

## UberASM

Code pro **Level** (000–1FF), **Overworld-Karte** (0–6) und **Game Mode** (00–FF) sowie globaler Code.
Das Format entspricht UberASM Tool 2.x, vorhandene Ressourcen funktionieren unverändert:

* Ordner `level/`, `overworld/`, `gamemode/`, `library/`, `routines/`, `other/` und eine `list.txt`. Ein
  UberASM-Tool-Ordner lässt sich als `.zip` importieren; die Dateien des Tools selbst (`asm/`, `.exe` …)
  werden ignoriert. *Exportieren* erzeugt wieder einen Ordner für UberASM Tool.
* Labels `init`, `main`, `end`, `load`, `nmi`, jeweils mit `RTL`. A/X/Y sind 8 Bit, das DBR ist die Bank
  der Ressource (außer mit `;>dbr off`).
* Extra-Bytes: `;>bytes n` oder `;>bytes any`; Zeiger in `$00-$01`. In der `list.txt` stehen sie nach `:`,
  z. B. `105 wind.asm : 02`.
* `library/`-Dateien: Wie bei UberASM Tool wird jede für sich assembliert (eigene Namespaces und Labels);
  ihre Labels heißen danach `<Dateiname>_<Label>`. Shared Routines aus `routines/` werden mit
  `%UberRoutine(Name)` aufgerufen.
* `%prot_file()`, `%prot_source()`, `%require_uber_ver()`, `%move_block()` und die Sprite-Tabellen-Defines
  (`!sprite_num`, `!14C8` …) stehen zur Verfügung.
* `global:` (`init` mit `RTS`), `statusbar:` (`main` mit `RTS`), `macrolib:` und `freeram:` (2 Bytes) wie in
  UberASM Tool.

**Unterschiede zu UberASM Tool:**
- Alles wird als **ein** Patch eingetragen: erst je ein Asar-Lauf pro Bibliothek, dann einer für
  Ressourcen und Verteiler.
- Das Überspringen von `*`-Ressourcen (`-datei.asm`) wird nicht unterstützt.
- Kein SA-1, daher wird `;>sa1` ignoriert.
- Level-Ressourcen brauchen die Levelnummer in `$7E010B`; dafür wird bei Bedarf der Editor-Patch
  installiert.

Die Einsprungstellen sind dieselben wie bei UberASM Tool (siehe [Hooks](#hooks-des-editors)). Patches, die
mit UberASM Tool kollidieren, kollidieren also auch hier.

## Custom Blocks (GPS-Format)

Ein Block ist eine `.asm`-Datei in `blocks/`. Sie beginnt mit `db $42`, gefolgt von einem `JMP` je Offset;
jeder Offset endet mit `RTL`:

```asm
db $42
JMP MarioBelow : JMP MarioAbove : JMP MarioSide
JMP SpriteV : JMP SpriteH : JMP MarioCape : JMP MarioFireball
JMP TopCorner : JMP BodyInside : JMP HeadInside
; mit "db $37" zusätzlich: JMP WallFeet : JMP WallBody

MarioAbove:
MarioSide:
    ; ...
    RTL
```

* Beim Aufruf enthalten **Y:`$1693`** das „acts like“ des Tiles. Der Block kann es ändern; danach gilt das
  neue Verhalten. Beispiel: `LDY #$00 : LDA #$25 : STA $1693` macht den Block für diesen Kontakt zu Luft.
* **X** ist das X des Aufrufers (Sprite-Index bei `SpriteV/H`, Feuerball-Index bei `MarioFireball`). Es
  wird danach wiederhergestellt.
* Shared Routines aus `routines/` werden als `%name()` aufgerufen und nur einmal eingefügt. Die
  Standard-Routinen von GPS 1.4.5 sind eingebaut (`change_map16`, `get_map16`, `spawn_bounce_sprite`,
  `spawn_sprite`, `shatter_block`, `glitter`, `teleport` …, mit denselben Ein- und Ausgaben, nach den Routinen
  des Spiels geschrieben); gleichnamige Dateien in `routines/` haben Vorrang. Ebenso die zusätzlichen Defines
  von GPS (`!sprite_extra_bits`, `!bounce_map16_low` … für den Custom-Bounce-Block-Patch).
* `list.txt` wie bei GPS: `200 block.asm` oder `200:130 block.asm` (Tile, optional „acts like“).
  Zuweisen lässt sich auch im Map16-Editor (*Custom Blocks …*).

Die Blöcke hängen an der Map16-Erweiterung (SMWX); sie wird bei Bedarf installiert. Custom Blocks
funktionieren für alle Tiles 000–FFF.

**Welcher Offset aufgerufen wird**, ergibt sich aus dem Aufrufer der Block-Routine `$00F545`:

| Aufrufer | Offset |
|---|---|
| Mario, Punkt Körpermitte | `BodyInside` |
| Mario, Seitenpunkte | `MarioSide` |
| Mario, Kopfpunkt | `MarioBelow` beim Steigen, sonst `HeadInside` |
| Mario, Fußpunkte | `MarioAbove` beim Fallen/Stehen, sonst `TopCorner` |
| Mario beim Wandlauf | `WallFeet` / `WallBody` (nur Blöcke mit `db $37`) |
| Sprites (`$019441`) | `SpriteV` für Boden/Decke, `SpriteH` für Wände |
| Cape (`$0295AE`) | `MarioCape` |
| Feuerbälle / erweiterte Sprites (`$02A6xx`) | `MarioFireball` |

Diese Zuordnung ist aus dem Original-Code abgeleitet und nicht aus Lunar Magic übernommen. Blöcke, die
sich auf LM-spezifische Feinheiten verlassen (z. B. genau wann `TopCorner` kommt), können sich leicht
anders verhalten.

## Block-Pakete

Viele Blöcke auf SMWCentral kommen als Paket, z. B.:
- `list.txt`: GPS-Liste, etwa `500:025 LeftWallLedge.asm`;
- die Block-Dateien;
- `Tiles.map16`: die Grafik der Map16-Tiles, als Lunar-Magic-Export;
- `ExGFX80_BG2.bin`: die 8×8-Grafik, auf die die Map16-Tiles verweisen, hier für den BG2-Slot.

*Hinzufügen …* richtet das zusammen ein:
1. Die Blöcke kommen auf die Tiles aus der `list.txt`.
2. Die `.map16`-Tiles kommen ab dem ersten Tile der Liste (änderbar) in die Map16-Tabelle, mit ihrem
   „acts like“, sofern die Liste keines angibt.
3. Die ExGFX-Datei wird unter ihrer Nummer aus dem Dateinamen gespeichert und im aktuellen Level in den
   Slot aus dem Dateinamen gelegt (`_BG2`, `_FG1` …). Für andere Level: Grafik-Bereich → *Grafiken* → Slot-Karte → „Tauschen …“.

Einzeln geht das auch:
- *Grafiken* → *Import/Export → Importieren (.bin)* (4 KB = 4bpp unkomprimiert, 3 KB = 3bpp, sonst LZ2-gepackt);
- *Map16-Tiles* → *Import/Export → Importieren (.map16)* (ab dem gewählten Tile).

**BG2/BG3:** Wie Lunar Magic hat der Editor pro Level zwei zusätzliche Grafik-Slots für die Map16-Tiles
200–27F (BG2) und 280–2FF (BG3), im Grafik-Bereich unter *Grafiken* als Slot-Karten BG2/BG3. Im Original-Spiel liegt an
dieser Stelle im VRAM (`$2000–$2FFF`) die Layer-1-Tilemap. Die Slots brauchen deshalb den **VRAM-Patch**
(„SMWV“), der die Tilemaps wie bei LM verlegt, siehe unten. Er wird mit der Karte „BG2/BG3“ → „Aktivieren …“
im Tab *Grafiken* installiert, bei Block-Paketen mit BG2/BG3-Grafik automatisch.

Eine frühere Installation der Slots ohne VRAM-Patch (bis zu dieser Version) hat die Layer-1-Tilemap
überschrieben. Sie wird beim Öffnen der ROM abgeschaltet; ihre Zuordnungen bleiben erhalten und gelten
wieder, sobald der VRAM-Patch installiert ist.

### VRAM-Patch (SMWV)

In Leveln liegen die Layer-1/2-Tilemaps mit dem Patch als 64×32 bei `$3000`/`$3800` statt 64×64 bei
`$2000`/`$3000`.
- **Horizontale Level:** Eine 64×32-Tilemap fasst 32 der 54 Tile-Zeilen. Alle Zeilen beider Layer stehen
  in einem RAM-Schatten bei `$7F0000–$7F3653`; die Tilemap hält ein Fenster um die Kamera, und beim
  vertikalen Scrollen werden Zeilen aus dem Schatten nachgeladen.
- **Vertikale Level:** Sie laden ohnehin zeilenweise; dort baut das Spiel nur 1 Block über und 15 Blöcke
  unter der Kamera vor statt 8 und 23.
- **Einzelne Tile-Änderungen** (Münzen, Blöcke …) gehen in den Schatten und, falls sichtbar, ins VRAM.
- **Overworld, Titelbild und Abspann** bleiben unverändert.

Geprüft wird das, indem jedes Level mit und ohne Patch mit denselben Eingaben gespielt wird: Bei gleichem
Spielzustand muss der sichtbare Inhalt beider Tilemaps exakt übereinstimmen (`tools/testvram.ts`). Der
Patch kostet etwas Rechenzeit. In Frames, die schon im Original am Limit sind, entsteht deshalb selten
ein Lag-Frame mehr, im Test rund 0,1 % der Frames. Belegt ein anderer Patch RAM im `$7F0000`-Bereich (über
`ram` in der `patch.json`), lehnt der Editor ihn ab; schreibt er nur dorthin, gibt es eine Warnung (siehe
[Free RAM](#patches-anwenden)). Patches, die den Bereich trotzdem nutzen oder die Tilemap-Uploads selbst
verändern, vertragen sich nicht damit.

## Hintergrund-Pakete

Hintergründe auf SMWCentral sind Lunar-Magic-Exporte: ein Level (`.mwl`), dessen Layer 2 eine
BG-Tilemap ist, dazu eine `.map16` mit den BG-Map16-Tiles (meist ab 200), die ExGFX-Dateien der Slots
und eine Palette `.pal` mit `.palmask`, die angibt, welche Farben zum Hintergrund gehören.
*Hinzufügen …* übernimmt davon **nur den Hintergrund ins aktuelle Level**. Layer 1, Sprites und Header
bleiben. Das Level muss einen BG-Hintergrund haben, also keine Layer-2-Objekte.

1. Die BG-Tilemap kommt aus der `.mwl` und wird als Level-Änderung übernommen (noch nicht gespeichert).
2. Die `.map16`-Tiles kommen auf die erweiterten BG-Map16-Seiten 2–F (BG-Map16-Erweiterung, SMWH).
   Vorgeschlagen wird der Platz aus dem Paket. Ist der schon belegt, kommen sie auf die nächsten freien
   Tiles; die Tilemap wird entsprechend verschoben.
3. Die ExGFX-Dateien werden unter freien Nummern gespeichert (Lunar Magic zählt bis FFF, der Editor
   bis FE) und in die Slots gelegt, die die `.mwl` nennt (BG1–BG3, ggf. FG1–FG3). Für BG2/BG3 wird
   bei Bedarf der VRAM-Patch installiert.
4. Die Farben laut `.palmask` (aus der `.pal`) und, falls markiert, die Hintergrundfarbe (aus der
   `.mwl`) kommen in die eigene Palette des Levels. Sie wird bei Bedarf aus den aktuellen Farben angelegt.

Das Ganze ist rückgängig zu machen: Strg+Z nimmt zuerst die Tilemap zurück, dann den Rest.

### BG-Map16-Erweiterung (SMWH)

Das Spiel zeichnet BG-Spalten in einer einzigen Routine (`$058D7A`, auch für den ersten Aufbau). Die
Tile-Wörter eines BG-Tiles liegen dort bei `$0D9100 + Tile × 8`. Der Hook bei `$058DE6` nimmt für die
Tiles 200–FFF eine eigene Tabelle (`!SMWE_BG_MAP16_GFX`); 000–1FF bleiben unverändert. Die High-Bytes
der Tilemap (`$7EBD00`) schreibt der RLE-Decoder des Spiels schon vollständig, deshalb braucht es dafür
keinen weiteren Hook. Im Grafik-Bereich zeigt *Map16-Tiles → Hintergrund* die Seiten 2–F. Der BG-Pinsel
hat eine Seitenauswahl. Wird ein BG mit solchen Tiles gespeichert, installiert der Editor den Patch
automatisch.

## Hooks des Editors

Stellen im Original-Code, die der Editor selbst verändert. Ein Patch, der dieselben Stellen ändert, ist
mit der jeweiligen Funktion nicht kompatibel.

| Adresse | Funktion |
|---|---|
| `$05D8F5`, `$00BA2C`, `$00AA6B`, `$00A9E1`, `$00AA22`, Ext.-Objekt-Tabelle `$0DA115` | Editor-Patch (SMWE) |
| `$00922F` | Level-Paletten (SMWP) |
| `$058060` | BG-Tilemaps (SMWB) |
| `$058DE6` | BG-Map16-Erweiterung, BG-Tiles 200–FFF (SMWH) |
| `$058551` | Musik pro Level (SMWU) |
| `$00AA50` | BG2/BG3-Grafik-Slots (SMWG) |
| `$008A7F`, `$0087AD`, `$0085E3`, `$0580B0`, `$0580B4`, `$0580BF`, `$0580C3`, `$058730`, `$058770`, `$0587D4`, `$0587DB`, `$05880B`, `$058812` | VRAM-Patch (SMWV): Tilemaps verlegt; RAM `$7F0000–$7F3653` |
| Ext.-Objekt-Tabelle `$0DA118` (Eintrag `$03`) | Strukturen (SMWS); im Original leer, kein Code-Hook |
| `$05B20F` | Nachrichten in freiem Speicher (SMWM), nur wenn die Texte nicht mehr passen |
| `$00F545`, `$029328`, `$058A66`, `$058B46`, `$058C34`, `$058D2B`, `$00C096`, `$00C0E7` | Map16-Erweiterung und Custom Blocks (SMWX) |
| `$05808C`, `$00A5EE`, `$00A242`, `$00A295`, `$00A2EE` | UberASM: Level `load`/`init`/`main`/`end` |
| `$00A18F`, `$00A1C3` | UberASM: Overworld |
| `$009322` | UberASM: Game Modes |
| `$00804E`, `$008176`, `$008E1A` | UberASM: globaler Init, NMI, Statusleiste |
| Banks 01/02/07 (Liste in [pixi.md](pixi.md#umsetzung)) | Custom Sprites |

Die UberASM-Hooks werden nur gesetzt, wenn es Code für den jeweiligen Bereich gibt (`$00804E` immer).

## Kompatibilität bekannter Patches

Es werden keine Patches mitgeliefert, weil die Lizenzen auf SMWCentral unterschiedlich sind. Ob ein Patch
passt, lässt sich meist aus seiner Readme ablesen:

* **Hijack-Adressen** mit der Tabelle oben vergleichen. Beispiel: Ein VWF-Dialog-Patch, der die
  Nachrichtenroutine bei `$05B1xx–$05B2xx` ersetzt, verträgt sich nicht mit verlegten Nachrichtentexten
  (SMWM). Solange die Texte an ihrem Platz bleiben, ist SMWM nicht installiert.
* **„Requires Lunar Magic“ oder „LM x.y+“** bedeutet meist, dass der Patch auf LM-Hooks aufbaut; das
  funktioniert hier nicht.
* **SA-1-only** funktioniert nicht.
* **Patches für UberASM Tool/GPS** (Ressourcen, Blöcke) gehören in den UberASM- bzw. Block-Dialog, nicht
  in *Patch hinzufügen*.

Im Zweifel einfach anwenden: Der Editor lehnt Konflikte ab, und über *Entfernen* ist jeder Patch wieder
rückgängig zu machen.

## Technisches

* `src/core/asar.ts`: Asar-WASM (`tools/build-asar.sh` baut es mit Emscripten nach `src/vendor/asar/`).
  Pfade von `incsrc`/`incbin` werden wie von einem Dateisystem aufgelöst (`a//b`, mehrere `..`
  hintereinander; `tools/asar-wasm/normalize-paths.patch`), da die Dateien nur im Speicher liegen.
* `src/core/pkgmap.ts`, `src/ui/pkgmap.ts`: Pakete aus mehreren Teilen; `src/ui/docview.ts`: Anleitungen.
* `src/core/patchapply.ts`: Anwenden, Konfliktprüfung, Entfernen.
* `src/core/patchreg.ts`: Patch-Verzeichnis „SMWA“ in der ROM.
* `src/core/pkgreg.ts`, `src/ui/pkgtrack.ts`, `src/ui/packages.ts`: Paket-Verzeichnis „SMWK“, Beobachten,
  Entfernen; der Tab *Pakete*.
* `src/core/patchpkg.ts`: `.zip`, `patch.json`, Defines.
* `src/core/uberasm.ts`, `src/core/uberproject.ts`: UberASM-Generator und -Projekt.
* `src/core/blocks.ts`, `src/core/map16ext.ts`: Custom Blocks.
* `src/core/structs.ts`: Strukturen (erweitertes Objekt `$03`). Level-Daten: `00`-Objekt-Bytes wie bei jedem
  erweiterten Objekt mit `$03`, dann 1 Byte Strukturnummer. Ohne SMWS gilt `$03` als gewöhnliches
  3-Byte-Objekt, damit Patches, die `$03` selbst belegen, weiter funktionieren.
* Tests: `tools/testasar.ts`, `tools/testuberasm.ts`, `tools/testblocks.ts`, `tools/teststructs.ts`,
  `tools/testpkgreg.ts` (Teil von `npm test`).
