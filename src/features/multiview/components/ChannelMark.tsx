import { monogramFill, monogramText } from '@/features/live/lib/monogram';

import { cn, useImageChain } from '../deps';

/**
 * A channel's logo on a plate (transparent PNGs read on any frame), or its coloured monogram when
 * it has none or the image fails: the same tile as in Live and the guide (LG-14). Decorative: the channel's name is always spelled out beside it.
 * Remote logos load through the image cache, then the original URL once and the cache again, before the initials
 * show (C3). Pass `sourceId` so the cache applies that source's network rules.
 */
export function ChannelMark({ src, name, sourceId, className }: { src?: string; name: string; sourceId?: string; className?: string }) {
  // Keyed by address: a replaced tile must not inherit the old channel's broken-image state.
  const image = useImageChain([src], sourceId);
  const showImage = !!image.url;
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-sm font-display text-[0.6875rem] font-semibold tracking-wide',
        // Fixed plates, not theme surfaces: the wall is dark in every theme.
        showImage ? 'bg-[#161d2a] ring-1 ring-white/6 ring-inset' : 'text-white',
        className,
      )}
      style={showImage ? undefined : { background: monogramFill(name) }}
    >
      {showImage ? (
        <img
          key={image.url}
          src={image.url}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={image.onError}
          className="max-h-full max-w-full object-contain p-0.5"
        />
      ) : (
        monogramText(name)
      )}
    </span>
  );
}
