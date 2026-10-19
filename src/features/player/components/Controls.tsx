import {
  Captions,
  CaptionsOff,
  CircleDot,
  Check,
  ChevronLeft,
  ChevronRight,
  History,
  Lock,
  Maximize,
  Minimize,
  Pause,
  PictureInPicture2,
  Play,
  Radio,
  RotateCcw,
  Settings2,
  SkipBack,
  SkipForward,
  Square,
  Volume1,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { isDesktop, rpc } from '@/api/transport';
import { intlLocale } from '@/lib/intl';

import { useToast } from '@/ui/Toast';
import { errorDescription } from '@/ui/States';
import { cn } from '../cn';
import { formatTime, LIVE_EDGE_SLACK, LIVE_EDGE_SLACK_MPV } from '../format';
import { setHistoryOpen, useHistoryStore } from '../history';
import { useMediaStore, type TimeRange } from '../media';
import { ASPECTS, setPicture, usePictureStore, ZOOMS, type PictureAspect, type PictureZoom } from '../picture';
import { usePipStore } from '../pip';
import { nextInQueue, prevInQueue, replay, reportStatus, retryResolve, selectEnded, usePlayerStore, type PlayerState } from '../store';
import { toggleStreamInfo, useStreamInfoStore } from '../streamInfo';
import { InlineSpinner } from './InlineSpinner';
import { useNarrow } from './useNarrow';
// failover: AlternatesMenu, AlternatesRow
import {
  AlternatesMenu,
  AlternatesRow,
  ChannelHistory,
  ScreenshotButton,
  SleepChip,
  SleepMenu,
  SleepRowValue,
  SubtitleStyleMenu,
  SubtitleTrackMenu,
} from './lazyParts';
import { SeekBar } from './SeekBar';
import { SyncRows, useSyncSummary } from './SyncMenu';

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

/** Key names as shown in tooltips, and their `aria-keyshortcuts` form. */
const KEYS = {
  playPause: { hint: 'Space', aria: 'Space K' },
  fullscreen: { hint: 'F', aria: 'F' },
  exitPip: { hint: 'F', aria: 'F' },
  mute: { hint: 'M', aria: 'M' },
  captions: { hint: 'C', aria: 'C' },
  history: { hint: 'Shift+B', aria: 'Shift+B' },
  previousItem: { hint: 'Shift+P', aria: 'Shift+P' },
  nextItem: { hint: 'N', aria: 'N' },
} as const;
export type CtlShortcut = keyof typeof KEYS;

/** Tooltip text: the label, plus the key that does the same thing. */
export function ctlTitle(label: string, shortcut?: CtlShortcut): string {
  return shortcut ? `${label} (${KEYS[shortcut].hint})` : label;
}

export function CtlButton({
  label,
  onClick,
  children,
  pressed,
  disabled,
  className,
  shortcut,
  id,
  role,
}: {
  label: string;
  onClick(): void;
  children: ReactNode;
  pressed?: boolean;
  disabled?: boolean;
  className?: string;
  /** Adds the key to the tooltip and `aria-keyshortcuts`. */
  shortcut?: CtlShortcut;
  /** Stable control id (`data-ctl`) so focus can be put back after the chrome re-renders. */
  id?: string;
  /** `menuitem` in the options menu's row of moved controls. */
  role?: 'menuitem';
}) {
  return (
    <button
      type="button"
      role={role}
      data-ctl={id}
      aria-label={label}
      title={ctlTitle(label, shortcut)}
      aria-keyshortcuts={shortcut ? KEYS[shortcut].aria : undefined}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex size-10 shrink-0 items-center justify-center rounded-full hover:bg-white/12 hover:text-white disabled:opacity-40 motion-safe:transition-colors [&_svg]:size-5',
        pressed ? 'bg-white/12 text-white dark:text-accent-hover' : 'text-white/90',
        className,
      )}
    >
      {children}
    </button>
  );
}

function VolumeControl({ compact }: { compact?: boolean }) {
  const { t } = useTranslation('player');
  const volume = usePlayerStore((s) => s.volume);
  const muted = usePlayerStore((s) => s.muted);
  const shown = muted ? 0 : volume;
  const percent = Math.round(shown * 100);
  const Icon = shown === 0 ? VolumeX : shown < 0.5 ? Volume1 : Volume2;
  return (
    <div data-vol="" className="group/vol flex items-center">
      <CtlButton id="mute" shortcut="mute" label={muted ? t('unmute') : t('mute')} onClick={() => usePlayerStore.getState().toggleMute()}>
        <Icon />
      </CtlButton>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={percent}
        aria-label={t('volume')}
        aria-valuetext={t('volumePercent', { percent })}
        onChange={(e) => usePlayerStore.getState().setVolume(Number(e.target.value) / 100)}
        onKeyDown={(e) => e.stopPropagation()}
        className="player-range w-0 opacity-0 group-focus-within/vol:w-24 group-focus-within/vol:opacity-100 group-hover/vol:w-24 group-hover/vol:opacity-100 motion-safe:transition-[width,opacity] motion-safe:duration-200"
        style={{ ['--fill' as string]: `${percent}%` }}
      />
      {/* The level as a number while the slider is out (the slider itself announces it). */}
      {!compact && (
        <span
          aria-hidden
          data-testid="volume-readout"
          className="w-0 overflow-hidden text-end font-display text-xs whitespace-nowrap text-white/80 tabular-nums opacity-0 group-focus-within/vol:w-10 group-focus-within/vol:opacity-100 group-hover/vol:w-10 group-hover/vol:opacity-100 motion-safe:transition-[width,opacity] motion-safe:duration-200"
        >
          {percent}%
        </span>
      )}
    </div>
  );
}

/** Start or stop `mpv.record` (embedded mpv live recording), with a toast for the outcome. */
function useRecordToggle(): { recording: boolean; busy: boolean; toggle(): void } {
  const { t } = useTranslation('player');
  const { toast } = useToast();
  const recording = useMediaStore((s) => !!s.mpv?.recording);
  const [busy, setBusy] = useState(false);

  const toggle = (): void => {
    if (busy) return;
    const start = !recording;
    const lastPath = useMediaStore.getState().mpv?.recordPath ?? null;
    setBusy(true);
    rpc('mpv.record', { start })
      .then((res) => {
        const mpv = useMediaStore.getState().mpv;
        if (mpv) useMediaStore.setState({ mpv: { ...mpv, recording: res.recording, recordPath: res.path } });
        if (res.recording) {
          if (!useMediaStore.getState().recordStartedAt) useMediaStore.setState({ recordStartedAt: Date.now() });
          return;
        }
        useMediaStore.setState({ recordStartedAt: undefined });
        const path = res.path ?? lastPath;
        if (!start) toast({ title: t('recordSaved'), description: path ?? undefined, variant: 'success' });
      })
      .catch((err: unknown) => {
        toast({
          title: start ? t('recordStartFailed') : t('recordStopFailed'),
          description: errorDescription(err),
          variant: 'error',
        });
      })
      .finally(() => setBusy(false));
  };
  return { recording, busy, toggle };
}

/** Embedded mpv live recording: a toggle plus a red REC timer while `mpv.record` writes to disk. */
export function RecordControl({ compact }: { compact?: boolean }) {
  const { t } = useTranslation('player');
  const { recording, busy, toggle } = useRecordToggle();
  const startedAt = useMediaStore((s) => s.recordStartedAt);
  const recordPath = useMediaStore((s) => s.mpv?.recordPath ?? null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!recording) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [recording]);

  const elapsed = recording && startedAt ? Math.max(0, (now - startedAt) / 1000) : 0;
  // A tally light that blinks in step with the timer's own one-second tick: no CSS animation,
  // so nothing is redrawn over the video between ticks.
  const dim = Math.floor(elapsed) % 2 === 1;
  return (
    <>
      {recording && (
        <span
          data-testid="rec-indicator"
          title={recordPath ? t('recordingTo', { path: recordPath }) : undefined}
          className="ms-1 inline-flex items-center gap-1.5 rounded-full bg-[color:var(--color-danger,#ff7a7a)]/15 px-2 py-0.5 font-display text-xs font-semibold text-[color:var(--color-danger,#ff7a7a)] tabular-nums ring-1 ring-[color:var(--color-danger,#ff7a7a)]/45"
        >
          <span
            data-testid="rec-dot"
            className={cn('size-2 rounded-full bg-[color:var(--color-danger,#ff7a7a)]', dim && 'motion-safe:opacity-35')}
            aria-hidden
          />
          {t('rec')} {formatTime(elapsed)}
        </span>
      )}
      {!compact && (
        <CtlButton
          label={recording ? t('recordStop') : t('recordStart')}
          pressed={recording}
          disabled={busy}
          onClick={toggle}
          className={recording ? 'text-[#ff7a7a]!' : undefined}
        >
          <CircleDot />
        </CtlButton>
      )}
    </>
  );
}

/** How long the in-bar readout stays after a volume, seek or zap change. */
export const BAR_READOUT_MS = 1800;

/**
 * The OSD for embedded mpv: nothing can float over the native video, so volume, seek, zap and
 * resume readouts show briefly inside the control bar instead.
 */
export function BarReadout({
  fallback,
  className,
  dragRegion,
}: {
  /** Shown while there is no readout (the PiP bar's title). */
  fallback?: ReactNode;
  className?: string;
  /** Inside the borderless PiP bar: the readout area still moves the window. */
  dragRegion?: boolean;
} = {}) {
  const { t } = useTranslation('player');
  const osd = useMediaStore((s) => s.osd);
  const [shown, setShown] = useState<typeof osd>(undefined);
  useEffect(() => {
    // Recent readouts only: the key press that raised it may also be what mounted this bar
    // (fullscreen chrome comes back on any key), but an old one must not reappear.
    const left = osd?.at !== undefined ? BAR_READOUT_MS - (Date.now() - osd.at) : 0;
    if (!osd || left <= 0) {
      setShown(undefined);
      return;
    }
    setShown(osd);
    const id = setTimeout(() => setShown(undefined), left);
    return () => clearTimeout(id);
  }, [osd]);
  return (
    <span
      role="status"
      aria-live="polite"
      data-testid="bar-readout"
      data-tauri-drag-region={dragRegion ? '' : undefined}
      className={cn('me-2 min-w-0 truncate font-display text-sm whitespace-nowrap text-white tabular-nums', className)}
    >
      {!shown && fallback}
      {shown && (
        <span key={shown.key} className="motion-safe:animate-fade-in">
          {shown.locked && (
            <span data-testid="bar-readout-locked">
              <Lock aria-hidden className="me-1.5 inline size-3.5 align-[-0.125em]" />
              <span className="sr-only">{t('zapLocked')} </span>
            </span>
          )}
          <span className={cn(/^\d+$/.test(shown.primary) && 'text-accent-hover')}>{shown.primary}</span>
          {shown.secondary && <span className="ms-2 text-white/70">{shown.secondary}</span>}
        </span>
      )}
    </span>
  );
}

type MenuView = 'root' | 'quality' | 'audio' | 'text' | 'subStyle' | 'speed' | 'sync' | 'sources' | 'sleep' | 'picture'; // failover: + 'sources'

/** A row that opens a submenu (shared with the video's context menu). */
export function MenuRow({ label, value, onClick }: { label: string; value?: ReactNode; onClick(): void }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-center justify-between gap-6 rounded-sm px-3 py-2 text-start text-sm text-white hover:bg-white/10"
    >
      <span>{label}</span>
      <span className="player-on-glass-muted flex items-center gap-1">
        {value}
        <ChevronRight className="size-4 rtl:rotate-180" aria-hidden />
      </span>
    </button>
  );
}

/** An on/off row (shared with the video's context menu). */
export function MenuToggle({ label, checked, hint, onClick }: { label: string; checked: boolean; hint?: string; onClick(): void }) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      aria-keyshortcuts={hint}
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-sm px-3 py-2 text-start text-sm text-white hover:bg-white/10"
    >
      <Check className={cn('size-4 shrink-0', !checked && 'invisible', checked && 'dark:text-accent-hover')} aria-hidden />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint && <kbd className="font-sans text-xs text-white/50">{hint}</kbd>}
    </button>
  );
}

/** One choice of a submenu, checked when selected. */
export function MenuChoice({ label, selected, onClick }: { label: string; selected: boolean; onClick(): void }) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-sm px-3 py-2 text-start text-sm hover:bg-white/10',
        selected ? 'text-white dark:text-accent-hover' : 'text-white',
      )}
    >
      <Check className={cn('size-4 shrink-0', !selected && 'invisible')} aria-hidden />
      <span className="truncate">{label}</span>
    </button>
  );
}

/**
 * Quality, audio, subtitles, speed. Overlay: popover above the bar. Dock: rendered by the caller
 * inline above the bar. Picking a choice closes the menu; the header X closes it too, since
 * Escape may never reach the webview while the native mpv window has focus.
 */
/** Space kept between a floating menu and the top of what is visible (the app header, the screen). */
const MENU_EDGE = 8;

/**
 * The height a menu that grows up from its bottom edge may take: up to the app header (or the top
 * of the screen in fullscreen) and the top of the player it floats in, which clips it (a docked
 * stage, the mini frame). Null when it cannot be measured.
 */
export function roomAbove(menu: HTMLElement): number | null {
  const bottom = menu.getBoundingClientRect().bottom;
  const header = document.fullscreenElement ? null : document.querySelector<HTMLElement>('[data-testid="shell-header"]');
  const host = menu.closest<HTMLElement>('[data-player-host]');
  const top = Math.max(0, header?.getBoundingClientRect().bottom ?? 0, host?.getBoundingClientRect().top ?? 0) + MENU_EDGE;
  const room = Math.floor(bottom - top);
  return Number.isFinite(room) && bottom > 0 ? Math.max(room, 0) : null;
}

/** When an Escape last closed a player menu (see `playerMenuJustClosed`). */
let menuEscapeAt = Number.NEGATIVE_INFINITY;

/**
 * True right after Escape closed a player menu. A page-level Escape (close the player) lets such
 * a key go: a held or doubled Escape must not run on from closing the menu into stopping playback.
 */
export function playerMenuJustClosed(withinMs = 600): boolean {
  return Date.now() - menuEscapeAt < withinMs;
}

function OptionsMenu({
  view,
  setView,
  isVod,
  moved,
}: {
  view: MenuView;
  setView(v: MenuView | null): void;
  isVod: boolean;
  /** Controls the bar has no room for (a narrow player), as a row at the top of the root view. */
  moved?: ReactNode;
}) {
  const { t, i18n } = useTranslation('player');
  const { t: tc } = useTranslation('common');
  const tracks = useMediaStore((s) => s.tracks);
  const rate = useMediaStore((s) => s.rate);
  const commands = useMediaStore((s) => s.commands);
  const statsOpen = useStreamInfoStore((s) => s.open);
  const syncSummary = useSyncSummary();
  const picture = usePictureStore();
  const mpvMode = usePlayerStore((s) => s.mode === 'embedded-mpv');
  const ref = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState<number | null>(null);
  // The style view holds form fields (radio groups, a slider), which a menu may not contain: it
  // is a small dialog in the same frame instead.
  const styleView = view === 'subStyle';

  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    // Floating over the picture and growing upward: never taller than the room above its bottom edge.
    const measure = (): void => setRoom(roomAbove(menu));
    measure();
    window.addEventListener('resize', measure);
    document.addEventListener('fullscreenchange', measure);
    return () => {
      window.removeEventListener('resize', measure);
      document.removeEventListener('fullscreenchange', measure);
    };
  }, [view]);

  useEffect(() => {
    // The first item that can take focus (Sync rows may all be disabled, Sources may still be
    // loading), else the header's Back: focus must stay in the menu for its arrow keys and Escape.
    const menu = ref.current;
    (menu?.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled):not([data-menu-back]):not([data-menu-close])') ?? menu?.querySelector<HTMLElement>('[data-menu-back]'))?.focus();
  }, [view]);

  const qualityValue = tracks.qualityAuto ? t('qualityAuto') : (tracks.qualities.find((q) => q.selected)?.label ?? t('qualityAuto'));
  const audioValue = tracks.audio.find((a) => a.selected)?.label ?? t('trackDefault');
  const textValue = tracks.text.find((a) => a.selected)?.label ?? t('off');
  const aspectLabel = (a: PictureAspect): string => (a === 'auto' ? t('aspectAuto') : a === 'fill' ? t('aspectFill') : a);
  const zoomLabel = (z: PictureZoom): string =>
    z === 'none'
      ? t('zoomNone')
      : z === 'crop'
        ? t('zoomCrop')
        : new Intl.NumberFormat(intlLocale(i18n.language), { style: 'percent' }).format(Number(z) / 100);
  // The Picture row names what is changed; nothing while both are at their defaults.
  const pictureValue = picture.aspect !== 'auto' ? aspectLabel(picture.aspect) : picture.zoom !== 'none' ? zoomLabel(picture.zoom) : undefined;

  const pick = (run: () => void): void => {
    run();
    setView(null);
  };

  const header = (
    <div className="mb-1 flex items-center gap-1 border-b border-white/10">
      {view === 'root' ? (
        <span className="flex-1 px-2 py-2 text-sm font-medium text-white">{t('settingsMenu')}</span>
      ) : (
        <button
          type="button"
          role={styleView ? undefined : 'menuitem'}
          data-menu-back
          onClick={() => setView(view === 'subStyle' ? 'text' : 'root')}
          className="flex flex-1 items-center gap-1 rounded-sm px-2 py-2 text-start text-sm font-medium text-white hover:bg-white/10"
        >
          <ChevronLeft className="size-4 rtl:rotate-180" aria-hidden />
          {view === 'quality'
            ? t('quality')
            : view === 'audio'
              ? t('audioTrack')
              : view === 'text'
                ? t('subtitles')
                : view === 'subStyle'
                  ? t('subtitleStyle.menuTitle')
                  : view === 'sync'
                  ? t('sync')
                  : view === 'sources'
                    ? t('alternateSources')
                    : view === 'sleep'
                      ? t('sleepTimer')
                      : view === 'picture'
                        ? t('picture')
                        : t('speed')}
        </button>
      )}
      <button
        type="button"
        role={styleView ? undefined : 'menuitem'}
        data-menu-close
        aria-label={tc('close')}
        title={tc('close')}
        onClick={() => setView(null)}
        className="player-on-glass-muted inline-flex size-8 shrink-0 items-center justify-center rounded-sm hover:bg-white/10 hover:text-white"
      >
        <X className="size-4" aria-hidden />
      </button>
    </div>
  );

  return (
    <div
      ref={ref}
      role={styleView ? 'dialog' : 'menu'}
      aria-label={styleView ? t('subtitleStyle.menuTitle') : t('settingsMenu')}
      data-testid="player-options-menu"
      data-view={view}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          if (view === 'root') menuEscapeAt = Date.now();
          setView(view === 'root' ? null : view === 'subStyle' ? 'text' : 'root');
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          e.stopPropagation();
          const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input[type="range"]:not(:disabled)') ?? []);
          const i = items.indexOf(document.activeElement as HTMLElement);
          const next = items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length];
          next?.focus();
        }
      }}
      style={room !== null ? { maxHeight: `min(60vh, 360px, ${room}px)` } : undefined}
      className="player-glass-strong player-glass-edge glass-blur max-h-[min(60vh,360px)] w-64 max-w-[calc(100vw-1.5rem)] overflow-y-auto overscroll-contain rounded-lg border p-1.5 motion-safe:animate-pop-in"
    >
      {view === 'root' && (
        <>
          {header}
          {moved && (
            <div data-testid="moved-controls" className="mb-1 flex flex-wrap items-center gap-0.5 border-b border-white/10 pb-1">
              {moved}
            </div>
          )}
          {tracks.qualities.length > 0 && <MenuRow label={t('quality')} value={qualityValue} onClick={() => setView('quality')} />}
          {tracks.audio.length > 0 && <MenuRow label={t('audioTrack')} value={audioValue} onClick={() => setView('audio')} />}
          {/* Always there (C6): a file can be loaded into a stream without subtitles. */}
          <MenuRow label={t('subtitles')} value={textValue} onClick={() => setView('text')} />
          {isVod && (
            <MenuRow
              label={t('speed')}
              value={rate === 1 ? t('speedNormal') : t('speedValue', { speed: rate })}
              onClick={() => setView('speed')}
            />
          )}
          <MenuRow label={t('sync')} value={syncSummary} onClick={() => setView('sync')} />
          <MenuRow label={t('picture')} value={pictureValue} onClick={() => setView('picture')} />
          {/* Sleep timer (C5): the countdown as its value while on. */}
          <MenuRow label={t('sleepTimer')} value={<SleepRowValue />} onClick={() => setView('sleep')} />
          <MenuToggle label={t('streamInfo')} checked={statsOpen} hint="I" onClick={() => pick(() => void toggleStreamInfo())} />
          {/* failover: other copies of the live channel. */}
          <AlternatesRow onOpen={() => setView('sources')} />
        </>
      )}
      {view === 'sync' && (
        <>
          {header}
          <SyncRows />
        </>
      )}
      {view === 'sources' && (
        <>
          {header}
          <AlternatesMenu onDone={() => setView(null)} />
        </>
      )}
      {view === 'sleep' && (
        <>
          {header}
          <SleepMenu onDone={() => setView(null)} />
        </>
      )}
      {view === 'picture' && (
        <>
          {header}
          {/* Choices keep the menu open, so the effect can be compared on the picture. */}
          <div role="group" aria-label={t('pictureAspect')}>
            <p className="px-3 pt-1 pb-0.5 text-xs text-white/50">{t('pictureAspect')}</p>
            {ASPECTS.map((a) => (
              <MenuChoice key={a} label={aspectLabel(a)} selected={picture.aspect === a} onClick={() => setPicture({ aspect: a })} />
            ))}
          </div>
          <div role="group" aria-label={t('pictureZoom')} className="mt-1 border-t border-white/10 pt-1">
            <p className="px-3 pt-1 pb-0.5 text-xs text-white/50">{t('pictureZoom')}</p>
            {ZOOMS.map((z) => (
              <MenuChoice key={z} label={zoomLabel(z)} selected={picture.zoom === z} onClick={() => setPicture({ zoom: z })} />
            ))}
          </div>
          {/* Browsers deinterlace on their own; only mpv takes the switch. */}
          {mpvMode && (
            <div className="mt-1 border-t border-white/10 pt-1">
              <MenuToggle label={t('deinterlace')} checked={picture.deinterlace} onClick={() => setPicture({ deinterlace: !picture.deinterlace })} />
            </div>
          )}
        </>
      )}
      {view === 'quality' && (
        <>
          {header}
          <MenuChoice label={t('qualityAuto')} selected={tracks.qualityAuto} onClick={() => pick(() => commands?.setQuality('auto'))} />
          {[...tracks.qualities].reverse().map((q) => (
            <MenuChoice key={q.id} label={q.label} selected={!tracks.qualityAuto && q.selected} onClick={() => pick(() => commands?.setQuality(q.id))} />
          ))}
        </>
      )}
      {view === 'audio' && (
        <>
          {header}
          {tracks.audio.map((a) => (
            <MenuChoice key={a.id} label={a.label} selected={a.selected} onClick={() => pick(() => commands?.setAudio(a.id))} />
          ))}
        </>
      )}
      {view === 'text' && (
        <>
          {header}
          <SubtitleTrackMenu onDone={() => setView(null)} onStyle={() => setView('subStyle')} />
        </>
      )}
      {view === 'subStyle' && (
        <>
          {header}
          <SubtitleStyleMenu />
        </>
      )}
      {view === 'speed' && (
        <>
          {header}
          {SPEEDS.map((s) => (
            <MenuChoice
              key={s}
              label={s === 1 ? t('speedNormal') : t('speedValue', { speed: s })}
              selected={rate === s}
              onClick={() => pick(() => commands?.setRate(s))}
            />
          ))}
        </>
      )}
    </div>
  );
}

export interface ControlsProps {
  /** 'overlay' floats over a DOM video; 'dock' is a solid strip under a native (mpv) surface. */
  variant: 'overlay' | 'dock';
  visible: boolean;
  /** Compact chrome for the mini player. */
  compact?: boolean;
  onMenuOpenChange?(open: boolean): void;
  /** Dock bar: a lasting status (embedded mpv buffering) shown in the readout when no transient one is up. */
  readoutIdle?: ReactNode;
}

export { InlineSpinner };

/**
 * Try a failed stream again: look its URL up again when that lookup is what failed, else reload
 * the media through the active engine.
 */
export function retryPlayback(): void {
  if (retryResolve()) return;
  reportStatus('loading');
  useMediaStore.getState().commands?.retry();
}

/**
 * Below this width (CSS px) the compact mini bar is a phone's: see `tiny` in Controls. Under the
 * desktop mini player's 280 px minimum, so only the phone sizes (PlayerDock below sm) get it.
 */
export const TINY_MINI_PX = 260;

/** How long the live dot pulses after the stream starts playing; it then holds still. */
export const LIVE_PULSES = 3;

/**
 * The live status at the stream's edge. On air (playing): the red dot pulses a few times, then
 * holds still, because a never-ending animation keeps the compositor redrawing over the video.
 * Starting or paused: a dim dot. Failed: "No signal" with a hollow dot, never the red badge.
 */
function LiveBadge({ status, pulseKey, className }: { status: PlayerState['status']; pulseKey: string; className?: string }) {
  const { t } = useTranslation('player');
  const failed = status === 'error';
  const onAir = status === 'playing';
  return (
    <span
      data-testid="live-badge"
      data-state={failed ? 'no-signal' : onAir ? 'on-air' : 'standby'}
      className={cn(
        'ms-1 inline-flex shrink-0 items-center gap-1.5 px-2 py-0.5 font-display text-xs font-semibold tracking-wide whitespace-nowrap',
        onAir ? 'text-white' : 'text-white/70',
        className,
      )}
    >
      <span
        // A new channel (or the stream coming back) pulses again.
        key={`${pulseKey}|${status}`}
        data-testid="live-dot"
        className={cn(
          'size-2 rounded-full',
          onAir ? 'bg-live motion-safe:animate-live-pulse' : failed ? 'ring-1 ring-white/60 ring-inset' : 'bg-white/45',
        )}
        style={onAir ? { animationIterationCount: LIVE_PULSES } : undefined}
        aria-hidden
      />
      {failed ? t('liveNoSignal') : t('live')}
    </span>
  );
}

/** Live DVR window: scrub only when the window is at least 30 s. */
function liveWindowOf(seekable: TimeRange | undefined): TimeRange | undefined {
  return seekable && seekable.end - seekable.start >= 30 ? seekable : undefined;
}

interface Subscribable<S> {
  getState(): S;
  subscribe(listener: () => void): () => void;
}

/**
 * `select(store state)`, followed only while `shown`. Playback progress changes the position 4-7
 * times a second; chrome that is hidden keeps what it last showed instead of re-rendering with
 * it, and reads the current value when it shows again.
 */
function useWhileShown<S, T>(store: Subscribable<S>, select: (s: S) => T, shown: boolean): T {
  const subscribe = useCallback((onChange: () => void) => (shown ? store.subscribe(onChange) : () => undefined), [store, shown]);
  return useSyncExternalStore(subscribe, () => select(store.getState()));
}

/** The seek bar, with its own subscriptions to the position and buffer (the bar around it stays put). */
function PositionSeekBar({
  shown,
  live,
  duration,
  edgeSlack,
  onSeek,
}: {
  shown: boolean;
  live: boolean;
  duration: number | undefined;
  edgeSlack: number;
  onSeek(seconds: number): void;
}) {
  const position = useWhileShown(usePlayerStore, (s) => s.positionSeconds, shown);
  const buffered = useWhileShown(useMediaStore, (s) => s.buffered, shown);
  const seekable = useWhileShown(useMediaStore, (s) => s.seekable, shown);
  const liveWindow = live ? liveWindowOf(seekable) : undefined;
  if (live && !liveWindow) return null;
  return (
    <SeekBar
      min={liveWindow ? liveWindow.start : 0}
      max={liveWindow ? liveWindow.end : (duration ?? 0)}
      value={position}
      buffered={buffered}
      live={!!liveWindow}
      edgeSlack={edgeSlack}
      onSeek={onSeek}
      className="mb-0.5"
    />
  );
}

/** VOD: position and duration. `tiny` (a phone's mini player) drops the duration (F-PHONE-DOCK). */
function TimeReadout({ shown, duration, narrow, tiny }: { shown: boolean; duration: number | undefined; narrow: boolean; tiny: boolean }) {
  const position = useWhileShown(usePlayerStore, (s) => s.positionSeconds, shown);
  return (
    <span className={cn('ms-1 font-display whitespace-nowrap text-white/90 tabular-nums', narrow ? cn('text-xs', NARROW_YIELD_TO_VOLUME) : tiny ? 'text-xs' : 'text-sm')}>
      {formatTime(position)}
      {!tiny && <span className="text-white/70"> / {formatTime(duration)}</span>}
    </span>
  );
}

/** Live: the badge at the live edge (or after a failure), else Go live and how far behind it playback is. */
function LiveEdge({
  shown,
  status,
  pulseKey,
  short,
  narrow,
  edgeSlack,
  mpv,
}: {
  shown: boolean;
  status: PlayerState['status'];
  pulseKey: string;
  /** Compact or narrow: "Live" and "-1:30" instead of "Go live" and "1:30 behind live". */
  short: boolean;
  narrow: boolean;
  edgeSlack: number;
  mpv: boolean;
}) {
  const { t } = useTranslation('player');
  const position = useWhileShown(usePlayerStore, (s) => s.positionSeconds, shown);
  const seekable = useWhileShown(useMediaStore, (s) => s.seekable, shown);
  const liveWindow = liveWindowOf(seekable);
  const behindLive = liveWindow ? Math.max(0, liveWindow.end - position) : 0;
  const atLiveEdge = !liveWindow || behindLive < edgeSlack;
  if (atLiveEdge || status === 'error') {
    // At the edge there is nothing to jump to: a status badge, not a dead button.
    return <LiveBadge status={status} pulseKey={pulseKey} className={cn(narrow && NARROW_YIELD_TO_VOLUME)} />;
  }
  return (
    <>
      <button
        type="button"
        data-ctl="golive"
        onClick={(e) => {
          // At the edge this button gives way to the LIVE badge: hand focus to play/pause
          // first, or it would fall to the page and the player's keys would stop working.
          const bar = e.currentTarget.closest('[data-player-controls]');
          bar?.querySelector<HTMLElement>('[data-ctl="play"]')?.focus({ preventScroll: true });
          usePlayerStore.getState().seekTo(mpv ? liveWindow.end - 1 : liveWindow.end);
        }}
        aria-label={t('goLive')}
        title={t('goLive')}
        className="ms-1 inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 font-display text-xs font-semibold tracking-wide text-white ring-1 ring-white/30 hover:bg-white/12 hover:ring-white/50 motion-safe:transition-colors"
      >
        <span className="size-2 rounded-full bg-white/50" aria-hidden />
        {short ? t('live') : t('goLive')}
      </button>
      <span
        className={cn('ms-1.5 min-w-0 truncate font-display text-sm whitespace-nowrap text-white/90 tabular-nums', narrow && NARROW_YIELD_TO_VOLUME)}
        data-testid="behind-live"
      >
        {short ? `-${formatTime(behindLive)}` : t('behindLive', { time: formatTime(behindLive) })}
      </span>
    </>
  );
}

/** The record toggle as one of the options menu's moved controls. */
function RecordMenuAction({ onDone }: { onDone(): void }) {
  const { t } = useTranslation('player');
  const { recording, busy, toggle } = useRecordToggle();
  return (
    <CtlButton
      role="menuitem"
      label={recording ? t('recordStop') : t('recordStart')}
      pressed={recording}
      disabled={busy}
      onClick={() => {
        toggle();
        onDone();
      }}
      className={recording ? 'text-[#ff7a7a]!' : undefined}
    >
      <CircleDot />
    </CtlButton>
  );
}

/**
 * While the volume slider is out in a narrow bar, the live badge or the time steps aside for it
 * (the row has no room for both).
 */
const NARROW_YIELD_TO_VOLUME = '[[data-ctl-row]:has([data-vol]:hover)_&]:hidden [[data-ctl-row]:has([data-vol]:focus-within)_&]:hidden';

/** The buttons a narrow row can do without (the options menu takes them), by group. */
type Spare = 'captions' | 'pip' | 'skip' | 'stop' | 'screenshot' | 'history';
/** A spare button's room in the row: 40 px and the row's 2 px gap. */
const SPARE_SLOT_PX = 42;
/** What the dock's readout keeps for itself (typed channel digits, the volume level). */
const READOUT_KEEP_PX = 72;

/**
 * The spare groups a narrow row keeps, given room for `slots` buttons. `groups` come most useful
 * first with their button counts; one that does not fit is skipped and a smaller one may follow.
 */
export function keepSpares(groups: readonly (readonly [Spare, number])[], slots: number): Set<Spare> {
  const kept = new Set<Spare>();
  let left = slots;
  for (const [spare, n] of groups) {
    if (n > 0 && n <= left) {
      kept.add(spare);
      left -= n;
    }
  }
  return kept;
}

/**
 * How many spare buttons fit in a narrow row: the spacer's width, the readout's beyond what it
 * keeps, and the spares shown now, less any overflow. That sum does not depend on how many spares
 * show, so it settles in one pass. Read after layout (the row's ResizeObserver, or the next frame
 * after a render), never during one. Not measured while the volume slider is out: the row lends it
 * room then (the spares step aside), and it is measured again when the pointer or focus leaves.
 */
function useSpareSlots(row: HTMLElement | null, active: boolean): { slots: number; showing: { current: number } } {
  const [slots, setSlots] = useState(0);
  // How many spares the render being measured shows (set by the caller once it has picked them).
  const showing = useRef(0);
  const measure = useRef<() => void>(() => undefined);
  measure.current = () => {
    if (!row || !active) return;
    if (row.querySelector('[data-vol]')?.matches(':hover, :focus-within')) return;
    const width = row.clientWidth;
    if (!width) return;
    let free = showing.current * SPARE_SLOT_PX - Math.max(0, row.scrollWidth - width);
    for (const el of row.querySelectorAll<HTMLElement>(':scope > [data-row-free]')) free += el.offsetWidth;
    const readout = row.querySelector<HTMLElement>(':scope > [data-testid="bar-readout"]');
    if (readout) free += readout.offsetWidth - READOUT_KEEP_PX;
    const next = Math.max(0, Math.floor(free / SPARE_SLOT_PX));
    setSlots((s) => (s === next ? s : next));
  };
  const frame = useRef(0);
  const later = useRef((): void => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => measure.current());
  });
  // What the row holds changes with the render (a badge, Retry, a caption track).
  useEffect(() => {
    if (active) later.current();
  });
  useEffect(() => {
    if (!row) return;
    const again = later.current;
    row.addEventListener('pointerout', again);
    row.addEventListener('focusout', again);
    const ro = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => measure.current());
    ro?.observe(row);
    return () => {
      cancelAnimationFrame(frame.current);
      row.removeEventListener('pointerout', again);
      row.removeEventListener('focusout', again);
      ro?.disconnect();
    };
  }, [row]);
  return { slots: active ? slots : 0, showing };
}

export function Controls({ variant, visible, compact, onMenuOpenChange, readoutIdle }: ControlsProps) {
  const { t } = useTranslation('player');
  const source = usePlayerStore((s) => s.source);
  const status = usePlayerStore((s) => s.status);
  // The position, buffer and live window are read by the leaves that show them (PositionSeekBar,
  // TimeReadout, LiveEdge): the bar itself re-renders only when what it lays out changes.
  const hasPosition = usePlayerStore((s) => s.positionSeconds > 0);
  const duration = usePlayerStore((s) => s.durationSeconds);
  const isFullscreen = usePlayerStore((s) => s.isFullscreen);
  const mode = usePlayerStore((s) => s.mode);
  const mpvAttached = useMediaStore((s) => !!s.mpv?.attached);
  const ended = usePlayerStore(selectEnded);
  usePlayerStore((s) => s.queue);
  const liveWindowed = useMediaStore((s) => !!liveWindowOf(s.seekable));
  const tracks = useMediaStore((s) => s.tracks);
  const canPip = useMediaStore((s) => s.canPip);
  const browserPip = useMediaStore((s) => s.inPip);
  const windowPip = usePipStore((s) => s.active);
  const inPip = browserPip || windowPip;
  const commands = useMediaStore((s) => s.commands);
  const historyOpen = useHistoryStore((s) => s.open);
  const [menu, setMenuState] = useState<MenuView | null>(null);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  // A phone-width player (not the mini one, which has its own compact set): the row keeps its
  // core controls and the options menu takes the rest.
  const narrow = useNarrow(root) && !compact;
  // A phone's mini player (PlayerDock below sm, 190 px at least): the compact row drops
  // picture-in-picture and the duration, so play, mute, the time or live badge, and fullscreen fit.
  const tiny = useNarrow(root, TINY_MINI_PX) && !!compact;
  const [row, setRow] = useState<HTMLDivElement | null>(null);
  const spareRoom = useSpareSlots(row, narrow);
  // A narrow row measures its spare room after each render: the time readout growing a digit is one.
  useWhileShown(usePlayerStore, (s) => formatTime(s.positionSeconds).length, narrow && visible);

  const setMenu = (v: MenuView | null): void => {
    setMenuState(v);
    if (v !== null) setHistoryOpen(false);
    onMenuOpenChange?.(v !== null || useHistoryStore.getState().open);
  };

  /**
   * The menu asks to change view or close. Closing with focus inside it hands focus back to the
   * control that opened it: dropped on the page, the player's keys would stop working and the
   * page's own Escape (close the player) would be next in line.
   */
  const setMenuView = (v: MenuView | null): void => {
    if (v === null && root) {
      const open = root.querySelector('[data-testid="player-options-menu"]');
      if (open?.contains(document.activeElement)) {
        const trigger =
          root.querySelector<HTMLElement>('[data-ctl="options"]') ??
          root.querySelector<HTMLElement>('[data-ctl="sleep"]') ??
          root.querySelector<HTMLElement>('[data-ctl="play"]');
        trigger?.focus({ preventScroll: true });
      }
    }
    setMenu(v);
  };

  useEffect(() => {
    if (!visible && menu) setMenu(null);
  }, [visible]);

  // Shift+C (C6): the Subtitles submenu, asked for just now (a bar mounting later must not open it).
  const subtitleMenuAt = useMediaStore((s) => s.subtitleMenuAt);
  useEffect(() => {
    if (subtitleMenuAt === undefined) return;
    useMediaStore.setState({ subtitleMenuAt: undefined });
    if (Date.now() - subtitleMenuAt < 1000) setMenu('text');
  }, [subtitleMenuAt]);

  // The history popover (also opened by Shift+B) keeps the chrome up like a menu, and only one
  // of them is open at a time.
  const live = !!source?.isLive;
  const showHistory = historyOpen && live;
  useEffect(() => {
    if (showHistory) {
      setMenuState(null);
      onMenuOpenChange?.(true);
    } else onMenuOpenChange?.(menu !== null);
  }, [showHistory]);
  // Leaving live TV (or the player) closes it.
  useEffect(() => {
    if (!live && historyOpen) setHistoryOpen(false);
  }, [live]);
  useEffect(() => () => setHistoryOpen(false), []);

  if (!source) return null;
  const isLive = source.isLive;
  const isVod = !isLive && !source.isRadio;
  const playing = status === 'playing' || status === 'loading';
  const failed = status === 'error';
  const prev = prevInQueue();
  const next = nextInQueue();
  const captionsOn = tracks.text.some((x) => x.selected);
  // Sync and Stream info are always there.
  const hasOptions = true;
  const episodic = !!source.episodeId;

  // mpv's cache runs a few seconds ahead of playback even at the live edge.
  const edgeSlack = mode === 'embedded-mpv' ? LIVE_EDGE_SLACK_MPV : LIVE_EDGE_SLACK;
  const showSeek = isVod ? !!duration : isLive && liveWindowed;
  // Nothing known yet: no "0:00 / 0:00" while the stream (or the mpv session) is still starting.
  const showTime = !!duration || hasPosition || status !== 'loading';
  const canRecord = isDesktop && mode === 'embedded-mpv' && isLive && mpvAttached;
  const showPip = canPip && (variant === 'overlay' || !compact) && !tiny;

  const store = usePlayerStore.getState();
  // Overlay: a glass pane floating over a light scrim (the mini player's is full width, it has no
  // room to spare). Dock: a strong glass strip under the native video.
  const floating = variant === 'overlay' && !compact;

  // A narrow row keeps the spares it has room for, most useful first; the menu takes the rest.
  const kept = narrow
    ? keepSpares(
        [
          ['captions', tracks.text.length > 0 ? 1 : 0],
          ['pip', showPip && !windowPip ? 1 : 0],
          ['skip', (prev ? 1 : 0) + (next ? 1 : 0)],
          ['stop', 1],
          ['screenshot', 1],
          ['history', isLive ? 1 : 0],
        ],
        spareRoom.slots,
      )
    : undefined;
  const inRow = (spare: Spare): boolean => !kept || kept.has(spare);
  spareRoom.showing.current = kept
    ? (kept.has('captions') ? 1 : 0) +
      (kept.has('pip') ? 1 : 0) +
      (kept.has('skip') ? (prev ? 1 : 0) + (next ? 1 : 0) : 0) +
      (kept.has('stop') ? 1 : 0) +
      (kept.has('screenshot') ? 1 : 0) +
      (kept.has('history') ? 1 : 0)
    : 0;
  // A kept spare steps aside while the volume slider is out, like the live badge.
  const spareClass = narrow ? NARROW_YIELD_TO_VOLUME : undefined;

  const prevButton = prev && (
    <CtlButton id="prev" className={spareClass} shortcut="previousItem" label={episodic ? t('previousEpisode') : t('previous')} onClick={() => store.prev()}>
      <SkipBack />
    </CtlButton>
  );
  const nextButton = next && (
    <CtlButton id="next" className={spareClass} shortcut="nextItem" label={episodic ? t('nextEpisode') : t('next')} onClick={() => store.next()}>
      <SkipForward />
    </CtlButton>
  );
  const stopButton = (
    <CtlButton id="stop" className={spareClass} label={t('stop')} onClick={() => store.stop()}>
      <Square className="size-4! fill-current" />
    </CtlButton>
  );

  /** A moved control did its job: close the menu, focus back on its trigger. */
  const done = (): void => setMenuView(null);
  const closeThen =
    (run: () => void) =>
    (): void => {
      done();
      run();
    };
  const moved = narrow ? (
    <>
      {prev && !inRow('skip') && (
        <CtlButton role="menuitem" label={episodic ? t('previousEpisode') : t('previous')} shortcut="previousItem" onClick={closeThen(() => store.prev())}>
          <SkipBack />
        </CtlButton>
      )}
      {next && !inRow('skip') && (
        <CtlButton role="menuitem" label={episodic ? t('nextEpisode') : t('next')} shortcut="nextItem" onClick={closeThen(() => store.next())}>
          <SkipForward />
        </CtlButton>
      )}
      {showPip && !windowPip && !inRow('pip') && (
        <CtlButton role="menuitem" label={inPip ? t('exitPip') : t('pip')} pressed={inPip} onClick={closeThen(() => commands?.togglePip())}>
          <PictureInPicture2 />
        </CtlButton>
      )}
      {!inRow('screenshot') && <ScreenshotButton menuItem onDone={done} />}
      {canRecord && <RecordMenuAction onDone={done} />}
      {isLive && !inRow('history') && (
        <CtlButton
          role="menuitem"
          label={t('channelHistory')}
          shortcut="history"
          onClick={() => {
            done();
            setHistoryOpen(true);
          }}
        >
          <History />
        </CtlButton>
      )}
      {!inRow('stop') && (
        <CtlButton role="menuitem" label={t('stop')} onClick={() => store.stop()}>
          <Square className="size-4! fill-current" />
        </CtlButton>
      )}
    </>
  ) : undefined;

  return (
    <div
      ref={setRoot}
      data-player-controls=""
      data-narrow={narrow ? '' : undefined}
      className={cn(
        'relative text-white',
        variant === 'overlay'
          ? compact
            ? 'player-scrim-bottom pt-8'
            : 'player-scrim-bottom px-2 pt-12 pb-2 sm:px-3 sm:pb-3'
          : 'player-glass-strong border-t px-3 py-1.5',
        variant === 'overlay' && 'motion-safe:transition-opacity motion-safe:duration-200',
        // The scrim's padding is only shade: the pointer goes through it to what is under it (a
        // stream error's Retry, the picture), and only the pane and its menus take it.
        variant !== 'overlay' ? 'pointer-events-auto' : visible ? 'pointer-events-none *:pointer-events-auto' : 'pointer-events-none opacity-0',
      )}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {menu && (
        // Floating: just above the glass pane, inside the scrim. Compact, and the embedded mpv dock:
        // just above the bar, over the picture. Over mpv the native window leaves an open menu
        // (role="menu" or "dialog") out of its region (mpvBounds), so the strip it reserves for the
        // bar keeps the bar's height and the video keeps its size.
        <div className={cn('absolute z-10', floating ? 'end-2 bottom-[calc(100%-2.5rem)] sm:end-3' : 'end-1.5 bottom-full mb-1')}>
          <OptionsMenu view={menu} setView={setMenuView} isVod={isVod} moved={moved} />
        </div>
      )}

      {showHistory && (
        <div className={cn('absolute z-10', floating ? 'start-2 bottom-[calc(100%-2.5rem)] sm:start-3' : 'start-1.5 bottom-full mb-1')}>
          <ChannelHistory />
        </div>
      )}

      <div
        data-testid="controls-pane"
        className={cn(
          variant === 'overlay' && 'player-glass glass-blur',
          floating && 'player-glass-edge rounded-xl border px-1.5 pt-1 sm:px-2.5',
          variant === 'overlay' && compact && 'border-t px-1',
        )}
      >
        {showSeek && <PositionSeekBar shown={visible} live={isLive} duration={duration} edgeSlack={edgeSlack} onSeek={(s) => store.seekTo(s)} />}
        <div ref={setRow} data-ctl-row="" className="flex min-w-0 items-center gap-0.5">
          {!compact && !narrow && prevButton}
          {ended ? (
            <CtlButton id="play" label={t('replay')} onClick={replay}>
              <RotateCcw />
            </CtlButton>
          ) : failed ? (
            // Nothing to play or pause after a failure: the same spot tries the stream again.
            <CtlButton id="play" label={t('retry')} onClick={retryPlayback}>
              <RotateCcw />
            </CtlButton>
          ) : (
            <CtlButton id="play" shortcut="playPause" label={playing ? t('pause') : t('play')} onClick={() => store.togglePlay()}>
              {playing ? <Pause className="fill-current" /> : <Play className="fill-current" />}
            </CtlButton>
          )}
          {!compact && !narrow && nextButton}
          {!compact && !narrow && stopButton}
          <VolumeControl compact={compact || narrow} />

          {isLive ? (
            <LiveEdge
              shown={visible}
              status={status}
              pulseKey={source.url}
              short={!!compact || narrow}
              narrow={narrow}
              edgeSlack={edgeSlack}
              mpv={mode === 'embedded-mpv'}
            />
          ) : source.isRadio ? (
            <span className="ms-1 inline-flex items-center gap-1.5 text-xs text-white/70">
              <Radio className="size-4" aria-hidden />
              {t('radio')}
            </span>
          ) : showTime ? (
            <TimeReadout shown={visible} duration={duration} narrow={narrow} tiny={tiny} />
          ) : null}
          {/* Sleep timer (C5): the countdown while one runs; opens its menu. */}
          <SleepChip compact={compact || narrow} onOpen={() => setMenu(menu === 'sleep' ? null : 'sleep')} />
          {canRecord && <RecordControl compact={compact || narrow} />}
          {isLive && !compact && inRow('history') && (
            <CtlButton id="history" className={spareClass} shortcut="history" label={t('channelHistory')} pressed={showHistory} onClick={() => setHistoryOpen(!historyOpen)}>
              <History />
            </CtlButton>
          )}

          <div data-row-free="" className="flex-1" />
          {variant === 'dock' && !compact && <BarReadout fallback={readoutIdle} />}
          {/* A narrow row keeps its spares right of the volume, so they can step aside when it opens. */}
          {narrow && inRow('skip') && prevButton}
          {narrow && inRow('skip') && nextButton}
          {narrow && inRow('stop') && stopButton}
          {/* Screenshot (C6). Radio and external players have no bar: their stages show it, disabled with the reason. */}
          {!compact && inRow('screenshot') && <ScreenshotButton className={spareClass} />}

          {tracks.text.length > 0 && !compact && inRow('captions') && (
            <CtlButton
              id="captions"
              className={spareClass}
              // In live fullscreen, C opens the channel list instead.
              shortcut={isLive && isFullscreen ? undefined : 'captions'}
              label={captionsOn ? t('captionsOff') : t('captionsOn')}
              pressed={captionsOn}
              onClick={() => {
                const first = tracks.text[0];
                commands?.setText(captionsOn || !first ? null : first.id);
              }}
            >
              {captionsOn ? <Captions /> : <CaptionsOff />}
            </CtlButton>
          )}
          {hasOptions && !compact && (
            <CtlButton id="options" label={t('settingsMenu')} pressed={menu !== null} onClick={() => setMenu(menu ? null : 'root')}>
              <Settings2 />
            </CtlButton>
          )}
          {showPip && (windowPip || inRow('pip')) && (
            <CtlButton
              id="pip"
              className={windowPip ? undefined : spareClass}
              shortcut={windowPip ? 'exitPip' : undefined}
              label={inPip ? t('exitPip') : t('pip')}
              pressed={inPip}
              onClick={() => commands?.togglePip()}
            >
              <PictureInPicture2 />
            </CtlButton>
          )}
          {!windowPip && (
            <CtlButton
              id="fullscreen"
              shortcut="fullscreen"
              label={isFullscreen ? t('exitFullscreen') : t('fullscreen')}
              onClick={() => store.toggleFullscreen()}
            >
              {isFullscreen ? <Minimize /> : <Maximize />}
            </CtlButton>
          )}
        </div>
      </div>
    </div>
  );
}
