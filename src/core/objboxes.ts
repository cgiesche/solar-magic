// Objects that draw no tile in the level's load – ObjecTool's custom extended objects that only set a flag
// (issue #104), any other object that leaves nothing – are shown by the editor as a box on their tile (the level
// view; the picker's thumbnail is the same box), so they can be seen, selected, moved and deleted. The box is
// editor-only, never written to the ROM. Lunar Magic shows a placeholder tile for unused extended objects.

import type { Level, LevelObject } from './level.ts';
import { isDm16 } from './cdm16.ts';
import { hex2 } from './names.ts';

// the key of a layer's object at an index in the level's load (LevelRender.touched, owner)
export const objectKey = (layer2: boolean, idx: number): number => (layer2 ? 0x8000 | idx : idx);

// the objects of a layer (key: of the object at an index, objectKey) that wrote no tile; a conditional
// Direct Map16 object hidden by its flag is shown otherwise
export function boxedObjects(objs: LevelObject[], touched: Map<number, Set<number>>, key: (i: number) => number): LevelObject[] {
  return objs.filter((o, i) => !touched.get(key(i))?.size && !(isDm16(o) && o.cond));
}

// the same of a level's layer 1 (or 2) in its load
export function layerBoxes(lv: Pick<Level, 'objects' | 'layer2Objects'>, touched: Map<number, Set<number>>, layer2: boolean): LevelObject[] {
  return boxedObjects((layer2 ? lv.layer2Objects : lv.objects) ?? [], touched, (i) => objectKey(layer2, i));
}

// what its box says: its number as in the picker (extended objects' own, 2D's custom number after a dot)
export function boxLabel(o: Pick<LevelObject, 'num' | 'ext' | 'extension'>): string {
  return o.num === 0 ? hex2(o.ext) : o.extension ? `${hex2(o.num)}.${hex2(o.extension[0])}` : hex2(o.num);
}

// the box at a tile, the topmost (the later object) where several are
export function boxAt(boxed: LevelObject[], tx: number, ty: number): LevelObject | null {
  for (let i = boxed.length - 1; i >= 0; i--) if (boxed[i].x === tx && boxed[i].y === ty) return boxed[i];
  return null;
}
