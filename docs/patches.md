# ASM-Patches, UberASM und Custom Blocks

Der Editor enthält [Asar](https://github.com/RPGHacker/asar) 1.91 (LGPL-3.0) als WebAssembly. Damit lassen
sich drei Arten von ASM-Code direkt im Browser in die ROM bringen:

| Art | Format | Wo |
|---|---|---|
| **Patches** | beliebige Asar-Patches (`.asm` oder `.zip`), z. B. von SMWCentral | Toolbar → *Patches* |
| **UberASM** | Code pro Level, Overworld-Karte und Game Mode im Format von UberASM Tool 2.x | *Patches* → *UberASM …* |
| **Custom Blocks** | Blöcke im GPS-Format | *Patches* → *Custom Blocks …* oder im Map16-Editor |

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

## Patches anwenden

1. *Patches* → *Patch hinzufügen …* und eine `.asm`- oder `.zip`-Datei wählen. Aus einem Archiv wird ein
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
  ]
}
```

| Feld | Bedeutung |
|---|---|
| `name`, `main` | Pflicht. `main` ist die Hauptdatei (Pfad im Archiv) |
| `options[]` | Formularfelder; `define` ohne `!`. Typen: `bool` (1/0), `number`, `hex` (`$…`), `enum` (`values`), `text` |
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
| `!SMWE_MAP16X` | 1, wenn die Map16-Erweiterung (SMWX) installiert ist |
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
* `library/`-Dateien: Labels heißen `<Dateiname>_<Label>`. Shared Routines aus `routines/` werden mit
  `%UberRoutine(Name)` aufgerufen.
* `%prot_file()`, `%prot_source()`, `%require_uber_ver()`, `%move_block()` und die Sprite-Tabellen-Defines
  (`!sprite_num`, `!14C8` …) stehen zur Verfügung.
* `global:` (`init` mit `RTS`), `statusbar:` (`main` mit `RTS`), `macrolib:` und `freeram:` (2 Bytes) wie in
  UberASM Tool.

**Unterschiede zu UberASM Tool:**
- Alles wird als **ein** Asar-Patch assembliert: erst die Bibliotheken, dann die Ressourcen, dann der
  Verteiler.
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
* Shared Routines aus `routines/` werden als `%name()` aufgerufen und nur einmal eingefügt.
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

## Hooks des Editors

Stellen im Original-Code, die der Editor selbst verändert. Ein Patch, der dieselben Stellen ändert, ist
mit der jeweiligen Funktion nicht kompatibel.

| Adresse | Funktion |
|---|---|
| `$05D8F5`, `$00BA2C`, `$00AA6B`, `$00A9E1`, `$00AA22`, Ext.-Objekt-Tabelle `$0DA115` | Editor-Patch (SMWE) |
| `$00922F` | Level-Paletten (SMWP) |
| `$058060` | BG-Tilemaps (SMWB) |
| `$05B20F` | Nachrichten in freiem Speicher (SMWM), nur wenn die Texte nicht mehr passen |
| `$00F545`, `$029328`, `$058A66`, `$058B46`, `$058C34`, `$058D2B`, `$00C096`, `$00C0E7` | Map16-Erweiterung und Custom Blocks (SMWX) |
| `$05808C`, `$00A5EE`, `$00A242`, `$00A295`, `$00A2EE` | UberASM: Level `load`/`init`/`main`/`end` |
| `$00A18F`, `$00A1C3` | UberASM: Overworld |
| `$009322` | UberASM: Game Modes |
| `$00804E`, `$008176`, `$008E1A` | UberASM: globaler Init, NMI, Statusleiste |

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
* `src/core/patchapply.ts`: Anwenden, Konfliktprüfung, Entfernen.
* `src/core/patchreg.ts`: Patch-Verzeichnis „SMWA“ in der ROM.
* `src/core/patchpkg.ts`: `.zip`, `patch.json`, Defines.
* `src/core/uberasm.ts`, `src/core/uberproject.ts`: UberASM-Generator und -Projekt.
* `src/core/blocks.ts`, `src/core/map16ext.ts`: Custom Blocks.
* Tests: `tools/testasar.ts`, `tools/testuberasm.ts`, `tools/testblocks.ts` (Teil von `npm test`).
