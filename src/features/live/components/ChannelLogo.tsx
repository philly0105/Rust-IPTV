import { useImageChain } from '@/ui';

function initials(name: string): string {
  const words = name
    .replace(/^[A-Z]{2,3}\s*[:|-]\s*/, '')
    .split(/\s+/)
    .filter(Boolean);
  // Code points, not UTF-16 units: an emoji or astral-plane letter must not split into half a surrogate pair.
  const first = Array.from(words[0] ?? '?');
  const second = Array.from(words[1] ?? '');
  return (second.length > 0 ? `${first[0]}${second[0]}` : first.slice(0, 2).join('')).toUpperCase();
}

/**
 * Channel logo with a lettered fallback; logos sit on a neutral plate so transparent PNGs read in both themes.
 * Remote logos load through the image cache; when the cache route errors the original URL is tried once
 * before the letters show (C3). Pass `sourceId` so the cache applies that source's network rules.
 */
export function ChannelLogo({ src, name, size = 36, sourceId }: { src?: string; name: string; size?: number; sourceId?: string }) {
  // The chain is keyed by address: virtual rows are reused for other channels, and one broken logo must not
  // stick to the slot and hide the next channel's good one.
  const image = useImageChain([src], sourceId);
  const style = { width: size, height: size };
  if (!image.url) {
    return (
      <span
        aria-hidden
        style={style}
        className="inline-flex shrink-0 items-center justify-center rounded-md bg-surface-3 text-[calc(11rem/15)] font-semibold text-fg-muted"
      >
        {initials(name)}
      </span>
    );
  }
  return (
    <span aria-hidden style={style} className="inline-flex shrink-0 items-center justify-center overflow-hidden rounded-md bg-surface-2">
      <img
        key={image.url}
        src={image.url}
        alt=""
        loading="lazy"
        decoding="async"
        // Low priority: a screen of logos must not hold the guide's RPCs behind it on the connection pool.
        fetchPriority="low"
        draggable={false}
        onError={image.onError}
        className="max-h-full max-w-full object-contain p-0.5"
      />
    </span>
  );
}
