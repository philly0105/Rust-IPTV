import type { Source } from '@/api/types';

import { cn, hueOf, initialsOf } from '@/ui';

/**
 * A source's monogram: its initials on a gradient whose hue comes from the name. The same
 * formula as the rail's SourceMark (src/shell/Rail.tsx), so a source keeps one identity between
 * the rail and its card. Decorative: the name always sits next to it.
 */
export function SourceMonogram({ source, className }: { source: Pick<Source, 'name'>; className?: string }) {
  const hue = hueOf(source.name);
  return (
    <span
      aria-hidden
      data-testid="source-monogram"
      className={cn('inline-flex size-11 shrink-0 items-center justify-center rounded-lg font-display text-body font-semibold text-white shadow-1', className)}
      style={{ background: `linear-gradient(150deg, hsl(${hue} 42% 38%), hsl(${(hue + 36) % 360} 48% 24%))` }}
    >
      {initialsOf(source.name)}
    </span>
  );
}
