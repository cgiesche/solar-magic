# Credits

Tools and formats whose interfaces the editor follows or that it contains. No code is taken from them,
except for Asar, snes_spc and AddmusicK (included as WebAssembly).

| What | Used in the editor for | Authors |
|---|---|---|
| [Asar](https://github.com/RPGHacker/asar) (LGPL-3.0) | Assembler, included as WebAssembly | RPGHacker, Alcaro, randomdude999 and others |
| [PIXI](https://github.com/JackTheSpades/SpriteToolSuperDelux) | Format and interface of custom sprites, names and contracts of the shared routines ([pixi.md](pixi.md)) | JackTheSpades, RPGHacker, Tattletale, Atari2.0; contributions by KevinM, tim-burget, dtothefourth, Super Maks 64, randomdude999, akaginite, Lx5, spooonsss, Fernap and others. Individual routines after Akaginite, imamelia, MarioE, GIEPY; cluster sprites originally by Alcaro, extended sprites by imamelia |
| [snes_spc](https://github.com/blarggs-audio-libraries/snes_spc) 0.9.0 (LGPL-2.1) | SPC700 and S-DSP emulator (sound in test mode, music playback), included as WebAssembly (`tools/build-spc.sh`) | Shay Green (blargg) |
| [AddmusicK](https://github.com/KungFuFurby/AddMusicKFF) 1.0.11 | Music insertion: song compiler (MML), sound driver, SNES patch; included as WebAssembly with Asar (`tools/build-amk.sh`), along with its original songs, samples and sound effects. No license stated; used as is customary in the SMW scene, crediting the authors | Kipernal; maintained since 1.0.6 by Medic, HertzDevil, Vitor Vilela, Lui, KevinM, KungFuFurby and others; based on Addmusic 4.05 (Romi) and AddmusicM (Masashi27) |
| [GPS](https://www.smwcentral.net/?p=section&a=details&id=31515) (Gopher Popcorn Stew) | Format of custom blocks, names and contracts of the standard routines | p4plus2; maintained by TheBiob, GHB, Arinsu; contributions by Majorflare, MarioFanGamer, Vitor Vilela; routines after Akaginite, Tattletale, imamelia |
| [UberASM Tool](https://github.com/Fernap/UberASMTool) | Format and calling conventions of UberASM | Vitor Vilela, Fernap and others |
| [Tauri](https://tauri.app) 2 (MIT/Apache-2.0) | Framework of the desktop app (`src-tauri/`): native window with the system's webview | Tauri Programme within The Commons Conservancy and contributors |
| Lunar Magic | Formats of `.mwl`, `.map16`, ExGFX, size table of the sprite data (`$0EF30C`) | FuSoYa |
| [SMW-Data: MWL File Format](https://github.com/Ankouno/SMW-Data/blob/master/Misc/MWL%20File%20Format.md) | Sections of the `.mwl` (level information, layers, sprites, palette) for sample levels | Ankouno |
| [Level Data Format](https://www.smwspeedruns.com/Level_Data_Format) (SMW Speedrunning Wiki) | Lunar Magic's Direct Map16 objects 22/23/27/29 in sample levels; also the ExAnimation format | SMW speedrunning community |

Packages on which editor features were developed and tested (as test data in `test/fixtures/`):

| What | Used for | Authors |
|---|---|---|
| [Retry System](https://kkevinm.github.io/retry-system/) (Unlicense) | Test case for packages made of several parts, UberASM libraries with their own namespaces, and instructions in the editor | Kevin (kkevinm); successor of the Retry patch by worldpeace; contributions by lx5, imamelia, 0x400, Thomas, Lui, AmperSam, MiracleWater, elusive |
| Sonic Mania – Studiopolis Zone Act 1 (SMWCentral, graphics, `sonicmaniasszact1.zip`) | Test case for Lunar Magic graphics packages with FG and BG Map16, several palettes and layer 3; used to work out the origin in the `.map16` header | *author still to be added* |
| Ghostbusters – Ghost Trap / Java Manhattan BG (SMWCentral, graphics, `ghostbustersghosttrapjavamanhattanBG.zip`) | Test case for Lunar Magic background packages (`.mwl`, `.map16`, ExGFX, palette) | *author still to be added* |
| Rock Climbing Blocks (SMWCentral, blocks, `RockClimbBlocksUpdate.zip`) | Test case for block packages with `list.txt`, Map16 and ExGFX | GreenHammerBro; SA-1 update by yoshifanatic |
| Brutal Bill (SMWCentral, sprite, `BrutalBill.zip`) | Test case for PIXI packages with a sprite and a shooter | Sonikku; based on Carol's Homing Bullet Bill |
| Aftertouch Shatter (SMWCentral, block, `Aftertouch Shatter.zip`) | Test case for blocks that spawn their own bounce sprite | Arinsu; original by HammerBrother |
| On/Off Blocks (SMWCentral, block, `On-Off Block.zip`) | Test case for packages mixing upload styles: a GPS block, its PIXI bounce sprite, Map16 tiles, ExGFX, a palette and a sample level (ADR 0002) | MarioFanGamer; block code adapted from his Question Mark Blocks, sprites modified from the original game |
| Enemy Stack (SMWCentral, sprite, `EnemyStack.zip`; not in `test/fixtures/`, the test rebuilds its own stacking sprite) | Case on which the sprite images from spawned sprites were developed: an invisible sprite that spawns the sprites given in its extra bytes on top of each other | dtothefourth |
