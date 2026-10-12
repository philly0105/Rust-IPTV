import { useState } from 'react';

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

/** Channel logo with a lettered fallback; logos sit on a neutral plate so transparent PNGs read in both themes. */
export function ChannelLogo({ src, name, size = 36 }: { src?: string; name: string; size?: number }) {
  // Keyed by address: virtual rows are reused for other channels, and one broken logo must not
  // stick to the slot and hide the next channel's good one.
  const [failedSrc, setFailedSrc] = useState<string | undefined>(undefined);
  const failed = !!src && failedSrc === src;
  const style = { width: size, height: size };
  if (!src || failed) {
    return (
      <span
        aria-hidden
        style={style}
        className="inline-flex shrink-0 items-center justify-center rounded-md bg-surface-3 text-[11px] font-semibold text-fg-muted"
      >
        {initials(name)}
      </span>
    );
  }
  return (
    <span aria-hidden style={style} className="inline-flex shrink-0 items-center justify-center overflow-hidden rounded-md bg-surface-2">
      <img
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
        onError={() => setFailedSrc(src)}
        className="max-h-full max-w-full object-contain p-0.5"
      />
    </span>
  );
}
