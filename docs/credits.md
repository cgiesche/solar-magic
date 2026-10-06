# Credits

Werkzeuge und Formate, deren Schnittstellen der Editor nachbildet oder die er enthält. Code daraus ist
nicht übernommen, außer bei Asar und snes_spc (eingebunden als WebAssembly).

| Was | Wofür im Editor | Autoren |
|---|---|---|
| [Asar](https://github.com/RPGHacker/asar) (LGPL-3.0) | Assembler, eingebunden als WebAssembly | RPGHacker, Alcaro, randomdude999 und weitere |
| [PIXI](https://github.com/JackTheSpades/SpriteToolSuperDelux) | Format und Schnittstelle der Custom Sprites, Namen und Verträge der Shared Routines ([pixi.md](pixi.md)) | JackTheSpades, RPGHacker, Tattletale, Atari2.0; Beiträge von KevinM, tim-burget, dtothefourth, Super Maks 64, randomdude999, akaginite, Lx5, spooonsss, Fernap u. a. Einzelne Routinen nach Akaginite, imamelia, MarioE, GIEPY; Cluster-Sprites ursprünglich Alcaro, Extended-Sprites imamelia |
| [snes_spc](https://github.com/blarggs-audio-libraries/snes_spc) 0.9.0 (LGPL-2.1) | SPC700- und S-DSP-Emulator (Ton im Testmodus, Musik abspielen), eingebunden als WebAssembly (`tools/build-spc.sh`) | Shay Green (blargg) |
| [GPS](https://www.smwcentral.net/?p=section&a=details&id=31515) (Gopher Popcorn Stew) | Format der Custom Blocks, Namen und Verträge der Standard-Routinen | p4plus2; Pflege TheBiob, GHB, Arinsu; Beiträge von Majorflare, MarioFanGamer, Vitor Vilela; Routinen nach Akaginite, Tattletale, imamelia |
| [UberASM Tool](https://github.com/Fernap/UberASMTool) | Format und Aufrufkonventionen von UberASM | Vitor Vilela, Fernap und weitere |
| Lunar Magic | Formate von `.mwl`, `.map16`, ExGFX, Größentabelle der Sprite-Daten (`$0EF30C`) | FuSoYa |

Pakete, an denen Funktionen des Editors entwickelt und getestet wurden (nicht im Repository):

| Was | Wofür | Autoren |
|---|---|---|
| [Retry System](https://kkevinm.github.io/retry-system/) (Unlicense) | Testfall für Pakete aus mehreren Teilen, UberASM-Bibliotheken mit eigenen Namespaces und Anleitungen im Editor | Kevin (kkevinm); Nachfolger des Retry-Patches von worldpeace; Beiträge von lx5, imamelia, 0x400, Thomas, Lui, AmperSam, MiracleWater, elusive |
