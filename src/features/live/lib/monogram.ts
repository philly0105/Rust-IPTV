import { hueOf } from '@/ui/Poster';

/**
 * A channel's monogram (LG-14): two letters on a two-stop fill from its name, one of eight hues
 * spread round the colour wheel and dark enough for white letters (the source monograms in the
 * rail use the same recipe). The same name gets the same tile everywhere: the list, the guide,
 * the stage, the archive and multi-view.
 */
export function monogramHue(name: string): number {
  return (hueOf(name) % 8) * 45 + 12;
}

export function monogramFill(name: string): string {
  const hue = monogramHue(name);
  return `linear-gradient(150deg, hsl(${hue} 40% 34%), hsl(${(hue + 30) % 360} 46% 22%))`;
}

/** Two letters ("UK: BBC One HD" -> "BO"): no country tag, and whole code points. */
export function monogramText(name: string): string {
  const words = name
    .replace(/^[A-Z]{2,3}\s*[:|-]\s*/, '')
    .split(/\s+/)
    .filter(Boolean);
  // Code points, not UTF-16 units: an emoji or astral-plane letter must not split into half a surrogate pair.
  const first = Array.from(words[0] ?? '?');
  const second = Array.from(words[1] ?? '');
  return (second.length > 0 ? `${first[0]}${second[0]}` : first.slice(0, 2).join('')).toUpperCase();
}
