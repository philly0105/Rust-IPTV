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

/** A per-game channel's league and slot before its matchup ("NFL 03: ", "NBA | 05 - "). */
const SLOT_TAG = /^[A-Z]{2,5}\s*[|:-]?\s*\d{1,3}\s*[:|-]\s*/;
/** The word between the two teams of a matchup. */
const MATCHUP = /\s+(?:vs\.?|v\.?|versus|at|@|x)\s+/i;
/** A slot number or a kickoff time ("03", "1pm", "8:20pm"), never a team's initial. */
const NOT_A_NAME = /^\d+(?::\d+)?(?:am|pm)?$/i;

/** The first letter of the first word of a matchup side that names something. */
function sideInitial(side: string): string | undefined {
  const word = initialWords(side).find((w) => !NOT_A_NAME.test(w));
  return word === undefined ? undefined : Array.from(word)[0];
}

/**
 * Two letters ("UK: BBC One HD" -> "BO", "US| ESPN ᴴᴰ" -> "ES", "US| CBS (Backup)" -> "CB"): no
 * country tag, no quality or copy markers, and whole code points, so an emoji or astral-plane letter
 * never splits into half a surrogate pair. A per-game channel takes one letter of each team ("NFL 03:
 * Cleveland Browns vs Tennessee Titans" -> "CT"), so a provider's slots don't all read "N0".
 */
export function monogramText(name: string): string {
  const untagged = name.trim().replace(/^[A-Z]{2,3}\s*[:|-]\s*/, '');
  const game = untagged.replace(SLOT_TAG, '');
  // The first separator splits the teams; a later one ("@ 1:00 PM ET") belongs to the second side.
  const split = MATCHUP.exec(game);
  if (split) {
    const away = sideInitial(game.slice(0, split.index));
    const home = sideInitial(game.slice(split.index + split[0].length));
    if (away && home) return (away + home).toUpperCase();
  }
  return twoInitials(initialWords(untagged || name));
}
