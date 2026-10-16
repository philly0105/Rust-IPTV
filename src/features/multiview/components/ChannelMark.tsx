import { cn, initialsOf, useImageChain } from '../deps';

/**
 * A channel's logo on a plate (transparent PNGs read on any frame), or its initials when it
 * has none or the image fails. Decorative: the channel's name is always spelled out beside it.
 * Remote logos load through the image cache, then the original URL once, before the initials
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
        showImage ? 'bg-surface-2' : 'bg-surface-3 text-fg-muted',
        className,
      )}
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
        initialsOf(name)
      )}
    </span>
  );
}
