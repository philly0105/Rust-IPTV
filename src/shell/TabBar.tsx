/**
 * Phones (below sm, CB-PHONE-NAV): a bottom tab bar instead of the rail. The collapsed rail took
 * 72 px, a fifth of a 390 px screen, for nineteen unlabelled icons, and every page under it
 * truncated or wrapped. The bar holds Home, Live TV, the guide, Search and More; More opens a
 * sheet with the Library pages, the sources and Settings.
 *
 * The bar sits in the shell's column under the outlet, not over it, so no page needs bottom
 * padding for it. Overlays that float over the page read its height from --shell-bottom-inset on
 * <html> (SHELL_BOTTOM_INSET), which the shell sets while it shows; the toast stack measures the
 * bar itself (data-toast-avoid, ui/Toast.tsx) and lifts above it, as above the mini player.
 *
 * The tabs carry short labels of their own (tabHome, tabLive, tabGuide): a fifth of a 360 px
 * phone holds about eleven letters at the tab's text size, and the rail's longer names were cut
 * off in German, Greek, Polish and Belarusian.
 */

import { CalendarRange, ChevronRight, House, LayoutGrid, ListVideo, Menu as MenuIcon, Plus, Search, Settings as SettingsIcon, Trophy, Tv, type LucideIcon } from 'lucide-react';
import { memo, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, NavLink, useLocation } from 'react-router';

import type { Source } from '@/api/types';
import { cn, Dialog, SourceMonogram } from '@/ui';

import { isLiveRoute, LIBRARY_LINKS, liveTabTarget, readLastSource } from './navigation';
import { railLinkCurrent, railLinks, routeSourceId } from './railLinks';
import { useVisibleSources } from './useVisibleSources';

/** The bar's own height, in rem against the 15 px root: it follows the UI scale, not density. */
export const TAB_BAR_HEIGHT = 'calc(56rem / 15)';
/** What overlays lift by while the bar shows: its height plus the home indicator's safe area. */
export const SHELL_BOTTOM_INSET = `calc(${TAB_BAR_HEIGHT} + env(safe-area-inset-bottom, 0px))`;

interface Tab {
  id: 'home' | 'live' | 'guide' | 'search';
  to: string;
  label: string;
  icon: LucideIcon;
  active: boolean;
  tour?: 'search';
}

const tabClass = (active: boolean) =>
  cn(
    'relative flex h-full w-full flex-col items-center justify-center gap-1 rounded-md px-1 text-2xs font-medium outline-offset-[-2px] select-none',
    'motion-safe:transition-colors motion-safe:duration-(--duration-fast)',
    // The current tab: the accent tick along the bar's top edge, an accent icon and full text.
    active
      ? 'text-fg before:absolute before:inset-x-[30%] before:top-0 before:h-0.5 before:rounded-b-full before:bg-accent'
      : 'text-fg-muted active:bg-active',
  );

/** The bar. Rendered by the shell below sm only. */
export const TabBar = memo(function TabBar() {
  const { t } = useTranslation('shell');
  const sources = useVisibleSources();
  const { pathname, key } = useLocation();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreOpenRef = useRef(moreOpen);
  moreOpenRef.current = moreOpen;
  // The sheet closed because one of its links moved on: focus goes to the new page, not back to More.
  const leftFromSheet = useRef(false);
  // A tab or a link in the sheet moved on: the sheet belongs to the page it opened over.
  useEffect(() => {
    if (!moreOpenRef.current) return;
    leftFromSheet.current = true;
    setMoreOpen(false);
  }, [key]);
  // Runs after the sheet's own focus return (its layout effect), which put focus back on More.
  useEffect(() => {
    if (moreOpen || !leftFromSheet.current) return;
    leftFromSheet.current = false;
    document.getElementById('main')?.focus({ preventScroll: true });
  }, [moreOpen]);

  // The source on show first: the remembered one is written in an effect after this render, so
  // reading only that left the tab on the previous source until the next navigation.
  const live = liveTabTarget(sources.data, routeSourceId(pathname) ?? readLastSource());
  const tabs: Tab[] = [
    { id: 'home', to: '/dashboard', label: t('tabHome'), icon: House, active: pathname === '/dashboard' },
    // No sources yet: the tab leads to adding one, as Home does.
    { id: 'live', to: live ?? '/sources', label: t('tabLive'), icon: Tv, active: isLiveRoute(pathname) },
    { id: 'guide', to: '/epg', label: t('tabGuide'), icon: CalendarRange, active: pathname === '/epg' || pathname.startsWith('/epg/') },
    { id: 'search', to: '/search', label: t('navSearch'), icon: Search, active: pathname === '/search', tour: 'search' },
  ];
  const moreActive = !tabs.some((tab) => tab.active);

  return (
    <nav
      aria-label={t('mainNavigation')}
      data-testid="tab-bar"
      // Toasts lift above the bar instead of covering it (ui/Toast.tsx, TOAST_AVOID_SELECTOR).
      data-toast-avoid=""
      className="shrink-0 border-t border-divider bg-surface pb-[env(safe-area-inset-bottom,0px)]"
    >
      <ul className="grid grid-cols-5 px-1" style={{ height: TAB_BAR_HEIGHT }}>
        {tabs.map(({ id, to, label, icon: Icon, active, tour }) => (
          <li key={id} className="min-w-0">
            <Link to={to} aria-current={active ? 'page' : undefined} data-tab={id} data-tour={tour} className={tabClass(active)}>
              <Icon aria-hidden size={22} className={cn('shrink-0', active && 'text-accent')} />
              <span className="max-w-full truncate">{label}</span>
            </Link>
          </li>
        ))}
        <li className="min-w-0">
          <button
            type="button"
            aria-haspopup="dialog"
            aria-expanded={moreOpen}
            // The page on show lives in the sheet: More is the current tab, said as well as drawn.
            aria-current={moreActive ? 'true' : undefined}
            data-tab="more"
            onClick={() => setMoreOpen(true)}
            className={tabClass(moreActive)}
          >
            <MenuIcon aria-hidden size={22} className={cn('shrink-0', moreActive && 'text-accent')} />
            <span className="max-w-full truncate">{t('tabMore')}</span>
          </button>
        </li>
      </ul>
      <MoreSheet open={moreOpen} onClose={() => setMoreOpen(false)} sources={sources.data ?? []} pathname={pathname} />
    </nav>
  );
});

const rowClass = (active: boolean) =>
  cn(
    'flex min-h-12 items-center gap-3 rounded-md px-3 text-body font-medium',
    active ? 'tuning-tick bg-selected text-fg' : 'text-fg hover:bg-hover active:bg-active',
  );

/**
 * The More sheet: the kit Dialog as a bottom sheet (`sheet`), so it keeps the dialog's focus trap,
 * Escape, scroll lock and focus return. Below sm only, like the bar, which unmounts it above.
 */
function MoreSheet({ open, onClose, sources, pathname }: { open: boolean; onClose: () => void; sources: readonly Source[]; pathname: string }) {
  const { t } = useTranslation('shell');
  const current = (to: string) => pathname === to || pathname.startsWith(`${to}/`);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('tabMore')}
      testId="more-sheet"
      sheet
      className="max-sm:max-h-[85dvh]"
      bodyClassName="flex flex-col gap-6"
    >
      <section aria-labelledby="more-library" className="flex flex-col gap-2">
        <h3 id="more-library" className="text-caption font-medium text-fg-subtle">
          {t('navGroupLibrary')}
        </h3>
        <ul className="grid grid-cols-4 gap-2">
          {LIBRARY_LINKS.map(({ to, labelKey, icon: Icon }) => {
            const active = current(to);
            return (
              <li key={to} className="min-w-0">
                <NavLink
                  to={to}
                  className={cn(
                    'flex h-full flex-col items-center gap-1.5 rounded-lg px-1 py-2.5 text-center text-caption font-medium',
                    active ? 'bg-selected text-fg' : 'text-fg-muted hover:bg-hover active:bg-active',
                  )}
                >
                  <span aria-hidden className="flex size-11 items-center justify-center rounded-lg border border-edge bg-surface-2">
                    <Icon size={20} className={cn(active ? 'text-accent' : 'text-fg')} />
                  </span>
                  <span className="line-clamp-2 break-words">{t(labelKey)}</span>
                </NavLink>
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="more-sources" className="flex flex-col gap-2">
        <h3 id="more-sources" className="text-caption font-medium text-fg-subtle">
          {t('sources')}
        </h3>
        {sources.length === 0 ? (
          <Link to="/sources?add=1" className={cn(rowClass(false), 'border border-dashed border-edge')}>
            <Plus aria-hidden size={18} className="shrink-0 text-fg-muted" />
            <span className="min-w-0 flex-1 truncate">{t('addSource')}</span>
          </Link>
        ) : (
          <ul className="flex flex-col gap-1">
            {sources.map((s) => (
              <li key={s.id} className="flex flex-col gap-2 rounded-lg border border-edge bg-surface-2 p-3">
                <div className="flex min-w-0 items-center gap-3">
                  <SourceMonogram name={s.name} className="size-9 rounded-md text-sm" />
                  {/* text-match-parent: a Latin name in an RTL layout stays beside its monogram (as in the rail). */}
                  <span dir="auto" title={s.name} className="min-w-0 flex-1 truncate text-match-parent text-body font-medium text-fg">
                    {s.name}
                  </span>
                </div>
                {/* An M3U source lists Radio only when it has stations, as in the palette. */}
                <ul className="flex flex-wrap gap-1.5" aria-label={s.name}>
                  {/* What the source holds; its favourites and history are in Library above. */}
                  {railLinks(s, { hasRadio: (s.radioCount ?? 0) > 0 })
                    .filter((l) => l.id !== 'favorites' && l.id !== 'recent')
                    .map((l) => {
                    const active = railLinkCurrent(l, pathname);
                    return (
                      <li key={l.id}>
                        <NavLink
                          to={l.to}
                          className={cn(
                            'inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-body-sm font-medium',
                            active ? 'bg-fg text-bg' : 'bg-surface-3 text-fg hover:bg-pressed active:bg-pressed',
                          )}
                        >
                          <l.icon aria-hidden size={14} />
                          {t(l.labelKey)}
                        </NavLink>
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ul className="flex flex-col gap-0.5 border-t border-divider pt-3">
        {(
          [
            { to: '/sports', label: t('sports:title'), icon: Trophy },
            { to: '/multiview', label: t('navMultiview'), icon: LayoutGrid },
            { to: '/sources', label: t('manageSources'), icon: ListVideo },
            { to: '/settings', label: t('navSettings'), icon: SettingsIcon },
          ] as const
        ).map(({ to, label, icon: Icon }) => (
          <li key={to}>
            <NavLink to={to} className={rowClass(current(to))}>
              <Icon aria-hidden size={18} className={cn('shrink-0', current(to) ? 'text-accent' : 'text-fg-muted')} />
              <span className="min-w-0 flex-1 truncate">{label}</span>
              <ChevronRight aria-hidden size={16} className="shrink-0 text-fg-subtle rtl:rotate-180" />
            </NavLink>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
