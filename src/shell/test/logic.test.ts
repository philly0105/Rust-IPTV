import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, type RecentEntry, type SeriesItem, type Source, type VodItem } from '@/api/types';

import { mergeRecentlyAdded, minutesLeft, rankSources, watchedFraction } from '../dashboard/DashboardPage';
import { deepLinkToPath, importToastPolicy, isRestorableRoute, isSourcesRoute } from '../effects';
import { railFadeMask } from '../Rail';
import { railLinks } from '../railLinks';
import { groupShortcuts } from '../ShortcutOverlay';
import { matches, normalizeCombo, parseCombo } from '../shortcuts';
import { titleEndsWithYear } from '../dashboard/heroSlides';
import { routeSourceId, sourceHomePath } from '../railLinks';
import { routeListId, startupTarget } from '../StartupRedirect';
import { resolveTheme } from '../theme';

const ev = (key: string, init: Partial<KeyboardEventInit> = {}) => new KeyboardEvent('keydown', { key, ...init });

describe('shortcut matching', () => {
  it('maps mod to ctrl off Mac', () => {
    const p = parseCombo('mod+k');
    expect(matches(p, ev('k', { ctrlKey: true }))).toBe(true);
    expect(matches(p, ev('k'))).toBe(false);
    expect(matches(p, ev('k', { ctrlKey: true, shiftKey: true }))).toBe(false);
  });
  it('matches symbol keys regardless of shift', () => {
    expect(matches(parseCombo('?'), ev('?', { shiftKey: true }))).toBe(true);
  });
  it('matches the digit wildcard', () => {
    const p = parseCombo('digit');
    expect(matches(p, ev('7'))).toBe(true);
    expect(matches(p, ev('a'))).toBe(false);
  });
  it('normalizes modifier order and case', () => {
    expect(normalizeCombo('Shift+Mod+K')).toBe(normalizeCombo('mod+shift+k'));
  });
});

describe('deep links', () => {
  it('routes iptv://add?url= to the add-source flow', () => {
    expect(deepLinkToPath('iptv://add?url=http%3A%2F%2Fx.test%2Fa.m3u')).toBe('/sources?add=http%3A%2F%2Fx.test%2Fa.m3u');
    expect(deepLinkToPath('iptv://add')).toBe('/sources?add=');
  });
  it('keeps the kind and reads the path form of add links', () => {
    expect(deepLinkToPath('iptv://add?url=http%3A%2F%2Fx.test%2Fa.m3u&kind=xtream')).toBe('/sources?add=http%3A%2F%2Fx.test%2Fa.m3u&kind=xtream');
    expect(deepLinkToPath('iptv://add/http%3A%2F%2Fx.test%2Fa.m3u')).toBe('/sources?add=http%3A%2F%2Fx.test%2Fa.m3u');
    expect(deepLinkToPath('iptv://add?url=file%3A%2F%2F%2Fetc%2Fpasswd')).toBeNull();
  });
  it('routes search and ignores unknown actions', () => {
    expect(deepLinkToPath('iptv://search?q=news')).toBe('/search?q=news');
    expect(deepLinkToPath('iptv://explode')).toBeNull();
    expect(deepLinkToPath('https://example.test')).toBeNull();
  });
});

describe('startup target', () => {
  it('uses lastRoute only when restoring', () => {
    expect(startupTarget({ ...DEFAULT_SETTINGS, startupBehavior: 'restore-last-view', lastRoute: '/epg' })).toBe('/epg');
    expect(startupTarget({ ...DEFAULT_SETTINGS, startupBehavior: 'first-view', lastRoute: '/epg', showDashboard: true })).toBe('/dashboard');
  });
  it('falls back to /sources when the dashboard is off', () => {
    expect(startupTarget({ ...DEFAULT_SETTINGS, startupBehavior: 'first-view', showDashboard: false })).toBe('/sources');
  });
  it('does not restore a screen of a source that no longer exists', () => {
    const s = { ...DEFAULT_SETTINGS, startupBehavior: 'restore-last-view' as const, lastRoute: '/s/gone/live', showDashboard: true };
    expect(startupTarget(s, { sources: [{ id: 'other' }] })).toBe('/dashboard');
    expect(startupTarget(s, { sources: [{ id: 'gone' }] })).toBe('/s/gone/live');
    // Unknown list (failed or not needed): restore as before.
    expect(startupTarget(s)).toBe('/s/gone/live');
    expect(routeSourceId('/s/a%20b/movies')).toBe('a b');
    expect(routeSourceId('/epg')).toBeUndefined();
  });
  it('does not restore the archive of a removed source', () => {
    const s = { ...DEFAULT_SETTINGS, startupBehavior: 'restore-last-view' as const, lastRoute: '/live/archive/gone/ch1', showDashboard: true };
    expect(routeSourceId('/live/archive/a%20b/ch1')).toBe('a b');
    expect(startupTarget(s, { sources: [{ id: 'other' }] })).toBe('/dashboard');
    expect(startupTarget(s, { sources: [{ id: 'gone' }] })).toBe('/live/archive/gone/ch1');
  });
  it('does not restore a deleted list', () => {
    const s = { ...DEFAULT_SETTINGS, startupBehavior: 'restore-last-view' as const, lastRoute: '/lists/l1', showDashboard: true };
    expect(routeListId('/lists/l%201')).toBe('l 1');
    expect(routeListId('/lists')).toBeUndefined();
    expect(startupTarget(s, { lists: [{ id: 'l2' }] })).toBe('/dashboard');
    expect(startupTarget(s, { lists: [{ id: 'l1' }] })).toBe('/lists/l1');
    expect(startupTarget(s)).toBe('/lists/l1');
  });
  it('does not restore a path no route renders', () => {
    const s = { ...DEFAULT_SETTINGS, startupBehavior: 'restore-last-view' as const, lastRoute: '/no/such/page?x=1', showDashboard: false };
    const isKnownPath = (p: string) => p !== '/no/such/page';
    expect(startupTarget(s, { isKnownPath })).toBe('/sources');
    expect(startupTarget({ ...s, lastRoute: '/epg?source=a' }, { isKnownPath })).toBe('/epg?source=a');
  });
  it('never restores transient routes', () => {
    expect(isRestorableRoute('/sources?add=1')).toBe(false);
    expect(isRestorableRoute('/')).toBe(false);
    expect(isRestorableRoute('/s/a/live')).toBe(true);
  });
});

describe('titleEndsWithYear', () => {
  it('spots a year the title already carries', () => {
    expect(titleEndsWithYear('Dune (2021)', 2021)).toBe(true);
    expect(titleEndsWithYear('Dune [2021] ', '2021')).toBe(true);
    expect(titleEndsWithYear('Dune - 2021', 2021)).toBe(true);
    expect(titleEndsWithYear('Dune (2021)', 1984)).toBe(false);
    expect(titleEndsWithYear('Blade Runner 2049', 2049)).toBe(false);
    expect(titleEndsWithYear('Dune', 2021)).toBe(false);
    expect(titleEndsWithYear(undefined, 2021)).toBe(false);
    expect(titleEndsWithYear('Dune (2021)', undefined)).toBe(false);
  });
});

describe('rail fade cues', () => {
  it('fades only the edges that have more links', () => {
    expect(railFadeMask(false, false)).toBeUndefined();
    expect(railFadeMask(false, true)?.maskImage).toBe('linear-gradient(to bottom, #000, #000 calc(100% - 24px), transparent)');
    expect(railFadeMask(true, false)?.maskImage).toBe('linear-gradient(to bottom, transparent, #000 24px, #000)');
    expect(railFadeMask(true, true)?.WebkitMaskImage).toContain('transparent, #000 24px, #000 calc(100% - 24px), transparent');
  });
});

describe('rail links', () => {
  const src = (kind: Source['kind'], movieCount = 0) => ({ id: 'a b', kind, movieCount }) as Source;
  it('gives xtream and stalker every link', () => {
    expect(railLinks(src('xtream')).map((l) => l.id)).toEqual(['live', 'radio', 'movies', 'series', 'favorites', 'recent']);
  });
  it('adds movies for m3u only when it has movies', () => {
    expect(railLinks(src('m3u', 3)).map((l) => l.id)).toEqual(['live', 'movies', 'favorites', 'recent']);
  });
  it('adds radio for m3u only when it has radio', () => {
    expect(railLinks(src('m3u'), { hasRadio: true }).map((l) => l.id)).toContain('radio');
    expect(railLinks(src('m3u'), { hasRadio: false }).map((l) => l.id)).not.toContain('radio');
  });
  it('encodes the source id in paths', () => {
    expect(railLinks(src('xtream'), { hasRadio: false })[0]!.to).toBe('/s/a%20b/live');
  });
  it('drops empty Xtream sections once an import has counted them (F-RAIL-COUNTS)', () => {
    const counted = (patch: Partial<Source>) => ({ ...src('xtream'), lastRefreshAt: '2026-10-19T10:00:00Z', radioCount: 0, seriesCount: 0, ...patch }) as Source;
    expect(railLinks(counted({})).map((l) => l.id)).toEqual(['live', 'favorites', 'recent']);
    expect(railLinks(counted({ movieCount: 4, seriesCount: 2, radioCount: 1 })).map((l) => l.id)).toEqual(['live', 'radio', 'movies', 'series', 'favorites', 'recent']);
    // Not imported yet: the zeros are no answer, so every link stays.
    expect(railLinks({ ...counted({}), lastRefreshAt: undefined }).map((l) => l.id)).toHaveLength(6);
  });
  it('keeps Stalker movies and series, whose totals the portal may not report', () => {
    const portal = { ...src('stalker'), lastRefreshAt: '2026-10-19T10:00:00Z', radioCount: 0, seriesCount: 0 } as Source;
    expect(railLinks(portal).map((l) => l.id)).toEqual(['live', 'movies', 'series', 'favorites', 'recent']);
  });
});

describe('source home path (F-VOD-ONLY-SOURCE)', () => {
  const counts = (patch: Partial<Source>) => ({ id: 'a b', channelCount: 0, movieCount: 0, seriesCount: 0, radioCount: 0, ...patch }) as Source;
  it('opens live channels first, else the first section with anything in it', () => {
    expect(sourceHomePath(counts({ channelCount: 3, movieCount: 5 }))).toBe('/s/a%20b/live');
    expect(sourceHomePath(counts({ movieCount: 5, seriesCount: 2 }))).toBe('/s/a%20b/movies');
    expect(sourceHomePath(counts({ seriesCount: 2 }))).toBe('/s/a%20b/series');
    expect(sourceHomePath(counts({ radioCount: 2 }))).toBe('/s/a%20b/radio');
    expect(sourceHomePath(counts({}))).toBe('/s/a%20b/live');
  });
});

describe('shortcut overlay grouping', () => {
  it('dedupes documented entries already registered in the same area', () => {
    const groups = groupShortcuts(
      [{ combo: 'mod+k', description: 'Palette (live)', area: 'Global' }],
      [
        { combo: 'mod+k', description: 'Palette (doc)', area: 'Global' },
        { combo: 'space', description: 'Play', area: 'Playback' },
      ],
    );
    const global = groups.find(([a]) => a === 'Global')![1];
    expect(global).toHaveLength(1);
    expect(global[0]!.description).toBe('Palette (live)');
    expect(groups.map(([a]) => a)).toContain('Playback');
  });
});

describe('theme', () => {
  it('resolves system against the OS preference', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
  });
});

describe('dashboard helpers', () => {
  it('computes watched fraction and minutes left', () => {
    expect(watchedFraction({ positionSeconds: 30, durationSeconds: 120 })).toBe(0.25);
    expect(watchedFraction({ positionSeconds: 30 })).toBeUndefined();
    expect(minutesLeft({ positionSeconds: 0, durationSeconds: 3600 })).toBe(60);
    expect(minutesLeft({ positionSeconds: 3599, durationSeconds: 3600 })).toBe(1);
  });
  it('ranks sources by latest use, then refresh time', () => {
    const s = (id: string, lastRefreshAt?: string) => ({ id, position: 0, createdAt: '2026-01-01', lastRefreshAt }) as Source;
    const recent = [{ ref: { sourceId: 'b', contentType: 'live', itemId: '1' }, viewedAt: '2026-10-10' }] as RecentEntry[];
    expect(rankSources([s('a', '2026-10-09'), s('b'), s('c', '2026-10-11')], recent).map((x) => x.id)).toEqual(['b', 'c', 'a']);
  });
  it('merges recently added movies and series newest first', () => {
    const m = [{ title: 'm1', added: '2026-10-01' }, { title: 'm2', added: '2026-10-05' }] as VodItem[];
    const se = [{ title: 's1', added: '2026-10-03' }] as SeriesItem[];
    expect(mergeRecentlyAdded(m, se, 2).map((x) => x.title)).toEqual(['m2', 's1']);
  });
});

describe('import toast policy', () => {
  it('recognizes only the Sources page itself', () => {
    expect(isSourcesRoute('/sources')).toBe(true);
    expect(isSourcesRoute('/sources/')).toBe(true);
    expect(isSourcesRoute('/s/abc/live')).toBe(false);
    expect(isSourcesRoute('/sourcesx')).toBe(false);
    expect(isSourcesRoute('/dashboard')).toBe(false);
  });

  it('stays quiet on Sources for progress and done, but always reports errors', () => {
    expect(importToastPolicy('parsing', true)).toBe('dismiss');
    expect(importToastPolicy('done', true)).toBe('dismiss');
    expect(importToastPolicy('error', true)).toBe('toast');
    for (const phase of ['fetching', 'parsing', 'saving', 'done', 'error'] as const) {
      expect(importToastPolicy(phase, false)).toBe('toast');
    }
  });
});
