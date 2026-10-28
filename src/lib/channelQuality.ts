/**
 * The picture quality a channel's name gives ("ESPN HD", "4K | Sky Cinema", "BBC One Full HD"): a port of
 * the core's `live::matcher::quality`, which the Live TV quality filter stores per channel, so a quality
 * shown in the UI is the one the filter goes by. Except for a renamed channel: the core reads the provider's
 * name, and `Channel.name` carries the rename. The name's country or group tag counts too ("4K-DE - Das
 * Erste"). A leaf module.
 */

import type { ChannelQuality } from '@/api/types';

import { splitCountryTag } from './channelName';

const ORDER: Record<ChannelQuality, number> = { sd: 1, hd: 2, fhd: 3, uhd: 4 };

const MARKERS = new Map<string, ChannelQuality>([
  ...['sd', 'lq', '480p', '576p', '576i', '480i'].map((w) => [w, 'sd'] as const),
  ...['hd', 'hd+', 'hq', '720p', '720', 'ʜᴅ', 'ᴴᴰ', 'ʰᵈ'].map((w) => [w, 'hd'] as const),
  ...['fhd', 'fullhd', '1080p', '1080i', '1080', 'ꜰʜᴅ', 'ᶠᴴᴰ'].map((w) => [w, 'fhd'] as const),
  ...['uhd', '4k', '8k', '2160p', '4320p', 'uhd4k', 'ᵁᴴᴰ', 'ᴜʜᴅ'].map((w) => [w, 'uhd'] as const),
]);

/** The core's accent folding (`fold`): the Latin letters FTS5's tokenizer folds, and nothing else. */
const FOLD: Record<string, string> = {};
for (const [to, from] of Object.entries({
  a: 'àáâãäåāăą', c: 'çćč', d: 'ďđ', e: 'èéêëēėęě', g: 'ğ', i: 'ìíîïīıį', l: 'łľ', n: 'ñńň', o: 'òóôõöøōő', r: 'ř',
  s: 'śšşș', t: 'ťţț', u: 'ùúûüūůűų', y: 'ýÿ', z: 'źżž', ss: 'ß', ae: 'æ', oe: 'œ',
})) {
  for (const c of from) FOLD[c] = to;
}
const FOLDED = new RegExp(`[${Object.keys(FOLD).join('')}]`, 'g');

/** Words as the core splits them: letters, digits and `+`; a lone `+` joins the word before ("HD +" is "hd+"). */
function words(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().replace(FOLDED, (c) => FOLD[c]!).split(/[^\p{Alphabetic}\p{N}+]+/u)) {
    if (!raw) continue;
    if (/^\++$/.test(raw)) {
      if (out.length > 0) out[out.length - 1] += raw;
    } else out.push(raw);
  }
  return out;
}

function higher(a: ChannelQuality | null, b: ChannelQuality | null | undefined): ChannelQuality | null {
  return b && (!a || ORDER[b] > ORDER[a]) ? b : a;
}

/**
 * The highest marker among the words; an HD marker right after "full" is Full HD, after "ultra" 4K. "8K
 * EXCLUSIVE" is no marker: a provider's brand on every one of its event channels, placeholders included.
 */
function wordsQuality(text: string): ChannelQuality | null {
  let best: ChannelQuality | null = null;
  let lead: ChannelQuality | null = null;
  // An "8K" waits for the next word, which may make it the brand.
  let eightK = false;
  for (const w of words(text)) {
    if (eightK && w !== 'exclusive') best = higher(best, 'uhd');
    eightK = w === '8k';
    const q = eightK ? undefined : MARKERS.get(w);
    best = higher(best, q);
    if (q === 'hd') best = higher(best, lead);
    lead = w === 'full' ? 'fhd' : w === 'ultra' ? 'uhd' : null;
  }
  return eightK ? higher(best, 'uhd') : best;
}

/** The highest quality marker in a channel name, its country or group tag included; null when it names none. */
export function channelQuality(name: string): ChannelQuality | null {
  const { name: rest, tag } = splitCountryTag(name);
  return higher(wordsQuality(rest), tag === undefined ? null : wordsQuality(tag));
}

/** 1 for SD up to 4 for 4K, so qualities compare. */
export function qualityOrder(q: ChannelQuality): number {
  return ORDER[q];
}
