/**
 * Language of a provider VOD title.
 *
 * Xtream panels tag each movie with a language prefix ("EN - Interstellar (2014)",
 * "|FR| ...", "LAT - ...") and usually also put a code in the category name
 * ("VOD - SPAIN [ES]"). `titleBase` strips that prefix for matching and captions, so
 * the language is read back from the raw title here, with the category as the fallback
 * for prefixes that name a service or a quality instead ("NF - ", "4K - ", "D+ - ").
 *
 * Mirrors `crates/iptv-core/src/catalog/language.rs`, which runs the English-only
 * filter in SQL; keep both tables in step.
 */

import { intlLocale } from '@/lib/intl';

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
  USA: { tag: 'en' },
  AU: { tag: 'en' },
  NZ: { tag: 'en' },
  IE: { tag: 'en' },
  FR: { tag: 'fr' },
  FRA: { tag: 'fr' },
  DE: { tag: 'de' },
  GER: { tag: 'de' },
  AT: { tag: 'de' },
  ES: { tag: 'es' },
  SP: { tag: 'es' },
  ESP: { tag: 'es' },
  LA: { tag: 'es-419' },
  LAT: { tag: 'es-419' },
  LATINO: { tag: 'es-419' },
  LATAM: { tag: 'es-419' },
  MX: { tag: 'es-419' },
  IT: { tag: 'it' },
  ITA: { tag: 'it' },
  NL: { tag: 'nl' },
  NED: { tag: 'nl' },
  PL: { tag: 'pl' },
  POL: { tag: 'pl' },
  RU: { tag: 'ru' },
  RUS: { tag: 'ru' },
  PT: { tag: 'pt' },
  POR: { tag: 'pt' },
  BR: { tag: 'pt-BR' },
  BRA: { tag: 'pt-BR' },
  AR: { tag: 'ar' },
  ARA: { tag: 'ar' },
  ARAB: { tag: 'ar' },
  HU: { tag: 'hu' },
  RO: { tag: 'ro' },
  TR: { tag: 'tr' },
  TUR: { tag: 'tr' },
  FI: { tag: 'fi' },
  FIN: { tag: 'fi' },
  NO: { tag: 'no' },
  NOR: { tag: 'no' },
  SE: { tag: 'sv' },
  SV: { tag: 'sv' },
  SWE: { tag: 'sv' },
  IS: { tag: 'is' },
  GR: { tag: 'el' },
  EL: { tag: 'el' },
  GRE: { tag: 'el' },
  DK: { tag: 'da' },
  DA: { tag: 'da' },
  DEN: { tag: 'da' },
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
  VN: { tag: 'vi' },
  TH: { tag: 'th' },
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

/** Keywords in a category name, for categories without a bracket code. First match wins. */
const CATEGORY_WORDS: [RegExp, string][] = [
  [/\bENGLISH\b/i, 'EN'],
  [/\bFRENCH\b|\bFRAN[CÇ]AIS\b|\bFRANCE\b|\bQUEBEC\b/i, 'FR'],
  [/\bGERMAN\b|\bDEUTSCH|\bGERMANY\b/i, 'DE'],
  [/\bSPANISH\b|\bESPA[NÑ]OL\b|\bSPAIN\b|\bESPA[NÑ]A\b/i, 'ES'],
  [/\bLATINO\b|\bLATAM\b|\bLATIN\b|\bMEXICO\b/i, 'LAT'],
  [/\bITALIAN\b|\bITALIANO\b|\bITALY\b|\bITALIA\b/i, 'IT'],
  [/\bPORTUGU|\bPORTUGAL\b/i, 'PT'],
  [/\bBRAZIL\b|\bBRASIL\b/i, 'BR'],
  [/\bTURK/i, 'TR'],
  [/\bPAKISTAN/i, 'PK'],
  [/\bPUNJABI\b/i, 'PB'],
  [/\bSOMALI/i, 'SOM'],
  [/\bINDIA\b|\bHINDI\b|\bBOLLYWOOD\b/i, 'IN'],
  [/\bMULTI-?SUBS?\b/i, 'MULTISUB'],
  [/\bNORDIC\b|\bSCANDINAVIA/i, 'SC'],
  [/\bPOLAND\b|\bPOLSKA\b|\bPOLISH\b/i, 'PL'],
  [/\bNETHERLANDS\b|\bHOLLAND\b|\bNEDERLAND\b|\bDUTCH\b/i, 'NL'],
  [/\bSWEDEN\b|\bSVERIGE\b|\bSWEDISH\b/i, 'SE'],
  [/\bNORWAY\b|\bNORGE\b|\bNORWEGIAN\b/i, 'NO'],
  [/\bDENMARK\b|\bDANMARK\b|\bDANISH\b/i, 'DK'],
  [/\bFINLAND\b|\bSUOMI\b|\bFINNISH\b/i, 'FI'],
  [/\bGREECE\b|\bGREEK\b/i, 'GR'],
  [/\bROMANIA/i, 'RO'],
  [/\bBULGARIA/i, 'BG'],
  [/\bHUNGARY\b|\bHUNGARIAN\b|\bMAGYAR\b/i, 'HU'],
  [/\bCZECH\b/i, 'CZ'],
  [/\bSLOVAK/i, 'SK'],
  [/\bRUSSIA/i, 'RU'],
  [/\bUKRAIN/i, 'UA'],
  [/\bALBANIA/i, 'AL'],
  [/\bISRAEL\b|\bHEBREW\b/i, 'HE'],
  [/\bIRAN\b|\bPERSIAN\b|\bFARSI\b/i, 'IR'],
  [/\bKURD/i, 'KU'],
  [/\bKOREA/i, 'KR'],
  [/\bJAPAN/i, 'JP'],
  [/\bCHINA\b|\bCHINESE\b/i, 'CN'],
  [/\bARABIC\b/i, 'AR'],
  [/\bEX-?YU\b|\bBALKAN/i, 'EXYU'],
  [/\bVIETNAM/i, 'VN'],
  [/\bTHAI\b|\bTHAILAND\b/i, 'TH'],
];

const BIDI_MARKS = /[‎‏‪-‮⁦-⁩]/g;
/** "EN - ", "|EN| ", "[EN] ", "EN: ", "EN | " at the start of a title. */
const TITLE_PREFIX = /^\s*[[|(]?\s*([A-Za-z]{2,8}|D\+|4K|3D)\s*[\]|)]?\s*(?:[-:|–—]\s*|(?<=[\]|)])\s*)/;
/** "[ES]", "[EXYU]", "[MULTISUB]" anywhere in a category name. */
const CATEGORY_BRACKET = /\[([A-Za-z]{2,8})\]/;
const ARABIC_SCRIPT = /[؀-ۿ]/;
/** Letters of scripts English never uses: Greek, Cyrillic, Hebrew, Arabic, Indic, Thai, Georgian, Hangul, CJK and kana. */
const FOREIGN_SCRIPT = /[\u0370-\u03FF\u0400-\u052F\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u0900-\u0DFF\u0E00-\u0E7F\u10A0-\u10FF\u1100-\u11FF\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF]/;

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

/**
 * Language of a movie or series from its raw provider title and category name, if either says.
 * A title prefix counts only in capitals ("IT - Film", not "It: Chapter Two").
 */
export function itemLanguage(title: string, categoryName?: string): ItemLanguage | undefined {
  const clean = title.replace(BIDI_MARKS, '');
  const m = clean.match(TITLE_PREFIX);
  const prefix = m?.[1];
  if (prefix && !NOT_LANGUAGE.has(prefix.toUpperCase()) && !/[a-z]/.test(prefix)) {
    const hit = resolve(prefix, categoryName);
    if (hit) return hit;
  }
  return fromCategory(categoryName);
}

/**
 * True when an item is clearly in a language other than English (the `englishOnly`
 * setting). Unknown, multi-subtitle and African items stay, as in the core.
 */
export function isNonEnglish(title: string, categoryName?: string): boolean {
  const lang = itemLanguage(title, categoryName);
  if (lang?.tag) return lang.tag !== 'en' && !lang.tag.startsWith('en-');
  if (lang?.group) return lang.group !== 'multisub' && lang.group !== 'african';
  return FOREIGN_SCRIPT.test(title) || FOREIGN_SCRIPT.test(categoryName ?? '');
}

const displayNames = new Map<string, Intl.DisplayNames | null>();

function namesFor(locale: string): Intl.DisplayNames | null {
  let names = displayNames.get(locale);
  if (names === undefined) {
    try {
      names = new Intl.DisplayNames([intlLocale(locale), 'en'], { type: 'language', fallback: 'none' });
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
