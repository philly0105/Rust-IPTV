import { clsx } from 'clsx';
import {
  CalendarClock,
  Clapperboard,
  DatabaseBackup,
  Info,
  Keyboard,
  MonitorPlay,
  Palette,
  Play,
  SlidersHorizontal,
  Smartphone,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, type ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, NavLink, useParams } from 'react-router';

import { useShell } from '@/shell';
import { SectionError, SectionSkeleton } from './components';
import { useSettingsQuery, useUpdateSettings } from './lib/useUpdateSettings';
import { AboutSection } from './sections/AboutSection';
import { AppearanceSection } from './sections/AppearanceSection';
import { BackupSection } from './sections/BackupSection';
import { EpgSection } from './sections/EpgSection';
import { GeneralSection } from './sections/GeneralSection';
import { MetadataSection } from './sections/MetadataSection';
import { PlaybackSection } from './sections/PlaybackSection';
import { PlayersSection } from './sections/PlayersSection';
import { RemoteSection } from './sections/RemoteSection';
import { ShortcutsSection } from './sections/ShortcutsSection';
import { SECTION_IDS, isSectionId, type SectionId, type SectionProps } from './sections/types';

const SECTIONS: Record<SectionId, { icon: LucideIcon; label: string; component: ComponentType<SectionProps> }> = {
  general: { icon: SlidersHorizontal, label: 'sectionGeneral', component: GeneralSection },
  playback: { icon: Play, label: 'sectionPlayback', component: PlaybackSection },
  players: { icon: MonitorPlay, label: 'sectionPlayers', component: PlayersSection },
  epg: { icon: CalendarClock, label: 'sectionEpg', component: EpgSection },
  metadata: { icon: Clapperboard, label: 'sectionMetadata', component: MetadataSection },
  appearance: { icon: Palette, label: 'sectionAppearance', component: AppearanceSection },
  remote: { icon: Smartphone, label: 'sectionRemote', component: RemoteSection },
  backup: { icon: DatabaseBackup, label: 'sectionBackup', component: BackupSection },
  shortcuts: { icon: Keyboard, label: 'sectionShortcuts', component: ShortcutsSection },
  about: { icon: Info, label: 'sectionAbout', component: AboutSection },
};

/**
 * Section list. `panel` is the vertical list in the shell's context panel;
 * `inline` is the wrapping row the page shows itself while the shell keeps the
 * panel in a drawer (under 1440 px, the shell's inline-panel breakpoint).
 */
export function SettingsNav({ current, variant = 'panel' }: { current: SectionId; variant?: 'panel' | 'inline' }) {
  const { t } = useTranslation('settings');
  const inline = variant === 'inline';
  return (
    <nav
      aria-label={t('navLabel')}
      className={inline ? 'flex flex-wrap gap-1.5' : 'flex flex-col gap-0.5 p-3'}
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
              inline ? 'gap-2 rounded-full border px-3 py-1.5 text-sm' : 'gap-3 rounded-md px-3 py-2 text-sm',
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

export function SettingsPage() {
  const { section } = useParams();
  const { t } = useTranslation('settings');
  const { setHeader, setContextPanel } = useShell();
  const query = useSettingsQuery();
  const update = useUpdateSettings();
  const valid = isSectionId(section);
  const current: SectionId = valid ? section : 'general';

  useEffect(() => {
    if (!valid) return;
    setHeader({ title: t('title'), subtitle: t(SECTIONS[current].label) });
  }, [setHeader, t, current, valid]);

  useEffect(() => {
    if (!valid) return;
    setContextPanel(<SettingsNav current={current} />);
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
        Below that the panel lives in a drawer, so the page lists the sections itself.
      */}
      <div className="mb-8 border-b border-border pb-5 min-[1440px]:hidden" data-testid="settings-nav-inline-wrap">
        <SettingsNav current={current} variant="inline" />
      </div>
      {query.isPending ? (
        <SectionSkeleton />
      ) : query.isError ? (
        <SectionError error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <Section settings={query.data} update={update} />
      )}
    </div>
  );
}
