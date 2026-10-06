// Replaces AddmusicK's asardll.c for the WebAssembly build: instead of loading asar.dll at run
// time, the Asar library is linked in (its exported functions renamed to asarlib_*, see
// tools/build-amk.sh) and AddmusicK's function pointers point straight at them.
#include "asardll.h"

extern "C" {
bool asarlib_init(void);
int asarlib_apiversion(void);
int asarlib_version(void);
bool asarlib_patch_ex(const struct patchparams *);
const struct errordata *asarlib_geterrors(int *);
const struct errordata *asarlib_getwarnings(int *);
const char *const *asarlib_getprints(int *);

int (*asar_version)(void) = nullptr;
int (*asar_apiversion)(void) = nullptr;
bool (*asar_reset)(void) = nullptr;
bool (*asar_patch)(const char *, char *, int, int *) = nullptr;
bool (*asar_patch_ex)(const struct patchparams *) = nullptr;
int (*asar_maxromsize)(void) = nullptr;
const struct errordata *(*asar_geterrors)(int *) = nullptr;
const struct errordata *(*asar_getwarnings)(int *) = nullptr;
const char *const *(*asar_getprints)(int *) = nullptr;
const struct labeldata *(*asar_getalllabels)(int *) = nullptr;
int (*asar_getlabelval)(const char *) = nullptr;
const char *(*asar_getdefine)(const char *) = nullptr;
const struct definedata *(*asar_getalldefines)(int *) = nullptr;
const char *(*asar_resolvedefines)(const char *, bool) = nullptr;
double (*asar_math)(const char *, const char **) = nullptr;
const struct writtenblockdata *(*asar_getwrittenblocks)(int *) = nullptr;
enum mappertype (*asar_getmapper)(void) = nullptr;
const char *(*asar_getsymbolsfile)(const char *) = nullptr;

bool asar_init(void) {
	asar_version = asarlib_version;
	asar_patch_ex = asarlib_patch_ex;
	asar_geterrors = asarlib_geterrors;
	asar_getwarnings = asarlib_getwarnings;
	asar_getprints = asarlib_getprints;
	// like asardll.c: the API version check (Asar refuses to init without it)
	if (asarlib_apiversion() < expectedapiversion) return false;
	return asarlib_init();
}
bool asar_init_with_dll_path(const char *) { return asar_init(); }
void asar_close(void) {}
}
