import type { Source } from '@/api/types';

import { cn, SourceMonogram as Monogram } from '@/ui';

/** The kit's source monogram at the size of a source card, so the card and the rail show one mark. */
export function SourceMonogram({ source, className }: { source: Pick<Source, 'name'>; className?: string }) {
  return <Monogram name={source.name} testId="source-monogram" className={cn('size-11 rounded-lg text-body shadow-1', className)} />;
}
