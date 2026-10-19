/**
 * The Subtitles submenu (C6) of the options menu and of embedded mpv's context menu: Off, the
 * stream's tracks and loaded files, "Load subtitle file..." and "Subtitle style...", plus the
 * compact style view. Split out of the main chunk (lazyParts).
 */

import { FileUp, LoaderCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { rpc } from '@/api/transport';
import type { Settings } from '@/api/types';
import { toast } from '@/ui/Toast';
import { errorDescription } from '@/ui/States';

import { useMediaStore } from '../media';
import { peekSettings, setSettingsCache } from '../store';
import { styleFromSettings } from '../subtitles/style';
import { usePlayerSettings } from '../useSettings';
import { MenuChoice, MenuRow } from './Controls';
import { BackgroundChoice, ColorChoice, PositionSlider, SizeChoice } from './SubtitleStyleFields';

/** Off, every track, then loading a file and the style view. `onDone` closes the menu. */
export function SubtitleTrackMenu({ onDone, onStyle }: { onDone(): void; onStyle(): void }) {
  const { t } = useTranslation('player');
  const tracks = useMediaStore((s) => s.tracks.text);
  const commands = useMediaStore((s) => s.commands);
  const [loading, setLoading] = useState(false);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  const pick = (id: string | null): void => {
    commands?.setText(id);
    onDone();
  };

  const load = (): void => {
    if (loading) return;
    setLoading(true);
    void import('../subtitles/load')
      .then((m) => m.loadSubtitleFile(t))
      .then((added) => {
        if (!alive.current) return;
        setLoading(false);
        // The new track is on screen: the menu has done its job.
        if (added) onDone();
      })
      .catch((err: unknown) => {
        if (alive.current) setLoading(false);
        toast({ title: t('subtitleLoadFailedGeneric'), description: errorDescription(err), variant: 'error' });
      });
  };

  return (
    <div data-testid="subtitle-menu">
      <MenuChoice label={t('off')} selected={!tracks.some((x) => x.selected)} onClick={() => pick(null)} />
      {tracks.map((a) => (
        <MenuChoice key={a.id} label={a.label} selected={a.selected} onClick={() => pick(a.id)} />
      ))}
      {tracks.length === 0 && (
        <p className="player-on-glass-muted px-3 pt-0.5 pb-1.5 ps-9 text-xs" data-testid="subtitle-menu-empty">
          {t('subtitleNoTracks')}
        </p>
      )}
      <div role="separator" className="mx-2 my-1 h-px bg-white/10" />
      <button
        type="button"
        role="menuitem"
        aria-disabled={loading || undefined}
        aria-busy={loading || undefined}
        onClick={load}
        data-testid="subtitle-load"
        className="flex w-full items-center gap-2 rounded-sm px-3 py-2 text-start text-sm text-white hover:bg-white/10 aria-disabled:cursor-progress aria-disabled:text-white/70"
      >
        {loading ? <LoaderCircle className="size-4 shrink-0 motion-safe:animate-spin" aria-hidden /> : <FileUp className="size-4 shrink-0" aria-hidden />}
        <span className="truncate">{loading ? t('subtitleLoading') : t('subtitleLoad')}</span>
      </button>
      <MenuRow label={t('subtitleStyle.menu')} onClick={onStyle} />
    </div>
  );
}

/** Saves a style change from the player: shown at once, written through `settings.update`. */
export function saveSubtitleSettings(patch: Partial<Settings>, failedTitle: string): void {
  const before = peekSettings();
  if (before) setSettingsCache({ ...before, ...patch });
  rpc('settings.update', { patch })
    .then((next) => setSettingsCache(next))
    .catch((err: unknown) => {
      // Put back only what this write changed, unless something newer replaced it meanwhile.
      const now = peekSettings();
      if (before && now) {
        const undo = Object.fromEntries(
          (Object.keys(patch) as (keyof Settings)[]).filter((k) => now[k] === patch[k]).map((k) => [k, before[k]]),
        ) as Partial<Settings>;
        setSettingsCache({ ...now, ...undo });
      }
      toast({ title: failedTitle, description: errorDescription(err), variant: 'error' });
    });
}

/** The compact style controls inside the player menu; they change the same settings as the Playback page. */
export function SubtitleStyleMenu() {
  const { t } = useTranslation('player');
  const settings = usePlayerSettings();
  if (!settings) {
    return (
      <p role="status" className="player-on-glass-muted flex items-center gap-2 px-3 py-3 text-sm" data-testid="subtitle-style-loading">
        <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden />
        {t('subtitleStyle.loading')}
      </p>
    );
  }
  const style = styleFromSettings(settings);
  const save = (patch: Partial<Settings>): void => saveSubtitleSettings(patch, t('subtitleStyle.saveFailed'));
  const label = 'player-on-glass-muted px-1 text-xs';
  return (
    <div className="flex flex-col gap-2.5 px-2 pt-1 pb-2" data-testid="subtitle-style-menu">
      <div className="flex flex-col gap-1">
        <span className={label}>{t('subtitleStyle.size')}</span>
        <SizeChoice tone="glass" value={style.size} onChange={(subtitleSize) => save({ subtitleSize })} />
      </div>
      <div className="flex flex-col gap-1">
        <span className={label}>{t('subtitleStyle.color')}</span>
        <ColorChoice tone="glass" value={style.color} onChange={(subtitleColor) => save({ subtitleColor })} />
      </div>
      <div className="flex flex-col gap-1">
        <span className={label}>{t('subtitleStyle.background')}</span>
        <BackgroundChoice tone="glass" value={style.background} color={style.color} onChange={(subtitleBackground) => save({ subtitleBackground })} />
      </div>
      <div className="flex flex-col gap-1">
        <span className={label}>{t('subtitleStyle.position')}</span>
        <PositionSlider
          tone="glass"
          value={style.position}
          // The picture follows the thumb (cache only); the drag's end saves once.
          onPreview={(subtitlePosition) => {
            const now = peekSettings();
            if (now) setSettingsCache({ ...now, subtitlePosition });
          }}
          onCommit={(subtitlePosition) => save({ subtitlePosition })}
        />
      </div>
    </div>
  );
}
