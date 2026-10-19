import { Command as Cmdk, defaultFilter } from 'cmdk';
import type { TFunction } from 'i18next';
import {
  AlarmClock,
  Bookmark,
  CalendarRange,
  ChartColumn,
  Clapperboard,
  CornerDownLeft,
  Download,
  Gift,
  HardDrive,
  Heart,
  History,
  House,
  Keyboard,
  Layers,
  LayoutGrid,
  ListOrdered,
  ListVideo,
  Lock,
  Monitor,
  Moon,
  Plus,
  Radio,
  Route,
  Search,
  Settings as SettingsIcon,
  Sun,
  Terminal,
  Tv,
  type LucideIcon,
} from 'lucide-react';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { useRpcQuery } from '@/api/query';
import { isDesktop } from '@/api/transport';
import { itemKey, type ContentType, type ItemRef, type ItemSnapshot } from '@/api/types';
// Light modules only (no guide page): programme hits and the guide link they open.
import { guideHitLink, useProgrammeSearch } from '@/features/live/guide/programmeSearch';
import { useDebounced } from '@/features/live/hooks/useDebounced';
import { useDisplayPrefs } from '@/features/live/hooks/useDisplayPrefs';
import { displayChannelName } from '@/features/live/lib/channelName';
import { formatClock, formatDay, ms } from '@/features/live/lib/epgTime';
// The openers only: the store has no UI imports, so the tour and What's new stay in their own chunks.
import { openTour, openWhatsNew } from '@/features/onboarding/store';
import { lockNow, useParentalStatus } from '@/features/parental/status';
import { cn, Dialog, Kbd, toast, errorDescription } from '@/ui';

import { useCommandList } from './commands';
import { railLinks } from './railLinks';
import { useShellStore } from './store';
import { useVisibleSources } from './useVisibleSources';
import { persistTheme } from './theme';

/**
 * Every Settings section, in page order. A copy of the settings feature's `SECTION_IDS` (importing
 * it would pull that module into the main chunk); a shell test fails when the two drift apart.
 */
export const SETTINGS_SECTIONS = [
  'general',
  'playback',
  'players',
  'epg',
  'recording',
  'metadata',
  'appearance',
  'parental',
  'remote',
  'backup',
  'shortcuts',
  'about',
] as const;

/** Separates an item's title from its id inside the cmdk value (the id keeps values unique). */
const VALUE_SEP = '';

/** True when every word of `search` appears, unbroken, somewhere in `text` (case-insensitive). */
function containsWords(text: string, search: string): boolean {
  const hay = text.toLowerCase();
  return search
    .toLowerCase()
    .split(/\s+/)
    .every((word) => hay.includes(word));
}

/**
 * Score for an item value: matches the visible title and keywords only, so internal ids
 * (`nav.*`, `settings.*`) never make unrelated items match. An item matches only when every
 * typed word appears unbroken in its title or keywords; cmdk's score then orders the matches.
 * Its loose subsequence matching alone let "bbc" find "Settings: Backup" (b..b..c across the
 * title and keywords) ahead of a "BBC News" favourite.
 */
export function paletteFilter(value: string, search: string, keywords?: string[]): number {
  const title = value.split(VALUE_SEP)[0] ?? value;
  // Title matches land in (0.5, 1], keyword-only matches in (0, 0.5], so an item
  // named for the query (a "Mock Xtream" source) outranks one that only lists it
  // as a keyword ("Add source"). Words typed out of order ("recording settings")
  // still match, with the floor score of their band.
  if (containsWords(title, search)) return 0.5 + Math.max(defaultFilter(title, search), 0.01) / 2;
  if (keywords?.length && containsWords(`${title} ${keywords.join(' ')}`, search)) {
    return Math.max(defaultFilter(title, search, keywords), 0.01) / 2;
  }
  return 0;
}

interface PaletteItem {
  id: string;
  title: string;
  group: string;
  icon?: LucideIcon;
  shortcut?: string;
  keywords?: string[];
  /** Quiet trailing text: a favourite's or recent item's kind, then its source when there are several. */
  detail?: readonly string[];
  run(): void;
}

/** Most favourites and recent items the palette lists for one query. */
const CONTENT_LIMIT = 8;

/** The dashboard's `recent.list` arguments: the palette reads the same cache entry. */
const RECENT_ARGS = { limit: 60 } as const;

const CONTENT_ICONS: Record<ContentType, LucideIcon> = { live: Tv, radio: Radio, movie: Clapperboard, series: Layers };
const CONTENT_KIND_KEYS: Record<ContentType, string> = { live: 'liveTv', radio: 'radio', movie: 'movie', series: 'series' };

interface ContentEntry {
  ref: ItemRef;
  snapshot: ItemSnapshot;
}

/** The entries whose titles match `query`, one per item (the first copy wins), best first, at most `limit`. */
export function matchContent<E extends ContentEntry>(entries: readonly E[], query: string, limit = CONTENT_LIMIT): E[] {
  const q = query.trim();
  if (!q) return [];
  const seen = new Set<string>();
  const hits: { entry: E; score: number }[] = [];
  for (const entry of entries) {
    const key = itemKey(entry.ref);
    if (seen.has(key)) continue;
    seen.add(key);
    const score = paletteFilter(entry.snapshot.title, q);
    if (score > 0) hits.push({ entry, score });
  }
  // A stable sort: equal scores keep favourites ahead of recent items.
  return hits
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((h) => h.entry);
}

/**
 * Favourites and recently watched items that match the query, so "bbc" finds a "BBC News"
 * favourite. They read the dashboard's own queries (same keys, so Home has them cached) and
 * only while the palette is open: no request per keystroke. A channel plays in the dock, as
 * from a dashboard card; a movie or series opens its detail page (the paths of the
 * dashboard's `itemPath`, which the palette does not import: its module pulls in the VOD
 * routes, and this chunk loads with the shell).
 */
function useContentItems(query: string, open: boolean): PaletteItem[] {
  const { t } = useTranslation('shell');
  const navigate = useNavigate();
  const sources = useVisibleSources();
  const favorites = useRpcQuery('favorites.list', {}, { enabled: open });
  const recent = useRpcQuery('recent.list', RECENT_ARGS, { enabled: open });
  const q = query.trim();

  return useMemo(() => {
    if (!q) return [];
    const sourceById = new Map((sources.data ?? []).map((s) => [s.id, s]));
    // Items of a removed source (or one waiting out its delete-undo window) stay out.
    const entries = [...(favorites.data ?? []), ...(recent.data ?? [])].filter((e) => sourceById.has(e.ref.sourceId));
    const group = t('groupFavoritesRecent');
    return matchContent(entries, q).map(({ ref, snapshot }): PaletteItem => {
      const source = sourceById.get(ref.sourceId)!;
      const title = snapshot.title;
      const kind = t(CONTENT_KIND_KEYS[ref.contentType]);
      const live = ref.contentType === 'live' || ref.contentType === 'radio';
      const sid = encodeURIComponent(ref.sourceId);
      const iid = encodeURIComponent(ref.itemId);
      return {
        id: `content.${itemKey(ref)}`,
        title,
        group,
        icon: CONTENT_ICONS[ref.contentType],
        detail: sourceById.size > 1 ? [kind, source.name] : [kind],
        run: live
          ? () =>
              void import('@/features/player')
                .then(({ playItem }) =>
                  playItem({ ref, title, posterUrl: snapshot.posterUrl, isLive: true, isRadio: ref.contentType === 'radio', sourceKind: source.kind }),
                )
                .catch((err: unknown) =>
                  toast({ variant: 'error', title: t('playFailed', { title }), description: errorDescription(err) }),
                )
          : () => void navigate(`/s/${sid}/${ref.contentType}/${iid}`),
      };
    });
  }, [q, sources.data, favorites.data, recent.data, t, navigate]);
}

/** Most guide programmes the palette lists for one query. */
const PROGRAMME_LIMIT = 5;

/**
 * Guide programmes whose titles match the query (`epg.search` of each source, after a pause in
 * typing, only while the palette is open). One opens the guide at the programme.
 */
function useProgrammeItems(query: string, open: boolean): PaletteItem[] {
  const { t, i18n } = useTranslation('shell');
  const navigate = useNavigate();
  const sources = useVisibleSources();
  const prefs = useDisplayPrefs();
  const debounced = useDebounced(query.trim(), 200);
  const ids = useMemo(() => (sources.data ?? []).map((s) => s.id), [sources.data]);
  const { hits } = useProgrammeSearch(ids, debounced, { enabled: open, limit: PROGRAMME_LIMIT, offsetMinutes: prefs.epgOffsetMinutes });

  return useMemo(() => {
    if (!query.trim()) return [];
    const group = t('groupProgrammes');
    const lang = i18n.language;
    return hits.map((hit): PaletteItem => {
      const at = ms(hit.program.start);
      const link = guideHitLink(hit);
      return {
        id: `programme.${itemKey(hit.ref)}@${at}`,
        title: hit.program.title,
        group,
        icon: CalendarRange,
        detail: [`${formatDay(at, lang)} ${formatClock(at, lang)}`, displayChannelName(hit.channelName, prefs.stripCountryPrefix)],
        // The core matched the title with diacritics folded ("cafe" finds "Café"), which the
        // palette's own filter does not: the typed words count as its keywords.
        keywords: [debounced],
        run: () => void navigate(link.to, { state: link.state }),
      };
    });
  }, [query, hits, debounced, prefs.stripCountryPrefix, t, i18n.language, navigate]);
}

/**
 * What a settings section holds, as search words: its i18n keyword list (`settingsGeneralKeywords`
 * and so on) in the UI language and in English, so "language", "theme" or "pin" find the section
 * whatever language the app is in (L3-app-8).
 */
function settingsKeywords(key: string, section: string, t: TFunction, en: TFunction): string[] {
  const words = new Set(['settings', section]);
  for (const list of [t(`${key}Keywords`), en(`${key}Keywords`)]) {
    for (const w of list.split(',')) if (w.trim()) words.add(w.trim());
  }
  return [...words];
}

/** Built-in navigation, source, and settings commands. Exported for tests. */
export function usePaletteItems(): PaletteItem[] {
  const { t, i18n } = useTranslation(['shell', 'parental']);
  const navigate = useNavigate();
  const sources = useVisibleSources();
  const setHelpOpen = useShellStore((s) => s.setHelpOpen);
  const registered = useCommandList();
  const parental = useParentalStatus();
  // Only while a PIN is set and the session is unlocked: there is nothing to lock otherwise.
  const canLockParental = !!parental.data?.enabled && !!parental.data.unlocked;

  return useMemo(() => {
    const go = (to: string) => () => navigate(to);
    const nav = t('groupNavigation');
    const items: PaletteItem[] = [
      { id: 'nav.dashboard', title: t('navDashboard'), group: nav, icon: House, run: go('/dashboard'), keywords: ['home'] },
      { id: 'nav.search', title: t('navSearch'), group: nav, icon: Search, shortcut: 'mod+f', run: go('/search') },
      { id: 'nav.guide', title: t('navGuide'), group: nav, icon: CalendarRange, run: go('/epg'), keywords: ['epg', 'tv guide', 'schedule'] },
      { id: 'nav.multiview', title: t('navMultiview'), group: nav, icon: LayoutGrid, run: go('/multiview'), keywords: ['multiview', 'wall', 'split screen', 'mosaic'] },
      { id: 'nav.favorites', title: t('navFavorites'), group: nav, icon: Heart, run: go('/favorites') },
      { id: 'nav.myList', title: t('navMyList'), group: nav, icon: Bookmark, run: go('/my-list'), keywords: ['watchlist', 'watch later'] },
      { id: 'nav.lists', title: t('lists:title'), group: nav, icon: ListOrdered, run: go('/lists'), keywords: ['custom lists', 'channel lists', 'playlists'] },
      { id: 'nav.recent', title: t('navRecent'), group: nav, icon: History, shortcut: 'mod+r', run: go('/recent'), keywords: ['history'] },
      { id: 'nav.downloads', title: t('navDownloads'), group: nav, icon: Download, run: go('/downloads') },
      { id: 'nav.myVideos', title: t('navMyVideos'), group: nav, icon: HardDrive, run: go('/my-videos'), keywords: ['offline'] },
      { id: 'nav.scheduled', title: t('navScheduled'), group: nav, icon: AlarmClock, run: go('/scheduled'), keywords: ['recordings', 'reminders'] },
      { id: 'nav.stats', title: t('stats:title'), group: nav, icon: ChartColumn, run: go('/stats'), keywords: ['statistics', 'time watched', 'history'] },
      { id: 'nav.sources', title: t('manageSources'), group: nav, icon: ListVideo, run: go('/sources'), keywords: ['playlists'] },
      { id: 'nav.addSource', title: t('addSource'), group: nav, icon: Plus, run: go('/sources?add=1'), keywords: ['playlist', 'm3u', 'xtream', 'stalker', 'portal'] },
      { id: 'nav.settings', title: t('navSettings'), group: nav, icon: SettingsIcon, run: go('/settings'), keywords: ['preferences'] },
    ];

    const srcGroup = t('groupSources');
    for (const s of sources.data ?? []) {
      // An M3U source lists Radio only when it has stations, as in the rail.
      for (const l of railLinks(s, { hasRadio: (s.radioCount ?? 0) > 0 })) {
        items.push({
          id: `source.${s.id}.${l.id}`,
          title: t('sourceSection', { source: s.name, section: t(l.labelKey) }),
          group: srcGroup,
          icon: l.icon,
          run: go(l.to),
          keywords: [s.name, s.kind, l.id],
        });
      }
    }

    const set = t('groupSettings');
    items.push(
      { id: 'theme.dark', title: t('themeDark'), group: set, icon: Moon, run: () => void persistTheme('dark'), keywords: ['theme', 'night'] },
      { id: 'theme.light', title: t('themeLight'), group: set, icon: Sun, run: () => void persistTheme('light'), keywords: ['theme', 'day'] },
      { id: 'theme.system', title: t('themeSystem'), group: set, icon: Monitor, run: () => void persistTheme('system'), keywords: ['theme', 'auto'] },
      { id: 'help.shortcuts', title: t('keyboardShortcuts'), group: set, icon: Keyboard, shortcut: '?', run: () => setHelpOpen(true), keywords: ['keys', 'help'] },
      // Run 3 C7: replay the first-run tour, or read every release's notes.
      { id: 'help.tour', title: t('takeTour'), group: set, icon: Route, run: openTour, keywords: ['tour', 'onboarding', 'introduction', 'help', 'guide'] },
      { id: 'help.whatsNew', title: t('whatsNew'), group: set, icon: Gift, run: openWhatsNew, keywords: ['release notes', 'changelog', 'updates', 'version'] },
    );
    if (canLockParental) {
      items.push({
        id: 'parental.lockNow',
        title: t('lockParentalNow'),
        group: set,
        icon: Lock,
        shortcut: 'mod+alt+l',
        keywords: ['parental', 'pin', 'lock', 'kids'],
        run: () =>
          void lockNow().then(
            () => toast({ variant: 'success', title: t('parental:lockedNowToast') }),
            (err: unknown) => toast({ variant: 'error', title: t('parental:saveFailed'), description: errorDescription(err) }),
          ),
      });
    }
    const en = i18n.getFixedT('en', 'shell');
    for (const section of SETTINGS_SECTIONS) {
      // External players run only in the desktop app; the browser's settings page has no such section.
      if (section === 'players' && !isDesktop) continue;
      const key = `settings${section[0]!.toUpperCase()}${section.slice(1)}`;
      items.push({
        id: `settings.${section}`,
        title: t('settingsSection', { section: t(key) }),
        group: set,
        icon: SettingsIcon,
        run: go(`/settings/${section}`),
        keywords: settingsKeywords(key, section, t, en),
      });
    }

    for (const c of registered) {
      items.push({ id: `cmd.${c.id}`, title: c.title, group: c.group, icon: Terminal, shortcut: c.shortcut, keywords: c.keywords, run: () => c.run() });
    }
    return items;
  }, [t, navigate, sources.data, setHelpOpen, registered, canLockParental]);
}

export function CommandPalette() {
  const { t } = useTranslation('shell');
  const open = useShellStore((s) => s.paletteOpen);
  const setOpen = useShellStore((s) => s.setPaletteOpen);
  const items = usePaletteItems();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const content = useContentItems(query, open);
  const programmes = useProgrammeItems(query, open);
  // Every way of closing (Esc, the scrim, Ctrl+K again, Back) leaves the next open empty: the
  // query resets as the palette opens, during render, so no frame shows the old filter.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open && query !== '') setQuery('');
  }

  // Favourites and recent items lead: a tie with a command goes to the content.
  const groups = useMemo(() => {
    const map = new Map<string, PaletteItem[]>();
    for (const it of [...content, ...programmes, ...items]) {
      const list = map.get(it.group) ?? [];
      list.push(it);
      map.set(it.group, list);
    }
    return [...map.entries()];
  }, [content, programmes, items]);

  // cmdk 1.1 sorts items inside a group but never moves the groups themselves (it looks a
  // group up by its value while tracking it by an internal id), so "Go to" always led. Order
  // the groups here by their best match while a query is typed; ties keep the default order.
  const ranked = useMemo(() => {
    const q = query.trim();
    if (!q) return groups;
    const best = (list: PaletteItem[]) => Math.max(0, ...list.map((it) => paletteFilter(it.title, q, it.keywords)));
    return groups
      .map((g) => [g, best(g[1])] as const)
      .sort((a, b) => b[1] - a[1])
      .map(([g]) => g);
  }, [groups, query]);

  // A new query re-ranks the list and cmdk selects its first item; bring the top back into
  // view so Enter never runs an item scrolled out of sight. cmdk re-sorts the DOM in its own
  // effect afterwards and scroll anchoring then nudges the list (about one group heading),
  // so the reset is repeated a frame later, before checking the selected item.
  const listRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTop = 0;
    const raf = requestAnimationFrame(() => {
      list.scrollTop = 0;
      list.querySelector<HTMLElement>('[cmdk-item][data-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(raf);
  }, [query]);

  const close = () => {
    setOpen(false);
    setQuery('');
  };
  const run = (fn: () => void) => {
    close();
    // Let the dialog unmount (and restore focus) before the command moves focus elsewhere.
    setTimeout(fn, 0);
  };

  return (
    <Dialog open={open} onClose={close} title={t('commandPalette')} hideTitle hideClose size="md" bodyClassName="p-0" testId="command-palette">
      {/*
        vimBindings off: cmdk's Ctrl+K (move up) would claim the key, and the
        shell's mod+k must reach the registry to toggle the palette closed.
      */}
      <Cmdk label={t('commandPalette')} loop vimBindings={false} filter={paletteFilter} className="flex flex-col">
        <div className="flex items-center gap-3 border-b border-divider px-4">
          <Search aria-hidden size={18} className="shrink-0 text-fg-subtle" />
          <Cmdk.Input
            data-autofocus=""
            value={query}
            onValueChange={setQuery}
            placeholder={t('palettePlaceholder')}
            className="h-14 min-w-0 flex-1 bg-transparent text-base text-fg outline-none placeholder:text-fg-subtle focus-visible:shadow-none focus-visible:outline-none"
          />
          <Kbd>Esc</Kbd>
        </div>
        <Cmdk.List ref={listRef} className="max-h-[min(60vh,480px)] overflow-y-auto overscroll-contain p-2">
          <Cmdk.Empty className="px-4 py-10 text-center text-sm text-fg-muted">{t('paletteEmpty')}</Cmdk.Empty>
          {ranked.map(([group, list]) => (
            <Cmdk.Group key={group} heading={group}>
              {list.map((it) => {
                const Icon = it.icon;
                return (
                  <Cmdk.Item
                    key={it.id}
                    value={`${it.title}${VALUE_SEP}${it.id}`}
                    keywords={it.keywords}
                    onSelect={() => run(it.run)}
                    className="flex h-11 cursor-pointer items-center gap-3 rounded-md px-3 text-sm text-fg-muted"
                  >
                    {Icon && <Icon aria-hidden size={16} className="shrink-0" />}
                    <span dir="auto" title={it.title} className="min-w-0 flex-1 truncate text-match-parent">
                      {it.title}
                    </span>
                    {it.detail?.map((d, i) => (
                      <span key={i} dir="auto" title={i > 0 ? d : undefined} className={cn('shrink-0 text-xs text-fg-subtle', i > 0 && 'max-w-40 truncate')}>
                        {d}
                      </span>
                    ))}
                    {it.shortcut && <Kbd combo={it.shortcut} />}
                  </Cmdk.Item>
                );
              })}
            </Cmdk.Group>
          ))}
          {query.trim().length > 0 && (
            <Cmdk.Group heading={t('groupSearch')} forceMount>
              <Cmdk.Item
                value={`search-everywhere ${query}`}
                forceMount
                onSelect={() => run(() => navigate(`/search?q=${encodeURIComponent(query.trim())}`))}
                className="flex h-11 cursor-pointer items-center gap-3 rounded-md px-3 text-sm text-fg-muted"
              >
                <Search aria-hidden size={16} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">{t('searchFor', { query: query.trim() })}</span>
                <CornerDownLeft aria-hidden size={14} className="text-fg-subtle" />
              </Cmdk.Item>
            </Cmdk.Group>
          )}
        </Cmdk.List>
        <div className="flex items-center gap-4 border-t border-divider px-4 py-2 text-xs text-fg-subtle">
          <span className="flex items-center gap-1.5">
            <Kbd combo="arrowup" />
            <Kbd combo="arrowdown" />
            {t('paletteHintMove')}
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd combo="enter" />
            {t('paletteHintRun')}
          </span>
        </div>
      </Cmdk>
    </Dialog>
  );
}
