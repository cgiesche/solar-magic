// The UI's icons (#475): Lucide (ISC, Lucide Contributors) as inline SVG in the text's color, instead of Unicode
// glyphs. Only the icons named here are bundled. An icon-only button carries an aria-label and a title with its key.

import {
  createElement, ArrowLeft, ArrowRight, ArrowRightLeft, Check, ChevronDown, ChevronLeft, ChevronRight, CircleX, Copy,
  Eraser, FlipHorizontal2, FlipVertical2, Info, Music, PaintBucket, Pencil, Pipette, Play, Redo2, RotateCw, Save, Search,
  SlidersHorizontal, SquareDashed, Trash2, TriangleAlert, Undo2, X,
  DoorOpen, Ghost, Grid2x2, Image, Layers, Mountain, Paintbrush, Route, Type,
} from 'lucide';
import { h } from './dom.ts';

const ICONS = {
  back: ArrowLeft, forward: ArrowRight, undo: Undo2, redo: Redo2, play: Play, music: Music, close: X,
  'chevron-down': ChevronDown, 'chevron-right': ChevronRight, 'chevron-left': ChevronLeft, check: Check,
  settings: SlidersHorizontal, reverse: ArrowRightLeft, duplicate: Copy, delete: Trash2,
  warning: TriangleAlert, error: CircleX, info: Info,
  select: SquareDashed, pen: Pencil, eraser: Eraser, fill: PaintBucket, eyedropper: Pipette,
  rotate: RotateCw, save: Save, search: Search, 'flip-h': FlipHorizontal2, 'flip-v': FlipVertical2,
  // edit modes and tools of the rails (#477)
  'layer-1': Grid2x2, 'layer-2': Layers, sprites: Ghost, exits: DoorOpen, bg: Image, 'layer-3': Type,
  terrain: Mountain, brush: Paintbrush, route: Route,
};
export type IconName = keyof typeof ICONS;

/** An icon, sized by the text around it (1.2em), decorative (the button's label or aria-label names it). */
export function icon(name: IconName): SVGElement {
  const el = createElement(ICONS[name], { 'aria-hidden': 'true' });
  el.classList.add('icon');
  return el;
}

/** A button's content: an icon and its label. */
export function iconLabel(name: IconName, label: string): Node[] {
  return [icon(name), h('span', { class: 'icon-label' }, label)];
}
