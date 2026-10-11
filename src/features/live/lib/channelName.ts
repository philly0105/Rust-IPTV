/**
 * Country / group tag stripping for channel names (`settings.stripCountryPrefix`), ported from
 * the old app's `strip-country-prefix.util.ts` plus `[XX] ` bracket tags.
 *
 * Pipes always separate a tag ("US | CNN", "FR|TF1", "|DE| ARD"). Dashes and colons only count
 * when the prefix looks like a short tag, since they appear inside real names ("Sky - Sports F1",
 * "NCIS: LA", "DUNE - Part Two"): a 2-3 char code ("UK", "4K") or a compound ("4K-DE", "AR-SUBS")
 * before a dash, a 2-3 char code before a colon. Every tag needs a letter, so "1917 - ..." stays.
 * When stripping would leave nothing, the trimmed name is returned.
 */
const DASH_SEPARATORS = [' - ', '- ', ' -'];
const COLON_SEPARATOR = ': ';
const TAG_SEPARATORS = [...DASH_SEPARATORS, COLON_SEPARATOR];
const TAG_PREFIX_PATTERN =
  /^(?:(?=[0-9+]*[A-Z])[A-Z0-9+]{2,5}(?:-(?=[0-9+]*[A-Z])[A-Z0-9+]{2,6}){1,2}|(?=[0-9+]*[A-Z])[A-Z0-9+]{2,3})$/;
const COLON_TAG_PATTERN = /^(?=[0-9+]*[A-Z])[A-Z0-9+]{2,3}$/;
const BRACKET_TAG_PATTERN = /^\[(?=[0-9+]*[A-Z])[A-Z0-9+-]{2,8}\]\s*/;

function findTagSeparator(name: string): { index: number; length: number } | null {
  let best: { index: number; length: number } | null = null;
  const pipe = name.indexOf('|');
  if (pipe !== -1) best = { index: pipe, length: 1 };
  for (const sep of TAG_SEPARATORS) {
    const index = name.indexOf(sep);
    if (index === -1 || (best && best.index <= index)) continue;
    const pattern = sep === COLON_SEPARATOR ? COLON_TAG_PATTERN : TAG_PREFIX_PATTERN;
    if (!pattern.test(name.slice(0, index).trim())) continue;
    best = { index, length: sep.length };
  }
  return best;
}

export function stripCountryPrefix(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return trimmed;

  const bracket = BRACKET_TAG_PATTERN.exec(trimmed);
  if (bracket) {
    const rest = trimmed.slice(bracket[0].length).trim();
    return rest ? rest : trimmed;
  }

  const match = findTagSeparator(trimmed);
  if (!match) return trimmed;
  const prefix = trimmed.slice(0, match.index).trim();
  const stripped = trimmed.slice(match.index + match.length).trim();
  if (!stripped) return trimmed;
  // A leading separator ("|DE| ARD") strips nothing by itself: retry on the remainder.
  return prefix ? stripped : stripCountryPrefix(stripped);
}

/** Display name for a channel under the current setting. */
export function displayChannelName(name: string | null | undefined, strip: boolean | undefined): string {
  const raw = name ?? '';
  return strip ? stripCountryPrefix(raw) : raw;
}
