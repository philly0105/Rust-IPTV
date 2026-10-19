import type { EpgLinks } from '@/api/types';

import { checkHttpUrl } from './validate';

export interface EpgLinkRow {
  url: string;
  origin: 'detected' | 'manual';
  enabled: boolean;
}

/** One row per distinct URL, detected first, in stored order. */
export function epgRows(links: EpgLinks): EpgLinkRow[] {
  const disabled = new Set(links.disabledUrls);
  const seen = new Set<string>();
  const rows: EpgLinkRow[] = [];
  for (const url of links.detectedUrls) {
    if (seen.has(url)) continue;
    seen.add(url);
    rows.push({ url, origin: 'detected', enabled: !disabled.has(url) });
  }
  for (const url of links.manualUrls) {
    if (seen.has(url)) continue;
    seen.add(url);
    rows.push({ url, origin: 'manual', enabled: !disabled.has(url) });
  }
  return rows;
}

export type AddEpgResult = { ok: true; links: EpgLinks } | { ok: false; error: string };

export function addManualEpgUrl(links: EpgLinks, raw: string): AddEpgResult {
  const r = checkHttpUrl(raw);
  if (!r.ok) return { ok: false, error: r.error };
  if (links.detectedUrls.includes(r.url) || links.manualUrls.includes(r.url)) return { ok: false, error: 'errorEpgDuplicate' };
  return { ok: true, links: { ...links, manualUrls: [...links.manualUrls, r.url] } };
}

export function removeManualEpgUrl(links: EpgLinks, url: string): EpgLinks {
  return {
    ...links,
    manualUrls: links.manualUrls.filter((u) => u !== url),
    disabledUrls: links.disabledUrls.filter((u) => u !== url),
  };
}

export function setEpgUrlEnabled(links: EpgLinks, url: string, enabled: boolean): EpgLinks {
  const rest = links.disabledUrls.filter((u) => u !== url);
  return { ...links, disabledUrls: enabled ? rest : [...rest, url] };
}

/** Partial patch for `sources.update` (`patch.epg`) or undefined when unchanged. */
export function epgPatch(before: EpgLinks, after: EpgLinks): Partial<EpgLinks> | undefined {
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);
  const out: Partial<EpgLinks> = {};
  if (!same(before.manualUrls, after.manualUrls)) out.manualUrls = after.manualUrls;
  if (!same(before.disabledUrls, after.disabledUrls)) out.disabledUrls = after.disabledUrls;
  // The core stores no shift for 0, so 0 is how a patch removes it.
  if ((before.shiftMinutes ?? 0) !== (after.shiftMinutes ?? 0)) out.shiftMinutes = after.shiftMinutes ?? 0;
  return Object.keys(out).length > 0 ? out : undefined;
}
