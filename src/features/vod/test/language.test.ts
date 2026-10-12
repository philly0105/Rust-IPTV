import { describe, expect, it } from 'vitest';

import { itemLanguage, languageName, type LanguageGroup } from '../lib/language';

const group = (g: LanguageGroup) => `group:${g}`;
const name = (title: string, category?: string, locale = 'en') => {
  const lang = itemLanguage(title, category);
  return lang ? `${lang.code}|${languageName(lang, locale, group)}` : undefined;
};

describe('itemLanguage', () => {
  it('reads the provider prefix in front of the title', () => {
    expect(name('EN - Interstellar (2014)', 'VOD - NEW ADDED [EN]')).toBe('EN|English');
    expect(name('IT - Interstellar (2014)', 'VOD - FILM 1990/2024 [IT]')).toBe('IT|Italian');
    expect(name('NL - Interstellar (2014)')).toBe('NL|Dutch');
    expect(name('PL - INTERSTELLAR (2014)')).toBe('PL|Polish');
    expect(name('ENG - Interstellar  (2014)', 'VOD - INDIA')).toBe('EN|English');
    expect(name('LAT - Interstellar  (2014)', 'VOD - LATINO [ES]')).toBe('LAT|Latin American Spanish');
    expect(name('GR - Something (2020)')).toBe('GR|Greek');
    expect(name('DK - Something (2020)')).toBe('DK|Danish');
    expect(name('AL - Something (2020)')).toBe('AL|Albanian');
  });

  it('accepts bracket, pipe and colon prefixes and ignores bidi marks', () => {
    expect(name('|FR| Le Film (2020)')).toBe('FR|French');
    expect(name('[DE] Der Film')).toBe('DE|German');
    expect(name('ES: La Película')).toBe('ES|Spanish');
    expect(name('EN | The Film')).toBe('EN|English');
    expect(name('‫AR - Stranger Things (2026) (US)', 'مسلسلات أجنبيه')).toBe('AR|Arabic');
  });

  it('maps the regional Indian codes by language', () => {
    expect(name('TG - Film (2024)', 'VOD - INDIA')).toBe('TG|Telugu');
    expect(name('TM - Film (2024)', 'VOD - INDIA')).toBe('TM|Tamil');
    expect(name('KD - Film (2024)', 'VOD - INDIA')).toBe('KD|Kannada');
    expect(name('MA - Film (2024)', 'VOD - INDIA')).toBe('MA|Malayalam');
    expect(name('PB - Film (2024)', 'VOD - PUNJABI')).toBe('PB|Punjabi');
    expect(name('STH - Film (2024)', 'VOD - INDIA')).toBe('STH|group:southIndian');
    expect(name('IN - Film (2024)', 'VOD - INDIA')).toBe('IN|group:indian');
  });

  it('falls back to the category when the prefix names a service or quality', () => {
    expect(name('4K - Hungry (2026)', 'VOD - ENGLISH 4K')).toBe('EN|English');
    expect(name('NF - Show (2024)', 'VOD - NETFLIX [MULTISUB]')).toBe('MULTI|group:multisub');
    expect(name('D+ - Muppets Now (US)', 'SRS - DISNEY+ [MULTISUB]')).toBe('MULTI|group:multisub');
    expect(name('EX - Film (2001)', 'VOD - FILMOVI [EXYU]')).toBe('EX|group:exYu');
  });

  it('uses the category alone when the title has no prefix', () => {
    expect(name('Sweetness (2026)', 'VOD - ENGLISH 4K')).toBe('EN|English');
    expect(name('Bigg Boss (2006) (IN)', 'SRS - INDIA')).toBe('IN|group:indian');
    expect(name('Some Film (2020)', 'VOD - GERMANY 2024-2026 [DE]')).toBe('DE|German');
    expect(name('Film', 'VOD - أفلام أجنبية')).toBe('AR|Arabic');
    expect(name('Le Film (2020)', 'FR - FILM ᴰᴼᴸᴮʸ ⁴ᴷ')).toBe('FR|French');
    expect(name('TOP - Corina (2025)', 'TOP MOVIES BLURAY (MULTI-SUBS)')).toBe('MULTI|group:multisub');
  });

  it('does not invent a language', () => {
    expect(itemLanguage('Interstellar (2014)')).toBeUndefined();
    expect(itemLanguage('The Matrix - Reloaded (2003)')).toBeUndefined();
    expect(itemLanguage('TOP - Film (1994)', 'VOD - TOP 500 IMDB')).toBeUndefined();
    expect(itemLanguage('D+ - Mickey Mouse Clubhouse (US)', 'SRS - DISNEY+ KIDS')).toBeUndefined();
  });

  it('names the language in the UI locale', () => {
    expect(name('EN - Interstellar (2014)', undefined, 'fr')).toBe('EN|Anglais');
    expect(name('FR - Interstellar (2014)', undefined, 'de')).toBe('FR|Französisch');
  });
});
