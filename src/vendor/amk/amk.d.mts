export interface AmkFS {
  chdir(p: string): void;
  mkdirTree(p: string): void;
  writeFile(p: string, data: Uint8Array | string): void;
  readFile(p: string): Uint8Array;
  readFile(p: string, opts: { encoding: 'utf8' }): string;
  readdir(p: string): string[];
}
export interface AmkModule {
  FS: AmkFS;
  callMain(args: string[]): number | undefined;
}
export default function createAmk(opts?: Record<string, unknown>): Promise<AmkModule>;
