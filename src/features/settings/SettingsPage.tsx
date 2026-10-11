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
import { useEffect, useMemo, type ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, NavLink, useNavigate, useParams } from 'react-router';

import { Select, useShell } from '../sources/_shim';
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

/** Section list rendered in the shell's context panel. */
export function SettingsNav({ current }: { current: SectionId }) {
  const { t } = useTranslation('settings');
  return (
    <nav aria-label={t('navLabel')} className="flex flex-col gap-0.5 p-3" data-testid="settings-nav">
      {SECTION_IDS.map((id) => {
        const { icon: Icon, label } = SECTIONS[id];
        return (
          <NavLink
            key={id}
            to={`/settings/${id}`}
            aria-current={id === current ? 'page' : undefined}
            className={clsx(
              'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium motion-safe:transition-colors',
              id === current ? 'bg-surface-3 text-fg' : 'text-fg-muted hover:bg-surface-2 hover:text-fg',
            )}
          >
            <Icon aria-hidden className={clsx('size-4', id === current && 'text-accent')} />
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
  const navigate = useNavigate();
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

  const navOptions = useMemo(() => SECTION_IDS.map((id) => ({ value: id, label: t(SECTIONS[id].label) })), [t]);

  if (!valid) return <Navigate to="/settings/general" replace />;

  const Section = SECTIONS[current].component;

  return (
    <div className="@container mx-auto w-full max-w-4xl px-4 py-6 @2xl:px-8" data-testid="settings-page">
      {/* The page's single h1 (C16) matches the header title; each section's own title is its h2. */}
      <h1 className="sr-only">{t('title')}</h1>
      {/* The context panel holds the nav; this picker covers windows under 1024px, where the shell turns the panel into a drawer. */}
      <div className="mb-6 lg:hidden">
        <Select aria-label={t('navLabel')} value={current} options={navOptions} onChange={(v) => navigate(`/settings/${v}`)} className="w-full" />
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
