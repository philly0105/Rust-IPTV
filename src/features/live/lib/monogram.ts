import { initialWords, isNameMarker, twoInitials } from '@/ui/Poster';
import { tintFill, tintOf } from '@/ui/tint';

import { channelNameParts } from '@/lib/channelName';

/**
 * A channel's monogram (LG-14): two letters on its name's tint (src/ui/tint.ts), the one every
 * fallback tile uses, so the same name gets the same colour everywhere: the list, the guide, the
 * stage, the archive, multi-view, and Home and Favorites, which draw the kit's poster tile.
 */

/** The HSL hue of the monogram's colour, for the idle stage's glow (written in hsl()). */
export function monogramHue(name: string): number {
  return tintOf(name).hslHue;
}

/** The monogram's deep fill, for white letters: the player and multi-view, over video, use it in every theme. */
export function monogramFill(name: string): string {
  return tintFill(name);
}

/** A per-game channel's league and slot before its matchup ("NFL 03: ", "NBA | 05 - "). */
const SLOT_TAG = /^[A-Z]{2,5}\s*[|:-]?\s*\d{1,3}\s*[:|-]\s*/;
/** The word between the two teams of a matchup. */
const MATCHUP = /\s+(?:vs\.?|v\.?|versus|at|@|x)\s+/i;
/** A slot number, a kickoff time or its zone ("03", "1pm", "8:20", "PM", "ET"), never a team's initial. */
const NOT_A_NAME = /^(?:\d+(?::\d+)?(?:am|pm)?|am|pm|et|pt|ct|mt|est|edt|pst|pdt|cst|cdt|gmt|utc)$/i;
/** Emoji, flags and symbols before a name ("⚽ ESPNU", "🇬🇧 ANTENA 3"): decoration, never an initial. */
const LEADING_SYMBOLS = /^[\p{Extended_Pictographic}\p{S}\p{M}\u200D\s]+/u;
/**
 * What a provider puts before the name: a country tag, with its language ("UK: ", "CA EN: ") or an
 * event slot ("US (ESPN+ 002) | "), or a longer capital word before a colon or pipe, an event's
 * state or a service ("NEXT | ", "PRIME: "). Taken from the name, they gave whole groups the same
 * letters: "CE" on every Canadian row, "PP", "PF", "PB" down a 1,001-row group.
 */
const LEAD_TAG = /^(?:[A-Z]{2,3}(?: [A-Z]{2})?\s*(?:\([^)]*\))?\s*[:|-]|[A-Z][A-Z0-9+]{3,7}\s*[:|])\s*/;

/**
 * An empty event slot ("- NO EVENT STREAMING - | 8K EXCLUSIVE | US: ESPN+ PPV 2", ":NCAAB  01",
 * "MLB 05 :"): its number ('' when it has none), or null for a channel. Its tile shows the number
 * on a neutral plate: letters of "NO EVENT" on every empty slot named nothing.
 */
export function slotNumber(name: string): string | null {
  const trimmed = name.trim();
  if (!/^[-\s]*NO EVENT\b/i.test(trimmed) && !/^:\s*[A-Z]{2,6}\s+\d{1,3}$|^[A-Z]{2,6}\s+\d{1,3}\s*:$/.test(trimmed)) return null;
  return /(\d{1,3})\s*:?$/.exec(trimmed)?.[1] ?? '';
}

/** The first letter of the first word of a matchup side that names something, past markers ("HD", "4K"). */
function sideInitial(side: string): string | undefined {
  const word = initialWords(side).find((w) => !NOT_A_NAME.test(w) && !isNameMarker(w));
  return word === undefined ? undefined : Array.from(word)[0];
}

/**
 * Two letters ("UK: BBC One HD" -> "BO", "US| ESPN ᴴᴰ" -> "ES", "US| CBS (Backup)" -> "CB"): no
 * country tag or other lead (`LEAD_TAG`), no leading emoji, no quality or copy markers, and whole
 * code points, so an astral-plane letter never splits into half a surrogate pair. A per-game channel
 * takes one letter of each team ("NFL 03: Cleveland Browns vs Tennessee Titans" -> "CT"), so a
 * provider's slots don't all read "N0"; an empty slot shows its number (`slotNumber`).
 */
export function monogramText(name: string): string {
  const slot = slotNumber(name);
  if (slot !== null) return slot || '–';
  let untagged = name.trim();
  for (let i = 0; i < 3; i++) {
    const next = untagged.replace(LEADING_SYMBOLS, '').replace(LEAD_TAG, '');
    if (next === untagged) break;
    untagged = next;
  }
  const game = untagged.replace(SLOT_TAG, '');
  // The first separator splits the teams; a later one ("@ 1:00 PM ET") belongs to the second side.
  const split = MATCHUP.exec(game);
  if (split) {
    const away = sideInitial(game.slice(0, split.index));
    const home = sideInitial(game.slice(split.index + split[0].length));
    if (away && home) return (away + home).toUpperCase();
  }
  // The station without its feed's quality and copy words ("PBS HD (BACKUP 2)" -> "PBS"), so a
  // backup's number never becomes a letter: its tile reads "PB" like the station's other feeds.
  const station = untagged ? channelNameParts(untagged, false).name : '';
  return twoInitials(initialWords(station || untagged || name));
}
