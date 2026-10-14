import type { MultiviewLayout } from '../types';

type Rect = readonly [x: number, y: number, w: number, h: number];

/** Slot rectangles of each layout in a 28 x 16 box, in slot order. */
const RECTS: Record<MultiviewLayout, readonly Rect[]> = {
  '1x2': [
    [1, 4, 12.5, 8],
    [14.5, 4, 12.5, 8],
  ],
  '2x2': [
    [1, 1, 12.5, 6.5],
    [14.5, 1, 12.5, 6.5],
    [1, 8.5, 12.5, 6.5],
    [14.5, 8.5, 12.5, 6.5],
  ],
  '1+3': [
    [1, 1, 19, 14],
    [21, 1, 6, 4],
    [21, 6, 6, 4],
    [21, 11, 6, 4],
  ],
};

const TALLY = 'fill-accent stroke-accent';
/** Over video the accent is the glass one (the theme accent can be dark). */
const TALLY_ON_GLASS =
  'fill-[color:var(--color-glass-accent,var(--color-accent,#f5b544))] stroke-[color:var(--color-glass-accent,var(--color-accent,#f5b544))]';

/**
 * A layout drawn as its monitor wall. `tally` marks one slot the way the wall marks the tile
 * with sound: filled with the accent.
 */
export function LayoutGlyph({
  layout,
  tally,
  onGlass = false,
  className,
}: {
  layout: MultiviewLayout;
  tally?: number | undefined;
  onGlass?: boolean;
  className?: string;
}) {
  return (
    <svg viewBox="0 0 28 16" aria-hidden focusable="false" className={className}>
      {RECTS[layout].map(([x, y, w, h], i) => (
        <rect
          key={i}
          x={x}
          y={y}
          width={w}
          height={h}
          rx={1}
          strokeWidth={1.2}
          className={i === tally ? (onGlass ? TALLY_ON_GLASS : TALLY) : 'fill-current stroke-current [fill-opacity:0.16]'}
        />
      ))}
    </svg>
  );
}
