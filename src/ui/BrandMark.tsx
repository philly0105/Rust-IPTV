import { useId, type SVGProps } from 'react';

export interface BrandMarkProps extends Omit<SVGProps<SVGSVGElement>, 'children' | 'width' | 'height' | 'viewBox' | 'title'> {
  /** Width and height: px as a number, or any CSS length. Default 32. */
  size?: number | string;
  /**
   * `color` (default) is the app icon: the amber dial on its ink-navy tile, the same in every
   * theme. `mono` is the glyph alone in currentColor, for small marks on any surface.
   */
  variant?: 'color' | 'mono';
  /** Accessible name. Without one the mark is decorative and hidden from assistive tech. */
  title?: string;
}

/**
 * The Tsrust IPTV mark, drawn inline so it needs no request and scales cleanly. The artwork is
 * docs/brand/mark.svg (color) and docs/brand/mark-mono.svg (mono); every app, installer and web
 * icon is rendered from those files, so change them together (docs/brand/README.md).
 */
export function BrandMark({ size = 32, variant = 'color', title, ...rest }: BrandMarkProps) {
  // Gradient and filter ids must be unique per instance: two marks on one page would otherwise
  // share the first one's defs, and lose them when that one unmounts or is display:none.
  const uid = useId().replace(/[^\w-]/g, '');
  const id = (name: string) => `${uid}-${name}`;
  const url = (name: string) => `url(#${id(name)})`;
  const a11y = title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true as const };

  if (variant === 'mono') {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="10 8 44 44"
        fill="none"
        stroke="currentColor"
        {...a11y}
        {...rest}
      >
        <rect x="14" y="18" width="36" height="24" rx="5" strokeWidth="4" />
        <path d="M18 35h28M18 35v-4m4 4v-2m4 2v-4m4 4v-2m8 2v-2m4 2v-4m4 4v-2" strokeOpacity=".5" strokeWidth="1.5" strokeLinecap="round" />
        <rect x="32" y="22" width="4" height="16" rx="2" fill="currentColor" stroke="none" />
      </svg>
    );
  }

  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 64 64" {...a11y} {...rest}>
      <defs>
        <linearGradient id={id('tile')} x1="0" y1="0" x2="0" y2="64" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#1d283b" />
          <stop offset=".5" stopColor="#111827" />
          <stop offset="1" stopColor="#0a0e17" />
        </linearGradient>
        <radialGradient id={id('backlight')} cx="34" cy="30" r="26" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#f5b544" stopOpacity=".2" />
          <stop offset="1" stopColor="#f5b544" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={id('rim')} x1="0" y1="0" x2="0" y2="64" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#fff" stopOpacity=".2" />
          <stop offset=".3" stopColor="#fff" stopOpacity=".05" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={id('frame')} x1="0" y1="16" x2="0" y2="44" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffc964" />
          <stop offset="1" stopColor="#e3972a" />
        </linearGradient>
        <linearGradient id={id('needle')} x1="0" y1="22.5" x2="0" y2="37.5" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#fff4da" />
          <stop offset=".5" stopColor="#ffd27a" />
          <stop offset="1" stopColor="#f5b544" />
        </linearGradient>
        <radialGradient id={id('glow')} cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(34 30) scale(6.5 13)">
          <stop offset="0" stopColor="#ffc55a" stopOpacity=".6" />
          <stop offset="1" stopColor="#ffc55a" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={id('sheen')} x1="0" y1="20" x2="0" y2="40" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#fff" stopOpacity=".08" />
          <stop offset=".45" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <filter id={id('lift')} x="-20%" y="-20%" width="140%" height="160%">
          <feGaussianBlur stdDeviation="1.6" />
        </filter>
      </defs>
      <rect width="64" height="64" rx="14" fill={url('tile')} />
      <rect width="64" height="64" rx="14" fill={url('backlight')} />
      <rect x=".5" y=".5" width="63" height="63" rx="13.5" fill="none" stroke={url('rim')} />
      <rect x="14" y="20" width="36" height="24" rx="5" fill="none" stroke="#000" strokeOpacity=".45" strokeWidth="4" filter={url('lift')} />
      <rect x="14" y="18" width="36" height="24" rx="5" fill="#05080e" fillOpacity=".6" stroke={url('frame')} strokeWidth="4" />
      <rect x="16" y="20" width="32" height="20" rx="3" fill={url('sheen')} />
      <path d="M18 35h28" fill="none" stroke="#f5b544" strokeOpacity=".45" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M18 35v-4m4 4v-2m4 2v-4m4 4v-2m8 2v-2m4 2v-4m4 4v-2" fill="none" stroke="#f5b544" strokeOpacity=".55" strokeWidth="1.2" strokeLinecap="round" />
      <ellipse cx="34" cy="30" rx="6.5" ry="13" fill={url('glow')} />
      <rect x="32.25" y="22.5" width="3.5" height="15" rx="1.75" fill={url('needle')} />
    </svg>
  );
}
