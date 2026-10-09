# Credits

Werkzeuge und Formate, deren Schnittstellen der Editor nachbildet oder die er enthält. Code daraus ist
nicht übernommen, außer bei Asar, snes_spc und AddmusicK (eingebunden als WebAssembly).

| Was | Wofür im Editor | Autoren |
|---|---|---|
| [Asar](https://github.com/RPGHacker/asar) (LGPL-3.0) | Assembler, eingebunden als WebAssembly | RPGHacker, Alcaro, randomdude999 und weitere |
| [PIXI](https://github.com/JackTheSpades/SpriteToolSuperDelux) | Format und Schnittstelle der Custom Sprites, Namen und Verträge der Shared Routines ([pixi.md](pixi.md)) | JackTheSpades, RPGHacker, Tattletale, Atari2.0; Beiträge von KevinM, tim-burget, dtothefourth, Super Maks 64, randomdude999, akaginite, Lx5, spooonsss, Fernap u. a. Einzelne Routinen nach Akaginite, imamelia, MarioE, GIEPY; Cluster-Sprites ursprünglich Alcaro, Extended-Sprites imamelia |
| [snes_spc](https://github.com/blarggs-audio-libraries/snes_spc) 0.9.0 (LGPL-2.1) | SPC700- und S-DSP-Emulator (Ton im Testmodus, Musik abspielen), eingebunden als WebAssembly (`tools/build-spc.sh`) | Shay Green (blargg) |
| [AddmusicK](https://github.com/KungFuFurby/AddMusicKFF) 1.0.11 | Musik einfügen: Compiler der Songs (MML), Sound-Treiber, SNES-Patch; eingebunden als WebAssembly mit Asar (`tools/build-amk.sh`), samt seiner Originalsongs, Samples und Soundeffekte. Ohne angegebene Lizenz; Nutzung wie in der SMW-Szene üblich mit Nennung der Autoren | Kipernal; seit 1.0.6 gepflegt von Medic, HertzDevil, Vitor Vilela, Lui, KevinM, KungFuFurby u. a.; Grundlage Addmusic 4.05 (Romi) und AddmusicM (Masashi27) |
| [GPS](https://www.smwcentral.net/?p=section&a=details&id=31515) (Gopher Popcorn Stew) | Format der Custom Blocks, Namen und Verträge der Standard-Routinen | p4plus2; Pflege TheBiob, GHB, Arinsu; Beiträge von Majorflare, MarioFanGamer, Vitor Vilela; Routinen nach Akaginite, Tattletale, imamelia |
| [UberASM Tool](https://github.com/Fernap/UberASMTool) | Format und Aufrufkonventionen von UberASM | Vitor Vilela, Fernap und weitere |
| [Tauri](https://tauri.app) 2 (MIT/Apache-2.0) | Rahmen der Desktop-App (`src-tauri/`): natives Fenster mit dem Webview des Systems | Tauri Programme within The Commons Conservancy und Mitwirkende |
| Lunar Magic | Formate von `.mwl`, `.map16`, ExGFX, Größentabelle der Sprite-Daten (`$0EF30C`) | FuSoYa |

Pakete, an denen Funktionen des Editors entwickelt und getestet wurden (als Testdaten in `test/fixtures/`):

| Was | Wofür | Autoren |
|---|---|---|
| [Retry System](https://kkevinm.github.io/retry-system/) (Unlicense) | Testfall für Pakete aus mehreren Teilen, UberASM-Bibliotheken mit eigenen Namespaces und Anleitungen im Editor | Kevin (kkevinm); Nachfolger des Retry-Patches von worldpeace; Beiträge von lx5, imamelia, 0x400, Thomas, Lui, AmperSam, MiracleWater, elusive |
| Sonic Mania – Studiopolis Zone Act 1 (SMWCentral, Grafik, `sonicmaniasszact1.zip`) | Testfall für Lunar-Magic-Grafikpakete mit FG- und BG-Map16, mehreren Paletten und Layer 3; daran wurde der Ursprung im `.map16`-Kopf erkannt | *Autor noch nachzutragen* |
| Ghostbusters – Ghost Trap / Java Manhattan BG (SMWCentral, Grafik, `ghostbustersghosttrapjavamanhattanBG.zip`) | Testfall für Lunar-Magic-Hintergrundpakete (`.mwl`, `.map16`, ExGFX, Palette) | *Autor noch nachzutragen* |
| Rock Climbing Blocks (SMWCentral, Blöcke, `RockClimbBlocksUpdate.zip`) | Testfall für Blockpakete mit `list.txt`, Map16 und ExGFX | GreenHammerBro; SA-1-Update von yoshifanatic |
| Brutal Bill (SMWCentral, Sprite, `BrutalBill.zip`) | Testfall für PIXI-Pakete mit Sprite und Shooter | Sonikku; nach dem Homing Bullet Bill von Carol |
| Aftertouch Shatter (SMWCentral, Block, `Aftertouch Shatter.zip`) | Testfall für Blöcke, die einen eigenen Bounce-Sprite erzeugen | Arinsu; Original von HammerBrother |
| Enemy Stack (SMWCentral, Sprite, `EnemyStack.zip`; nicht in `test/fixtures/`, der Test baut einen eigenen Stapel-Sprite nach) | Fall, an dem die Sprite-Bilder aus gespawnten Sprites entwickelt wurden: ein unsichtbarer Sprite, der die Sprites seiner Extra-Bytes übereinander spawnt | dtothefourth |
