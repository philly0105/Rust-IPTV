import { clsx } from 'clsx';
import {
  CalendarClock,
  Check,
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
import { useCallback, useEffect, useRef, useState, type ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, NavLink, useParams } from 'react-router';

import { ParentalSection } from '@/features/parental/ParentalSection';
import { useShell } from '@/shell';
import { SectionError, SectionSkeleton } from './components';
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
import { SECTION_IDS, isSectionId, type SectionId, type SectionProps } from './sections/types';

const SECTIONS: Record<SectionId, { icon: LucideIcon; label: string; component: ComponentType<SectionProps> }> = {
  general: { icon: SlidersHorizontal, label: 'sectionGeneral', component: GeneralSection },
  playback: { icon: Play, label: 'sectionPlayback', component: PlaybackSection },
  players: { icon: MonitorPlay, label: 'sectionPlayers', component: PlayersSection },
  epg: { icon: CalendarClock, label: 'sectionEpg', component: EpgSection },
  // recording:
  recording: { icon: CircleDot, label: 'sectionRecording', component: RecordingSection },
  metadata: { icon: Clapperboard, label: 'sectionMetadata', component: MetadataSection },
  appearance: { icon: Palette, label: 'sectionAppearance', component: AppearanceSection },
  parental: { icon: ShieldCheck, label: 'sectionParental', component: ParentalSection },
  remote: { icon: Smartphone, label: 'sectionRemote', component: RemoteSection },
  backup: { icon: DatabaseBackup, label: 'sectionBackup', component: BackupSection },
  shortcuts: { icon: Keyboard, label: 'sectionShortcuts', component: ShortcutsSection },
  about: { icon: Info, label: 'sectionAbout', component: AboutSection },
};

/**
 * Section list. `panel` is the vertical list in the shell's context panel;
 * `inline` is the row the page shows itself where the shell has no room for the
 * panel (under 1440 px, the shell's inline-panel breakpoint): one
 * horizontally scrolling row of chips in a narrow container (a phone), with
 * the current section scrolled into view, and wrapping rows from @2xl.
 */
export function SettingsNav({ current, variant = 'panel' }: { current: SectionId; variant?: 'panel' | 'inline' }) {
  const { t } = useTranslation('settings');
  const inline = variant === 'inline';
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!inline) return;
    const nav = navRef.current;
    const active = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !active || nav.scrollWidth <= nav.clientWidth) return;
    // Centre the current chip inside the row only; never scroll the page.
    const navBox = nav.getBoundingClientRect();
    const box = active.getBoundingClientRect();
    nav.scrollLeft += box.left + box.width / 2 - (navBox.left + navBox.width / 2);
  }, [inline, current]);
  return (
    <nav
      ref={navRef}
      aria-label={t('navLabel')}
      className={
        inline
          ? '-mx-4 flex scroll-px-4 gap-1.5 overflow-x-auto px-4 pb-1 scrollbar-none @2xl:mx-0 @2xl:flex-wrap @2xl:overflow-visible @2xl:px-0 @2xl:pb-0'
          : 'flex flex-col gap-0.5 p-3'
      }
      data-testid={inline ? 'settings-nav-inline' : 'settings-nav'}
    >
      {SECTION_IDS.map((id) => {
        const { icon: Icon, label } = SECTIONS[id];
        const active = id === current;
        return (
          <NavLink
            key={id}
            to={`/settings/${id}`}
            aria-current={active ? 'page' : undefined}
            className={clsx(
              'flex items-center font-medium motion-safe:transition-colors',
              inline ? 'shrink-0 gap-2 whitespace-nowrap rounded-full border px-3 py-1.5 text-sm' : 'gap-3 rounded-md px-3 py-2 text-sm',
              inline
                ? active
                  ? 'border-accent/60 bg-accent/10 text-fg'
                  : 'border-border text-fg-muted hover:border-fg-subtle hover:bg-surface-2 hover:text-fg'
                : active
                  ? 'bg-surface-3 text-fg'
                  : 'text-fg-muted hover:bg-surface-2 hover:text-fg',
            )}
          >
            <Icon aria-hidden className={clsx('size-4', active && 'text-accent')} />
            {t(label)}
          </NavLink>
        );
      })}
    </nav>
  );
}

/** How long the "Saved" confirmation stays up after the last successful save. */
export const SAVED_VISIBLE_MS = 2000;

type SaveState = 'idle' | 'saving' | 'saved';

/**
 * Wraps `update` so the page can confirm every save: "Saving..." while any
 * request is in flight, then "Saved" for a moment. Failures already toast with
 * a retry, so they just clear the indicator.
 */
function useSaveStatus(update: (patch: SettingsPatch) => Promise<boolean>) {
  const [state, setState] = useState<SaveState>('idle');
  const inFlight = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const tracked = useCallback(
    async (patch: SettingsPatch): Promise<boolean> => {
      if (timer.current) clearTimeout(timer.current);
      inFlight.current += 1;
      setState('saving');
      let ok = false;
      try {
        ok = await update(patch);
      } finally {
        inFlight.current -= 1;
        if (inFlight.current === 0) {
          setState(ok ? 'saved' : 'idle');
          if (ok) timer.current = setTimeout(() => setState('idle'), SAVED_VISIBLE_MS);
        }
      }
      return ok;
    },
    [update],
  );
  return { state, update: tracked };
}

/** Polite live region confirming saves; always mounted so screen readers hear the change. */
function SaveStatus({ state }: { state: SaveState }) {
  const { t } = useTranslation('settings');
  return (
    <p
      role="status"
      aria-live="polite"
      data-testid="settings-save-status"
      data-state={state}
      className={clsx(
        'pointer-events-none fixed bottom-6 end-6 z-20 flex items-center gap-2 rounded-full border border-border bg-surface-2 px-3 py-1.5 text-sm font-medium text-fg shadow-1 motion-safe:transition-opacity',
        state === 'idle' ? 'opacity-0' : 'opacity-100',
      )}
    >
      {state === 'saved' ? <Check aria-hidden className="size-4 text-success" /> : null}
      {state === 'saving' ? t('saving') : state === 'saved' ? t('saved') : ''}
    </p>
  );
}

export function SettingsPage() {
  const { section } = useParams();
  const { t } = useTranslation('settings');
  const { setHeader, setContextPanel } = useShell();
  const query = useSettingsQuery();
  const save = useSaveStatus(useUpdateSettings());
  const valid = isSectionId(section);
  const current: SectionId = valid ? section : 'general';

  useEffect(() => {
    if (!valid) return;
    setHeader({ title: t('title'), subtitle: t(SECTIONS[current].label) });
  }, [setHeader, t, current, valid]);

  useEffect(() => {
    if (!valid) return;
    // Below 1440 px the page lists the sections inline (below), so no drawer and header toggle there.
    setContextPanel(<SettingsNav current={current} />, { drawer: false });
  }, [setContextPanel, current, valid]);

  useEffect(() => () => setContextPanel(null), [setContextPanel]);

  if (!valid) return <Navigate to="/settings/general" replace />;

  const Section = SECTIONS[current].component;

  return (
    <div className="@container mx-auto w-full max-w-4xl px-4 py-6 @2xl:px-8" data-testid="settings-page">
      {/* The page's single h1 (C16) matches the header title; each section's own title is its h2. */}
      <h1 className="sr-only">{t('title')}</h1>
      {/*
        At 1440 px and up the shell shows the context panel (and its section list) beside the page.
        Below that the panel has no drawer (drawer: false), so the page lists the sections itself.
      */}
      <div className="mb-6 border-b border-divider pb-4 @2xl:mb-8 @2xl:pb-5 min-[1440px]:hidden" data-testid="settings-nav-inline-wrap">
        <SettingsNav current={current} variant="inline" />
      </div>
      {query.isPending ? (
        <SectionSkeleton />
      ) : query.isError ? (
        <SectionError error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <Section settings={query.data} update={save.update} />
      )}
      <SaveStatus state={save.state} />
    </div>
  );
}
