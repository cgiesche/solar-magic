// C interface of snes_spc for the editor (src/core/apu.ts): one SPC per handle, port reads/writes
// at SPC clock times within the current frame, filtered sample output per frame and full state
// save/load.
#define private public // spcw_ram reads the RAM directly
#include "SNES_SPC.h"
#undef private
#include "SPC_Filter.h"
#include <string.h>
#include <emscripten/emscripten.h>

// The SPC700's 64-byte boot ROM (IPL): the upload protocol every game uses to send its sound
// engine. snes_spc doesn't contain it.
static const unsigned char ipl_rom[64] = {
	0xCD, 0xEF, 0xBD, 0xE8, 0x00, 0xC6, 0x1D, 0xD0, 0xFC, 0x8F, 0xAA, 0xF4, 0x8F, 0xBB, 0xF5, 0x78,
	0xCC, 0xF4, 0xD0, 0xFB, 0x2F, 0x19, 0xEB, 0xF4, 0xD0, 0xFC, 0x7E, 0xF4, 0xD0, 0x0B, 0xE4, 0xF5,
	0xCB, 0xF4, 0xD7, 0x00, 0xFC, 0xD0, 0xF3, 0xAB, 0x01, 0x10, 0xEF, 0x7E, 0xF4, 0x10, 0xEB, 0xBA,
	0xF6, 0xDA, 0x00, 0xBA, 0xF4, 0xC4, 0xF4, 0xDD, 0x5D, 0xD0, 0xDB, 0x1F, 0x00, 0x00, 0xC0, 0xFF,
};

struct Inst {
	SNES_SPC spc;
	SPC_Filter filter; // the SNES's analog output stage (low-pass and bass)
};

static void save_func( unsigned char** io, void* state, size_t size ) { memcpy( *io, state, size ); *io += size; }
static void load_func( unsigned char** io, void* state, size_t size ) { memcpy( state, *io, size ); *io += size; }

extern "C" {

EMSCRIPTEN_KEEPALIVE Inst* spcw_new() {
	Inst* s = new Inst;
	if ( s->spc.init() ) { delete s; return 0; }
	s->spc.init_rom( ipl_rom );
	s->spc.reset();
	return s;
}
EMSCRIPTEN_KEEPALIVE void spcw_delete( Inst* s ) { delete s; }
EMSCRIPTEN_KEEPALIVE void spcw_reset( Inst* s ) { s->spc.reset(); s->filter.clear(); }
EMSCRIPTEN_KEEPALIVE int spcw_read( Inst* s, int time, int port ) { return s->spc.read_port( time, port ); }
EMSCRIPTEN_KEEPALIVE void spcw_write( Inst* s, int time, int port, int data ) { s->spc.write_port( time, port, data ); }
// runs to time (SPC clocks since the frame began) and starts a new frame; out: room for max
// samples (16-bit, stereo interleaved); returns the number written (2 per stereo pair)
EMSCRIPTEN_KEEPALIVE int spcw_end_frame( Inst* s, int time, short* out, int max ) {
	s->spc.set_output( out, max );
	s->spc.end_frame( time );
	int n = s->spc.sample_count();
	s->filter.run( out, n );
	return n;
}
// produces count samples (2 per stereo pair) without port activity (an .spc file, a preview)
EMSCRIPTEN_KEEPALIVE int spcw_play( Inst* s, int count, short* out ) {
	if ( s->spc.play( count, out ) ) return 0;
	s->filter.run( out, count );
	return 1;
}
EMSCRIPTEN_KEEPALIVE int spcw_state_size() { return SNES_SPC::state_size; }
EMSCRIPTEN_KEEPALIVE int spcw_save( Inst* s, unsigned char* out ) {
	unsigned char* p = out;
	s->spc.copy_state( &p, save_func );
	return (int) ( p - out );
}
EMSCRIPTEN_KEEPALIVE void spcw_load( Inst* s, unsigned char* in ) {
	unsigned char* p = in;
	s->spc.copy_state( &p, load_func );
	s->filter.clear();
}
EMSCRIPTEN_KEEPALIVE int spcw_load_spc( Inst* s, const unsigned char* data, int size ) {
	if ( s->spc.load_spc( data, size ) ) return 0;
	s->spc.clear_echo();
	s->filter.clear();
	return 1;
}
EMSCRIPTEN_KEEPALIVE void spcw_mute( Inst* s, int mask ) { s->spc.mute_voices( mask ); }
// the SPC's 64 KB of RAM (for tests and tools: what the sound engine is playing)
EMSCRIPTEN_KEEPALIVE unsigned char* spcw_ram( Inst* s ) { return s->spc.m.ram.ram; }

}
