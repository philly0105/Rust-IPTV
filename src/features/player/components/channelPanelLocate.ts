import type { Channel, ItemRef } from '@/api/types';

/** The most pages `locateChannel` asks for: a binary search over 50k channels in pages of 100 needs 9. */
export const MAX_LOCATE_PROBES = 12;

export interface LocatedChannel {
  /** Its index in the whole list. */
  index: number;
  /** The page that holds it, as fetched (the panel keeps it, so the row draws at once). */
  page: number;
  items: Channel[];
  total: number;
}

/**
 * Finds a channel's place in a list ordered by channel number (numberless channels last, as the
 * catalog sorts `number`), asking for as few pages as it can: first the page its number would
 * be on if the list were numbered 1, 2, 3 (a whole source usually is, so one page), then a
 * binary search on the numbers. Null when it is not in the list or has no number to look for.
 */
export async function locateChannel(
  fetchPage: (page: number) => Promise<{ items: Channel[]; total: number }>,
  ref: ItemRef,
  number: number | undefined,
  pageSize: number,
): Promise<LocatedChannel | null> {
  const same = (c: Channel): boolean => c.ref.itemId === ref.itemId && c.ref.sourceId === ref.sourceId;
  const seen = new Set<number>();
  let lo = 0;
  let hi = Number.POSITIVE_INFINITY;
  let p = number !== undefined && number > 0 ? Math.floor((number - 1) / pageSize) : 0;
  for (let probe = 0; probe < MAX_LOCATE_PROBES && p >= lo && p <= hi && !seen.has(p); probe++) {
    seen.add(p);
    const res = await fetchPage(p);
    hi = Math.min(hi, Math.max(0, Math.ceil(res.total / pageSize) - 1));
    const at = res.items.findIndex(same);
    if (at >= 0) return { index: p * pageSize + at, page: p, items: res.items, total: res.total };
    const head = res.items[0];
    const tail = res.items[res.items.length - 1];
    if (!head || !tail) {
      // Past the end (a guess from the number in a shorter list): search what is there.
      hi = Math.min(hi, p - 1);
      p = Math.floor((lo + hi) / 2);
      continue;
    }
    if (number === undefined) return null;
    const first = head.number ?? Number.POSITIVE_INFINITY;
    const last = tail.number ?? Number.POSITIVE_INFINITY;
    if (number < first) hi = p - 1;
    else if (number > last) lo = p + 1;
    // Its number is on this page but another channel has it: equal numbers can spill over an edge.
    else if (number === first && !seen.has(p - 1)) {
      p -= 1;
      continue;
    } else if (number === last && !seen.has(p + 1)) {
      p += 1;
      continue;
    } else return null;
    p = Math.floor((lo + hi) / 2);
  }
  return null;
}
