import { hueOf, initialWords, twoInitials } from '@/ui/Poster';

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

/**
 * Two letters ("UK: BBC One HD" -> "BO", "US| ESPN ᴴᴰ" -> "ES", "US| CBS (Backup)" -> "CB"): no
 * country tag, no quality or copy markers, and whole code points, so an emoji or astral-plane letter
 * never splits into half a surrogate pair.
 */
export function monogramText(name: string): string {
  const untagged = name.trim().replace(/^[A-Z]{2,3}\s*[:|-]\s*/, '');
  return twoInitials(initialWords(untagged || name));
}
