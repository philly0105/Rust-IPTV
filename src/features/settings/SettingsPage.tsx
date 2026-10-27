import { clsx } from 'clsx';
import {
  CalendarClock,
  ChevronRight,
  Clapperboard,
  // recording:
  CircleDot,
  DatabaseBackup,
  Info,
  Keyboard,
  MonitorPlay,
  Palette,
  Play,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ComponentType, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, NavLink, useLocation, useNavigate, useParams } from 'react-router';

import { isDesktop } from '@/api/transport';
import { ParentalSection } from '@/features/parental/ParentalSection';
import { useShell } from '@/shell';
import { useMediaQuery } from '@/shell/useMediaQuery';
import { Page } from '@/ui';
import { SaveFeedback, SectionError, SectionSkeleton, type SaveState } from './components';
import type { SettingsPatch } from './lib/patch';
import { useSettingsQuery, useUpdateSettings } from './lib/useUpdateSettings';
import { AboutSection } from './sections/AboutSection';
import { AppearanceSection } from './sections/AppearanceSection';
import { BackupSection } from './sections/BackupSection';
import { EpgSection } from './sections/EpgSection';
import { GeneralSection } from './sections/GeneralSection';
import { MetadataSection } from './sections/MetadataSection';
import { PlaybackSection } from './sections/PlaybackSection';
import { PlayersSection } from './sections/PlayersSection';
// recording:
import { RecordingSection } from './sections/RecordingSection';
import { RemoteSection } from './sections/RemoteSection';
import { ShortcutsSection } from './sections/ShortcutsSection';
import { isSectionId, type SectionId, type SectionProps } from './sections/types';

const SECTIONS: Record<SectionId, { icon: LucideIcon; label: string; lead?: string; component: ComponentType<SectionProps> }> = {
  general: { icon: SlidersHorizontal, label: 'sectionGeneral', lead: 'sectionGeneralLead', component: GeneralSection },
  playback: { icon: Play, label: 'sectionPlayback', lead: 'sectionPlaybackLead', component: PlaybackSection },
  players: { icon: MonitorPlay, label: 'sectionPlayers', lead: 'sectionPlayersLead', component: PlayersSection },
  epg: { icon: CalendarClock, label: 'sectionEpg', lead: 'sectionEpgLead', component: EpgSection },
  // recording:
  recording: { icon: CircleDot, label: 'sectionRecording', lead: 'recordingSectionHint', component: RecordingSection },
  metadata: { icon: Clapperboard, label: 'sectionMetadata', lead: 'sectionMetadataLead', component: MetadataSection },
  appearance: { icon: Palette, label: 'sectionAppearance', lead: 'sectionAppearanceLead', component: AppearanceSection },
  parental: { icon: ShieldCheck, label: 'sectionParental', lead: 'sectionParentalLead', component: ParentalSection },
  remote: { icon: Smartphone, label: 'sectionRemote', lead: 'sectionRemoteLead', component: RemoteSection },
  backup: { icon: DatabaseBackup, label: 'sectionBackup', lead: 'sectionBackupLead', component: BackupSection },
  shortcuts: { icon: Keyboard, label: 'sectionShortcuts', lead: 'sectionShortcutsLead', component: ShortcutsSection },
  about: { icon: Info, label: 'sectionAbout', lead: 'sectionAboutLead', component: AboutSection },
};

/**
 * The sections this host offers. External players run only in the desktop app, and the core
 * refuses their paths and arguments in server mode, so the browser has no External players section.
 */
export function sectionAvailable(id: SectionId): boolean {
  return isDesktop || id !== 'players';
}

/**
 * The nav's groups, in order (SS-7). Every section is in exactly one; a test checks that. The
 * order differs from SECTION_IDS, which the command palette copies.
 */
export const NAV_GROUPS: readonly { id: string; label: string; sections: readonly SectionId[] }[] = [
  { id: 'app', label: 'navGroupApp', sections: ['general', 'appearance', 'shortcuts'] },
  { id: 'watching', label: 'navGroupWatching', sections: ['playback', 'players', 'epg', 'recording', 'metadata'] },
  { id: 'household', label: 'navGroupHousehold', sections: ['parental', 'remote'] },
  { id: 'system', label: 'navGroupSystem', sections: ['backup', 'about'] },
];

/**
 * A device with touch and nothing that hovers: a phone or a tablet without a trackpad. Its nav
 * leaves out Keyboard shortcuts, a list of keys it has no keyboard for. A tablet with a keyboard
 * case or trackpad reports a fine pointer or hover and keeps it. The route itself stays, so a
 * link or the command palette still opens the section.
 */
export const TOUCH_ONLY_QUERY = '(hover: none) and (pointer: coarse)';

/**
 * Below this width Settings is a list of sections that opens one at a time (the phone layout);
 * from it up the page has a sticky section nav on the inline start, beside the section.
 */
export const PHONE_QUERY = '(max-width: 767.98px)';

/**
 * The section nav. `sidebar`: a sticky column at the start of the page, grouped under small
 * headings, like the settings of Linear, Vercel or Raycast; the current section has the selected
 * fill and the amber tick. `list`: the phone's Settings screen, one row per section with its
 * lead line and a chevron, opening that section.
 */
export function SettingsNav({ current, variant = 'sidebar' }: { current?: SectionId; variant?: 'sidebar' | 'list' }) {
  const { t } = useTranslation('settings');
  const touchOnly = useMediaQuery(TOUCH_ONLY_QUERY);
  const listed = (id: SectionId) => sectionAvailable(id) && !(touchOnly && id === 'shortcuts' && id !== current);
  const groups = NAV_GROUPS.map((g) => ({ ...g, sections: g.sections.filter(listed) })).filter((g) => g.sections.length > 0);

  if (variant === 'list') {
    return (
      <nav aria-label={t('navLabel')} className="flex flex-col gap-6" data-testid="settings-nav-list">
        {groups.map((g) => (
          <div key={g.id} className="flex flex-col gap-2">
            <p id={`settings-nav-${g.id}`} className="px-1 text-caption font-medium text-fg-subtle">
              {t(g.label)}
            </p>
            {/* No overflow-hidden to round the rows: it would clip their focus ring. The first and
                last rows round themselves, so the hover fill keeps to the corners, and the ring is
                drawn inside the row, clear of the dividers and the group's edge. */}
            <ul aria-labelledby={`settings-nav-${g.id}`} className="flex flex-col divide-y divide-divider rounded-lg border border-edge bg-surface">
              {g.sections.map((id, i) => {
                const { icon: Icon, label, lead } = SECTIONS[id];
                return (
                  <li key={id}>
                    <Link
                      to={`/settings/${id}`}
                      // The section's Back goes back in history from here (see SettingsPage).
                      state={{ fromSettingsList: true }}
                      className={clsx(
                        'flex min-h-14 items-center gap-3 px-3 py-2.5 hover:bg-hover focus-visible:outline-offset-[-2px] active:bg-active motion-safe:transition-colors',
                        i === 0 && 'rounded-t-[calc(var(--radius-lg)-1px)]',
                        i === g.sections.length - 1 && 'rounded-b-[calc(var(--radius-lg)-1px)]',
                      )}
                    >
                      <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-md border border-edge bg-surface-2 text-fg-muted">
                        <Icon size={16} />
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="text-body font-medium text-fg">{t(label)}</span>
                        {/* Two lines, not one cut mid-word: at phone width most leads run past one. */}
                        {lead ? <span className="line-clamp-2 text-caption text-fg-muted">{t(lead)}</span> : null}
                      </span>
                      <ChevronRight aria-hidden size={16} className="shrink-0 text-fg-subtle rtl:rotate-180" />
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    );
  }

  return (
    <nav aria-label={t('navLabel')} className="flex flex-col gap-5" data-testid="settings-nav">
      {groups.map((g) => (
        <div key={g.id} className="flex flex-col gap-0.5">
          <p id={`settings-nav-${g.id}`} className="px-3 pb-1 text-caption font-medium text-fg-subtle">
            {t(g.label)}
          </p>
          <ul aria-labelledby={`settings-nav-${g.id}`} className="flex flex-col gap-0.5">
            {g.sections.map((id) => {
              const { icon: Icon, label } = SECTIONS[id];
              const active = id === current;
              return (
                <li key={id}>
                  <NavLink
                    to={`/settings/${id}`}
                    aria-current={active ? 'page' : undefined}
                    className={clsx(
                      'flex min-h-9 items-center gap-2.5 rounded-md px-3 py-1.5 text-body-sm font-medium motion-safe:transition-colors',
                      active ? 'tuning-tick bg-selected text-fg' : 'text-fg-muted hover:bg-hover hover:text-fg active:bg-active',
                    )}
                  >
                    <Icon aria-hidden size={16} className={clsx('shrink-0', active && 'text-accent')} />
                    <span className="min-w-0 truncate">{t(label)}</span>
                  </NavLink>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/** How long the "Saved" confirmation stays up after the last successful save. */
export const SAVED_VISIBLE_MS = 2000;

/** A press this recent names the row a save came from; older, the focused row does. */
const PRESS_WINDOW_MS = 1500;

/** The settings row `el` is in, by its `data-settings-row` id. */
function rowOf(el: EventTarget | Element | null): string | null {
  return el instanceof Element ? (el.closest('[data-settings-row]')?.getAttribute('data-settings-row') ?? null) : null;
}

/**
 * Wraps `update` so the page can confirm every save: "Saving..." while any request is in
 * flight, then "Saved" for a moment, beside the row that changed (SS-17). The row is the one the
 * user last pressed (a switch in WebKit does not take focus on a click), or else the one holding
 * focus (keyboard, a field committing on blur). Failures already toast with a retry, so they
 * just clear the indicator.
 */
function useSaveStatus(update: (patch: SettingsPatch) => Promise<boolean>) {
  const [status, setStatus] = useState<{ state: SaveState; rowId: string | null }>({ state: 'idle', rowId: null });
  const inFlight = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const press = useRef<{ row: string | null; at: number }>({ row: null, at: 0 });
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const tracked = useCallback(
    async (patch: SettingsPatch): Promise<boolean> => {
      if (timer.current) clearTimeout(timer.current);
      const pressed = Date.now() - press.current.at < PRESS_WINDOW_MS ? press.current.row : null;
      const rowId = pressed ?? rowOf(document.activeElement);
      inFlight.current += 1;
      setStatus({ state: 'saving', rowId });
      let ok = false;
      try {
        ok = await update(patch);
      } finally {
        inFlight.current -= 1;
        if (inFlight.current === 0) {
          setStatus((s) => ({ state: ok ? 'saved' : 'idle', rowId: s.rowId }));
          if (ok) timer.current = setTimeout(() => setStatus((s) => ({ state: 'idle', rowId: s.rowId })), SAVED_VISIBLE_MS);
        }
      }
      return ok;
    },
    [update],
  );
  const onPointerDownCapture = useCallback((e: PointerEvent) => {
    press.current = { row: rowOf(e.target), at: Date.now() };
  }, []);
  return { status, update: tracked, onPointerDownCapture };
}

/** Polite live region confirming saves; always mounted so screen readers hear the change. The visible mark is in the row. */
function SaveStatus({ state }: { state: SaveState }) {
  const { t } = useTranslation('settings');
  return (
    <p role="status" aria-live="polite" data-testid="settings-save-status" data-state={state} className="sr-only">
      {state === 'saving' ? t('saving') : state === 'saved' ? t('saved') : ''}
    </p>
  );
}

export function SettingsPage() {
  const { section } = useParams();
  const { t } = useTranslation('settings');
  const { setHeader } = useShell();
  const phone = useMediaQuery(PHONE_QUERY);
  const query = useSettingsQuery();
  const save = useSaveStatus(useUpdateSettings());
  const location = useLocation();
  const navigate = useNavigate();
  // `/settings` itself: the phone's list of sections; a wider window goes straight to General.
  const index = section === undefined;
  const valid = isSectionId(section) && sectionAvailable(section);
  const current: SectionId = valid ? section : 'general';
  // A phone shows one section at a time: the header names it and holds the way back to the list.
  const phoneSection = phone && valid;
  const fromList = (location.state as { fromSettingsList?: boolean } | null)?.fromSettingsList === true;

  useEffect(() => {
    if (phoneSection) {
      // The header's Back to the list. From the list, back in history: a pushed /settings would leave
      // list and sections taking turns in history, so the system back from the list went to the
      // section just left instead of out of Settings. Opened any other way (a deep link, the command
      // palette, a link in another section), the list replaces this section.
      const backToList = () => {
        if (fromList) navigate(-1);
        else navigate('/settings', { replace: true });
      };
      setHeader({ title: t(SECTIONS[current].label), documentTitle: t('title'), back: { onClick: backToList, label: t('allSettings') } });
    } else if (valid || index) {
      // The section's own heading names it; the header says only where the user is (no title said three times).
      setHeader({ title: t('title') });
    }
  }, [setHeader, t, valid, index, phoneSection, current, fromList, navigate]);

  if (index && !phone) return <Navigate to="/settings/general" replace />;
  if (!index && !valid) return <Navigate to="/settings/general" replace />;

  if (index) {
    return (
      <Page width="narrow" data-testid="settings-page">
        <h1 className="sr-only">{t('title')}</h1>
        <SettingsNav variant="list" />
      </Page>
    );
  }

  const Section = SECTIONS[current].component;

  return (
    <Page width="default" data-testid="settings-page" onPointerDownCapture={save.onPointerDownCapture}>
      {/* The page's single h1 (C16) matches the header title; each section's own title is its h2,
          which a phone hides, since its header already names the section. */}
      <h1 className="sr-only">{phone ? t(SECTIONS[current].label) : t('title')}</h1>
      <div className="flex items-start gap-8 lg:gap-12">
        {phone ? null : (
          // Sticky inside the shell's scrolling main, so the nav stays put down a long section.
          <aside className="sticky top-6 w-48 shrink-0 lg:w-52" data-testid="settings-sidebar">
            <SettingsNav current={current} />
          </aside>
        )}
        {/* Its own container: rows lay out by the column's width, not the window's. */}
        <div className="@container min-w-0 max-w-[46rem] flex-1">
          <SaveFeedback.Provider value={save.status}>
            {query.isPending ? (
              <SectionSkeleton />
            ) : query.isError ? (
              <SectionError error={query.error} onRetry={() => void query.refetch()} />
            ) : (
              <Section settings={query.data} update={save.update} />
            )}
          </SaveFeedback.Provider>
        </div>
      </div>
      <SaveStatus state={save.status.state} />
    </Page>
  );
}
