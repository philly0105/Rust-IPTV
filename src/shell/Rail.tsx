import {
  CalendarRange,
  ChevronDown,
  Download,
  HardDrive,
  Heart,
  History,
  Keyboard,
  LayoutDashboard,
  ListVideo,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RotateCw,
  Search,
  Settings as SettingsIcon,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, NavLink, useLocation } from 'react-router';

import { useRpcQuery } from '@/api/query';
import type { Source, SourceKind } from '@/api/types';
import { cn, hueOf, initialsOf, Skeleton } from '@/ui';

import { railLinks, sourceBasePath } from './railLinks';
import { useShellStore } from './store';

interface PrimaryLink {
  to: string;
  labelKey: string;
  icon: LucideIcon;
  end?: boolean;
}

const PRIMARY: PrimaryLink[] = [
  { to: '/dashboard', labelKey: 'navDashboard', icon: LayoutDashboard },
  { to: '/search', labelKey: 'navSearch', icon: Search },
  { to: '/epg', labelKey: 'navGuide', icon: CalendarRange },
  { to: '/favorites', labelKey: 'navFavorites', icon: Heart },
  { to: '/recent', labelKey: 'navRecent', icon: History },
  { to: '/downloads', labelKey: 'navDownloads', icon: Download },
  { to: '/my-videos', labelKey: 'navMyVideos', icon: HardDrive },
];

const KIND_LABEL: Record<SourceKind, string> = { m3u: 'M3U', xtream: 'XC', stalker: 'STB' };

const itemClass = (active: boolean, collapsed: boolean) =>
  cn(
    'group flex h-10 items-center gap-3 rounded-md text-sm font-medium outline-offset-[-2px]',
    'motion-safe:transition-colors motion-safe:duration-150',
    collapsed ? 'justify-center px-0' : 'px-3',
    active ? 'tuning-tick bg-surface-2 text-fg' : 'text-fg-muted hover:bg-surface-2/60 hover:text-fg',
  );

function RailNavLink({ to, labelKey, icon: Icon, collapsed, end }: PrimaryLink & { collapsed: boolean }) {
  const { t } = useTranslation('shell');
  const label = t(labelKey);
  return (
    <NavLink
      to={to}
      end={end}
      title={collapsed ? label : undefined}
      aria-label={collapsed ? label : undefined}
      className={({ isActive }) => itemClass(isActive, collapsed)}
    >
      {({ isActive }) => (
        <>
          <Icon aria-hidden size={18} className={cn('shrink-0', isActive && 'text-accent')} />
          {!collapsed && <span className="truncate">{label}</span>}
        </>
      )}
    </NavLink>
  );
}

function SourceMark({ source, size = 'sm' }: { source: Source; size?: 'sm' | 'md' }) {
  const hue = hueOf(source.name);
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-sm font-display font-semibold text-white',
        size === 'sm' ? 'h-6 w-6 text-[11px]' : 'h-9 w-9 text-sm',
      )}
      style={{ background: `linear-gradient(150deg, hsl(${hue} 42% 38%), hsl(${(hue + 36) % 360} 48% 24%))` }}
    >
      {initialsOf(source.name)}
    </span>
  );
}

function SourceEntry({ source, collapsed, active }: { source: Source; collapsed: boolean; active: boolean }) {
  const { t } = useTranslation('shell');
  const [expanded, setExpanded] = useState(active);
  useEffect(() => {
    if (active) setExpanded(true);
  }, [active]);

  const radio = useRpcQuery(
    'catalog.channels',
    { sourceId: source.id, query: { offset: 0, limit: 1 }, radio: true },
    { enabled: source.kind === 'm3u' && (expanded || active), staleTime: 5 * 60_000 },
  );
  const links = railLinks(source, { hasRadio: (radio.data?.total ?? 0) > 0 });
  const listId = `rail-source-${source.id}`;

  if (collapsed) {
    return (
      <li>
        <Link
          to={`${sourceBasePath(source.id)}/live`}
          title={source.name}
          aria-label={source.name}
          className={cn(itemClass(active, true))}
        >
          <SourceMark source={source} />
        </Link>
      </li>
    );
  }

  return (
    <li>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={listId}
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          'flex h-10 w-full items-center gap-3 rounded-md px-3 text-start text-sm',
          active ? 'text-fg' : 'text-fg-muted hover:bg-surface-2/60 hover:text-fg',
        )}
      >
        <SourceMark source={source} />
        <span className="min-w-0 flex-1 truncate font-medium">{source.name}</span>
        {source.lastError ? (
          <span className="h-2 w-2 shrink-0 rounded-full bg-danger" title={t('sourceHasError')} aria-label={t('sourceHasError')} />
        ) : (
          <span className="shrink-0 text-[10px] font-semibold text-fg-subtle">{KIND_LABEL[source.kind]}</span>
        )}
        <ChevronDown
          aria-hidden
          size={14}
          className={cn('shrink-0 text-fg-subtle motion-safe:transition-transform', expanded ? 'rotate-0' : '-rotate-90')}
        />
      </button>
      {expanded && (
        <ul id={listId} className="mt-0.5 mb-1 ms-[22px] flex flex-col gap-0.5 border-s border-border ps-2">
          {links.map((l) => (
            <li key={l.id}>
              <NavLink
                to={l.to}
                className={({ isActive }) =>
                  cn(
                    'flex h-8 items-center gap-2.5 rounded-sm px-2.5 text-[13px]',
                    isActive ? 'tuning-tick bg-surface-2 font-medium text-fg' : 'text-fg-muted hover:bg-surface-2/60 hover:text-fg',
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    <l.icon aria-hidden size={15} className={cn('shrink-0', isActive && 'text-accent')} />
                    <span className="truncate">{t(l.labelKey)}</span>
                  </>
                )}
              </NavLink>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function Rail({ collapsed, autoCollapsed }: { collapsed: boolean; autoCollapsed: boolean }) {
  const { t } = useTranslation('shell');
  const sources = useRpcQuery('sources.list', undefined);
  const toggleRail = useShellStore((s) => s.toggleRail);
  const setHelpOpen = useShellStore((s) => s.setHelpOpen);
  const location = useLocation();
  const activeSourceId = /^\/s\/([^/]+)/.exec(location.pathname)?.[1];

  return (
    <nav
      aria-label={t('mainNavigation')}
      data-testid="shell-rail"
      data-collapsed={collapsed || undefined}
      className={cn(
        'flex h-full shrink-0 flex-col border-e border-border bg-surface',
        collapsed ? 'w-(--rail-width-collapsed)' : 'w-(--rail-width)',
      )}
    >
      <div className={cn('flex h-(--header-height) shrink-0 items-center gap-2', collapsed ? 'justify-center px-2' : 'px-4')}>
        <Link to="/dashboard" className="flex min-w-0 items-center gap-2.5 rounded-md" aria-label={t('appName')}>
          <span aria-hidden className="relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface-3">
            <span className="absolute inset-x-2 bottom-2 h-0.5 rounded-full bg-fg-subtle/60" />
            <span className="absolute bottom-2 left-[55%] h-4 w-0.5 rounded-full bg-accent shadow-[0_0_8px_var(--color-accent)]" />
          </span>
          {!collapsed && <span className="truncate font-display text-lg font-semibold tracking-wide">{t('appName')}</span>}
        </Link>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overflow-x-hidden px-2 pb-3">
        <ul className="flex flex-col gap-0.5">
          {PRIMARY.map((l) => (
            <li key={l.to}>
              <RailNavLink {...l} collapsed={collapsed} />
            </li>
          ))}
        </ul>

        <section aria-labelledby="rail-sources-heading" className="flex flex-col gap-1">
          <div className={cn('flex items-center', collapsed ? 'justify-center' : 'justify-between px-3')}>
            <h2 id="rail-sources-heading" className={cn('text-xs font-semibold text-fg-subtle', collapsed && 'sr-only')}>
              {t('sources')}
            </h2>
            <Link
              to="/sources?add=1"
              title={t('addSource')}
              aria-label={t('addSource')}
              className="inline-flex h-8 w-8 items-center justify-center rounded-sm text-fg-subtle hover:bg-surface-2 hover:text-fg"
            >
              <Plus aria-hidden size={16} />
            </Link>
          </div>
          {sources.isPending ? (
            <div className="flex flex-col gap-2 px-3 py-1" aria-hidden>
              <Skeleton className="h-6" />
              <Skeleton className="h-6 w-4/5" />
            </div>
          ) : sources.isError ? (
            <div
              data-testid="rail-sources-error"
              className={cn('flex items-center gap-2', collapsed ? 'justify-center' : 'justify-between ps-3 pe-1')}
            >
              <p role="alert" className={cn('min-w-0 text-[13px] text-danger', collapsed && 'sr-only')}>
                {t('sourcesLoadFailed')}
              </p>
              <button
                type="button"
                onClick={() => void sources.refetch()}
                disabled={sources.isFetching}
                title={t('retry', { ns: 'common' })}
                aria-label={t('retry', { ns: 'common' })}
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-fg-muted hover:bg-surface-2 hover:text-fg disabled:opacity-50"
              >
                <RotateCw aria-hidden size={15} className={cn(sources.isFetching && 'motion-safe:animate-spin')} />
              </button>
            </div>
          ) : sources.data && sources.data.length > 0 ? (
            <ul className="flex flex-col gap-0.5" data-testid="rail-sources">
              {sources.data.map((s) => (
                <SourceEntry key={s.id} source={s} collapsed={collapsed} active={activeSourceId === encodeURIComponent(s.id) || activeSourceId === s.id} />
              ))}
            </ul>
          ) : (
            !collapsed && (
              <p className="px-3 text-[13px] text-fg-muted">
                {t('noSourcesYet')}{' '}
                <Link to="/sources?add=1" className="font-medium text-accent hover:underline">
                  {t('addFirstSource')}
                </Link>
              </p>
            )
          )}
          <RailNavLink to="/sources" labelKey="manageSources" icon={ListVideo} collapsed={collapsed} end />
        </section>
      </div>

      <div className="flex shrink-0 flex-col gap-0.5 border-t border-border p-2">
        <RailNavLink to="/settings" labelKey="navSettings" icon={SettingsIcon} collapsed={collapsed} />
        <button
          type="button"
          onClick={() => setHelpOpen(true)}
          title={collapsed ? t('keyboardShortcuts') : undefined}
          aria-label={collapsed ? t('keyboardShortcuts') : undefined}
          className={itemClass(false, collapsed)}
        >
          <Keyboard aria-hidden size={18} className="shrink-0" />
          {!collapsed && <span className="truncate">{t('keyboardShortcuts')}</span>}
        </button>
        {!autoCollapsed && (
          <button
            type="button"
            onClick={toggleRail}
            aria-label={collapsed ? t('expandRail') : t('collapseRail')}
            title={collapsed ? t('expandRail') : t('collapseRail')}
            className={itemClass(false, collapsed)}
          >
            {collapsed ? (
              <PanelLeftOpen aria-hidden size={18} className="shrink-0" />
            ) : (
              <PanelLeftClose aria-hidden size={18} className="shrink-0" />
            )}
            {!collapsed && <span className="truncate">{t('collapseRail')}</span>}
          </button>
        )}
      </div>
    </nav>
  );
}
