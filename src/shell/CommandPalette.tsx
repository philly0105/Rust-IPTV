import { Command as Cmdk, defaultFilter } from 'cmdk';
import {
  CalendarRange,
  CornerDownLeft,
  Download,
  HardDrive,
  Heart,
  History,
  Keyboard,
  LayoutDashboard,
  ListVideo,
  Monitor,
  Moon,
  Plus,
  Search,
  Settings as SettingsIcon,
  Sun,
  Terminal,
  type LucideIcon,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { useRpcQuery } from '@/api/query';
import { Dialog, Kbd } from '@/ui';

import { useCommandList } from './commands';
import { railLinks } from './railLinks';
import { useShellStore } from './store';
import { persistTheme } from './theme';

export const SETTINGS_SECTIONS = [
  'general',
  'playback',
  'players',
  'epg',
  'metadata',
  'appearance',
  'remote',
  'backup',
  'shortcuts',
  'about',
] as const;

/** Separates an item's title from its id inside the cmdk value (the id keeps values unique). */
const VALUE_SEP = '';

/**
 * Fuzzy score for an item value: matches the visible title and keywords only,
 * so internal ids (`nav.*`, `settings.*`) never make unrelated items match.
 */
export function paletteFilter(value: string, search: string, keywords?: string[]): number {
  return defaultFilter(value.split(VALUE_SEP)[0] ?? value, search, keywords);
}

interface PaletteItem {
  id: string;
  title: string;
  group: string;
  icon?: LucideIcon;
  shortcut?: string;
  keywords?: string[];
  run(): void;
}

/** Built-in navigation, source, and settings commands. Exported for tests. */
export function usePaletteItems(): PaletteItem[] {
  const { t } = useTranslation('shell');
  const navigate = useNavigate();
  const sources = useRpcQuery('sources.list', undefined);
  const setHelpOpen = useShellStore((s) => s.setHelpOpen);
  const registered = useCommandList();

  return useMemo(() => {
    const go = (to: string) => () => navigate(to);
    const nav = t('groupNavigation');
    const items: PaletteItem[] = [
      { id: 'nav.dashboard', title: t('navDashboard'), group: nav, icon: LayoutDashboard, run: go('/dashboard'), keywords: ['home'] },
      { id: 'nav.search', title: t('navSearch'), group: nav, icon: Search, shortcut: 'mod+f', run: go('/search') },
      { id: 'nav.guide', title: t('navGuide'), group: nav, icon: CalendarRange, run: go('/epg'), keywords: ['epg', 'tv guide', 'schedule'] },
      { id: 'nav.favorites', title: t('navFavorites'), group: nav, icon: Heart, run: go('/favorites') },
      { id: 'nav.recent', title: t('navRecent'), group: nav, icon: History, shortcut: 'mod+r', run: go('/recent'), keywords: ['history'] },
      { id: 'nav.downloads', title: t('navDownloads'), group: nav, icon: Download, run: go('/downloads') },
      { id: 'nav.myVideos', title: t('navMyVideos'), group: nav, icon: HardDrive, run: go('/my-videos'), keywords: ['offline'] },
      { id: 'nav.sources', title: t('manageSources'), group: nav, icon: ListVideo, run: go('/sources'), keywords: ['playlists'] },
      { id: 'nav.addSource', title: t('addSource'), group: nav, icon: Plus, run: go('/sources?add=1'), keywords: ['playlist', 'm3u', 'xtream', 'stalker', 'portal'] },
      { id: 'nav.settings', title: t('navSettings'), group: nav, icon: SettingsIcon, run: go('/settings'), keywords: ['preferences'] },
    ];

    const srcGroup = t('groupSources');
    for (const s of sources.data ?? []) {
      for (const l of railLinks(s)) {
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
    );
    for (const section of SETTINGS_SECTIONS) {
      const key = `settings${section[0]!.toUpperCase()}${section.slice(1)}`;
      items.push({
        id: `settings.${section}`,
        title: t('settingsSection', { section: t(key) }),
        group: set,
        icon: SettingsIcon,
        run: go(`/settings/${section}`),
        keywords: ['settings', section],
      });
    }

    for (const c of registered) {
      items.push({ id: `cmd.${c.id}`, title: c.title, group: c.group, icon: Terminal, shortcut: c.shortcut, keywords: c.keywords, run: () => c.run() });
    }
    return items;
  }, [t, navigate, sources.data, setHelpOpen, registered]);
}

export function CommandPalette() {
  const { t } = useTranslation('shell');
  const open = useShellStore((s) => s.paletteOpen);
  const setOpen = useShellStore((s) => s.setPaletteOpen);
  const items = usePaletteItems();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');

  const groups = useMemo(() => {
    const map = new Map<string, PaletteItem[]>();
    for (const it of items) {
      const list = map.get(it.group) ?? [];
      list.push(it);
      map.set(it.group, list);
    }
    return [...map.entries()];
  }, [items]);

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
        <div className="flex items-center gap-3 border-b border-border px-4">
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
        <Cmdk.List className="max-h-[min(60vh,480px)] overflow-y-auto overscroll-contain p-2">
          <Cmdk.Empty className="px-4 py-10 text-center text-sm text-fg-muted">{t('paletteEmpty')}</Cmdk.Empty>
          {groups.map(([group, list]) => (
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
                    <span dir="auto" className="min-w-0 flex-1 truncate text-match-parent">{it.title}</span>
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
        <div className="flex items-center gap-4 border-t border-border px-4 py-2 text-xs text-fg-subtle">
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
