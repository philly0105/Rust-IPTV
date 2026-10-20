import type { ReactNode } from 'react';

import { cn } from './cn';
import { hueOf, initialsOf } from './Poster';

export interface SourceMonogramProps {
  /** The source's name: its initials and its hue. */
  name: string;
  /** Size, corner and text size; the caller picks them for its place. */
  className?: string;
  /** Drawn over the mark (the rail's error dot). */
  children?: ReactNode;
  testId?: string;
}

/**
 * A source's monogram: its initials on a gradient whose hue comes from its name, so a source looks
 * the same in the rail, the phone's More sheet, the Sources page and the library's source badges.
 * Decorative: the name always sits next to it.
 */
export function SourceMonogram({ name, className, children, testId }: SourceMonogramProps) {
  const hue = hueOf(name);
  return (
    <span
      aria-hidden
      data-testid={testId}
      className={cn('inline-flex shrink-0 items-center justify-center font-display font-semibold text-white', className)}
      style={{ background: `linear-gradient(150deg, hsl(${hue} 42% 38%), hsl(${(hue + 36) % 360} 48% 24%))` }}
    >
      {initialsOf(name)}
      {children}
    </span>
  );
}
