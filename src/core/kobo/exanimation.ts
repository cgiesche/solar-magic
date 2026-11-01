// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of
// the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
// (Full text: LICENSE in this folder.)
//
// Lunar Magic compatible ExAnimation engine from Kobo (https://github.com/denley/kobo),
// crates/kobo-core/asm/lunar-magic/exanimation.asm and memory.asm, commit 395083bbf7a8664d7c970ce465a5fb418002ab91.
// Changed by Solar Magic (marked [Solar Magic]): the precision timer (trigger 0F) – a slot with it shares the
// counter of the first slot of its 8 and a rotation with it always runs, as Lunar Magic's help describes
// (level_ex20.htm); Kobo's runs it like "always". The game's animated tiles are called in the fast ROM bank $85
// (the editor's ROM is FastROM). A frame's work is Kobo's at less cost: the settings byte and each list's
// address read once, the scratch kept only as far as it is used, the NMI walks only the uploads queued (#151).
// The overworld's lists (a list per submap and the overworld's global one, with a settings byte per submap, in Lunar
// Magic's overworld layout: its hooks at $048086, $0480E0 and $00A4E3, its tables at the first one's target) run on
// the same code, with the overworld's event triggers in place of the level's conditions (#244).
// Only this file is under the MPL; it is used as Asar source by ../exanim.ts.

export const KOBO_COMMIT = '395083bbf7a8664d7c970ce465a5fb418002ab91';

export const EXANIMATION_ASM = `; Lunar Magic's ExAnimation: animated tiles and colours of a level's own and
; of every level (global), in its data format, with their triggers.
;
; Kobo's own code, written from the vanilla code it hooks (SMWDisX), the data
; format the community documents (smwspeedruns' level data format), Lunar
; Magic's help ("Edit Level ExAnimated Frames"), and what a Lunar
; Magic-saved ROM's levels do with chosen data frame by frame, observed as
; memory effects only (examples/exanim_probe.rs; docs/lunar-magic-install.md,
; "ExAnimation"), never from Lunar Magic's code.
;
; Data. A list (a level's, or the global one) is: the number of slots used
; (the highest plus one), the alternative file (ExGFX 60-63, as 0-3), which
; custom triggers keep their state at the load (a bit each, 16 bits; the
; others are cleared), which it sets, which manual triggers it sets (16
; bits), a frame for each of those in order, then a 16-bit offset per slot to its entry, counted from
; the offsets' start (0: an unused slot). An entry is its type, its
; trigger, its frames less one, a 16-bit destination (tiles: a VRAM word
; address, bit 15 for sources in the alternative file; colours: the first
; colour, then the colours less one, bit 7 the alternative file), and a
; 16-bit frame each (twice as many with a trigger that has a second set;
; none for the rotations): a RAM address in bank $7E or an offset into the
; alternative file, or, for a single colour, the colour itself.
;
; Tables, where Lunar Magic's layout has them: each level's settings byte
; at $03FE00 (PTLG----: the game's colour $64 flashing, the game's animated
; tiles, the level's list, the global list, each off when set); the
; alternative files' 3-byte pointers at $03BCC0; and, in the block the JSL
; at $0583AD leads to, at +$EA the address of 512 3-byte pointers to the
; levels' lists ($0000FF: none, a middle byte of 0), at +$5B the global
; list's bank times $100 (0: none) and at +$65 its low word. Lunar Magic's
; editor reads and writes those three at those offsets of the hook's target.
;
; Each frame the game's animation runs (JSL CODE_05BB39, in the level, the
; level's setup, and the ending), slots k, k+8, k+16, and k+24 of the global
; list and then of the level's run, k being the frame counter $14 mod 8:
; each moves its frame counter ($7FC080 level, $7FC0A0 global, $FF at the
; load) as its trigger says and queues its frame's upload, once for each
; value of $14 (which stands still while the game is stopped), which the NMI
; makes after the game's own animated tiles, the later slot over the
; earlier. $7FC004 counts every eighth frame, mod $20, for older custom
; blocks. Triggers: $7FC070 the manual frames, $7FC0F8 the one-shot bits,
; $7FC0FC the custom bits.
;
; Lunar Magic treats its ExAnimation as installed when $00A390 is a JSL,
; whatever it calls; Kobo's NMI hook is one, so a save keeps this code and
; uses its tables. It keeps the settings table at $03FE00 only when the
; byte before it, $03FDFF, is $00 (any other value, and it sets every
; level's again), so this writes that byte.

incsrc "memory.asm"

!Settings = $03FE00
!AltFiles = $03BCC0
!Level = !addr|$00010B
!EffFrame = $14
!EndLevelTimer = !addr|$001493
!BackAreaColour = !addr|$000701
!MainPalette = !addr|$000703
!CopyBackArea = !addr|$000903
!CopyPalette = !addr|$000905

!Legacy = $7FC004
!LastCall = $7FC003             ; the $14 of the last frame
!OwSettings = $7FC00A           ; the submap's settings, where Lunar Magic keeps them [Solar Magic]
!OwSubmap = !OwSettings+1       ; the submap the lists were set up for; $FF in a level [Solar Magic]
                                ; (Lunar Magic's layer 2 settings, which the editor's ROMs don't
                                ; keep: docs/research/lunar-magic-submap-graphics.md, "$7FC00B")
!LastFrame = $7FC019            ; the $14 the lists last ran for
!QueueEnd = $7FC01A             ; 16-bit, the high byte 0: the queue's uploads end here, from !Queue [Solar Magic]
!Manual = $7FC070
!Counters = $7FC080             ; level slots, the global ones $20 on
!Queue = $7FC0C0                ; up to 8 uploads of 7 bytes (see queue) [Solar Magic]
!OneShot = $7FC0F8
!Custom = $7FC0FC

; Direct page scratch, free where the game's animation runs (it uses $00),
; and in the NMI's uploads (which use $00).
!List = $00                     ; the list's address, 3 bytes
!Source = $03                   ; an upload's source, 3 bytes
!Base = $06                     ; 16-bit: the slot offsets, from !List
!Slot = $08                     ; 16-bit: the slot's entry, from !List
!Index = $0A                    ; the slot's number
!Counter = $0B                  ; its counter's index from !Counters
!Entry = $0C                    ; the next upload's offset from !Queue [Solar Magic]
!Frames = $0D                   ; its frames (the frames less one, plus one)
!Temp = $0E                     ; 16-bit

; ---------------------------------------------------------------------------
; Hooks.

; LoadLevel: SEP #$30 : STZ $1933. Every level's load starts here, the
; level number known ($010B).
org $0583AD
    autoclean JSL level_init
    NOP

; The game's tile animation, JSL CODE_05BB39: in the ending, the level, and
; the level's setup (eight times, with the uploads after each).
org $0095B5
    JSL frame
org $00A2A5
    JSL frame
org $00A5FD
    JSL setup_frame

; The NMI's animated tile upload and colour $64 flashing (CODE_00A390,
; entered with JSR by the NMI and the level's setup).
org $00A390
    JSL nmi
    RTS

; ClearMemory at reset: REP #$30 : LDX #$1FFE.
org $008A4E
    JSL clear_memory
    NOP

; The overworld [Solar Magic], at Lunar Magic's places (SMW Central's hijack
; map): its load sets up the game's animated tiles at $048086 (entered with
; JSR at the load, game mode $0C, the screen off; REP #$30 : STZ $03 : STZ
; $05), each frame animates them at $0480E0 (LDA $13 : AND #$07, then a BNE),
; the NMI uploads them and the level dots' colours 6D and 7D at $00A4E3 (REP
; #$10 : LDA #$80 : STA $2115). The game code a hook replaces runs in ours.
; As Lunar Magic, the game's tile animation counts with $14 instead of $13
; ($048102, $04810D, $04813B), so it keeps step with the lists; on the
; overworld both count every frame ($00A1C1), only their phase differs.
org $048086
    JSL ow_init
    RTS
org $0480E0
    JSL ow_frame
    RTS
assert read1($048102) == $13 && read1($04810D) == $13 && read1($04813B) == $13
org $048101
    LDA !EffFrame
org $04810C
    LDA !EffFrame
org $04813A
    AND !EffFrame
org $00A4E3
    JSL ow_nmi
    RTS
; the RTL the game's routines return through when this code runs them (their
; RTS to it)
assert read1($048414) == $6B

; The alternative files: none until a build writes them.
org !AltFiles
    dl $000000,$000000,$000000,$000000

; Every level's settings as Lunar Magic's first save leaves them (the game
; has $FF there, everything off): all on, but level 104's lists (the
; ending's Yoshi's House), until a build writes them.
org !Settings-1
    db $00                      ; Lunar Magic keeps the table only with $00 here
    fillbyte $00 : fill $104
    db $30
    fillbyte $00 : fill $FB

freedata

level_table:
    for i = 0..512
        dl $0000FF
    endfor

; The submaps' lists and settings [Solar Magic]: 7 each, as level_table and
; the levels' settings (all on).
ow_table:
    for i = 0..7
        dl $0000FF
    endfor
ow_settings:
    db $00,$00,$00,$00,$00,$00,$00

freecode
prot level_table

; ---------------------------------------------------------------------------
; The level's load. Lunar Magic's editor finds the tables through the three
; values at fixed offsets from here.
level_init:
    BRL level_init_body
    fillbyte $FF : fill $5B-3
global_bank:                    ; +$5B
    dw $0000
    fillbyte $FF : fill $65-$5D
global_low:                     ; +$65
    dw $0000
    fillbyte $FF : fill $EA-$67
level_list:                     ; +$EA
    dl level_table

assert global_bank-level_init == $5B
assert global_low-level_init == $65
assert level_list-level_init == $EA

level_init_body:
    SEP #$30
    STZ $1933|!addr             ; what the hook replaces
    PHP
    JSR save_scratch
    SEP #$20
    LDA #$1F                    ; the first eighth frame counts it to 0
    STA.l !Legacy
    LDA #$FF                    ; a level's lists [Solar Magic]
    STA.l !OwSubmap
    JSR setup_lists
    JSR restore_scratch
    PLP
    RTL

; The lists' start, in a level or on a submap [Solar Magic: shared]: every
; slot's counter, the one-shots, the queue; the triggers' starting states,
; the global list's, then the level's (the submap's).
setup_lists:
    REP #$30
    LDA #$FFFF
    LDX #$003E
-   STA.l !Counters,x           ; every slot's counter
    DEX
    DEX
    BPL -
    LDA #$0000
    STA.l !OneShot
    STA.l !OneShot+2
    JSR clear_queue
    SEP #$20
    LDA #$FF
    STA.l !LastFrame
    STA.l !LastCall
    REP #$20
    JSR global_address
    BCC +
    JSR init_triggers
+   JSR level_address
    BCC +
    JSR init_triggers
+   RTS

; The direct page scratch this code uses, $00-$0F, kept for the game's code
; around the hooks, which leaves values there across them. The caller's
; return address stays on top of the stack.
save_scratch:
    REP #$30
    PLA                         ; the return address
    PEI ($00)
    PEI ($02)
    PEI ($04)
    PEI ($06)
    PEI ($08)
    PEI ($0A)
    PEI ($0C)
    PEI ($0E)
    PHA
    RTS

restore_scratch:
    REP #$30
    PLA
    PLX
    STX $0E
    PLX
    STX $0C
    PLX
    STX $0A
    PLX
    STX $08
    PLX
    STX $06
    PLX
    STX $04
    PLX
    STX $02
    PLX
    STX $00
    PHA
    RTS

; !List = the global list; carry clear for none. A/X/Y 16-bit.
global_address:
    LDA.l !OwSettings           ; the high byte !OwSubmap: positive on the
    BPL ow_global_address       ; overworld [Solar Magic]
    LDA.l global_bank           ; the bank in the high byte
    BEQ .none
    STA !List+1
    LDA.l global_low
    STA !List
    SEC
    RTS
.none:
    CLC
    RTS

; !List = the level's list; carry clear for none. A/X/Y 16-bit. Of the
; scratch only !List is used. [Solar Magic]
level_address:
    LDA.l !OwSettings           ; on the overworld: the submap's [Solar Magic]
    BPL ow_submap_address
    LDA.l !Level
    AND #$01FF
    STA !List
    ASL A                       ; (carry clear)
    ADC !List
    TAY
    LDA.l level_list            ; the table, wherever Lunar Magic keeps it
    STA !List
    LDA.l level_list+1
    STA !List+1
    LDA [!List],y
    TAX
    INY
    LDA [!List],y
    STA !List+1
    STX !List
    AND #$00FF                  ; the middle byte: 0 for none
    BEQ .none
    SEC
    RTS
.none:
    CLC
    RTS

; !List = the overworld's global list; carry clear for none. A/X/Y 16-bit.
; [Solar Magic]
ow_global_address:
    LDA.l ow_global_bank        ; the address >> 8
    BEQ .none
    STA !List+1
    LDA.l ow_global_low
    STA !List
    SEC
    RTS
.none:
    CLC
    RTS

; !List = the list of the submap the lists were set up for; carry clear for
; none. A/X/Y 16-bit. [Solar Magic]
ow_submap_address:
    LDA.l !OwSubmap
    AND #$00FF
    STA !List
    ASL A                       ; (carry clear)
    ADC !List
    TAY
    LDA.l ow_list               ; the table, wherever Lunar Magic keeps it
    STA !List
    LDA.l ow_list+1
    STA !List+1
    LDA [!List],y
    TAX
    INY
    LDA [!List],y
    STA !List+1
    STX !List
    AND #$00FF                  ; the middle byte: 0 for none
    BEQ .none
    SEC
    RTS
.none:
    CLC
    RTS

; The custom triggers the list sets, and the manual ones. A/X/Y 16-bit.
init_triggers:
    LDY #$0002
    LDA [!List],y               ; those it keeps
    AND.l !Custom
    LDY #$0004
    ORA [!List],y               ; and those it sets
    STA.l !Custom
    LDY #$0006
    LDA [!List],y
    STA !Temp                   ; the manual triggers it sets
    LDY #$0008
    LDX #$0000
-   LSR !Temp
    BCC +
    SEP #$20
    LDA [!List],y
    STA.l !Manual,x
    REP #$20
    INY
+   INX
    CPX #$0010
    BNE -
    RTS

clear_queue:                    ; A 16-bit [Solar Magic]
    LDA #$0000
    STA.l !QueueEnd
    RTS

; ---------------------------------------------------------------------------
; Reset: the triggers and the rest cleared, and what the hook replaces.
clear_memory:
    REP #$30
    LDA #$0000
    LDX #$008E
-   STA.l !Manual,x
    DEX
    DEX
    BPL -
    STA.l !Legacy-1             ; $7FC003-$7FC004
    STA.l !QueueEnd             ; [Solar Magic]
    DEC A                       ; no submap's lists, all off [Solar Magic]
    STA.l !OwSettings
    LDX #$1FFE                  ; what the hook replaces
    RTL

; ---------------------------------------------------------------------------
; A frame of the animation, where the game runs its own. A/X/Y 8-bit.
; [Solar Magic] The same work as Kobo's, cheaper: the settings byte read
; once, the scratch kept only as far as it is used ($00-$03 for the
; game's tiles and the lists' addresses, the rest once a list runs), each
; list's address looked up once.
frame:
    PHP
    SEP #$20
    LDA !EffFrame
    CMP.l !LastCall
    BNE +
    PLP                         ; run for this $14 already (the game stopped
    RTL                         ; it): the game's tiles too
+   STA.l !LastCall
    REP #$30
    PEI ($02)                   ; the direct page scratch, kept for the game's
    PEI ($00)                   ; code around the hook (see save_scratch)
    LDA.l !Level
    AND #$01FF
    TAX
    SEP #$20
    LDA.l !Settings,x
    PHA                         ; the level's settings, at 1,s
    AND #$40
    BNE frame_lists
    SEP #$30
    JSL $85BB39                 ; the game's animated tiles (in FastROM's bank)
; Does a list with slots run? !List the first that does. [Solar Magic: also
; the overworld's frame's, ow_frame] The stack: the settings at 1,s, the
; scratch's $00-$03 and the caller's flags below.
frame_lists:
    SEP #$20
    LDA 1,s
    AND #$10
    BNE .no_global
    REP #$20
    JSR global_address
    BCC .no_global
    SEP #$20
    LDA [!List]
    BNE .run                    ; the global list, then the level's
.no_global:
    SEP #$20
    LDA 1,s
    ORA #$10                    ; (the settings' copy: no global list to run)
    STA 1,s
    AND #$20
    BNE .done
    REP #$30
    JSR level_address
    BCC .done
    SEP #$20
    LDA [!List]
    BEQ .done                   ; neither list
.run:
    REP #$30
    PEI ($0E)                   ; the rest of the scratch
    PEI ($0C)
    PEI ($0A)
    PEI ($08)
    PEI ($06)
    PEI ($04)
    SEP #$20
    LDA !EffFrame
    STA.l !LastFrame
    REP #$20
    JSR clear_queue
    SEP #$20
    STZ !Entry
    LDA !EffFrame
    AND #$07
    BNE +
    LDA.l !Legacy               ; every eighth frame a list runs
    INC A
    AND #$1F
    STA.l !Legacy
+   LDA 13,s                    ; the settings (below the six PEIs)
    AND #$10
    BNE .level                  ; !List the level's list
    LDA #$20
    STA !Counter
    JSR run_list                ; !List the global list
    SEP #$20
    LDA 13,s
    AND #$20
    BNE .restore
    REP #$30
    JSR level_address
    BCC .restore
.level:
    SEP #$20
    STZ !Counter
    JSR run_list                ; the level's uploads after the global ones
.restore:
    REP #$30
    PLX
    STX $04
    PLX
    STX $06
    PLX
    STX $08
    PLX
    STX $0A
    PLX
    STX $0C
    PLX
    STX $0E
.done:
    SEP #$20
    PLA
    REP #$30
    PLX
    STX $00
    PLX
    STX $02
    PLP
    RTL

; The level's setup runs the animation eight times, from $14 mod 8 = 0,
; before it copies the palette to the copy the game fades (MVN at $00A5E1);
; the rotations and the working palettes take that copy as theirs, so it
; is made before the first time as well.
setup_frame:
    PHP
    SEP #$20
    LDA !EffFrame
    AND #$07
    BNE +
    REP #$30
    PHB
    LDX.w #!MainPalette&$FFFF
    LDY.w #!CopyPalette&$FFFF
    LDA #$01FF                  ; all 256 colours (the game's copy stops at $F7)
    MVN $00,$00                 ; bank $00: either RAM, LoROM or SA-1
    PLB
+   PLP
    JML frame

; The list at !List, from slot $14 mod 8 in steps of 8, its uploads queued
; from !Entry on [Solar Magic]. A 8-bit, X/Y 16-bit.
run_list:
    REP #$20
    LDY #$0006
    LDA [!List],y               ; the manual triggers set: a frame each
    LDX #$0008
-   LSR A
    BCC +
    INX
+   CMP #$0000
    BNE -
    STX !Base
    SEP #$20
    LDA !EffFrame
    AND #$07
    STA !Index
.slot:
    LDA [!List]                 ; slots used
    CMP !Index
    BEQ .end
    BCC .end
    REP #$20
    LDA !Index
    AND #$00FF
    ASL A
    CLC
    ADC !Base
    TAY
    LDA [!List],y
    BEQ +                       ; unused
    CLC
    ADC !Base
    STA !Slot
    SEP #$20
    JSR run_slot
+   SEP #$20
    LDA !Index
    CLC
    ADC #$08
    STA !Index
    CMP #$20
    BCC .slot
.end:
    RTS

; ---------------------------------------------------------------------------
; A slot. A 8-bit, X/Y 16-bit; !Slot its entry.
run_slot:
    LDY !Slot
    INY
    INY
    LDA [!List],y               ; frames less one
    INC A
    STA !Frames
    LDY !Slot
    LDA [!List],y               ; the type
    CMP #$18
    BCC +
    JMP rotation
+   CMP #$15
    BEQ .fades
    CMP #$17
    BNE .trigger
.fades:
    LDA.l !OwSubmap             ; (not on the overworld, which has no end:
    BPL .trigger                ; Lunar Magic's help) [Solar Magic]
    LDA.l !EndLevelTimer        ; types 15 and 17 stop at the level's end
    BEQ .trigger
    RTS
.trigger:
    INY
    LDA [!List],y               ; the trigger
    CMP #$10
    BCC .game
    CMP #$20
    BCC .manual
    CMP #$30
    BCC .custom
    CMP #$50
    BCC .one_shot
    BRA .plain
.game:
    CMP #$06
    BEQ .condition_once
    CMP #$08
    BEQ .condition_once
.custom:
    JSR condition
    BCS .second
.plain:
    JSR advance
    JMP upload
.second:
    JSR advance
    CLC
    ADC !Frames
    JMP upload
.condition_once:
    PHA                         ; on the overworld 06 and 08 are event
    LDA.l !OwSubmap             ; triggers with a second set, as 01-05 and 07
    BMI +                       ; [Solar Magic]
    PLA
    BRA .custom
+   PLA
    JSR condition
    BCC .none
    JSR counter
    INC A
    CMP !Frames
    BCS .none                   ; ran once: stays on its last frame
    STA.l !Counters,x
    JMP upload
.none:
    RTS
.manual:
    AND #$0F
    REP #$20
    AND #$00FF
    TAX
    SEP #$20
    LDA.l !Manual,x
    STA !Temp
    JSR counter
    LDA !Temp
    CMP.l !Counters,x
    BEQ .none                   ; shown already ($FF: nothing yet)
    CMP !Frames
    BCC +
    LDA #$00                    ; past the last frame: the first, again
+   STA.l !Counters,x           ; each time, as the two stay unequal
    JMP upload
.one_shot:
    SEC
    SBC #$30
    JSR one_shot_bit
    BEQ .none                   ; off: the animation holds
    JSR counter
    INC A
    CMP !Frames
    BCS .finished
    STA.l !Counters,x
    JMP upload
.finished:                      ; done: the counter back to $FF, the bit off
    LDA #$FF
    STA.l !Counters,x
    LDY !Slot
    INY
    LDA [!List],y
    SEC
    SBC #$30
    JSR one_shot_bit
    LDA !Temp
    EOR #$FF
    AND.l !OneShot,x
    STA.l !OneShot,x
    RTS

; X = the slot's counter's index; A = the counter. A slot with the precision
; timer (trigger 0F) takes the counter of the first slot of its 8 (Lunar
; Magic's help, level_ex20.htm) and moves it on as well: with more of them it
; runs faster, the help's speed trick for rotations. [Solar Magic]
counter:
    PHY
    LDY !Slot
    INY
    LDA [!List],y               ; the trigger
    PLY
    CMP #$0F
    BNE .own
    LDA !Index
    AND #$18
    BRA .index
.own:
    LDA !Index
.index:
    CLC
    ADC !Counter
    REP #$20
    AND #$00FF
    TAX
    SEP #$20
    LDA.l !Counters,x
    RTS

; The counter moved on, from 0 again past the last frame; A = it.
advance:
    JSR counter
    INC A
    CMP !Frames
    BCC +
    LDA #$00
+   STA.l !Counters,x
    RTS

; One-shot trigger A: X = its byte's index, !Temp = its bit, Z set when off.
one_shot_bit:
    PHA
    AND #$07
    REP #$20
    AND #$00FF
    TAX
    SEP #$20
    LDA.l .bits,x
    STA !Temp
    PLA
    LSR A
    LSR A
    LSR A
    REP #$20
    AND #$00FF
    TAX
    SEP #$20
    LDA.l !OneShot,x
    AND !Temp
    RTS
.bits:
    db $01,$02,$04,$08,$10,$20,$40,$80

; Carry set when trigger A (the game's conditions, or a custom bit) holds.
condition:
    CMP #$20
    BCS .custom
    PHA
    LDA.l !OwSubmap
    BPL .overworld              ; [Solar Magic]
    PLA
    CMP #$01
    BEQ .pow
    CMP #$02
    BEQ .silver
    CMP #$03
    BEQ .on_off
    CMP #$04
    BEQ .star
    CMP #$05
    BEQ .timer
    CMP #$06
    BEQ .timer
    CMP #$07
    BEQ .coins
    CMP #$08
    BEQ .coins
    CLC
    RTS
.pow:
    LDA.l $0014AD|!addr
    BRA .nonzero
.silver:
    LDA.l $0014AE|!addr
    BRA .nonzero
.on_off:
    LDA.l $0014AF|!addr
    BRA .nonzero
.star:
    LDA.l $001490|!addr
.nonzero:
    CMP #$01
    RTS
.timer:
    LDA.l $000F31|!addr         ; the timer's hundreds: none left
    BEQ .holds
    CLC
    RTS
.holds:
    SEC
    RTS
.coins:
    LDA.l $001420|!addr
    CMP #$05
    RTS
.custom:
    SEC
    SBC #$20
    REP #$20
    AND #$000F
    TAX
    LDA.l !Custom
-   DEX
    BMI +
    LSR A
    BRA -
+   LSR A
    SEP #$20
    RTS
; On the overworld 01-08 are Lunar Magic's "Event Manual 8-F": they hold
; while the event whose number manual frame 8-F has is passed ($1F02, a bit
; each, the first event the high bit). [Solar Magic]
.overworld:
    PLA
    DEC A                       ; 01-08 as 0-7 (none and 09-0F: never)
    CMP #$08
    BCS .none
    REP #$20
    AND #$00FF
    TAX
    SEP #$20
    LDA.l !Manual+8,x           ; the event
    PHA
    LSR A
    LSR A
    LSR A
    REP #$20
    AND #$00FF
    TAX
    SEP #$20
    LDA.l $001F02|!addr,x
    STA !Temp
    PLA
    AND #$07
    REP #$20
    AND #$00FF
    TAX
    SEP #$20
    LDA.l .event_bits,x
    AND !Temp
    CMP #$01
    RTS
.none:
    CLC
    RTS
.event_bits:
    db $80,$40,$20,$10,$08,$04,$02,$01

; ---------------------------------------------------------------------------
; The upload of frame A of the slot. A 8-bit, X/Y 16-bit.
upload:
    REP #$20
    AND #$00FF
    ASL A
    CLC
    ADC !Slot
    ADC #$0005
    TAY                         ; the frame's word
    CLC
    ADC !List
    STA !Temp                   ; its address
    LDA [!List],y
    STA !Source
    SEP #$20
    LDY !Slot
    LDA [!List],y               ; the type
    CMP #$13
    BCC tiles
    JMP colours

; Tiles: the source in bank $7E, or in the alternative file.
tiles:
    REP #$20
    AND #$00FF
    ASL A
    TAX
    LDA.l tile_bytes-2,x
    PHA
    LDA !Entry
    AND #$00FF
    TAX
    PLA
    STA.l !Queue,x
    INY
    INY
    INY
    LDA [!List],y               ; the destination
    PHA
    AND #$7FFF
    STA.l !Queue+2,x
    PLA
    BPL .ram
    JSR alternative
    BRA .queue
.ram:
    SEP #$20
    LDA #$7E
    STA !Source+2
.queue:
    REP #$20
    LDA !Source
    STA.l !Queue+4,x
    SEP #$20
    LDA !Source+2
    STA.l !Queue+6,x
    JMP queued                  ; [Solar Magic]

; Bytes per upload by type (01-12); bit 14: two rows, this many bytes each,
; the second $100 words below.
tile_bytes:
    dw $0020,$0040,$0060,$0080,$00A0,$00C0,$00E0,$0100
    dw $0180,$0200,$0280,$0300,$0380,$0400
    dw $0010,$4020,$4040,$4080

; !Source (16-bit) + the list's alternative file's address. X kept.
alternative:
    PHX
    SEP #$20
    LDY #$0001
    LDA [!List],y               ; the file, 0-3
    AND #$03
    STA !Source+2
    ASL A
    CLC
    ADC !Source+2
    REP #$20
    AND #$00FF
    TAX
    LDA.l !AltFiles,x
    CLC
    ADC !Source
    STA !Source
    SEP #$20
    LDA.l !AltFiles+2,x
    STA !Source+2
    PLX
    RTS

; Colours: types 13 (CGRAM), 14 and 15 (also the palette's two copies in
; RAM), 16 and 17 (the back area colour and its copy, in RAM). One colour
; is the frame itself; more are read from the frame's address.
colours:
    CMP #$16
    BCS .back_area
    PHA
    INY
    INY
    INY
    INY
    LDA [!List],y
    AND #$7F
    INC A
    STA !Frames                 ; colours
    CMP #$01
    BNE .many
    REP #$20                    ; one: the frame's own word, in the list
    LDA !Temp
    STA !Source
    SEP #$20
    LDA !List+2
    STA !Source+2
    BRA .where
.many:
    LDA [!List],y
    BMI .alternative
    LDA #$7E
    STA !Source+2
    BRA .where
.alternative:
    JSR alternative
.where:
    LDY !Slot
    INY
    INY
    INY
    LDA [!List],y
    STA !Temp                   ; the first colour
    PLA
    CMP #$13
    BEQ colours_queue
    LDA.l !OwSubmap             ; the overworld's palette has no copy that
    BMI +                       ; fades [Solar Magic]
    JMP ow_colours
+   ; The palette's two copies in RAM.
    REP #$20
    LDA !Temp
    AND #$00FF
    ASL A
    TAX
    LDA !Frames
    AND #$00FF
    PHA
    LDY #$0000
-   LDA [!Source],y
    STA.l !MainPalette,x
    STA.l !CopyPalette,x
    INX
    INX
    INY
    INY
    LDA 1,s
    DEC A
    STA 1,s
    BNE -
    PLA
    LDA !Temp                   ; the colours go up from the copy the game fades
    AND #$00FF
    ASL A
    CLC
    ADC.w #!CopyPalette&$FFFF
    STA !Source
    SEP #$20
    LDA.b #!CopyPalette>>16
    STA !Source+2
    BRA colours_queue
.back_area:
    LDA.l !OwSubmap             ; (A 8-bit; N stays through the REP)
    REP #$20
    BMI +
    LDA !Source                 ; the overworld: no copy [Solar Magic]
    STA.l !BackAreaColour
    SEP #$20
    RTS
+   LDA !Source                 ; the colour itself
    STA.l !BackAreaColour
    STA.l !CopyBackArea
    SEP #$20
    RTS

; A CGRAM upload: !Frames colours to colour !Temp from !Source.
colours_queue:
    REP #$20
    LDA !Entry
    AND #$00FF
    TAX
    LDA !Frames
    AND #$00FF
    ASL A
    ORA #$8000                  ; bit 15: CGRAM
    STA.l !Queue,x
    LDA !Temp
    AND #$00FF
    STA.l !Queue+2,x
    LDA !Source
    STA.l !Queue+4,x
    SEP #$20
    LDA !Source+2
    STA.l !Queue+6,x
queued:                         ; the upload at !Entry queued; A 8-bit [Solar Magic]
    LDA !Entry
    CLC
    ADC #$07
    STA !Entry
    STA.l !QueueEnd
    RTS

; ---------------------------------------------------------------------------
; Types 18-1B: the palette's colours rotated in both copies, right (18, 19)
; or left (1A, 1B), once every frames times (the counter counts up to the
; frames less one from $FF). 18 and 1A wait for their
; trigger, if they have one; 19 and 1B turn the other way while it holds.
; The colours go up from the copy the game fades. A 8-bit, X/Y 16-bit.
rotation:
    PHA                         ; the type
    INY
    LDA [!List],y               ; the trigger
    PHA
    JSR condition
    PLA
    BCS .holds
    CMP #$00
    BEQ .go                     ; none: always
    CMP #$0F
    BEQ .go                     ; the precision timer: always [Solar Magic]
    LDA 1,s
    CMP #$19
    BEQ .go
    CMP #$1B
    BEQ .go
    PLA                         ; waits for its trigger
    RTS
.holds:
    LDA 1,s
    CMP #$19
    BEQ .reverse
    CMP #$1B
    BNE .go
.reverse:
    EOR #$02                    ; the other way
    STA 1,s
.go:
    JSR counter                 ; a turn when it would reach the frames less one
    INC A
    INC A
    CMP !Frames
    BCS .turn
    DEC A
    STA.l !Counters,x
    PLA
    RTS
.turn:
    LDA #$FF
    STA.l !Counters,x
    JSR rotate_range            ; X = 2 * the first colour, Y = the colours
    LDA.l !OwSubmap             ; the overworld: no copy that fades
    BMI +                       ; [Solar Magic]
    JMP ow_turn
+   PLA
    CMP #$1A
    REP #$20
    BCS .left
    TYA                         ; right: from the last colour down
    DEC A
    ASL A
    STA !Source
    TXA
    CLC
    ADC !Source
    TAX
    LDA.l !MainPalette,x
    PHA
    LDA.l !CopyPalette,x
    PHA
    DEY
    BEQ +
-   LDA.l !MainPalette-2,x
    STA.l !MainPalette,x
    LDA.l !CopyPalette-2,x
    STA.l !CopyPalette,x
    DEX
    DEX
    DEY
    BNE -
+   BRA .ends
.left:
    LDA.l !MainPalette,x
    PHA
    LDA.l !CopyPalette,x
    PHA
    DEY
    BEQ +
-   LDA.l !MainPalette+2,x
    STA.l !MainPalette,x
    LDA.l !CopyPalette+2,x
    STA.l !CopyPalette,x
    INX
    INX
    DEY
    BNE -
+
.ends:
    PLA
    STA.l !CopyPalette,x
    PLA
    STA.l !MainPalette,x
    SEP #$20
    JSR rotate_range
    STX !Source
    REP #$20
    LDA !Source
    CLC
    ADC.w #!CopyPalette&$FFFF
    STA !Source
    SEP #$20
    LDA.b #!CopyPalette>>16
    STA !Source+2
    TYA
    STA !Frames
    JMP colours_queue

; X = 2 * the slot's first colour, !Temp = it, Y = its colours. A 8-bit.
rotate_range:
    LDY !Slot
    INY
    INY
    INY
    LDA [!List],y
    STA !Temp
    INY
    LDA [!List],y
    AND #$7F
    INC A
    REP #$20
    AND #$00FF
    TAY
    LDA !Temp
    AND #$00FF
    ASL A
    TAX
    SEP #$20
    RTS

; ---------------------------------------------------------------------------
; The uploads, in the NMI and in the level's setup: the game's animated
; tiles, the queue, and the game's colour $64 flashing, as the level's
; settings allow.
nmi:
    PHP
    REP #$30
    LDA.l !Level
    AND #$01FF
    TAX
    SEP #$20
    LDA.l !Settings,x
    PHA
    AND #$40
    BNE +
    JSR game_tiles
+   JSR queue
    SEP #$20
    PLA
    AND #$80
    BNE +
    JSR game_flashing
+   PLP
    RTL

; The game's animated tiles ($0D76-$0D81): three tiles of four, the one at
; $0800 in two halves, the second at $0900.
game_tiles:
    REP #$20
    SEP #$10
    LDY #$80
    STY $2115
    LDA #$1801
    STA $4320
    LDY #$7E
    STY $4324
    LDX #$04
    LDA $0D80|!addr
    BEQ +
    STA $2116
    LDA $0D7A|!addr
    STA $4322
    LDA #$0080
    STA $4325
    STX $420B
+   LDA $0D7E|!addr
    BEQ +
    STA $2116
    LDA $0D78|!addr
    STA $4322
    LDA #$0080
    STA $4325
    STX $420B
+   LDA $0D7C|!addr
    BEQ .done
    STA $2116
    CMP #$0800
    BEQ .halves
    LDA $0D76|!addr
    STA $4322
    LDA #$0080
    STA $4325
    STX $420B
    BRA .done
.halves:
    LDA $0D76|!addr
    STA $4322
    LDA #$0040
    STA $4325
    STX $420B
    LDA #$0900
    STA $2116
    LDA $0D76|!addr
    CLC
    ADC #$0040
    STA $4322
    LDA #$0040
    STA $4325
    STX $420B
.done:
    SEP #$20
    REP #$10
    RTS

; Colour $64 from the game's flashing colours, by $14.
game_flashing:
    SEP #$30
    LDA #$64
    STZ $00
    STA $2121
    LDA !EffFrame
    AND #$1C
    LSR A
    TAX
    LDA.l $00B60C,x             ; FlashingColors
    STA $2122
    LDA.l $00B60D,x
    STA $2122
    REP #$10
    RTS

; The queued uploads, up to !QueueEnd [Solar Magic]: 7 bytes each, a 16-bit
; byte count (bit 15 CGRAM, the destination a colour; bit 14 two rows, the
; second $100 words on), the destination, and the source. They stay queued
; until the next frame of the animation replaces them, so an NMI without
; one (the one after the level's setup, which uploads the palette in
; between, or a paused frame's) makes them again, as it does the game's
; animated tiles.
queue:
    REP #$30
    LDX #$0000
.next:
    TXA
    CMP.l !QueueEnd
    BCC +
    RTS
+   LDA.l !Queue,x
    BMI .cgram
    AND #$3FFF
    STA $4325
    LDA.l !Queue+2,x
    STA $2116
    LDA.l !Queue+4,x
    STA $4322
    LDA.l !Queue+5,x
    STA $4323                   ; and the bank at $4324
    LDA #$1801
    STA $4320
    SEP #$20
    LDA #$80
    STA $2115
    LDA #$04
    STA $420B
    REP #$20
    LDA.l !Queue,x
    AND #$4000
    BEQ .skip
    LDA.l !Queue,x              ; the second row
    AND #$3FFF
    STA $4325
    STA $00
    LDA.l !Queue+2,x
    CLC
    ADC #$0100
    STA $2116
    LDA.l !Queue+4,x
    CLC
    ADC $00
    STA $4322
    SEP #$20
    LDA #$04
    STA $420B
    REP #$20
    BRA .skip
.cgram:
    AND #$3FFF
    STA $4325
    LDA.l !Queue+4,x
    STA $4322
    LDA.l !Queue+5,x
    STA $4323
    LDA #$2200
    STA $4320
    SEP #$20
    LDA.l !Queue+2,x
    STA $2121
    LDA #$04
    STA $420B
    REP #$20
.skip:
    TXA
    CLC
    ADC #$0007
    TAX
    JMP .next

; ---------------------------------------------------------------------------
; The overworld [Solar Magic]: a list per submap and the overworld's global
; one, run as a level's lists, with a settings byte per submap. Lunar
; Magic's editor finds the tables through the values at its offsets from the
; load's hook target (read from Lunar Magic's code in ROMs it saved,
; docs/research/lunar-magic-submap-graphics.md): the settings' address at
; +$4A, the global list's address >> 8 at +$57 and its low word at +$61, the
; submaps' 7 3-byte list pointers ($0000FF: none) at +$E1 and that address
; plus one at +$D6. A submap's settings byte: 80 the level dots' colours 6D
; and 7D, 40 the game's animated tiles, 20 the submap's list, 10 the global
; list, each off when set (Lunar Magic's). The lightning (colour 47) is the
; game's own, switched by its mask at $04F709 (exanim.ts).
ow_init:
    BRL ow_init_body
    fillbyte $FF : fill $4A-3
ow_settings_at:                 ; +$4A
    dl ow_settings
    fillbyte $FF : fill $57-$4D
ow_global_bank:                 ; +$57
    dw $0000
    fillbyte $FF : fill $61-$59
ow_global_low:                  ; +$61
    dw $0000
    fillbyte $FF : fill $D6-$63
ow_list_next:                   ; +$D6
    dl ow_table+1
    fillbyte $FF : fill $E1-$D9
ow_list:                        ; +$E1
    dl ow_table

assert ow_settings_at-ow_init == $4A
assert ow_global_bank-ow_init == $57
assert ow_global_low-ow_init == $61
assert ow_list_next-ow_init == $D6
assert ow_list-ow_init == $E1

; The overworld's load (A/X/Y 8-bit, the data bank $04, the screen off): the
; lists set up for the player's submap, the game's animated tiles set up
; (unless off), then eight frames of the lists with their uploads, $14 from
; 0 to 7 (and back after them), so the map shows them from the start.
ow_init_body:
    PHP
    JSR ow_setup
    SEP #$30
    LDA.l !OwSettings
    AND #$40
    BNE .setup
    REP #$30
    STZ $03                     ; what the hook replaces, then the game's
    STZ $05                     ; code after it, returning through an RTL
    PHK
    PER .setup-1
    PEA $8413
    JML $84808C
.setup:
    SEP #$30
    LDA !EffFrame
    PHA
    LDA.l !OwSettings
    PHA
    ORA #$C0                    ; the game's tiles set up already, no dots
    STA.l !OwSettings
    STZ !EffFrame
-   JSL ow_frame
    JSL ow_nmi
    INC !EffFrame
    LDA !EffFrame
    CMP #$08
    BCC -
    PLA
    STA.l !OwSettings
    PLA
    STA !EffFrame
    LDA #$FF
    STA.l !LastCall
    PLP
    RTL

; The lists set up for the player's submap ($1F11 of $0DB3), its settings
; read. Any A/X/Y size; the scratch kept.
ow_setup:
    PHP
    JSR save_scratch
    SEP #$30
    LDX $0DB3|!addr
    LDA $1F11|!addr,x
    STA.l !OwSubmap
    REP #$30
    AND #$00FF
    TAY
    LDA.l ow_settings_at
    STA !List
    LDA.l ow_settings_at+1
    STA !List+1
    SEP #$20
    LDA [!List],y
    STA.l !OwSettings
    JSR setup_lists
    JSR restore_scratch
    PLP
    RTS

; A frame on the overworld, where the game animates its tiles (A/X/Y 8-bit,
; the data bank $04): the game's tiles (unless off; by the frame counter
; $14, as Lunar Magic has them), then the lists, as a level's. When Mario
; walks to another submap the lists of the one he left run on until the
; window has closed over it: where the game loads the new submap's palette,
; the editor's graphics code at $04DBB9 (submapgfx.ts) runs the load's hook
; again, the screen off, which sets the new submap's lists up. (Lunar Magic
; keeps the lists the load set up until the next load.)
ow_frame:
    PHP
    SEP #$30
    LDA.l !OwSettings
    AND #$40
    BNE .lists
    PHK
    PER .lists-1
    PEA $8413
    LDA !EffFrame               ; what the hook replaces ($13: Lunar Magic's $14)
    AND #$07
    BNE +
    JML $8480E6
+   JML $848101
.lists:
    SEP #$30
    LDA !EffFrame
    CMP.l !LastCall
    BNE +
    PLP
    RTL
+   STA.l !LastCall
    REP #$30
    PEI ($02)
    PEI ($00)
    SEP #$20
    LDA.l !OwSettings
    PHA
    JMP frame_lists

; The overworld's NMI uploads (entered with JSR, A/X 8-bit): the game's
; animated tiles from $0AF6 (unless off), the queue, the level dots' colours
; 6D and 7D (unless off), as the code the hook replaces does them.
ow_nmi:
    PHP
    SEP #$20
    REP #$10
    LDA.l !OwSettings
    AND #$40
    BNE +
    LDA #$80
    STA $2115
    LDY #$0750
    STY $2116
    LDY #$1801
    STY $4320
    LDY #$0AF6
    STY $4322
    STZ $4324
    LDY #$0160
    STY $4325
    LDA #$04
    STA $420B
+   JSR queue
    SEP #$30
    LDA.l !OwSettings
    BMI .done
    LDA $13D9|!addr
    CMP #$0A
    BEQ .done
    STZ $00
    LDA #$6D
    JSR .dot
    LDA #$10
    STA $00
    LDA #$7D
    JSR .dot
.done:
    PLP
    RTL
.dot:                           ; colour A from the flashing colours, by $14
    STA $2121
    LDA !EffFrame
    AND #$1C
    LSR A
    ADC $00
    TAX
    LDA.l $00B60C,x
    STA $2122
    LDA.l $00B60D,x
    STA $2122
    RTS

; Colours (types 14 and 15) on the overworld: into its palette ($0703) and
; CGRAM, from the frame; A 8-bit, X/Y 16-bit, as colours has them.
ow_colours:
    REP #$20
    LDA !Temp
    AND #$00FF
    ASL A
    TAX
    LDA !Frames
    AND #$00FF
    PHA
    LDY #$0000
-   LDA [!Source],y
    STA.l !MainPalette,x
    INX
    INX
    INY
    INY
    LDA 1,s
    DEC A
    STA 1,s
    BNE -
    PLA
    SEP #$20
    JMP colours_queue

; A rotation's turn on the overworld: the palette's colours ($0703), then
; uploaded from there. The type at 1,s; X = 2 * the first colour, Y = the
; colours; A 8-bit.
ow_turn:
    PLA
    CMP #$1A
    REP #$20
    BCS .left
    TYA                         ; right: from the last colour down
    DEC A
    ASL A
    STA !Source
    TXA
    CLC
    ADC !Source
    TAX
    LDA.l !MainPalette,x
    PHA
    DEY
    BEQ .ends
-   LDA.l !MainPalette-2,x
    STA.l !MainPalette,x
    DEX
    DEX
    DEY
    BNE -
    BRA .ends
.left:
    LDA.l !MainPalette,x
    PHA
    DEY
    BEQ .ends
-   LDA.l !MainPalette+2,x
    STA.l !MainPalette,x
    INX
    INX
    DEY
    BNE -
.ends:
    PLA
    STA.l !MainPalette,x
    SEP #$20
    JSR rotate_range
    REP #$20
    TXA
    CLC
    ADC.w #!MainPalette&$FFFF
    STA !Source
    SEP #$20
    LDA.b #!MainPalette>>16
    STA !Source+2
    TYA
    STA !Frames
    JMP colours_queue
`;

export const MEMORY_ASM = `; Where the ROM maps and where the game keeps its variables, for every patch
; in this folder, which includes this file first. A vanilla ROM is LoROM
; with the game's variables in work RAM; an SA-1 ROM is SA-1 Pack's
; (docs/sa1.md), which moves them where both of its processors reach them.
; ram::RamMap is the same map for the library, and tests/install.rs checks
; that the two agree.
;
; How a patch names a variable, by its vanilla address:
;   $00-$FF        direct page, as the game addresses it ($0E); written as
;                  an absolute address, $000E|!dp
;   $0100-$1FFF    absolute, $010B|!addr; long, $00010B|!addr. A define
;                  puts the address last, !addr|$0BF6, so that !name+2
;                  means the same whichever order Asar evaluates | and +
;                  in; an operand written out has nothing added after it.
;   $7EC800        the tile grid's low bytes, !map16_low; high, !map16_high
;   $1938          the sprite load flags, !sprite_load_flags (!load_flags
;                  of them)
;   $9E, $14D4...  a sprite table, by its vanilla address: !9E,x, !14D4,x;
;                  SA-1 Pack packs them elsewhere, with 22 slots
;                  (more_sprites/sprite_tables.asm)
; A DMA from a buffer in $0100-$1FFF reads it from bank $00 at the address
; with !addr, as SA-1 Pack's own uploads do. Uploads in the NMI or with the
; screen off go through channel !dma ($43x0, its bit in $420B !dma_bit):
; the game's 1, which SA-1 Pack moves to 2, keeping 1 for HDMA
; (remap/dma.asm).
; Work RAM past $1FFF ($7E2000 on, $7F0000 on) stays where it is, and only
; the S-CPU reaches it, or the PPU's registers: under SA-1 Pack, code the
; SA-1 runs must leave those to the S-CPU (!sa1, docs/sa1.md).

if read1($00FFD5) == $23
    if read1($00FFD7) >= $0D
        fullsa1rom
    else
        sa1rom
    endif
    !sa1 = 1
    !dp = $3000
    !addr = $6000
    !map16_low = $40C800
    !map16_high = $41C800
    !sprite_load_flags = $418A00
    !load_flags = $FF
    !dma = $4320
    !dma_bit = $04
    !9E = $3200
    !D8 = $3216
    !E4 = $322C
    !14D4 = $3258
    !14E0 = $326E
    !167A = $7616
    !187B = $3410
else
    lorom
    !sa1 = 0
    !dp = $0000
    !addr = $0000
    !map16_low = $7EC800
    !map16_high = $7FC800
    !sprite_load_flags = $001938
    !load_flags = $80
    !dma = $4310
    !dma_bit = $02
    !9E = $9E
    !D8 = $D8
    !E4 = $E4
    !14D4 = $14D4
    !14E0 = $14E0
    !167A = $167A
    !187B = $187B
endif

; Has the S-CPU run <routine> for code that may run on the SA-1, which
; cannot reach work RAM past $1FFF or the PPU: SA-1 Pack's call from the
; SA-1 (engine/snes_irq.asm), which takes the routine's address in
; $0183-$0185 and $D0 in $2209, and sets $018A once the routine has
; returned. The routine runs with A, X, and Y 8-bit and the direct page at
; $3000, and ends with RTL; values go both ways through the direct page,
; which the two processors share. On the S-CPU, and on a LoROM ROM, the
; routine is called directly. A, X, and Y 8-bit; A is changed.
macro call_scpu(routine)
    if !sa1
        TSC
        XBA
        CMP #$37                ; the SA-1's stack page
        BNE ?direct
        LDA.b #<routine>
        STA.l $000183
        LDA.b #<routine>>>8
        STA.l $000184
        LDA.b #<routine>>>16
        STA.l $000185
        LDA #$D0
        STA.l $002209
    ?wait:
        LDA.l $00018A
        BEQ ?wait
        LDA #$00
        STA.l $00018A
        BRA ?done
    ?direct:
        JSL <routine>
    ?done:
    else
        JSL <routine>
    endif
endmacro
`;
