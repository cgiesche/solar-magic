// Thin wrapper around Asar's library interface (interface-lib.cpp) for the WASM build.
// smwe_patch() assembles `main` against the ROM buffer with the given in-memory files and
// defines and returns everything the editor needs as one JSON string.
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

extern "C" {
struct errordata { const char *fullerrdata, *rawerrdata, *block, *filename; int line; const char *callerfilename; int callerline; int errid; };
struct labeldata { const char *name; int location; };
struct definedata { const char *name, *contents; };
struct warnsetting { const char *warnid; bool enabled; };
struct memoryfile { const char *path; const void *buffer; size_t length; };
struct writtenblockdata { int pcoffset, snesoffset, numbytes; };
struct patchparams {
  int structsize;
  const char *patchloc; char *romdata; int buflen; int *romlen;
  const char **includepaths; int numincludepaths;
  bool should_reset;
  const definedata *additional_defines; int definecount;
  const char *stdincludesfile, *stddefinesfile;
  const warnsetting *warning_settings; int warning_setting_count;
  const memoryfile *memory_files; int memory_file_count;
  bool override_checksum_gen, generate_checksum;
};
bool asar_init();
int asar_version();
bool asar_patch_ex(const patchparams *);
const errordata *asar_geterrors(int *);
const errordata *asar_getwarnings(int *);
const char *const *asar_getprints(int *);
const labeldata *asar_getalllabels(int *);
const writtenblockdata *asar_getwrittenblocks(int *);
}

static void esc(std::string &o, const char *s) {
  o += '"';
  for (; s && *s; s++) {
    unsigned char c = (unsigned char)*s;
    if (c == '"' || c == '\\') { o += '\\'; o += (char)c; }
    else if (c < 0x20) { char b[8]; snprintf(b, sizeof b, "\\u%04x", c); o += b; }
    else o += (char)c;
  }
  o += '"';
}

static void msgs(std::string &o, const errordata *e, int n) {
  o += '[';
  for (int i = 0; i < n; i++) {
    if (i) o += ',';
    o += "{\"message\":"; esc(o, e[i].rawerrdata);
    o += ",\"full\":"; esc(o, e[i].fullerrdata);
    o += ",\"file\":"; esc(o, e[i].filename);
    o += ",\"line\":" + std::to_string(e[i].line) + "}";
  }
  o += ']';
}

static std::string result;

extern "C" const char *smwe_patch(const char *main, char *rom, int buflen, int *romlen,
                                  const char **paths, const void **bufs, const int *lens, int nfiles,
                                  const char **defnames, const char **defvals, int ndefs) {
  static bool inited = false;
  if (!inited) { asar_init(); inited = true; }
  memoryfile *mf = new memoryfile[nfiles > 0 ? nfiles : 1];
  for (int i = 0; i < nfiles; i++) mf[i] = { paths[i], bufs[i], (size_t)lens[i] };
  definedata *dd = new definedata[ndefs > 0 ? ndefs : 1];
  for (int i = 0; i < ndefs; i++) dd[i] = { defnames[i], defvals[i] };
  const char *inc[] = { "/" };
  patchparams p;
  memset(&p, 0, sizeof p);
  p.structsize = sizeof p;
  p.patchloc = main; p.romdata = rom; p.buflen = buflen; p.romlen = romlen;
  p.includepaths = inc; p.numincludepaths = 1;
  p.should_reset = true;
  p.additional_defines = dd; p.definecount = ndefs;
  p.memory_files = mf; p.memory_file_count = nfiles;
  p.override_checksum_gen = true; p.generate_checksum = false; // the editor fixes the checksum on output
  bool ok = asar_patch_ex(&p);
  delete[] mf; delete[] dd;

  int n;
  result = "{\"ok\":"; result += ok ? "true" : "false";
  result += ",\"romlen\":" + std::to_string(*romlen);
  const errordata *e = asar_geterrors(&n); result += ",\"errors\":"; msgs(result, e, n);
  e = asar_getwarnings(&n); result += ",\"warnings\":"; msgs(result, e, n);
  const char *const *pr = asar_getprints(&n);
  result += ",\"prints\":[";
  for (int i = 0; i < n; i++) { if (i) result += ','; esc(result, pr[i]); }
  result += "],\"labels\":{";
  const labeldata *l = asar_getalllabels(&n);
  for (int i = 0; i < n; i++) { if (i) result += ','; esc(result, l[i].name); result += ':' + std::to_string(l[i].location); }
  result += "},\"blocks\":[";
  const writtenblockdata *w = asar_getwrittenblocks(&n);
  for (int i = 0; i < n; i++) {
    if (i) result += ',';
    result += "[" + std::to_string(w[i].pcoffset) + "," + std::to_string(w[i].snesoffset) + "," + std::to_string(w[i].numbytes) + "]";
  }
  result += "]}";
  return result.c_str();
}

extern "C" int smwe_version() { return asar_version(); }
