/**
 * The core's `title_base` (`crates/iptv-core/src/catalog/title.rs`), ported rule for rule; keep
 * both in step. Catalog items carry the core's result as `titleBase`. Rows that hold only a saved
 * provider title (continue-watching, recent and My List snapshots written before the player stored
 * the base title) are cleaned at display time with this, so they read like the detail page:
 * "EN - The Matrix (1999) [4K]" becomes "The Matrix", and the year comes back separately.
 */

import type { ItemRef } from '@/api/types';

/** Two/three-letter codes accepted before a colon (`EN: Title`); arbitrary capitals are too risky (`CSI: Miami`). */
const COLON_PREFIX_CODES = new Set(
  'AL AR AT AU BE BG BR CA CH CN CZ DE DK EN ES EX FI FR GR HR HU IE IL IN IR IT JP KR KU LAT MX NL NO PK PL PT RO RS RU SE SI SK SQ TR UA UK US VOD VOSE 4K'.split(' '),
);
/** `|EN|`, `[EN]`, `(EN)` prefix tags (short, no spaces inside). */
const BRACKET_PREFIX = /^\s*(?:\|[^|\s]{1,8}\||\[[^\]\s]{1,8}\]|\([A-Za-z]{2,3}\))\s*[-:|]?\s*/;
/** `EN - Title`, `EN-US - Title`, `EN | Title`, `4K-EN - Title`. */
const DASH_PREFIX = /^\s*[A-Z0-9]{1,3}[A-Z](?:[-_][A-Z]{2,4})?\s*(?:\s-|\|)\s+/;
/** `EN: Title` (code checked against COLON_PREFIX_CODES). */
const COLON_PREFIX = /^\s*([A-Z0-9]{2,4})\s*:\s+/;
/** `(2019)` or `[2019]` anywhere. */
const PAREN_YEAR = /[([]\s*((?:19|20)\d{2})\s*[)\]]/;
/** `Title - 2019` at the end. */
const DASH_YEAR = /\s[-–]\s*((?:19|20)\d{2})\s*$/;
/** Any bracketed tag, after the year has been taken: `[4K]`, `[MULTI-SUB]`. */
const BRACKET_TAG = /\[[^\]]*\]/g;
const QUALITY = '4k|uhd|fhd|hd|sd|hdr|hdr10|1080p|720p|2160p|480p|hevc|x26[45]|h\\.?26[45]|multi(?:[- ]?sub)?|vostfr|vost';
/** Parenthesised quality and language tags: `(4K)`, `(VOSTFR)`, `(Dual Audio)`. */
const PAREN_TAG = new RegExp(`\\(\\s*(?:${QUALITY}|dv|vf|vo|dual(?: audio)?|sub(?:bed|s)?|dubbed|extended|remastered|imax|3d)\\s*\\)`, 'gi');
/** Trailing quality tokens, repeated: `Title FHD`, `Title 1080p HEVC`. */
const TRAILING_QUALITY = new RegExp(`[\\s._|-]+(?:${QUALITY}|dual|imax|3d)\\s*$`, 'i');
const EDGES = /^[\s\-–:|_.,]+|[\s\-–:|_.,]+$/g;

/** A release year from 1900 to two years ahead, as the core accepts. */
function plausibleYear(s: string | undefined): number | undefined {
  const y = Number(s);
  return Number.isInteger(y) && y >= 1900 && y <= new Date().getFullYear() + 2 ? y : undefined;
}

/**
 * Strips language prefixes, quality tags and the year from a provider title, and returns the year
 * when one was found. A title that would strip to nothing comes back trimmed.
 */
export function baseTitle(title: string): { title: string; year?: number } {
  const original = title.trim();
  let s = original;
  let year: number | undefined;

  // Prefixes may stack: "|EN| 4K - Title".
  for (let i = 0; i < 3; i++) {
    const before = s.length;
    const bracket = BRACKET_PREFIX.exec(s);
    if (bracket && bracket[0].length < s.length) s = s.slice(bracket[0].length);
    const dash = DASH_PREFIX.exec(s);
    if (dash && dash[0].length < s.length) s = s.slice(dash[0].length);
    const colon = COLON_PREFIX.exec(s);
    if (colon && COLON_PREFIX_CODES.has(colon[1] ?? '') && colon[0].length < s.length) s = s.slice(colon[0].length);
    if (s.length === before) break;
  }

  const paren = PAREN_YEAR.exec(s);
  const parenYear = paren ? plausibleYear(paren[1]) : undefined;
  if (paren && parenYear !== undefined) {
    year = parenYear;
    s = `${s.slice(0, paren.index)} ${s.slice(paren.index + paren[0].length)}`;
  } else {
    const dash = DASH_YEAR.exec(s);
    const dashYear = dash ? plausibleYear(dash[1]) : undefined;
    if (dash && dashYear !== undefined) {
      year = dashYear;
      s = s.slice(0, dash.index);
    }
  }

  s = s.replace(BRACKET_TAG, ' ').replace(PAREN_TAG, ' ');
  for (;;) {
    const next = s.replace(TRAILING_QUALITY, '');
    if (next.length === s.length || next.trim() === '') break;
    s = next;
  }

  s = s.replace(/\s+/g, ' ').replace(EDGES, '');
  return { title: s || original, ...(year !== undefined ? { year } : {}) };
}

/**
 * A saved snapshot title as lists show it: the base title (and the year it carried) for movies and
 * series; channels and everything else unchanged, as in the core, where a channel's "US: News"
 * prefix is part of its name.
 */
export function snapshotTitle(ref: Pick<ItemRef, 'contentType'>, title: string): { title: string; year?: number } {
  return ref.contentType === 'movie' || ref.contentType === 'series' ? baseTitle(title) : { title };
}
