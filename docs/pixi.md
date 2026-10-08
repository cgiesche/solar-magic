# Custom Sprites (PIXI-Format)

Der Editor fügt Custom Sprites im Format von [PIXI](https://github.com/JackTheSpades/SpriteToolSuperDelux)
1.4x ein. Ressourcen von SMWCentral laufen unverändert. PIXI selbst wird nicht verwendet: Die
Laufzeit (Lader, Verteiler, Shared Routines) ist eine eigene Implementierung derselben Schnittstelle und
wird mit dem eingebauten Asar als **ein** Patch in die ROM gebracht, wie die Custom Blocks.

Diese Seite beschreibt die Schnittstelle, die Ressourcen sehen, und wie der Editor sie umsetzt.

## Im Editor

- **Hochladen:** *ROM → Packages … → Upload package …* mit einem Download (`.zip` oder `.asm`, auch ein ganzer
  PIXI-Ordner). Der Editor erkennt
  Sprites (an `.json`/`.cfg`), Misc-Sprites (`.asm` mit `print "MAIN ",pc` in einem Ordner ihrer Art) und
  enthaltene Custom Blocks. Jeder Sprite bekommt die nächste freie Nummer seiner Art, jeder Block das nächste
  freie Map16-Tile ab 200. Defines, die einen Sprite des Pakets meinen, werden auf dessen Nummer gesetzt,
  erkannt am Dateinamen im Kommentar (`!Sprite = $18 ; Sprite number of BrutalBill.json`)
  oder an einer Misc-Art im Namen (`!bounce_sprite`).
- **Konfigurieren:** Tab *Sprites* im Packages-Dialog, eine Konfigurationsansicht: Einträge der `list.txt`
  (Sprite → Nummer) zuordnen und aufheben, jeder mit dem Paket, aus dem er stammt; Einstellungen der Dateien;
  Export eines PIXI-Ordners als `.zip`. Hinzugefügt wird nur durch Hochladen eines Pakets, entfernt mit dem
  Paket; eine aufgehobene Zuordnung lässt die Dateien im Projekt. Alles wird als ein Patch mit den Quellen in
  der ROM verzeichnet.
- **Platzieren:** Die Palette zeigt unter *Sprites* einen Abschnitt „Custom Sprites (PIXI)“ mit den Namen aus
  `Collection` und der Grafik, die das Spiel zeichnet – wie Lunar Magic nur die Varianten (Extra-Bit
  gelöscht/gesetzt), die `Collection` nennt; ohne `Collection` (`.cfg`) die ohne Extra-Bit. In den
  Eigenschaften stehen die Extra-Bytes; Sprites mit anderen Extra-Bytes als 0 bekommen ein eigenes Bild. Beim
  Einfügen nach Nummer gelten die Extra-Bits 2/3 als Custom Sprite.

## Arten und Ordner

| Art | Ordner | Nummern | Datei in `list.txt` |
|---|---|---|---|
| Sprite | `sprites/` | 00–BF | `.json` oder `.cfg` (verweist auf die `.asm`) |
| Shooter | `shooters/` | C0–CF | `.json` oder `.cfg` |
| Generator | `generators/` | D0–DF | `.json` oder `.cfg` |
| Cluster | `cluster/` | 00–7F | `.asm` |
| Extended | `extended/` | 00–7F | `.asm` |
| Minor Extended | `misc_sprites/minorextended/` | 00–3F | `.asm` |
| Bounce | `misc_sprites/bounce/` | 00–3F | `.asm` |
| Smoke | `misc_sprites/smoke/` | 00–1F | `.asm` |
| Spinning Coin | `misc_sprites/spinningcoin/` | 00–1F | `.asm` |
| Score | `misc_sprites/score/` | 00–1F | `.asm` |

Jeder Ordner darf eine `_header.asm` haben; sie wird in jede Datei dieser Art eingebunden.

### `list.txt`

```
00 Blue.json
C0 BrutalBillShooter.json
D0 Generator.cfg

CLUSTER:
00 flower.asm

BOUNCE:
01 shatter_aftertouch_bounce.asm
```

Abschnitte: `SPRITE:` (Standard), `CLUSTER:`, `EXTENDED:`, `MINOREXTENDED:`, `BOUNCE:`, `SMOKE:`,
`SPINNINGCOIN:`, `SCORE:`. Zusätze wie `display`/`nodisplay` (nur für Lunar Magic) werden ignoriert.

**Nicht unterstützt:** Per-Level-Sprites (`105:B0 datei.cfg`, PIXI-Option `-pl`). B0–BF sind normale
Sprites.

### Nummern im Spiel

Die Misc-Sprites teilen sich die Nummern mit den Original-Sprites ihrer Art. Custom Sprite *n* hat im Spiel
die Nummer *n* + Offset:

| Art | Offset (`!…Offset`) |
|---|---|
| Cluster | `$09` |
| Extended | `$13` |
| Minor Extended | `$0C` |
| Smoke | `$06` |
| Spinning Coin | `$02` |
| Bounce | `$08` |
| Score | `$16` |

Ein Block, der Bounce-Sprite 01 erzeugt, schreibt also `!bounce_sprite+$08` = `$09` nach `!bounce_num`.

## Sprites in den Level-Daten

Ein Eintrag besteht aus 3 Bytes plus den Extra-Bytes des Sprites:

```
Byte 0: YYYYEEsy   Y = Zeile, EE = Extra-Bits, s = Bildschirm-Bit 4, y = Zeile Bit 4
Byte 1: XXXXSSSS   X = Spalte, S = Bildschirm Bit 0–3
Byte 2: Nummer
Byte 3…: Extra-Bytes (0–12)
```

- `EE` Bit 1 (`$08` in Byte 0) ist das **Custom-Flag**, Bit 0 (`$04`) das **Extra-Bit**. Werte 0/1 sind
  Original-Sprites, 2/3 Custom Sprites ohne/mit Extra-Bit.
- Die Länge eines Eintrags ergibt sich aus einer Größentabelle mit `$400` Bytes: Index
  `EE × $100 + Nummer`, Wert = 3 + Anzahl Extra-Bytes. Die Anzahl steht in der cfg/json, getrennt für
  gelöschtes und gesetztes Extra-Bit. Ihre Adresse steht wie bei Lunar Magic und PIXI bei `$0EF30C`,
  gültig mit `$42` bei `$0EF30F`.
- Der Lader des Spiels liest die Liste mit 8-Bit-Index. Überschreitet der Index `$80`, rückt die Laufzeit den
  Zeiger `$CE` weiter und setzt ihn am Ende der Schleife zurück. So passen auch lange Listen mit Extra-Bytes.
- `.smwlevel`-Dateien enthalten die Größentabelle, mit der ihre Sprite-Daten geschrieben sind.
- Ändert sich die Anzahl für einen Sprite, der schon in Levels steht, schreibt der Editor diese Levels
  bei der Änderung gleich mit neu, wie PIXIs MeiMei.

## Laufzeit-RAM

| Define | Adresse | Inhalt |
|---|---|---|
| `!extra_bits` / `!7FAB10` | `$7FAB10,x` | Extra-Bits: `$08` = Custom, `$04` = Extra-Bit |
| `!new_code_flag` / `!7FAB1C` | `$7FAB1C,x` | Custom-Code aktiv |
| `!extra_prop_1/2` / `!7FAB28/34` | `$7FAB28,x` / `$7FAB34,x` | Extra Property Bytes aus der cfg/json |
| `!new_sprite_num` / `!7FAB9E` | `$7FAB9E,x` | Custom-Nummer |
| `!extra_byte_1…4` | `$7FAB40/4C/58/64,x` | Extra-Bytes; ab 5 Bytes ein 24-Bit-Zeiger auf die Bytes in `extra_byte_1…3` |
| `!shooter_extra_byte_1…3` | `$7FAC00/08/10,x` | Extra-Bytes von Shootern; ab 4 Bytes ein Zeiger |

`!extra_prop_2` Bit 7: MAIN läuft in jedem Status statt des Originalcodes; Bit 6: MAIN läuft in jedem
Status zusätzlich.

## Code-Einsprünge

- **Sprite:** `print "INIT ",pc` (Status `$01`) und `print "MAIN ",pc` (Status `$08`), beide mit `RTL`.
  Optional `CARRIABLE` (`$09`), `KICKED` (`$0A`), `CARRIED` (`$0B`), `MOUTH` (`$07`), `GOAL` (`$0C`); sie
  ersetzen den Originalcode dieses Status, das DBR ist gesetzt.
- **Shooter, Generator:** `MAIN`, jeden Frame (Shooter nach ihrem Timer, Generatoren nicht bei `$9D`).
  `!shoot_num` bzw. `$18B9` enthalten `$80` (Custom), das Extra-Bit als `$40` und Nummer − `$BF` bzw. − `$CF`.
- **Extended:** zusätzlich `print "CAPE",pc` für den Kontakt mit dem Cape.
- **Misc-Sprites:** `MAIN`, mit X = Slot und dem DBR auf der Bank der Routine.
- Öffentliche Einsprünge wie bei PIXI: `JSL $0187A7` richtet den Custom Sprite in Slot X ein (Nummer in
  `!new_sprite_num`, `$00-$02` = INIT), `JSL $01D43E` führt den Originalcode des Status in A aus.
- `print "VERG<version>"`: Mindestversion von PIXI. Der Editor gilt als 1.43.

## cfg und json

**cfg:**
```
<Typ>
<acts like>
<$1656> <$1662> <$166E> <$167A> <$1686> <$190F>
<Extra Property 1> <Extra Property 2>
<asm-Datei>
<Bytes ohne Extra-Bit>:<Bytes mit Extra-Bit>
```
Alle Werte hexadezimal. Fehlt der Doppelpunkt in der letzten Zeile (altes Format), sind beide Anzahlen 0.

**json:** `Type`, `ActLike`, `AsmFile`, `Extra Property Byte 1/2`,
`Additional Byte Count (extra bit clear/set)` (dezimal, höchstens 12), die Tweaker als Objekte `"$1656"`
… `"$190F"` mit benannten Bits, außerdem `Collection` (Namen) und `Displays` (Beschreibung). `Map16`,
`GFXInfo` und die Tile-Angaben in `Displays` sind für Lunar Magic gedacht und werden ignoriert, denn der
Editor zeigt Sprites per Emulation.

**Typ:** 0 = „Tweak“ (Original-Sprite `acts like` mit geänderten Tweakern, kein eigener Code),
1 = Custom Sprite. Shooter und Generatoren sind am Nummernbereich zu erkennen.

## Shared Routines

Aufruf als `%Name()`. Unterordner werden ohne Trennzeichen vorangestellt (`routines/Bounce/GetDrawInfo.asm`
→ `%BounceGetDrawInfo()`). Jede Routine wird nur eingefügt, wenn sie benutzt wird. Eigene Dateien in
`routines/` haben Vorrang vor den eingebauten.

Eingebaut sind die Routinen von PIXI 1.43 mit denselben Ein- und Ausgaben. Sie sind nach den Routinen des
Spiels geschrieben; deren Tabellen (Sinus, OAM-Indizes, Geschwindigkeiten) werden aus der ROM gelesen, und wo
das Spiel eine passende Routine hat, wird sie aufgerufen (z. B. `FinishOAMWrite` = `$01B7B3`):

- **Allgemein:** `Aiming`, `CapeContact`, `ChangeMap16`, `CheckForContactAlternate`, `CircleX`,
  `CircleXY`, `CircleY`, `FinishOAMWrite`, `FireballContact`, `GetDrawInfo`, `GetMap16`, `LoseYoshi`,
  `Random`, `ReplaceSelf`, `SetPlayerClippingAlternate`, `SetSpriteClippingAlternate`, `ShooterMain`,
  `Star`, `SubHorzPos`, `SubOffScreen`, `SubVertPos`.
- **Spawn:** `SpawnSprite`, `SpawnSpriteSafe`, `SpawnSmoke`, `SpawnSmokeGeneric`, `SpawnExtended`,
  `SpawnExtendedGeneric`, `SpawnClusterGeneric`, `SpawnMinorExtendedGeneric`,
  `SpawnMinorExtendedOverwriteGeneric`, `SpawnScoreGeneric`, `SpawnSpinningCoinGeneric`.
- **Bounce:** `GenericDraw`, `GetDrawInfo`, `SetMarioSpeed`, `SetSpeed`, `SetSpriteSpeed`, `SetupMap16`,
  `UpdatePos`.
- **Cluster:** `GetDrawInfo`, `Speed`.
- **Extended:** `CapeClipping`, `GetDrawInfo`, `Hurt`, `Speed`.
- **MinorExtended:** `GetDrawInfo`, `Speed`.
- **Score:** `GenericDraw`, `GetDrawInfo`, `UpdateYPos`.
- **Smoke:** `GenericDraw`, `GetDrawInfo`.
- **SpinningCoin:** `GetDrawInfo`, `UpdateYPos`.

## Defines

Jede Datei sieht die Defines von PIXIs `sa1def.asm` für ein ROM ohne SA-1:

- `!sa1 = 0`, `!SA1`, `!SA_1`, `!Base1 = $0000`, `!Base2 = $0000`, `!dp`, `!addr`, `!bank`, `!BankA`,
  `!BankB`, `!bank8`, `!SprSize = $0C`, `!CustomBit = $08`, `!GenStart = $D0`.
- `!…Offset` (siehe oben) und `!…Size` für jede Misc-Art.
- Die Sprite-Tabellen (`!sprite_num`, `!9E` …), außerdem `!shoot_…`, `!cluster_…`, `!extended_…`,
  `!minor_extended_…`, `!smoke_…`, `!spinning_coin_…`, `!score_…`, `!bounce_…`.
- `!sprite_load_table` / `!1938` = `$1938`. PIXIs Umzug auf `$7FAF00` für 255 Sprites pro Level gibt
  es im Editor nicht.
- Makros `%BES()`, `%BEC()`, `%Between()`, `%debugmsg()`.

## Umsetzung

Assembliert wird in mehreren Asar-Läufen, die zusammen als ein Patch verzeichnet werden:

1. die benutzten Shared Routines, jede einmal (Routinen, die andere aufrufen, ziehen diese nach);
2. jeder Sprite für sich, mit den Defines, den Routinen als `%Name()` → `JSL` und der `_header.asm` seiner
   Art (eine eigene im Projekt hat Vorrang). Labels und Makros verschiedener Sprites stören sich so nicht.
3. die Laufzeit mit den Tabellen, gefüllt aus den cfg/json und den `print`-Ausgaben der Sprites.

Die Hooks der Laufzeit (alle in Bank 01/02/07, bei Misc-Arten nur, wenn das Projekt sie benutzt):
Ladeschleife `$02A82A`/`$02A846`/`$02A936`/`$02A9D7`/`$02ABE9`, Extra-Bits `$02A94B`/`$02A963`, Spawn
`$02A9C9`, Shooter/Generatoren `$02A866`/`$02ABA0`/`$02B395`/`$02AFFE`, Status `$018127`/`$018151`/
`$018172`/`$0185C3`, Tabellen `$07F785`, öffentlich `$0187A7`/`$01D43E`; Misc-Verteiler `$029052` (Bounce),
`$02F818`/`$00A686` (Cluster), `$029B1B`/`$029633` (Extended), `$028B6C` (Minor Extended), `$0296C0`
(Smoke), `$0299D4`/`$028A7D` (Spinning Coin), `$02ADBA` (Score). Freies RAM: die Sprite-Tabellen (oben) und `$7FAC18-$7FAC19`, im Patch-Verzeichnis belegt (siehe
[Free RAM](patches.md#patches-anwenden)).

Ändert sich die Anzahl der Extra-Bytes eines Sprites, der in Levels steht, schreibt der Editor diese Levels
bei der Änderung gleich mit der neuen Größe neu (Extra-Bytes bleiben, soweit sie passen), wie PIXIs MeiMei. Beim
Entfernen fallen die Extra-Bytes weg.

## Grenzen

- Kein SA-1, keine Per-Level-Sprites, kein Umzug von `$1938` (255 Sprites pro Level), keine „Run-once“-
  Sprites jenseits von DF.
- `asm/ExtraDefines` und `asm/ExtraHijacks` werden nicht ausgewertet. Eigene Hijacks gehören in einen
  normalen Patch.
- ROMs, in die bereits mit PIXI Sprites eingefügt wurden, werden nicht erkannt.
