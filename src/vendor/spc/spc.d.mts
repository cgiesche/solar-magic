export interface SpcModule {
  HEAPU8: Uint8Array;
  HEAP16: Int16Array;
  _malloc(n: number): number;
  _free(p: number): void;
  _spcw_new(): number;
  _spcw_delete(s: number): void;
  _spcw_reset(s: number): void;
  _spcw_read(s: number, time: number, port: number): number;
  _spcw_write(s: number, time: number, port: number, data: number): void;
  _spcw_end_frame(s: number, time: number, out: number, max: number): number;
  _spcw_play(s: number, count: number, out: number): number;
  _spcw_state_size(): number;
  _spcw_save(s: number, out: number): number;
  _spcw_load(s: number, data: number): void;
  _spcw_load_spc(s: number, data: number, size: number): number;
  _spcw_mute(s: number, mask: number): void;
  _spcw_ram(s: number): number;
}
export default function createSpc(opts?: Record<string, unknown>): Promise<SpcModule>;
