import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import { rpcKey } from '@/api/query';
import { DEFAULT_SETTINGS, type Settings } from '@/api/types';
import { bindTmdbCacheSync, tmdbCacheScope } from '@/shell/effects';

// data-perf r1 F6: cached TMDB answers must not outlive TMDB being on, or the language they were fetched in.
const withTmdb = (enabled: boolean, language = 'en', tmdbLanguage?: string): Settings => ({
  ...DEFAULT_SETTINGS,
  language,
  tmdb: { ...DEFAULT_SETTINGS.tmdb, enabled, language: tmdbLanguage },
});

const MOVIE = ['tmdb.movie', { title: 'Dune' }];
const KEY_CHECK = ['tmdb.testKey', { apiKey: '' }];
const CATALOG = ['catalog.item', { id: 1 }];

function seed(client: QueryClient) {
  client.setQueryData(MOVIE, { overview: 'cached' });
  client.setQueryData(KEY_CHECK, { ok: true });
  client.setQueryData(CATALOG, { title: 'kept' });
}

describe('TMDB cache sync', () => {
  it('scopes by the TMDB language, falling back to the app language, and is null while off', () => {
    expect(tmdbCacheScope(withTmdb(true, 'de'))).toBe('de');
    expect(tmdbCacheScope(withTmdb(true, 'de', ' fr '))).toBe('fr');
    expect(tmdbCacheScope(withTmdb(true, 'de', '  '))).toBe('de');
    expect(tmdbCacheScope(withTmdb(false, 'de', 'fr'))).toBeNull();
  });

  it('removes cached TMDB answers when TMDB is turned off', () => {
    const client = new QueryClient();
    client.setQueryData(rpcKey('settings.get'), withTmdb(true));
    seed(client);
    const off = bindTmdbCacheSync(client);
    client.setQueryData(rpcKey('settings.get'), withTmdb(false));
    expect(client.getQueryData(MOVIE)).toBeUndefined();
    expect(client.getQueryData(KEY_CHECK)).toBeUndefined();
    expect(client.getQueryData(CATALOG)).toEqual({ title: 'kept' });
    off();
  });

  it('resets them when the effective TMDB language changes, including through the app language', () => {
    const client = new QueryClient();
    client.setQueryData(rpcKey('settings.get'), withTmdb(true, 'en'));
    seed(client);
    const off = bindTmdbCacheSync(client);
    // An unrelated settings change keeps the cache.
    client.setQueryData(rpcKey('settings.get'), { ...withTmdb(true, 'en'), showCaptions: !DEFAULT_SETTINGS.showCaptions });
    expect(client.getQueryData(MOVIE)).toEqual({ overview: 'cached' });
    // The app language TMDB follows.
    client.setQueryData(rpcKey('settings.get'), withTmdb(true, 'de'));
    expect(client.getQueryData(MOVIE)).toBeUndefined();
    expect(client.getQueryData(KEY_CHECK)).toEqual({ ok: true });
    // Its own language setting.
    seed(client);
    client.setQueryData(rpcKey('settings.get'), withTmdb(true, 'de', 'fr'));
    expect(client.getQueryData(MOVIE)).toBeUndefined();
    off();
  });

  it('does nothing on the first settings load', () => {
    const client = new QueryClient();
    seed(client);
    const off = bindTmdbCacheSync(client);
    client.setQueryData(rpcKey('settings.get'), withTmdb(false));
    expect(client.getQueryData(MOVIE)).toEqual({ overview: 'cached' });
    off();
  });
});
