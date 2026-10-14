import {
  Captions,
  CaptionsOff,
  CircleDot,
  Check,
  ChevronLeft,
  ChevronRight,
  History,
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
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { isDesktop, rpc } from '@/api/transport';

import { useToast } from '@/ui/Toast';
import { cn } from '../cn';
import { formatTime, LIVE_EDGE_SLACK, LIVE_EDGE_SLACK_MPV } from '../format';
import { setHistoryOpen, useHistoryStore } from '../history';
import { useMediaStore } from '../media';
import { usePipStore } from '../pip';
import { nextInQueue, prevInQueue, replay, selectEnded, usePlayerStore } from '../store';
import { toggleStreamInfo, useStreamInfoStore } from '../streamInfo';
import { InlineSpinner } from './InlineSpinner';
// failover: AlternatesMenu, AlternatesRow
import { AlternatesMenu, AlternatesRow, ChannelHistory, SleepChip, SleepMenu, SleepRowValue } from './lazyParts';
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
}) {
  return (
    <button
      type="button"
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
    <div className="group/vol flex items-center">
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

/** Embedded mpv live recording: a toggle plus a red REC timer while `mpv.record` writes to disk. */
export function RecordControl({ compact }: { compact?: boolean }) {
  const { t } = useTranslation('player');
  const { toast } = useToast();
  const recording = useMediaStore((s) => !!s.mpv?.recording);
  const startedAt = useMediaStore((s) => s.recordStartedAt);
  const recordPath = useMediaStore((s) => s.mpv?.recordPath ?? null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!recording) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [recording]);

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
          description: err instanceof Error ? err.message : String(err),
          variant: 'error',
        });
      })
      .finally(() => setBusy(false));
  };

  const elapsed = recording && startedAt ? Math.max(0, (now - startedAt) / 1000) : 0;
  return (
    <>
      {recording && (
        <span
          data-testid="rec-indicator"
          title={recordPath ? t('recordingTo', { path: recordPath }) : undefined}
          className="ms-1 inline-flex items-center gap-1.5 rounded-full bg-[#ff4d4d]/15 px-2 py-0.5 font-display text-xs font-semibold text-[#ff7a7a] tabular-nums ring-1 ring-[#ff4d4d]/45"
        >
          <span className="size-2 rounded-full bg-[#ff4d4d] motion-safe:animate-live-pulse" aria-hidden />
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
          <span className={cn(/^\d+$/.test(shown.primary) && 'text-accent-hover')}>{shown.primary}</span>
          {shown.secondary && <span className="ms-2 text-white/70">{shown.secondary}</span>}
        </span>
      )}
    </span>
  );
}

type MenuView = 'root' | 'quality' | 'audio' | 'text' | 'speed' | 'sync' | 'sources' | 'sleep'; // failover: + 'sources'

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
function OptionsMenu({ view, setView, isVod }: { view: MenuView; setView(v: MenuView | null): void; isVod: boolean }) {
  const { t } = useTranslation('player');
  const { t: tc } = useTranslation('common');
  const tracks = useMediaStore((s) => s.tracks);
  const rate = useMediaStore((s) => s.rate);
  const commands = useMediaStore((s) => s.commands);
  const statsOpen = useStreamInfoStore((s) => s.open);
  const syncSummary = useSyncSummary();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // The first item that can take focus (Sync rows may all be disabled, Sources may still be
    // loading), else the header's Back: focus must stay in the menu for its arrow keys and Escape.
    const menu = ref.current;
    (menu?.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled):not([data-menu-back])') ?? menu?.querySelector<HTMLElement>('[data-menu-back]'))?.focus();
  }, [view]);

  const qualityValue = tracks.qualityAuto ? t('qualityAuto') : (tracks.qualities.find((q) => q.selected)?.label ?? t('qualityAuto'));
  const audioValue = tracks.audio.find((a) => a.selected)?.label ?? t('trackDefault');
  const textValue = tracks.text.find((a) => a.selected)?.label ?? t('off');

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
          role="menuitem"
          data-menu-back
          onClick={() => setView('root')}
          className="flex flex-1 items-center gap-1 rounded-sm px-2 py-2 text-start text-sm font-medium text-white hover:bg-white/10"
        >
          <ChevronLeft className="size-4 rtl:rotate-180" aria-hidden />
          {view === 'quality'
            ? t('quality')
            : view === 'audio'
              ? t('audioTrack')
              : view === 'text'
                ? t('subtitles')
                : view === 'sync'
                  ? t('sync')
                  : view === 'sources'
                    ? t('alternateSources')
                    : view === 'sleep'
                      ? t('sleepTimer')
                      : t('speed')}
        </button>
      )}
      <button
        type="button"
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
      role="menu"
      aria-label={t('settingsMenu')}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          setView(view === 'root' ? null : 'root');
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          e.stopPropagation();
          const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? []);
          const i = items.indexOf(document.activeElement as HTMLElement);
          const next = items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length];
          next?.focus();
        }
      }}
      className="player-glass-strong player-glass-edge max-h-[min(60vh,360px)] w-64 max-w-[calc(100vw-1.5rem)] overflow-y-auto rounded-lg border p-1.5 motion-safe:animate-pop-in"
    >
      {view === 'root' && (
        <>
          {header}
          {tracks.qualities.length > 0 && <MenuRow label={t('quality')} value={qualityValue} onClick={() => setView('quality')} />}
          {tracks.audio.length > 0 && <MenuRow label={t('audioTrack')} value={audioValue} onClick={() => setView('audio')} />}
          {tracks.text.length > 0 && <MenuRow label={t('subtitles')} value={textValue} onClick={() => setView('text')} />}
          {isVod && (
            <MenuRow
              label={t('speed')}
              value={rate === 1 ? t('speedNormal') : t('speedValue', { speed: rate })}
              onClick={() => setView('speed')}
            />
          )}
          <MenuRow label={t('sync')} value={syncSummary} onClick={() => setView('sync')} />
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
          <MenuChoice label={t('off')} selected={!tracks.text.some((x) => x.selected)} onClick={() => pick(() => commands?.setText(null))} />
          {tracks.text.map((a) => (
            <MenuChoice key={a.id} label={a.label} selected={a.selected} onClick={() => pick(() => commands?.setText(a.id))} />
          ))}
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

export function Controls({ variant, visible, compact, onMenuOpenChange, readoutIdle }: ControlsProps) {
  const { t } = useTranslation('player');
  const source = usePlayerStore((s) => s.source);
  const status = usePlayerStore((s) => s.status);
  const position = usePlayerStore((s) => s.positionSeconds);
  const duration = usePlayerStore((s) => s.durationSeconds);
  const isFullscreen = usePlayerStore((s) => s.isFullscreen);
  const mode = usePlayerStore((s) => s.mode);
  const mpvAttached = useMediaStore((s) => !!s.mpv?.attached);
  const ended = usePlayerStore(selectEnded);
  usePlayerStore((s) => s.queue);
  const buffered = useMediaStore((s) => s.buffered);
  const seekable = useMediaStore((s) => s.seekable);
  const tracks = useMediaStore((s) => s.tracks);
  const canPip = useMediaStore((s) => s.canPip);
  const browserPip = useMediaStore((s) => s.inPip);
  const windowPip = usePipStore((s) => s.active);
  const inPip = browserPip || windowPip;
  const commands = useMediaStore((s) => s.commands);
  const historyOpen = useHistoryStore((s) => s.open);
  const [menu, setMenuState] = useState<MenuView | null>(null);

  const setMenu = (v: MenuView | null): void => {
    setMenuState(v);
    if (v !== null) setHistoryOpen(false);
    onMenuOpenChange?.(v !== null || useHistoryStore.getState().open);
  };

  useEffect(() => {
    if (!visible && menu) setMenu(null);
  }, [visible]);

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
  const prev = prevInQueue();
  const next = nextInQueue();
  const captionsOn = tracks.text.some((x) => x.selected);
  // Sync and Stream info are always there.
  const hasOptions = true;
  const episodic = !!source.episodeId;

  // Live DVR window: scrub only when the window is at least 30 s.
  const liveWindow = isLive && seekable && seekable.end - seekable.start >= 30 ? seekable : undefined;
  // mpv's cache runs a few seconds ahead of playback even at the live edge.
  const edgeSlack = mode === 'embedded-mpv' ? LIVE_EDGE_SLACK_MPV : LIVE_EDGE_SLACK;
  const behindLive = liveWindow ? Math.max(0, liveWindow.end - position) : 0;
  const atLiveEdge = !liveWindow || behindLive < edgeSlack;
  const showSeek = isVod ? !!duration : !!liveWindow;
  // Nothing known yet: no "0:00 / 0:00" while the stream (or the mpv session) is still starting.
  const showTime = !!duration || position > 0 || status !== 'loading';
  const canRecord = isDesktop && mode === 'embedded-mpv' && isLive && mpvAttached;

  const store = usePlayerStore.getState();
  // Overlay: a glass pane floating over a light scrim (the mini player's is full width, it has no
  // room to spare). Dock: a strong glass strip under the native video.
  const floating = variant === 'overlay' && !compact;

  return (
    <div
      data-player-controls=""
      className={cn(
        'pointer-events-auto relative text-white',
        variant === 'overlay'
          ? compact
            ? 'player-scrim-bottom pt-8'
            : 'player-scrim-bottom px-2 pt-12 pb-2 sm:px-3 sm:pb-3'
          : 'player-glass-strong border-t px-3 py-1.5',
        variant === 'overlay' && 'motion-safe:transition-opacity motion-safe:duration-200',
        variant === 'overlay' && !visible && 'pointer-events-none opacity-0',
      )}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {menu && variant === 'overlay' && (
        // Floating: just above the glass pane, inside the scrim. Compact: over the picture.
        <div className={cn('absolute z-10', floating ? 'end-2 bottom-[calc(100%-2.5rem)] sm:end-3' : 'end-1.5 bottom-full mb-1')}>
          <OptionsMenu view={menu} setView={setMenu} isVod={isVod} />
        </div>
      )}

      {showHistory && variant === 'overlay' && (
        <div className={cn('absolute z-10', floating ? 'start-2 bottom-[calc(100%-2.5rem)] sm:start-3' : 'start-1.5 bottom-full mb-1')}>
          <ChannelHistory />
        </div>
      )}

      {showHistory && variant === 'dock' && (
        <div className="flex max-h-48 items-start justify-start overflow-y-auto py-1">
          <ChannelHistory />
        </div>
      )}

      {menu && variant === 'dock' && (
        // A native surface sits above the DOM, so dock menus grow the dock upward instead of popping over
        // the video. The bar stays below so the options button can always close it; the surface shrinks
        // to fit because MpvSurface re-measures the reserved strip on resize.
        <div className="flex max-h-48 items-start justify-end overflow-y-auto py-1">
          <OptionsMenu view={menu} setView={setMenu} isVod={isVod} />
        </div>
      )}

      <div
        data-testid="controls-pane"
        className={cn(
          variant === 'overlay' && 'player-glass',
          floating && 'player-glass-edge rounded-xl border px-1.5 pt-1 sm:px-2.5',
          variant === 'overlay' && compact && 'border-t px-1',
        )}
      >
        {showSeek && (
          <SeekBar
            min={liveWindow ? liveWindow.start : 0}
            max={liveWindow ? liveWindow.end : (duration ?? 0)}
            value={position}
            buffered={buffered}
            live={!!liveWindow}
            edgeSlack={edgeSlack}
            onSeek={(s) => store.seekTo(s)}
            className="mb-0.5"
          />
        )}
        <div className="flex min-w-0 items-center gap-0.5">
          {prev && !compact && (
            <CtlButton id="prev" shortcut="previousItem" label={episodic ? t('previousEpisode') : t('previous')} onClick={() => store.prev()}>
              <SkipBack />
            </CtlButton>
          )}
          {ended ? (
            <CtlButton id="play" label={t('replay')} onClick={replay}>
              <RotateCcw />
            </CtlButton>
          ) : (
            <CtlButton id="play" shortcut="playPause" label={playing ? t('pause') : t('play')} onClick={() => store.togglePlay()}>
              {playing ? <Pause className="fill-current" /> : <Play className="fill-current" />}
            </CtlButton>
          )}
          {next && !compact && (
            <CtlButton id="next" shortcut="nextItem" label={episodic ? t('nextEpisode') : t('next')} onClick={() => store.next()}>
              <SkipForward />
            </CtlButton>
          )}
          {!compact && (
            <CtlButton id="stop" label={t('stop')} onClick={() => store.stop()}>
              <Square className="size-4! fill-current" />
            </CtlButton>
          )}
          <VolumeControl compact={compact} />

          {isLive ? (
            atLiveEdge ? (
              // At the edge there is nothing to jump to: a status badge, not a dead button.
              <span
                data-testid="live-badge"
                className="ms-1 inline-flex shrink-0 items-center gap-1.5 px-2 py-0.5 font-display text-xs font-semibold tracking-wide text-white"
              >
                <span className="size-2 rounded-full bg-live motion-safe:animate-live-pulse" aria-hidden />
                {t('live')}
              </span>
            ) : (
              <>
                <button
                  type="button"
                  data-ctl="golive"
                  onClick={(e) => {
                    if (!liveWindow) return;
                    // At the edge this button gives way to the LIVE badge: hand focus to play/pause
                    // first, or it would fall to the page and the player's keys would stop working.
                    const bar = e.currentTarget.closest('[data-player-controls]');
                    bar?.querySelector<HTMLElement>('[data-ctl="play"]')?.focus({ preventScroll: true });
                    store.seekTo(mode === 'embedded-mpv' ? liveWindow.end - 1 : liveWindow.end);
                  }}
                  aria-label={t('goLive')}
                  title={t('goLive')}
                  className="ms-1 inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 font-display text-xs font-semibold tracking-wide text-white ring-1 ring-white/30 hover:bg-white/12 hover:ring-white/50 motion-safe:transition-colors"
                >
                  <span className="size-2 rounded-full bg-white/50" aria-hidden />
                  {compact ? t('live') : t('goLive')}
                </button>
                <span
                  className="ms-1.5 min-w-0 truncate font-display text-sm whitespace-nowrap text-white/90 tabular-nums"
                  data-testid="behind-live"
                >
                  {compact ? `-${formatTime(behindLive)}` : t('behindLive', { time: formatTime(behindLive) })}
                </span>
              </>
            )
          ) : source.isRadio ? (
            <span className="ms-1 inline-flex items-center gap-1.5 text-xs text-white/70">
              <Radio className="size-4" aria-hidden />
              {t('radio')}
            </span>
          ) : showTime ? (
            <span className="ms-1 font-display text-sm whitespace-nowrap text-white/90 tabular-nums">
              {formatTime(position)}
              <span className="text-white/70"> / {formatTime(duration)}</span>
            </span>
          ) : null}
          {/* Sleep timer (C5): the countdown while one runs; opens its menu. */}
          <SleepChip compact={compact} onOpen={() => setMenu(menu === 'sleep' ? null : 'sleep')} />
          {canRecord && <RecordControl compact={compact} />}
          {isLive && !compact && (
            <CtlButton id="history" shortcut="history" label={t('channelHistory')} pressed={showHistory} onClick={() => setHistoryOpen(!historyOpen)}>
              <History />
            </CtlButton>
          )}

          <div className="flex-1" />
          {variant === 'dock' && !compact && <BarReadout fallback={readoutIdle} />}

          {tracks.text.length > 0 && !compact && (
            <CtlButton
              id="captions"
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
          {canPip && (variant === 'overlay' || !compact) && (
            <CtlButton
              id="pip"
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
