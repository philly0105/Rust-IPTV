/**
 * Language of a provider VOD title.
 *
 * Xtream panels tag each movie with a language prefix ("EN - Interstellar (2014)",
 * "|FR| ...", "LAT - ...") and usually also put a code in the category name
 * ("VOD - SPAIN [ES]"). `titleBase` strips that prefix for matching and captions, so
 * the language is read back from the raw title here, with the category as the fallback
 * for prefixes that name a service or a quality instead ("NF - ", "4K - ", "D+ - ").
 */

export interface ItemLanguage {
  /** Short tag for a badge, as the provider wrote it ("EN", "LAT", "TG"). */
  code: string;
  /** BCP 47 tag for `Intl.DisplayNames` when the code maps to one language. */
  tag?: string;
  /** i18n key suffix (`vod:languageGroup_<group>`) when the code names a group, not one language. */
  group?: LanguageGroup;
}

export type LanguageGroup = 'multisub' | 'scandinavian' | 'african' | 'indian' | 'southIndian' | 'exYu';

type Entry = { tag: string } | { group: LanguageGroup };

/** Provider codes that are not ISO 639-1, or whose ISO reading would be wrong. */
const CODES: Record<string, Entry> = {
  EN: { tag: 'en' },
  ENG: { tag: 'en' },
  UK: { tag: 'en' },
  US: { tag: 'en' },
  FR: { tag: 'fr' },
  DE: { tag: 'de' },
  GER: { tag: 'de' },
  ES: { tag: 'es' },
  SP: { tag: 'es' },
  LA: { tag: 'es-419' },
  LAT: { tag: 'es-419' },
  LATINO: { tag: 'es-419' },
  IT: { tag: 'it' },
  NL: { tag: 'nl' },
  PL: { tag: 'pl' },
  RU: { tag: 'ru' },
  PT: { tag: 'pt' },
  BR: { tag: 'pt-BR' },
  AR: { tag: 'ar' },
  HU: { tag: 'hu' },
  RO: { tag: 'ro' },
  TR: { tag: 'tr' },
  FI: { tag: 'fi' },
  NO: { tag: 'no' },
  SE: { tag: 'sv' },
  SV: { tag: 'sv' },
  IS: { tag: 'is' },
  GR: { tag: 'el' },
  EL: { tag: 'el' },
  DK: { tag: 'da' },
  DA: { tag: 'da' },
  AL: { tag: 'sq' },
  ALB: { tag: 'sq' },
  BG: { tag: 'bg' },
  IR: { tag: 'fa' },
  FA: { tag: 'fa' },
  SOM: { tag: 'so' },
  SO: { tag: 'so' },
  PK: { tag: 'ur' },
  UR: { tag: 'ur' },
  PB: { tag: 'pa' },
  PA: { tag: 'pa' },
  TG: { tag: 'te' },
  TE: { tag: 'te' },
  TM: { tag: 'ta' },
  TA: { tag: 'ta' },
  KD: { tag: 'kn' },
  KN: { tag: 'kn' },
  MR: { tag: 'mr' },
  ML: { tag: 'ml' },
  HI: { tag: 'hi' },
  EX: { group: 'exYu' },
  EXYU: { group: 'exYu' },
  YU: { group: 'exYu' },
  HR: { tag: 'hr' },
  RS: { tag: 'sr' },
  SR: { tag: 'sr' },
  BA: { tag: 'bs' },
  CZ: { tag: 'cs' },
  CS: { tag: 'cs' },
  SK: { tag: 'sk' },
  UA: { tag: 'uk' },
  KU: { tag: 'ku' },
  KR: { tag: 'ko' },
  KO: { tag: 'ko' },
  JP: { tag: 'ja' },
  JA: { tag: 'ja' },
  CN: { tag: 'zh' },
  ZH: { tag: 'zh' },
  HE: { tag: 'he' },
  IL: { tag: 'he' },
  MULTISUB: { group: 'multisub' },
  MULTI: { group: 'multisub' },
  MU: { group: 'multisub' },
  SC: { group: 'scandinavian' },
  SCAND: { group: 'scandinavian' },
  AF: { group: 'african' },
  IN: { group: 'indian' },
  IND: { group: 'indian' },
  STH: { group: 'southIndian' },
};

/** Prefixes that name a service, a quality, or a list rather than a language. */
const NOT_LANGUAGE = new Set(['NF', 'D+', '4K', 'UHD', 'FHD', 'HD', 'SD', '3D', 'TOP', 'SPT', 'FBI', 'EM', 'VIP', 'NEW', 'KIDS', 'VOD', 'SRS']);

/** Keywords in a category name, for categories without a bracket code. */
const CATEGORY_WORDS: [RegExp, string][] = [
  [/\bENGLISH\b/i, 'EN'],
  [/\bFRENCH\b|\bFRAN[CÇ]AIS\b/i, 'FR'],
  [/\bGERMAN\b|\bDEUTSCH\b/i, 'DE'],
  [/\bSPANISH\b|\bESPA[NÑ]OL\b/i, 'ES'],
  [/\bLATINO\b/i, 'LAT'],
  [/\bITALIAN\b|\bITALIANO\b/i, 'IT'],
  [/\bPORTUGU/i, 'PT'],
  [/\bTURK/i, 'TR'],
  [/\bPAKISTAN/i, 'PK'],
  [/\bPUNJABI\b/i, 'PB'],
  [/\bSOMALI/i, 'SOM'],
  [/\bINDIA\b|\bHINDI\b|\bBOLLYWOOD\b/i, 'IN'],
  [/\bMULTI-?SUBS?\b/i, 'MULTISUB'],
  [/\bNORDIC\b/i, 'SC'],
];

const BIDI_MARKS = /[‎‏‪-‮⁦-⁩]/g;
/** "EN - ", "|EN| ", "[EN] ", "EN: ", "EN | " at the start of a title. */
const TITLE_PREFIX = /^\s*[[|(]?\s*([A-Za-z]{2,8}|D\+|4K|3D)\s*[\]|)]?\s*(?:[-:|–—]\s*|(?<=[\]|)])\s*)/;
/** "[ES]", "[EXYU]", "[MULTISUB]" anywhere in a category name. */
const CATEGORY_BRACKET = /\[([A-Za-z]{2,8})\]/;
const ARABIC_SCRIPT = /[؀-ۿ]/;

function resolve(code: string, categoryName: string | undefined): ItemLanguage | undefined {
  const upper = code.toUpperCase();
  // "MA" is Malayalam in Indian categories and Moroccan elsewhere.
  if (upper === 'MA') {
    return /\bINDIA\b/i.test(categoryName ?? '') ? { code: 'MA', tag: 'ml' } : { code: 'MA', tag: 'ar-MA' };
  }
  const entry = CODES[upper];
  if (!entry) return undefined;
  const short = upper === 'ENG' ? 'EN' : upper === 'MULTISUB' ? 'MULTI' : upper;
  return 'tag' in entry ? { code: short, tag: entry.tag } : { code: short, group: entry.group };
}

function fromCategory(categoryName: string | undefined): ItemLanguage | undefined {
  if (!categoryName) return undefined;
  const bracket = categoryName.match(CATEGORY_BRACKET);
  if (bracket?.[1]) {
    const hit = resolve(bracket[1], categoryName);
    if (hit) return hit;
  }
  // "FR - FILM 4K", "DE - FILME": the category itself carries the prefix.
  const prefix = categoryName.replace(BIDI_MARKS, '').match(TITLE_PREFIX)?.[1];
  if (prefix && !NOT_LANGUAGE.has(prefix.toUpperCase())) {
    const hit = resolve(prefix, categoryName);
    if (hit) return hit;
  }
  for (const [re, code] of CATEGORY_WORDS) {
    if (re.test(categoryName)) return resolve(code, categoryName);
  }
  if (ARABIC_SCRIPT.test(categoryName)) return resolve('AR', categoryName);
  return undefined;
}

/** Language of a movie or series from its raw provider title and category name, if either says. */
export function itemLanguage(title: string, categoryName?: string): ItemLanguage | undefined {
  const clean = title.replace(BIDI_MARKS, '');
  const m = clean.match(TITLE_PREFIX);
  const prefix = m?.[1];
  if (prefix && !NOT_LANGUAGE.has(prefix.toUpperCase())) {
    const hit = resolve(prefix, categoryName);
    if (hit) return hit;
  }
  return fromCategory(categoryName);
}

const displayNames = new Map<string, Intl.DisplayNames | null>();

function namesFor(locale: string): Intl.DisplayNames | null {
  let names = displayNames.get(locale);
  if (names === undefined) {
    try {
      names = new Intl.DisplayNames([locale, 'en'], { type: 'language', fallback: 'none' });
    } catch {
      names = null;
    }
    displayNames.set(locale, names);
  }
  return names;
}

/**
 * Human name of a language in the UI locale ("English", "Latin American Spanish").
 * `groupName` translates the group keys; the badge code is the last resort.
 */
export function languageName(lang: ItemLanguage, locale: string, groupName: (group: LanguageGroup) => string): string {
  if (lang.group) return groupName(lang.group);
  if (lang.tag) {
    const name = namesFor(locale)?.of(lang.tag);
    if (name) return name.charAt(0).toLocaleUpperCase(locale) + name.slice(1);
  }
  return lang.code;
}
