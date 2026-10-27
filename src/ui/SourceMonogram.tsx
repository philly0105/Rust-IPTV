import type { ReactNode } from 'react';

import { cn } from './cn';
import { initialsOf } from './Poster';
import { TINT_THEME, tintVars } from './tint';

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
 * A source's monogram: its initials on its name's tint (tint.ts), pale in the light theme, so a source looks
 * the same in the rail, the phone's More sheet, the Sources page and the library's source badges.
 * Decorative: the name always sits next to it.
 */
export function SourceMonogram({ name, className, children, testId }: SourceMonogramProps) {
  return (
    <span
      aria-hidden
      data-testid={testId}
      className={cn('inline-flex shrink-0 items-center justify-center font-display font-semibold', TINT_THEME, className)}
      style={tintVars(name)}
    >
      {initialsOf(name)}
      {children}
    </span>
  );
}
