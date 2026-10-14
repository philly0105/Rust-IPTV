import { useState } from 'react';

import { cn, initialsOf } from '../deps';

/**
 * A channel's logo on a plate (transparent PNGs read on any frame), or its initials when it
 * has none or the image fails. Decorative: the channel's name is always spelled out beside it.
 */
export function ChannelMark({ src, name, className }: { src?: string; name: string; className?: string }) {
  // Keyed by address: a replaced tile must not inherit the old channel's broken-image state.
  const [failedSrc, setFailedSrc] = useState<string | undefined>(undefined);
  const showImage = !!src && failedSrc !== src;
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-sm font-display text-[0.6875rem] font-semibold tracking-wide',
        showImage ? 'bg-surface-2' : 'bg-surface-3 text-fg-muted',
        className,
      )}
    >
      {showImage ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFailedSrc(src)}
          className="max-h-full max-w-full object-contain p-0.5"
        />
      ) : (
        initialsOf(name)
      )}
    </span>
  );
}
