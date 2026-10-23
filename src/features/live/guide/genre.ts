/**
 * Guide genres (CB-GUIDE-GENRE): an XMLTV `<category>` sorted into one of five buckets the guide
 * colours and filters by, or none. Guides write categories in the broadcaster's language and in
 * DVB's content-descriptor wording ("Movie / Drama", "News / Current affairs", "Children's /
 * Youth programs"), so the table holds English, the DVB forms and the common translations.
 * Unknown words fall into no bucket: the cell keeps its plain fill.
 */

export const GENRES = ['movie', 'sports', 'news', 'kids', 'series'] as const;
export type Genre = (typeof GENRES)[number];

/** Case- and accent-folded, so "Películas" and "PELICULAS" match "peliculas". */
function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();
}

/**
 * Keywords per bucket, folded. Checked in this order, so "Children's movie" is kids and "Sports
 * news" is sports: the narrower audience or subject wins over the format. Exported for tests.
 */
export const KEYWORDS: readonly (readonly [Genre, readonly string[]])[] = [
  [
    'kids',
    [
      'kids', 'kid', 'children', "children's", 'childrens', 'youth', 'cartoon', 'cartoons', 'preschool', 'kinder', 'kinderprogramm',
      'infantil', 'infantiles', 'ninos', 'enfants', 'jeunesse', 'bambini', 'ragazzi', 'kinderen', 'jeugd', 'dzieci', 'detskie', 'детям',
      'детский', 'детские', 'мультфильм', 'мультфильмы', 'cocuk', 'çocuk', 'παιδικα', 'gyerek', 'gyermek', 'اطفال', 'أطفال', 'キッズ',
      '子供', 'こども', '儿童', '少儿', '兒童', '어린이', '키즈',
    ],
  ],
  [
    'sports',
    [
      'sport', 'sports', 'football', 'soccer', 'basketball', 'tennis', 'golf', 'cycling', 'racing', 'motorsport', 'motorsports', 'rugby',
      'cricket', 'baseball', 'hockey', 'boxing', 'athletics', 'olympics', 'wrestling', 'mma', 'nfl', 'nba', 'futbol', 'deporte', 'deportes',
      'deportivo', 'calcio', 'fussball', 'fußball', 'sportif', 'voetbal', 'esporte', 'esportes', 'desporto', 'pilka', 'spor', 'futbol',
      'αθλητικα', 'спорт', 'футбол', 'رياضة', 'رياضي', 'スポーツ', '体育', '體育', '스포츠', 'labdarugas',
    ],
  ],
  [
    'news',
    [
      'news', 'current affairs', 'newscast', 'bulletin', 'weather', 'nachrichten', 'aktuell', 'noticias', 'noticiero', 'informativo',
      'actualites', 'actualite', 'journal', 'notizie', 'telegiornale', 'tg', 'nieuws', 'journaal', 'noticias', 'telejornal', 'wiadomosci',
      'informacje', 'haber', 'haberler', 'ειδησεις', 'новости', 'hirek', 'híradó', 'hirado', 'اخبار', 'أخبار', 'ニュース', '新闻',
      '新聞', '뉴스',
    ],
  ],
  [
    'movie',
    [
      'movie', 'movies', 'film', 'films', 'feature film', 'cinema', 'kino', 'spielfilm', 'pelicula', 'peliculas', 'cine', 'filme', 'filmes',
      'cinema', 'fiction', 'sinema', 'ταινια', 'ταινιες', 'фильм', 'фильмы', 'кино', 'filmek', 'فيلم', 'افلام', 'أفلام', '映画', '电影',
      '電影', '영화',
    ],
  ],
  [
    'series',
    [
      'series', 'serie', 'serien', 'series tv', 'tv series', 'drama', 'sitcom', 'comedy', 'soap', 'entertainment', 'show', 'game show',
      'talk show', 'reality', 'telenovela', 'serial', 'feuilleton', 'unterhaltung', 'entretenimiento', 'divertissement', 'intrattenimento',
      'amusement', 'rozrywka', 'dizi', 'eglence', 'σειρα', 'σειρες', 'сериал', 'сериалы', 'развлечения', 'sorozat', 'مسلسل', 'مسلسلات',
      'ドラマ', 'バラエティ', '电视剧', '綜藝', '综艺', '電視劇', '드라마', '예능',
    ],
  ],
];

/** Scripts written without spaces between words: matched as substrings, not words. */
const NO_SPACES = /[぀-ヿ㐀-鿿가-힯]/u;

/**
 * Splits folded text into its words (runs of letters and digits) and what separates them: words
 * at even indices, separators at odd ones; the first and last word are empty when the text
 * starts or ends with a separator.
 */
const WORD_BREAKS = /([^\p{L}\p{N}]+)/u;

/**
 * A bucket's keywords, built on first use (P2-GUIDE-1). They were one regex per bucket, every
 * keyword a whole word between Unicode lookarounds: building and first running those took a
 * quarter of the guide's cold open. The same rule as lookups: an alphabetic keyword of n words
 * matches n words in a row of the text with the same separators between them (every keyword
 * begins and ends with a letter), and a keyword of the no-space scripts matches as a substring.
 */
interface Matcher {
  genre: Genre;
  substrings: readonly string[];
  /** Keywords by their number of words. */
  phrases: ReadonlyMap<number, ReadonlySet<string>>;
}

let matchers: readonly Matcher[] | undefined;

function buildMatchers(): readonly Matcher[] {
  return KEYWORDS.map(([genre, words]) => {
    const substrings: string[] = [];
    const phrases = new Map<number, Set<string>>();
    for (const w of new Set(words.map(fold))) {
      if (NO_SPACES.test(w)) {
        substrings.push(w);
        continue;
      }
      const n = (w.split(WORD_BREAKS).length + 1) / 2;
      let set = phrases.get(n);
      if (!set) phrases.set(n, (set = new Set()));
      set.add(w);
    }
    return { genre, substrings, phrases };
  });
}

function matches({ substrings, phrases }: Matcher, folded: string, parts: readonly string[]): boolean {
  for (const w of substrings) if (folded.includes(w)) return true;
  for (const [n, set] of phrases) {
    // A phrase of n words spans 2n - 1 parts: its words and the separators between them.
    for (let i = 0; i + 2 * n - 1 <= parts.length; i += 2) {
      if (set.has(n === 1 ? parts[i]! : parts.slice(i, i + 2 * n - 1).join(''))) return true;
    }
  }
  return false;
}

const cache = new Map<string, Genre | null>();

/** The bucket of a programme category, or null. Results are cached: guides repeat a few dozen strings. */
export function genreOf(category: string | undefined | null): Genre | null {
  if (!category) return null;
  const hit = cache.get(category);
  if (hit !== undefined) return hit;
  const folded = fold(category);
  const parts = folded.split(WORD_BREAKS);
  let out: Genre | null = null;
  for (const m of (matchers ??= buildMatchers())) {
    if (matches(m, folded, parts)) {
      out = m.genre;
      break;
    }
  }
  if (cache.size > 2000) cache.clear();
  cache.set(category, out);
  return out;
}

/** The stripe colour of a bucket: a token from the genre block at the end of tokens.css. */
export function genreColor(genre: Genre): string {
  return `var(--color-genre-${genre})`;
}

const FILTER_KEY = 'guide.genreFilter';

/** The genre the guide was last filtered to (localStorage, a UI preference), or null. */
export function storedGenreFilter(): Genre | null {
  try {
    const v = localStorage.getItem(FILTER_KEY);
    return (GENRES as readonly string[]).includes(v ?? '') ? (v as Genre) : null;
  } catch {
    return null;
  }
}

export function storeGenreFilter(genre: Genre | null): void {
  try {
    if (genre) localStorage.setItem(FILTER_KEY, genre);
    else localStorage.removeItem(FILTER_KEY);
  } catch {
    // storage unavailable: the filter lasts for the visit
  }
}
