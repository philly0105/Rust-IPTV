import {
  Captions,
  CaptionsOff,
  CircleDot,
  Check,
  ChevronLeft,
  ChevronRight,
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
import { formatTime } from '../format';
import { useMediaStore } from '../media';
import { usePipStore } from '../pip';
import { nextInQueue, prevInQueue, replay, selectEnded, usePlayerStore } from '../store';
import { SeekBar } from './SeekBar';

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
/** Seconds behind the end of the seekable window that still count as live. */
const LIVE_EDGE_SLACK = 6;
const LIVE_EDGE_SLACK_MPV = 10;

export function CtlButton({
  label,
  onClick,
  children,
  pressed,
  disabled,
  className,
}: {
  label: string;
  onClick(): void;
  children: ReactNode;
  pressed?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
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

function VolumeControl() {
  const { t } = useTranslation('player');
  const volume = usePlayerStore((s) => s.volume);
  const muted = usePlayerStore((s) => s.muted);
  const shown = muted ? 0 : volume;
  const Icon = shown === 0 ? VolumeX : shown < 0.5 ? Volume1 : Volume2;
  return (
    <div className="group/vol flex items-center">
      <CtlButton label={muted ? t('unmute') : t('mute')} onClick={() => usePlayerStore.getState().toggleMute()}>
        <Icon />
      </CtlButton>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={Math.round(shown * 100)}
        aria-label={t('volume')}
        aria-valuetext={t('volumePercent', { percent: Math.round(shown * 100) })}
        onChange={(e) => usePlayerStore.getState().setVolume(Number(e.target.value) / 100)}
        onKeyDown={(e) => e.stopPropagation()}
        className="player-range w-0 opacity-0 group-focus-within/vol:w-24 group-focus-within/vol:opacity-100 group-hover/vol:w-24 group-hover/vol:opacity-100 motion-safe:transition-[width,opacity] motion-safe:duration-200"
        style={{ ['--fill' as string]: `${Math.round(shown * 100)}%` }}
      />
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

type MenuView = 'root' | 'quality' | 'audio' | 'text' | 'speed';

function MenuRow({ label, value, onClick }: { label: string; value?: string; onClick(): void }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-center justify-between gap-6 rounded-sm px-3 py-2 text-start text-sm text-white hover:bg-white/10"
    >
      <span>{label}</span>
      <span className="flex items-center gap-1 text-white/70">
        {value}
        <ChevronRight className="size-4 rtl:rotate-180" aria-hidden />
      </span>
    </button>
  );
}

function MenuChoice({ label, selected, onClick }: { label: string; selected: boolean; onClick(): void }) {
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
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus();
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
          onClick={() => setView('root')}
          className="flex flex-1 items-center gap-1 rounded-sm px-2 py-2 text-start text-sm font-medium text-white hover:bg-white/10"
        >
          <ChevronLeft className="size-4 rtl:rotate-180" aria-hidden />
          {view === 'quality' ? t('quality') : view === 'audio' ? t('audioTrack') : view === 'text' ? t('subtitles') : t('speed')}
        </button>
      )}
      <button
        type="button"
        aria-label={tc('close')}
        title={tc('close')}
        onClick={() => setView(null)}
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-sm text-white/80 hover:bg-white/10 hover:text-white"
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
          const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('button') ?? []);
          const i = items.indexOf(document.activeElement as HTMLElement);
          const next = items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length];
          next?.focus();
        }
      }}
      className="max-h-[min(60vh,360px)] w-64 overflow-y-auto rounded-lg border border-white/10 bg-[rgb(10_14_22/0.94)] p-1.5 shadow-2 backdrop-blur-md motion-safe:animate-pop-in"
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
}

export function Controls({ variant, visible, compact, onMenuOpenChange }: ControlsProps) {
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
  const [menu, setMenuState] = useState<MenuView | null>(null);

  const setMenu = (v: MenuView | null): void => {
    setMenuState(v);
    onMenuOpenChange?.(v !== null);
  };

  useEffect(() => {
    if (!visible && menu) setMenu(null);
  }, [visible]);

  if (!source) return null;
  const isLive = source.isLive;
  const isVod = !isLive && !source.isRadio;
  const playing = status === 'playing' || status === 'loading';
  const prev = prevInQueue();
  const next = nextInQueue();
  const captionsOn = tracks.text.some((x) => x.selected);
  const hasOptions = tracks.qualities.length > 0 || tracks.audio.length > 0 || tracks.text.length > 0 || isVod;

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

  return (
    <div
      data-player-controls=""
      className={cn(
        'pointer-events-auto relative text-white',
        variant === 'overlay'
          ? 'bg-gradient-to-t from-black/85 via-black/45 to-transparent px-3 pt-10 pb-2 sm:px-4'
          : 'border-t border-white/10 bg-[#070b12] px-3 py-1.5',
        variant === 'overlay' && 'motion-safe:transition-opacity motion-safe:duration-200',
        variant === 'overlay' && !visible && 'pointer-events-none opacity-0',
      )}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {menu && variant === 'overlay' && (
        <div className="absolute end-3 bottom-full z-10 mb-1 sm:end-4">
          <OptionsMenu view={menu} setView={setMenu} isVod={isVod} />
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

      {showSeek && (
        <SeekBar
          min={liveWindow ? liveWindow.start : 0}
          max={liveWindow ? liveWindow.end : (duration ?? 0)}
          value={position}
          buffered={buffered}
          live={!!liveWindow}
          onSeek={(s) => store.seekTo(s)}
          className="mb-0.5"
        />
      )}
      <div className="flex min-w-0 items-center gap-0.5">
        {prev && !compact && (
          <CtlButton label={t('previous')} onClick={() => store.prev()}>
            <SkipBack />
          </CtlButton>
        )}
        {ended ? (
          <CtlButton label={t('replay')} onClick={replay}>
            <RotateCcw />
          </CtlButton>
        ) : (
          <CtlButton label={playing ? t('pause') : t('play')} onClick={() => store.togglePlay()}>
            {playing ? <Pause className="fill-current" /> : <Play className="fill-current" />}
          </CtlButton>
        )}
        {next && !compact && (
          <CtlButton label={t('next')} onClick={() => store.next()}>
            <SkipForward />
          </CtlButton>
        )}
        {!compact && (
          <CtlButton label={t('stop')} onClick={() => store.stop()}>
            <Square className="size-4! fill-current" />
          </CtlButton>
        )}
        <VolumeControl />

        {isLive ? (
          <button
            type="button"
            onClick={() => liveWindow && store.seekTo(mode === 'embedded-mpv' ? liveWindow.end - 1 : liveWindow.end)}
            disabled={atLiveEdge}
            aria-label={atLiveEdge ? t('live') : t('goLive')}
            className={cn(
              'ms-1 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-display text-xs font-semibold tracking-wide',
              atLiveEdge ? 'text-white' : 'text-white/70 hover:text-white',
            )}
          >
            <span className={cn('size-2 rounded-full', atLiveEdge ? 'bg-live motion-safe:animate-live-pulse' : 'bg-white/50')} />
            {t('live')}
          </button>
        ) : null}
        {isLive ? (
          !atLiveEdge && (
            <span className="ms-1 font-display text-sm whitespace-nowrap text-white/90 tabular-nums" data-testid="behind-live">
              -{formatTime(behindLive)}
            </span>
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
        {canRecord && <RecordControl compact={compact} />}

        <div className="flex-1" />

        {tracks.text.length > 0 && !compact && (
          <CtlButton
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
          <CtlButton label={t('settingsMenu')} pressed={menu !== null} onClick={() => setMenu(menu ? null : 'root')}>
            <Settings2 />
          </CtlButton>
        )}
        {canPip && (variant === 'overlay' || !compact) && (
          <CtlButton label={inPip ? t('exitPip') : t('pip')} pressed={inPip} onClick={() => commands?.togglePip()}>
            <PictureInPicture2 />
          </CtlButton>
        )}
        {!windowPip && (
          <CtlButton label={isFullscreen ? t('exitFullscreen') : t('fullscreen')} onClick={() => store.toggleFullscreen()}>
            {isFullscreen ? <Minimize /> : <Maximize />}
          </CtlButton>
        )}
      </div>
    </div>
  );
}
