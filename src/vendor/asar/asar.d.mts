export interface AsarModule {
  HEAPU8: Uint8Array;
  HEAP32: Int32Array;
  _malloc(n: number): number;
  _free(p: number): void;
  _smwe_patch(main: number, rom: number, buflen: number, romlen: number, paths: number, bufs: number, lens: number, nfiles: number, defNames: number, defVals: number, ndefs: number): number;
  _smwe_version(): number;
  UTF8ToString(p: number): string;
  stringToNewUTF8(s: string): number;
}
export default function createAsar(opts?: Record<string, unknown>): Promise<AsarModule>;
