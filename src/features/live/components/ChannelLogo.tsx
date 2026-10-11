import { useState } from 'react';

function initials(name: string): string {
  const words = name
    .replace(/^[A-Z]{2,3}\s*[:|-]\s*/, '')
    .split(/\s+/)
    .filter(Boolean);
  return (words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? '?').slice(0, 2)).toUpperCase();
}

/** Channel logo with a lettered fallback; logos sit on a neutral plate so transparent PNGs read in both themes. */
export function ChannelLogo({ src, name, size = 36 }: { src?: string; name: string; size?: number }) {
  const [failed, setFailed] = useState(false);
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
        onError={() => setFailed(true)}
        className="max-h-full max-w-full object-contain p-0.5"
      />
    </span>
  );
}
