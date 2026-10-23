/**
 * The genre buckets are found by word lookups (P2-GUIDE-1), not by a regex per bucket of every
 * keyword between Unicode lookarounds: building and first running those cost a quarter of the
 * guide's cold open. The lookups must sort every category as the regexes did; the regexes are
 * kept here as the reference.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { genreOf, KEYWORDS, type Genre } from '../genre';

function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();
}
const NO_SPACES = /[぀-ヿ㐀-鿿가-힯]/u;
/** The matchers genre.ts used before P2-GUIDE-1, verbatim. */
const REFERENCE = KEYWORDS.map(([genre, words]) => {
  const parts = [...new Set(words.map(fold))].map((w) => {
    const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return NO_SPACES.test(w) ? escaped : `(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`;
  });
  return [genre, new RegExp(parts.join('|'), 'u')] as const;
});
function referenceGenre(category: string): Genre | null {
  const folded = fold(category);
  for (const [genre, re] of REFERENCE) if (re.test(folded)) return genre;
  return null;
}

/** Expects genreOf to agree with the reference on every input; names the first that does not. */
function expectSame(inputs: Iterable<string>) {
  let n = 0;
  for (const input of inputs) {
    expect({ input, genre: genreOf(input) }).toEqual({ input, genre: referenceGenre(input) });
    n++;
  }
  return n;
}

const KEYWORD_LIST = KEYWORDS.flatMap(([, words]) => words);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('genreOf matches as the per-bucket regexes did (P2-GUIDE-1)', () => {
  it('every keyword begins and ends with a letter or a digit, or is of a no-space script', () => {
    // The lookups rely on it: a keyword's first and last word are then whole words of the text.
    for (const w of KEYWORD_LIST.map(fold)) {
      if (NO_SPACES.test(w)) continue;
      expect(w).toMatch(/^[\p{L}\p{N}].*[\p{L}\p{N}]$|^[\p{L}\p{N}]$/u);
    }
  });

  it('every keyword, alone, cased, accented, inside longer words and between separators', () => {
    const inputs: string[] = [];
    for (const w of KEYWORD_LIST) {
      inputs.push(
        w,
        w.toUpperCase(),
        w[0]!.toUpperCase() + w.slice(1),
        `${w}s`,
        `x${w}`,
        `${w}1`,
        `1${w}`,
        `${w}é`,
        `é${w}`,
        ` ${w} `,
        `(${w})`,
        `${w}/${w}`,
        `${w}-tv`,
        `tv-${w}`,
        `Movie / ${w}`,
        `${w} / Drama`,
        `新${w}`,
        `${w}新`,
        `가${w}`,
        `${w}ス`,
        w.replace(' ', '  '),
        w.replace(' ', '-'),
        w.replace(' ', ''),
        w.replace("'", '’'),
        w.slice(1),
        w.slice(0, -1),
        `${w.slice(0, Math.ceil(w.length / 2))} ${w.slice(Math.ceil(w.length / 2))}`,
      );
    }
    expect(expectSame(inputs)).toBeGreaterThan(5000);
  });

  it('tricky categories: DVB forms, punctuation, mixed scripts, CJK and Hangul', () => {
    expectSame([
      "Children's / Youth programs",
      "Children's movie",
      'Childrens',
      "children'",
      "children''s",
      'Movie / Drama',
      'News / Current affairs',
      'current  affairs',
      'Current-Affairs',
      'Sports news',
      'Sportsnews',
      'Show / Game show',
      'Talk-Show',
      'TALK SHOW',
      'Películas',
      'PELICULAS',
      'Fußball',
      'FUSSBALL',
      'Çocuk',
      'ÇOCUK',
      'İnfantil',
      'Детские фильмы',
      'НОВОСТИ',
      'Ειδήσεις',
      'ΤΑΙΝΙΑ',
      'أخبار',
      'اخبار عاجلة',
      'مسلسلات تركية',
      'スポーツニュース',
      'ニュース速報',
      'キッズ',
      'キツス',
      '電影台',
      '体育新闻',
      '아이들 뉴스',
      '어린이뉴스',
      '스포츠',
      '스포츠 중계',
      'KBS 드라마',
      'tg1',
      'TG',
      'TG 1',
      'mma',
      'MMA-Kampf',
      'Kinderprogramm',
      'Kinder-Programm',
      'Documentary',
      'Newsletter tips',
      'Weather.',
      '...news...',
      'news_flash',
      'news​flash',
      'news flash',
      'feature film',
      'kids😀',
      '😀kids',
      'serié',
      ' ',
      '!!!',
      '123',
    ]);
  });

  it('agrees on random mixes of keywords, their pieces, letters and separators', () => {
    // mulberry32: a fixed seed, so a failure repeats.
    let seed = 0x9e3779b9;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T>(a: readonly T[]) => a[Math.floor(rand() * a.length)]!;
    const glue = [' ', '  ', '/', ' / ', "'", '-', '.', ',', '(', ')', '’', '_', '|', ''];
    const bits = ['a', 'é', 'ß', 'x', '1', '9', '新', '가', 'ス', 'и', 'α', 'ب'];
    const piece = () => {
      const w = pick(KEYWORD_LIST);
      const r = rand();
      if (r < 0.5) return w;
      if (r < 0.7) return w.slice(0, 1 + Math.floor(rand() * w.length));
      if (r < 0.85) return w.slice(Math.floor(rand() * w.length));
      return pick(bits);
    };
    const inputs: string[] = [];
    for (let i = 0; i < 4000; i++) {
      let s = piece();
      for (let k = Math.floor(rand() * 4); k > 0; k--) s += pick(glue) + piece();
      inputs.push(rand() < 0.3 ? s.toUpperCase() : s);
    }
    expectSame(inputs);
  });
});

describe('genreOf cost (P2-GUIDE-1)', () => {
  it('runs no regex with an alternative per keyword', () => {
    const exec = vi.spyOn(RegExp.prototype, 'exec');
    expect(genreOf('Cost check: Sports / Fußball')).toBe('sports');
    expect(genreOf('Cost check: no bucket at all')).toBeNull();
    const longest = Math.max(0, ...exec.mock.contexts.map((re) => (re as RegExp).source.length));
    expect(longest).toBeLessThan(100);
  });
});
