# SMW Editor – Level-Editor für Super Mario World

Browserbasierter Editor für *Super Mario World* (US), orientiert am Funktionsumfang von Lunar Magic.
Läuft komplett lokal im Browser; die ROM wird nirgends hochgeladen (sie wird nur in der IndexedDB des Browsers zwischengespeichert).

## Start

```sh
npm install
npm run dev          # http://localhost:5173 – ROM per Button oder Drag & Drop öffnen
npm run build        # statischer Build nach dist/
npm test             # Regressionstests (benötigt "Super Mario World (U) [!].smc" im Projektordner)
```

Im Dev-Modus lädt `?rom=/<Dateiname>` eine ROM direkt aus dem Projektordner.

## Grundidee: Das Spiel rendert sich selbst

Statt die rund 250 Objektroutinen von SMW nachzuprogrammieren, enthält der Editor einen 65816-CPU-Emulator
mit SNES-Speicherabbild (DMA, VRAM/CGRAM/OAM, Mathe-Register, NMI/IRQ, APU-Handshake-Attrappe).
Beim Anzeigen eines Levels führt er die **originalen Laderoutinen** des ROMs aus (~15 ms pro Level):

* Die Map16-Daten der Level (`$7EC800`/`$7FC800`), Grafik (VRAM) und Palette (CGRAM) kommen direkt aus dem Spiel –
  pixelgenau, auch mit geänderten Grafiken und ROM-Patches.
* Beim Laden wird mitgeschrieben, welches Objekt welches Tile schreibt. So sind Auswahl, Hover und
  Umrisse exakt, ohne dass der Editor Objektformen kennen muss.
* Objektvorschauen in der Palette und Sprite-Grafiken werden ebenfalls erzeugt, indem das Spiel sie rendert
  (Sprites: ein paar Frames laufen lassen und die OAM-Einträge einsammeln).
* Ein Provenance-Tracking verfolgt, aus welchem ROM-Byte jede CGRAM-Farbe stammt – darüber schreibt der
  Paletten-Editor an die richtige Stelle zurück.
* Mit dem eingebauten PPU-Scanline-Renderer lässt sich das bearbeitete Level direkt **anspielen** (ohne Ton).

## Funktionen

### Level-Editor
* Alle 512 Level; Liste mit Levelnamen (aus der Overworld), Filter nach Nummer/Name.
* **Layer 1 / Layer 2 (bei L2-Levels) / Sprites / Screen-Exits** als Bearbeitungsmodi (Tasten 1–4).
* Objekte: auswählen (auch Rahmen, Strg+Klick), verschieben (Maus/Pfeile), Größe per Griff/Tasten,
  einfügen (Rechtsklick/Shift+Klick mit Paletteneintrag), löschen, kopieren/einfügen/duplizieren,
  Zeichenreihenfolge (Bild↑/↓), Undo/Redo.
* Palette: Standardobjekte 01–3F, erweiterte Objekte, **Map16-Direktplatzierung** (beliebiges Tile, s. Patch),
  Sprites mit Namen und echter Grafik.
* Header-Dialog (H): Primärer Header (Modus, Screens, Tileset, Paletten, Musik, Zeit, Sprite-GFX, …),
  sekundärer Header (Eingang, Midway, Layer-2/3-Einstellungen), Sprite-Header, BG-Tilemap-Auswahl,
  **Grafik-Bypass (ExGFX pro Level)**.
* Screen-Exits pro Screen (Ziel, sekundär), **sekundäre Eingänge** (Dialog), Level kopieren/„speichern unter“.
* **Eingangsmarkierungen** für Haupteingang (M), Zwischenziel-Screen (Z) und sekundäre Eingänge (S) – per Ziehen
  verschiebbar (rastet auf die möglichen Eingangspositionen ein).
* **Einfügen nach Nummer** (Einfg/I): Objekt, erweitertes Objekt oder Sprite mit Größe/Extra-Bits.
* Raster, Screen-Grenzen, Layer ein-/ausblendbar; **Ghost** (nicht bearbeitete Objektebene halbtransparent);
  Ansicht mit gedrückten Switch-Palästen bzw. ON/OFF auf OFF; Zoom 50–400 %.
* Statuszeile mit Objekt-/Sprite-Anzahl und Datengröße (Warnung ab 128 Sprites); **Level als PNG** exportieren.
* **Level testen (T):** das Level (inkl. ungespeicherter Änderungen) im eingebauten Emulator spielen.

### Grafik, Paletten, Map16
* **Map16-Editor** (M): FG- und BG-Tiles des aktuellen Tilesets, pro Viertel 8x8-Tile, Palette, Flip, Priorität.
* **Paletten-Editor** (P): Farben direkt an ihrer ROM-Quelle bearbeiten, `.pal` Import/Export,
  optional **eigene Palette pro Level** (alle 256 Farben).
* **Grafiken:** GFX00–31 und ExGFX 32–FF anzeigen, als PNG exportieren/importieren.
  Import wahlweise LZ2-komprimiert (Originalformat, 2/3/4bpp) oder als einheitliches **4bpp unkomprimiert**
  (16 Farben, per DMA aus dem ROM – kein 3bpp-Umweg mehr).
  Der eigene LZ2-Kompressor erzeugt kleinere Daten als das Original.

### Overworld-Editor (O)
* Hauptkarte und alle Submaps, Layer 1 (Wege/Level-Tiles) und Layer 2 (Gelände, 8x8) malen, Pipette,
  optionale Ansicht „alle Events freigeschaltet“.
* Level-Tiles zeigen Translevel → Levelnummer; Levelnamen aus den drei Namensbausteinen wählbar;
  Sprung zum Level-Editor.
* Speichern: Layer 1 an Ort und Stelle, Layer 2 mit optimalem RLE-Encoder in freien Speicher.

### ROM
* Header (512 Byte) wird erkannt und beim Export beibehalten; Prüfsumme wird korrigiert.
* Erweiterung auf 1/2/4 MB (automatisch beim Speichern, wenn nötig). Freier Speicher wird über
  RATS-Tags verwaltet (kompatibel zum üblichen Schema), alte Blöcke werden freigegeben.
* Geänderte Level werden, wenn sie passen, an Ort und Stelle geschrieben; geteilte oder größere Daten wandern
  in freien Speicher.

## Eigener ROM-Patch („SMWE“)

Wird bei Bedarf automatisch installiert (oder über *ROM → Editor-Patch installieren*). Er wird zur Laufzeit
assembliert und ändert nur wenige, verifizierte Stellen:

| Stelle | Zweck |
|---|---|
| `$05D8F5` | Sprite-Daten in beliebigen Banks (Banktabelle für 512 Level); aktuelle Levelnummer in `$7E010B` (wie Lunar Magic) |
| `$00BA2C` | GFX-Zeigertabelle mit 256 Einträgen (ExGFX) |
| `$00AA6B` | pro Datei wählbares Format: LZ2/3bpp (Original) oder 4bpp unkomprimiert per DMA |
| `$00A9E1`, `$00AA22` | Grafik-Bypass: 8 GFX-Slots pro Level (SP1–4, FG1–3, BG1) |
| Ext.-Objekt `$02` | „Direct Map16“: platziert ein beliebiges Map16-Tile als Rechteck (6 Byte) |
| `$00922F` („SMWP“) | eigene 256-Farben-Palette pro Level |

Die Tests prüfen, dass alle Vanilla-Level mit installiertem Patch identisch geladen werden.

## Grenzen / nicht enthalten

* **Musik:** Es gibt keinen Musik-Import (AddmusicK-artig). Die ROM-Erweiterung schafft Platz; das Einfügen
  von Musik bleibt Aufgabe eines separaten Werkzeugs.
* **Test-Emulator:** ohne Ton, ohne Mode 7 (Boss-Level), Fenster/HDMA-Effekte werden ignoriert.
* **Overworld:** Events, Overworld-Sprites und Pfad-Einstellungen sind nicht editierbar (Ansicht „alle Events“
  ist nur lesend). Translevel-Nummern folgen wie in Vanilla der Scan-Reihenfolge – neue Level-Tiles
  verschieben die Nummern nachfolgender Level.
* **Map16:** „Acts like“ (Tile-Verhalten) ist in Vanilla-SMW fest an die Tilenummer gebunden und nicht editierbar.
* Titelbild, Abspann, Custom-Blocks/-Sprites (ASM) sind nicht enthalten.
* Getestet mit der US-ROM (`Super Mario World (U) [!]`, MD5 `cdd3c8c37322978ca8669b34bc89c804`). Mit
  Lunar Magic bearbeitete ROMs nutzen andere Hooks/Formate und werden nicht gezielt unterstützt.

## Aufbau

```
src/core/cpu.ts          65816-Interpreter
src/core/snes.ts         Speicherabbild, DMA, PPU-Register, Timing, APU-Attrappe, Provenance-Tracking
src/core/ppu.ts          Scanline-Renderer für den Testmodus
src/core/levelemu.ts     Level laden per Emulation, Tile-Besitz pro Objekt
src/core/level.ts        Levelformat: Header, Objekte, Exits, Sprites, sek. Header/Eingänge
src/core/render.ts       Level-Layer aus Emulationsergebnis rendern
src/core/save.ts         Level in die ROM schreiben
src/core/rom.ts          LoROM-Adressen, Erweiterung, Prüfsumme, RATS
src/core/lz2.ts          LZ2 (de)kompression
src/core/patches.ts      Editor-Patch (assembliert mit asm.ts)
src/core/overworld.ts    Overworld-Formate, RLE, Namen, OW-Emulation
src/core/spritegfx.ts    Sprite-Grafiken aus dem laufenden Spiel erfassen
src/ui/*                 Oberfläche (ohne Framework)
tools/*                  Tests und Analysewerkzeuge (Disassembler: node tools/dis.ts 05D796 40)
```
