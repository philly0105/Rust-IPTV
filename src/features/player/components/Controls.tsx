import {
  Camera,
  Captions,
  CaptionsOff,
  CircleDot,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  History,
  Lock,
  Maximize,
  Maximize2,
  Minimize,
  Minimize2,
  PanelLeftOpen,
  Pause,
  PictureInPicture2,
  Play,
  Radio,
  RotateCcw,
  RotateCw,
  Settings2,
  SkipBack,
  SkipForward,
  Square,
  Volume1,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { isDesktop, rpc } from '@/api/transport';
import { intlLocale } from '@/lib/intl';

import { comboKeys, Kbd } from '@/ui/Misc';
import { useToast } from '@/ui/Toast';
import { Tooltip } from '@/ui/Tooltip';
import { errorDescription } from '@/ui/States';
import { cn } from '../cn';
import { focusFromPointer, formatTime, LIVE_EDGE_SLACK, LIVE_EDGE_SLACK_MPV, pressKeepsFocus, SEEK_STEP_JL } from '../format';
import { setHistoryOpen, useHistoryStore } from '../history';
import { useMediaStore, type TimeRange } from '../media';
import { noteMenuDismissed } from '../menuDismiss';
import { ASPECTS, setPicture, usePictureStore, ZOOMS, type PictureAspect, type PictureZoom } from '../picture';
import { usePipStore } from '../pip';
import { canZap, nextInQueue, prevInQueue, replay, reportStatus, retryResolve, selectEnded, usePlayerStore, zap, type PlayerState } from '../store';
import { toggleStreamInfo, useStreamInfoStore } from '../streamInfo';
import { canEnterFullscreen } from '../fullscreen';
import { InlineSpinner } from './InlineSpinner';
import { MENU_HEADER, menuFrameClass, menuFrameStyle, playerMenuLayer, SHEET_BELOW_PX, type MenuFit } from './menuFrame';
import { useNarrow } from './useNarrow';
// failover: AlternatesMenu, AlternatesRow
import {
  AlternatesMenu,
  AlternatesRow,
  ChannelHistory,
  SleepChip,
  SleepMenu,
  SleepRowValue,
  SubtitleStyleMenu,
  SubtitleTrackMenu,
} from './lazyParts';
import { SeekBar } from './SeekBar';
import { SyncRows, useSyncAvailable, useSyncSummary } from './SyncMenu';

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

/**
 * The key behind each control: `combo` is drawn as key caps in the tooltip, with key names in the
 * UI language (Kbd: "Leertaste", "Umschalt"); `aria` is the `aria-keyshortcuts` form.
 */
const KEYS = {
  playPause: { combo: 'space', aria: 'Space K' },
  fullscreen: { combo: 'f', aria: 'F' },
  exitPip: { combo: 'f', aria: 'F' },
  mute: { combo: 'm', aria: 'M' },
  captions: { combo: 'c', aria: 'C' },
  history: { combo: 'shift+b', aria: 'Shift+B' },
  previousItem: { combo: 'shift+p', aria: 'Shift+P' },
  nextItem: { combo: 'n', aria: 'N' },
  skipBack: { combo: 'j', aria: 'J' },
  skipForward: { combo: 'l', aria: 'L' },
  screenshot: { combo: 's', aria: 'S' },
  streamInfo: { combo: 'i', aria: 'I' },
  channelUp: { combo: 'pageup', aria: 'PageUp' },
  channelDown: { combo: 'pagedown', aria: 'PageDown' },
  channelPanel: { combo: 'c', aria: 'C' },
} as const;
export type CtlShortcut = keyof typeof KEYS;

/** The key combo a control's tooltip shows (`space`, `shift+b`), for Kbd. */
export function ctlCombo(shortcut?: CtlShortcut): string | undefined {
  return shortcut ? KEYS[shortcut].combo : undefined;
}

export { pressKeepsFocus };

/**
 * The size the bar's controls take: `mini` in the mini player (they must fit 190 px on a phone,
 * so a coarse pointer does not grow them), `big` in fullscreen, where the bar is seen from a sofa.
 */
type ChromeScale = 'mini' | 'normal' | 'big';
const ChromeScaleContext = createContext<ChromeScale>('normal');

/** Button sizes per scale: 44 px touch targets under a coarse pointer outside the mini player (PL-TOUCH-ERGONOMICS). */
const CTL_SIZE: Record<ChromeScale, { regular: string; primary: string }> = {
  mini: { regular: 'size-9 [&_svg]:size-[1.125rem]', primary: 'size-9 [&_svg]:size-5' },
  normal: { regular: 'size-10 pointer-coarse:size-11 [&_svg]:size-5', primary: 'size-12 pointer-coarse:size-14 [&_svg]:size-7' },
  big: { regular: 'size-12 [&_svg]:size-6', primary: 'size-16 [&_svg]:size-9' },
};

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
  primary = false,
  tooltip,
  popup,
}: {
  label: string;
  onClick(): void;
  children: ReactNode;
  /** A toggle whose label stays the same (Captions): `aria-pressed`, drawn as a tick under the icon. */
  pressed?: boolean;
  disabled?: boolean;
  className?: string;
  /** Adds the key to the tooltip and `aria-keyshortcuts`. */
  shortcut?: CtlShortcut;
  /** Stable control id (`data-ctl`) so focus can be put back after the chrome re-renders. */
  id?: string;
  /** `menuitem` in the options menu's row of moved controls. */
  role?: 'menuitem';
  /** Play/pause: the one large control of the bar (PL-BAR-HIERARCHY). */
  primary?: boolean;
  /** Tooltip text in place of the label (the state behind a toggle). */
  tooltip?: string;
  /** Opens a menu (PL-MENU-A11Y): announced as a menu button, expanded or not, never as a toggle. */
  popup?: { expanded: boolean; controls?: string | undefined };
}) {
  const scale = useContext(ChromeScaleContext);
  // A glass tooltip (PL-NATIVE-TOOLTIPS): the label and the key as key caps, instead of the OS's
  // pale title box. It repeats the accessible name, so it does not describe the button again.
  return (
    <Tooltip content={tooltip ?? label} shortcut={ctlCombo(shortcut)} tone="glass" describe={tooltip !== undefined && tooltip !== label}>
      <button
        type="button"
        role={role}
        data-ctl={id}
        aria-label={label}
        aria-keyshortcuts={shortcut ? KEYS[shortcut].aria : undefined}
        aria-pressed={pressed}
        aria-haspopup={popup ? 'menu' : undefined}
        aria-expanded={popup ? popup.expanded : undefined}
        aria-controls={popup?.expanded ? popup.controls : undefined}
        disabled={disabled}
        onMouseDown={role === 'menuitem' ? undefined : pressKeepsFocus}
        onClick={onClick}
        className={cn(
          'relative inline-flex shrink-0 items-center justify-center rounded-full text-on-glass hover:bg-white/12 active:bg-white/20 disabled:opacity-40 motion-safe:transition-colors motion-safe:duration-(--duration-fast)',
          primary ? CTL_SIZE[scale].primary : CTL_SIZE[scale].regular,
          (pressed || popup?.expanded) && 'bg-white/12',
          // An on toggle: a short accent tick under the icon, like the rail's active mark.
          pressed && 'after:absolute after:bottom-1.5 after:h-0.5 after:w-4 after:rounded-full after:bg-accent',
          className,
        )}
      >
        {children}
      </button>
    </Tooltip>
  );
}

/** 10 s back or ahead (J/L): a turn arrow with the step written inside it. */
function SkipIcon({ forward }: { forward: boolean }) {
  const big = useContext(ChromeScaleContext) === 'big';
  const Icon = forward ? RotateCw : RotateCcw;
  return (
    <span className="relative inline-flex" aria-hidden>
      <Icon className={big ? 'size-8!' : 'size-6!'} strokeWidth={1.75} />
      <span className={cn('absolute inset-0 flex items-center justify-center pt-px font-numeric leading-none tabular-nums', big ? 'text-[0.75rem]' : 'text-[0.6rem]')}>
        {SEEK_STEP_JL}
      </span>
    </span>
  );
}

/**
 * The control row's icons, made once: a render of the bar (the chrome showing or hiding, a pause)
 * reuses them instead of building each SVG again (P2-PLAYER-4).
 */
const ICON = {
  play: <Play className="fill-current" />,
  pause: <Pause className="fill-current" />,
  replay: <RotateCcw />,
  previous: <SkipBack className="fill-current" />,
  next: <SkipForward className="fill-current" />,
  back10: <SkipIcon forward={false} />,
  forward10: <SkipIcon forward />,
  pip: <PictureInPicture2 />,
  options: <Settings2 />,
  captionsOn: <Captions />,
  captionsOff: <CaptionsOff />,
  fullscreen: <Maximize />,
  exitFullscreen: <Minimize />,
  muted: <VolumeX />,
  quiet: <Volume1 />,
  loud: <Volume2 />,
  // A chevron is a small glyph in its box: a heavier stroke matches the weight of the icons beside it.
  channelUp: <ChevronUp strokeWidth={2.25} />,
  channelDown: <ChevronDown strokeWidth={2.25} />,
  channels: <PanelLeftOpen className="rtl:-scale-x-100" />,
};

/** Memoized with the row's icons (P2-PLAYER-4): it follows the volume itself. */
const VolumeControl = memo(function VolumeControl({ compact, onDragChange }: { compact?: boolean; onDragChange?(dragging: boolean): void }) {
  const { t } = useTranslation('player');
  const [dragging, setDragging] = useState(false);
  const draggingRef = useRef(false);
  useEffect(() => () => {
    if (draggingRef.current) onDragChange?.(false);
  }, [onDragChange]);
  const drag = useCallback((active: boolean): void => {
    if (draggingRef.current === active) return;
    draggingRef.current = active;
    setDragging(active);
    onDragChange?.(active);
  }, [onDragChange]);
  useEffect(() => {
    if (!dragging) return;
    const endDrag = () => drag(false);
    window.addEventListener('pointerup', endDrag, true);
    window.addEventListener('pointercancel', endDrag, true);
    window.addEventListener('mouseup', endDrag, true);
    window.addEventListener('blur', endDrag);
    return () => {
      window.removeEventListener('pointerup', endDrag, true);
      window.removeEventListener('pointercancel', endDrag, true);
      window.removeEventListener('mouseup', endDrag, true);
      window.removeEventListener('blur', endDrag);
    };
  }, [dragging, drag]);
  const volume = usePlayerStore((s) => s.volume);
  const muted = usePlayerStore((s) => s.muted);
  const shown = muted ? 0 : volume;
  const percent = Math.round(shown * 100);
  return (
    <div data-vol="" data-dragging={dragging ? '' : undefined} className="group/vol flex items-center">
      <CtlButton id="mute" shortcut="mute" label={muted ? t('unmute') : t('mute')} onClick={() => usePlayerStore.getState().toggleMute()}>
        {shown === 0 ? ICON.muted : shown < 0.5 ? ICON.quiet : ICON.loud}
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
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          drag(true);
        }}
        onPointerUp={() => drag(false)}
        onPointerCancel={() => drag(false)}
        className="player-range w-0 opacity-0 group-focus-within/vol:w-24 group-focus-within/vol:opacity-100 group-hover/vol:w-24 group-hover/vol:opacity-100 group-data-[dragging]/vol:w-24 group-data-[dragging]/vol:opacity-100 motion-safe:transition-[width,opacity] motion-safe:duration-(--duration-base)"
        style={{ ['--fill' as string]: `${percent}%` }}
      />
      {/* The level as a number while the slider is out (the slider itself announces it). */}
      {!compact && (
        <span
          aria-hidden
          data-testid="volume-readout"
          className="w-0 overflow-hidden text-end font-numeric text-caption whitespace-nowrap text-on-glass-muted tabular-nums opacity-0 group-focus-within/vol:w-10 group-focus-within/vol:opacity-100 group-hover/vol:w-10 group-hover/vol:opacity-100 group-data-[dragging]/vol:w-10 group-data-[dragging]/vol:opacity-100 motion-safe:transition-[width,opacity] motion-safe:duration-(--duration-base)"
        >
          {percent}%
        </span>
      )}
    </div>
  );
});

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
          className="ms-1 inline-flex items-center gap-1.5 rounded-full bg-danger/15 px-2 py-0.5 font-numeric text-caption text-danger tabular-nums ring-1 ring-danger/45"
        >
          <span data-testid="rec-dot" className={cn('size-2 rounded-full bg-danger', dim && 'motion-safe:opacity-35')} aria-hidden />
          {t('rec')} {formatTime(elapsed)}
        </span>
      )}
      {!compact && (
        <CtlButton
          label={recording ? t('recordStop') : t('recordStart')}
          pressed={recording}
          disabled={busy}
          onClick={toggle}
          className={recording ? 'text-danger!' : undefined}
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
      className={cn('me-2 min-w-0 truncate font-numeric text-body-sm whitespace-nowrap text-on-glass tabular-nums', className)}
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
          {shown.secondary && <span className="ms-2 text-on-glass-muted">{shown.secondary}</span>}
        </span>
      )}
    </span>
  );
}

type MenuView = 'root' | 'quality' | 'audio' | 'text' | 'subStyle' | 'speed' | 'sync' | 'sources' | 'sleep' | 'picture'; // failover: + 'sources'

/** Menu rows: a state layer on glass, 44 px tall under a coarse pointer (PL-TOUCH-ERGONOMICS). */
export const MENU_ITEM =
  'flex w-full items-center rounded-md px-3 py-2 text-start text-body-sm text-on-glass hover:bg-white/10 active:bg-white/15 pointer-coarse:min-h-[calc(44rem/15)] disabled:opacity-50 disabled:hover:bg-transparent';

/** A row that opens a submenu (shared with the video's context menu). */
export function MenuRow({ label, value, onClick }: { label: string; value?: ReactNode; onClick(): void }) {
  return (
    <button type="button" role="menuitem" onClick={onClick} className={cn(MENU_ITEM, 'justify-between gap-6')}>
      <span>{label}</span>
      <span className="flex items-center gap-1 text-on-glass-muted">
        {value}
        <ChevronRight className="size-4 rtl:rotate-180" aria-hidden />
      </span>
    </button>
  );
}

/**
 * A key hint at the end of a menu row, in the UI language; the item carries `aria-keyshortcuts`.
 * Not under a coarse pointer: a phone's menu has no keys to name. The kit's small key caps in the
 * glass tone the player's tooltips give theirs: as bare caption text a lone letter (the I after
 * Stream info) read as a stray divider at the row's end.
 */
function MenuHint({ combo }: { combo: string }) {
  return (
    <span aria-hidden data-menu-hint="" className="ms-auto flex shrink-0 gap-1 ps-4 pointer-coarse:hidden">
      {/* One cap per key, without Kbd's spoken copy: the row's aria-keyshortcuts names the key. */}
      {comboKeys(combo).map((key, i) => (
        <Kbd key={`${key}-${i}`} size="sm" className="border-glass-border bg-white/10 text-on-glass-muted">
          {key}
        </Kbd>
      ))}
    </span>
  );
}

/** An on/off row (shared with the video's context menu). `hint`: the key, as `aria-keyshortcuts` writes it. */
export function MenuToggle({ label, checked, hint, onClick }: { label: string; checked: boolean; hint?: string; onClick(): void }) {
  // The tick at the end, so the row starts on the same edge as the rows around it. The key goes
  // after it: the row then ends on its key cap, in the column the action rows' caps and the
  // submenu chevrons end in, rather than a tick's width short of them.
  return (
    <button type="button" role="menuitemcheckbox" aria-checked={checked} aria-keyshortcuts={hint} onClick={onClick} className={cn(MENU_ITEM, 'gap-2')}>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <Check className={cn('size-4 shrink-0 text-accent', !checked && 'invisible')} aria-hidden />
      {hint && <MenuHint combo={hint.toLowerCase()} />}
    </button>
  );
}

/** One choice of a submenu, checked when selected. */
export function MenuChoice({ label, selected, onClick }: { label: string; selected: boolean; onClick(): void }) {
  return (
    <button type="button" role="menuitemradio" aria-checked={selected} onClick={onClick} className={cn(MENU_ITEM, 'gap-2')}>
      <Check className={cn('size-4 shrink-0 text-accent', !selected && 'invisible')} aria-hidden />
      <span className="truncate">{label}</span>
    </button>
  );
}

/** A command row with an icon and its key (screenshot, channel history, stop), shared with the context menu. */
export function MenuAction({
  icon,
  label,
  shortcut,
  danger,
  disabled,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  shortcut?: CtlShortcut;
  danger?: boolean;
  disabled?: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      aria-keyshortcuts={shortcut ? KEYS[shortcut].aria : undefined}
      disabled={disabled}
      onClick={onClick}
      className={cn(MENU_ITEM, 'gap-2', danger && 'text-danger')}
    >
      <span className="flex size-4 shrink-0 items-center justify-center [&_svg]:size-4">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {shortcut && <MenuHint combo={KEYS[shortcut].combo} />}
    </button>
  );
}

/** A rule between groups of menu rows. */
export function MenuSeparator() {
  return <div role="separator" className="mx-2 my-1 h-px bg-white/10" />;
}

/** The Picture view: aspect and zoom for every channel; deinterlace for mpv. Choices keep the menu open. */
export function PictureRows() {
  const { t, i18n } = useTranslation('player');
  const picture = usePictureStore();
  const mpvMode = usePlayerStore((s) => s.mode === 'embedded-mpv');
  const aspectLabel = (a: PictureAspect): string => (a === 'auto' ? t('aspectAuto') : a === 'fill' ? t('aspectFill') : a);
  const zoomLabel = (z: PictureZoom): string => pictureZoomLabel(z, t, i18n.language);
  return (
    <>
      <div role="group" aria-label={t('pictureAspect')}>
        <p className="px-3 pt-1 pb-0.5 text-caption text-on-glass-muted">{t('pictureAspect')}</p>
        {ASPECTS.map((a) => (
          <MenuChoice key={a} label={aspectLabel(a)} selected={picture.aspect === a} onClick={() => setPicture({ aspect: a })} />
        ))}
      </div>
      <div role="group" aria-label={t('pictureZoom')} className="mt-1 border-t border-white/10 pt-1">
        <p className="px-3 pt-1 pb-0.5 text-caption text-on-glass-muted">{t('pictureZoom')}</p>
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
  );
}

function pictureZoomLabel(z: PictureZoom, t: (key: string) => string, lang: string): string {
  if (z === 'none') return t('zoomNone');
  if (z === 'crop') return t('zoomCrop');
  return new Intl.NumberFormat(intlLocale(lang), { style: 'percent' }).format(Number(z) / 100);
}

/** The Picture row's value: what is changed, nothing while both are at their defaults. */
export function usePictureSummary(): string | undefined {
  const { t, i18n } = useTranslation('player');
  const picture = usePictureStore();
  if (picture.aspect !== 'auto') return picture.aspect === 'fill' ? t('aspectFill') : picture.aspect;
  return picture.zoom !== 'none' ? pictureZoomLabel(picture.zoom, t, i18n.language) : undefined;
}

/** The Speed view's choices; `onDone` closes the menu after a pick. */
export function SpeedRows({ onDone }: { onDone(): void }) {
  const { t } = useTranslation('player');
  const rate = useMediaStore((s) => s.rate);
  const commands = useMediaStore((s) => s.commands);
  return (
    <>
      {SPEEDS.map((s) => (
        <MenuChoice
          key={s}
          label={s === 1 ? t('speedNormal') : t('speedValue', { speed: s })}
          selected={rate === s}
          onClick={() => {
            commands?.setRate(s);
            onDone();
          }}
        />
      ))}
    </>
  );
}

/** Takes a screenshot, loading the capture code on first use (it stays out of the player's chunk). */
function captureScreenshot(): void {
  void import('../screenshot').then((m) => m.takeScreenshot());
}

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

/**
 * Where a player menu opens from the bar (the options menu, the channel history). `className`
 * places this frame, and with it the menu's bottom edge, just above the bar. The room from there
 * up to the top of the player is measured here and handed to the menu (`fit`), again whenever the
 * bar or the player changes size: the live seek row arriving under an open menu, fullscreen,
 * a resized window. With less room than a header and a few rows (`SHEET_BELOW_PX`: a phone's
 * inline player, the mini player), and when `sheet` allows it, the menu opens as a sheet from the
 * bottom of the screen instead, over a scrim that closes it (`onScrim`). The frame stays in place
 * empty then, so the room is still measured from the same edge and the sheet goes back to a popover
 * when the player grows.
 */
function PlayerPopup({
  className,
  sheet: sheetAllowed,
  onScrim,
  children,
}: {
  className: string;
  sheet: boolean;
  onScrim(): void;
  children(fit: MenuFit): ReactNode;
}) {
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  const [room, setRoom] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!frame) return;
    const measure = (): void => setRoom(roomAbove(frame));
    measure();
    window.addEventListener('resize', measure);
    document.addEventListener('fullscreenchange', measure);
    const ro = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    for (const el of [frame.closest('[data-player-controls]'), frame.closest('[data-player-host]')]) if (el) ro?.observe(el);
    return () => {
      window.removeEventListener('resize', measure);
      document.removeEventListener('fullscreenchange', measure);
      ro?.disconnect();
    };
  }, [frame]);
  const sheet = sheetAllowed && room !== null && room < SHEET_BELOW_PX;
  const menu = children({ room, sheet });
  return (
    <div ref={setFrame} data-menu-frame="" className={cn('absolute z-10', className)}>
      {sheet
        ? createPortal(
            <>
              {/* A press here only closes the menu: it never reaches the page under it, and focus stays put until the menu hands it back. */}
              <div
                aria-hidden
                data-menu-scrim=""
                className="fixed inset-0 z-[60] touch-none bg-scrim motion-safe:animate-fade-in"
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => {
                  e.stopPropagation();
                  onScrim();
                }}
              />
              {menu}
            </>,
            playerMenuLayer(),
          )
        : menu}
    </div>
  );
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

/** The commands at the foot of the options menu, which the bar keeps out of its row (PL-BAR-HIERARCHY). */
interface MenuCommands {
  screenshot: boolean;
  history: boolean;
  record: boolean;
  stop: boolean;
}

/**
 * Quality, audio, subtitles, speed and the rest, as a popover above the bar or a sheet (`fit`, see
 * `PlayerPopup`). Picking a choice closes the menu; the header X closes it too, since Escape may
 * never reach the webview while the native mpv window has focus.
 */
function OptionsMenu({
  id,
  view,
  setView,
  isVod,
  moved,
  commandsShown,
  fit,
}: {
  id: string;
  view: MenuView;
  setView(v: MenuView | null): void;
  isVod: boolean;
  /** Controls the bar has no room for (a narrow player), as a row at the top of the root view. */
  moved?: ReactNode;
  commandsShown: MenuCommands;
  fit: MenuFit;
}) {
  const { t } = useTranslation('player');
  const { t: tc } = useTranslation('common');
  const tracks = useMediaStore((s) => s.tracks);
  const rate = useMediaStore((s) => s.rate);
  const commands = useMediaStore((s) => s.commands);
  const statsOpen = useStreamInfoStore((s) => s.open);
  const syncSummary = useSyncSummary();
  const syncAvailable = useSyncAvailable();
  const pictureValue = usePictureSummary();
  const ref = useRef<HTMLDivElement>(null);
  // The style view holds form fields (radio groups, a slider), which a menu may not contain: it
  // is a small dialog in the same frame instead.
  const styleView = view === 'subStyle';

  /**
   * More rows below the fold (a short stage caps the menu's height): a fade along the bottom
   * edge says the list goes on. Followed on scroll, on every render, and as rows come and go
   * (a lazy view arriving, the alternates loading).
   */
  const [more, setMore] = useState(false);
  const updateMore = (): void => {
    const menu = ref.current;
    setMore(!!menu && menu.scrollHeight - menu.scrollTop - menu.clientHeight > 2);
  };
  useEffect(updateMore);
  useEffect(() => {
    const menu = ref.current;
    if (!menu || typeof MutationObserver === 'undefined') return;
    const rows = new MutationObserver(updateMore);
    rows.observe(menu, { childList: true, subtree: true });
    return () => rows.disconnect();
    // `updateMore` reads the menu through its ref and sets state: the first render's copy does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // A new view starts at its top: the frame is the same element, and the scroll the last view
    // was left at would hide the new one's header.
    const menu = ref.current;
    if (menu) menu.scrollTop = 0;
    // The first item that can take focus (Sources may still be loading, the style view holds
    // fields), else the header's Back: focus must stay in the menu for its arrow keys and Escape.
    (menu?.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled):not([data-menu-back]):not([data-menu-close])') ?? menu?.querySelector<HTMLElement>('[data-menu-back]'))?.focus();
  }, [view]);

  const qualityValue = tracks.qualityAuto ? t('qualityAuto') : (tracks.qualities.find((q) => q.selected)?.label ?? t('qualityAuto'));
  const audioValue = tracks.audio.find((a) => a.selected)?.label ?? t('trackDefault');
  const textValue = tracks.text.find((a) => a.selected)?.label ?? t('off');

  const pick = (run: () => void): void => {
    run();
    setView(null);
  };

  const header = (
    <div className={MENU_HEADER}>
      {view === 'root' ? (
        <span className="flex-1 px-2 py-1.5 text-body-sm font-medium text-on-glass">{t('settingsMenu')}</span>
      ) : (
        <button
          type="button"
          role={styleView ? undefined : 'menuitem'}
          data-menu-back
          onClick={() => setView(view === 'subStyle' ? 'text' : 'root')}
          className="flex flex-1 items-center gap-1 rounded-md px-2 py-1.5 text-start text-body-sm font-medium text-on-glass hover:bg-white/10"
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
      <Tooltip content={tc('close')} tone="glass" describe={false}>
        <button
          type="button"
          role={styleView ? undefined : 'menuitem'}
          data-menu-close
          aria-label={tc('close')}
          onClick={() => setView(null)}
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-on-glass-muted hover:bg-white/10 hover:text-on-glass pointer-coarse:size-10"
        >
          <X className="size-4" aria-hidden />
        </button>
      </Tooltip>
    </div>
  );

  const hasCommands = commandsShown.screenshot || commandsShown.history || commandsShown.record || commandsShown.stop;

  return (
    <div
      ref={ref}
      id={id}
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
      data-sheet={fit.sheet ? '' : undefined}
      style={menuFrameStyle(fit, '70vh, 420px')}
      onScroll={updateMore}
      className={menuFrameClass(fit, 'max-h-[min(70vh,420px)] w-64 max-w-[calc(100vw-1.5rem)]')}
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
          {syncAvailable && <MenuRow label={t('sync')} value={syncSummary} onClick={() => setView('sync')} />}
          <MenuRow label={t('picture')} value={pictureValue} onClick={() => setView('picture')} />
          {/* Sleep timer (C5): the countdown as its value while on. */}
          <MenuRow label={t('sleepTimer')} value={<SleepRowValue />} onClick={() => setView('sleep')} />
          <MenuToggle label={t('streamInfo')} checked={statsOpen} hint="I" onClick={() => pick(() => void toggleStreamInfo())} />
          {/* failover: other copies of the live channel. */}
          <AlternatesRow onOpen={() => setView('sources')} />
          {hasCommands && <MenuSeparator />}
          {/* Screenshot (C6): the menu closes first, so it is never in the picture. */}
          {commandsShown.screenshot && <MenuAction icon={<Camera aria-hidden />} label={t('screenshot')} shortcut="screenshot" onClick={() => pick(captureScreenshot)} />}
          {commandsShown.history && (
            <MenuAction icon={<History aria-hidden />} label={t('channelHistory')} shortcut="history" onClick={() => pick(() => setHistoryOpen(true))} />
          )}
          {commandsShown.record && <RecordMenuAction onDone={() => setView(null)} />}
          {commandsShown.stop && (
            <MenuAction icon={<Square className="fill-current" aria-hidden />} label={t('stop')} onClick={() => pick(() => usePlayerStore.getState().stop())} />
          )}
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
          <PictureRows />
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
          <SpeedRows onDone={() => setView(null)} />
        </>
      )}
      {more && <MoreBelow />}
    </div>
  );
}

/**
 * The fade over the last visible rows of a menu that scrolls on. A zero-height marker stuck to the
 * bottom edge, the fade drawn up from it, so showing it never moves a row.
 */
function MoreBelow() {
  return (
    <div aria-hidden data-testid="menu-more" className="pointer-events-none sticky -bottom-1.5 h-0">
      <div className="absolute -inset-x-1.5 bottom-0 h-8 bg-linear-to-t from-glass-strong to-transparent" />
    </div>
  );
}

export interface ControlsProps {
  /** 'overlay' floats over a DOM video; 'dock' is a solid strip under a native (mpv) surface. */
  variant: 'overlay' | 'dock';
  visible: boolean;
  /** Compact chrome for the mini player. */
  compact?: boolean;
  /**
   * Overlay: a short player (a phone's inline player, a docked stage; see `SHORT_PLAYER_PX`). The
   * scrim fades in over 2rem instead of 4rem, so the shade is mostly the bar's own height and the
   * picture above it stays clear.
   */
  short?: boolean;
  onMenuOpenChange?(open: boolean): void;
  onVolumeDragChange?(dragging: boolean): void;
  /** Dock bar: a lasting status (embedded mpv buffering) shown in the readout when no transient one is up. */
  readoutIdle?: ReactNode;
  /** The fullscreen channel panel can open here (`FullscreenChannelPanel`): the bar gets its button. */
  channelPanel?: boolean;
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
 * The one live mark of the player (PL-DUPLICATE-CHROME): the title bar has none. Memoized: the
 * readout around it follows the position several times a second while the chrome shows (P2-PLAYER-4).
 */
const LiveBadge = memo(function LiveBadge({ status, pulseKey, className }: { status: PlayerState['status']; pulseKey: string; className?: string }) {
  const { t } = useTranslation('player');
  const failed = status === 'error';
  const onAir = status === 'playing';
  return (
    <span
      data-testid="live-badge"
      data-state={failed ? 'no-signal' : onAir ? 'on-air' : 'standby'}
      className={cn(
        'ms-1 inline-flex shrink-0 items-center gap-1.5 px-2 py-0.5 font-numeric text-caption tracking-wide whitespace-nowrap uppercase [[data-big]_&]:text-body-sm',
        onAir ? 'text-on-glass' : 'text-on-glass-muted',
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
});

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

/** The time at one end of the seek bar: tabular, on-glass, wide enough that the bar never shifts. */
const SEEK_TIME = 'shrink-0 font-numeric text-caption text-on-glass tabular-nums [text-shadow:0_1px_2px_rgb(0_0_0/0.6)] [[data-big]_&]:text-body';

/** Elapsed time, left of the seek bar (in right-to-left languages too). */
function ElapsedTime({ shown }: { shown: boolean }) {
  const position = useWhileShown(usePlayerStore, (s) => s.positionSeconds, shown);
  return (
    <span data-testid="time-elapsed" className={cn(SEEK_TIME, 'min-w-[4ch] text-start')}>
      {formatTime(position)}
    </span>
  );
}

/**
 * The seek bar, with its own subscriptions to the position and buffer (the bar around it stays
 * put). `times`: the elapsed time and the duration at its ends (VOD outside the mini player).
 */
function PositionSeekBar({
  shown,
  live,
  duration,
  edgeSlack,
  times,
  onSeek,
}: {
  shown: boolean;
  live: boolean;
  duration: number | undefined;
  edgeSlack: number;
  times: boolean;
  onSeek(seconds: number, step?: boolean): void;
}) {
  const position = useWhileShown(usePlayerStore, (s) => s.positionSeconds, shown);
  const buffered = useWhileShown(useMediaStore, (s) => s.buffered, shown);
  const seekable = useWhileShown(useMediaStore, (s) => s.seekable, shown);
  const liveWindow = live ? liveWindowOf(seekable) : undefined;
  if (live && !liveWindow) return null;
  const bar = (
    <SeekBar
      min={liveWindow ? liveWindow.start : 0}
      max={liveWindow ? liveWindow.end : (duration ?? 0)}
      value={position}
      buffered={buffered}
      live={!!liveWindow}
      edgeSlack={edgeSlack}
      onSeek={onSeek}
      className={times ? 'min-w-0 flex-1' : undefined}
    />
  );
  // Left to right in every language, as on other players: the timeline is the tape's direction, and
  // the bar fills from the left. The elapsed time stays at the played end, the length at the other.
  if (!times || live)
    return (
      <div dir="ltr" className="px-1">
        {bar}
      </div>
    );
  return (
    <div data-testid="seek-row" dir="ltr" className="flex items-center gap-3 px-1">
      <ElapsedTime shown={shown} />
      {bar}
      <span data-testid="time-duration" className={cn(SEEK_TIME, 'min-w-[4ch] text-end text-on-glass-muted')}>
        {formatTime(duration)}
      </span>
    </div>
  );
}

/** VOD in the mini player: position and duration in the row. `tiny` (a phone's mini player) drops the duration (F-PHONE-DOCK). */
function TimeReadout({ shown, duration, tiny }: { shown: boolean; duration: number | undefined; tiny: boolean }) {
  const position = useWhileShown(usePlayerStore, (s) => s.positionSeconds, shown);
  return (
    <span className="ms-1 font-numeric text-caption whitespace-nowrap text-on-glass tabular-nums">
      {formatTime(position)}
      {!tiny && duration !== undefined && <span className="text-on-glass-muted"> / {formatTime(duration)}</span>}
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
  tiny,
  edgeSlack,
  mpv,
}: {
  shown: boolean;
  status: PlayerState['status'];
  pulseKey: string;
  /** Compact or narrow: "Live" and "-1:30" instead of "Go live" and "1:30 behind live". */
  short: boolean;
  narrow: boolean;
  /** A phone's mini player: the "Live" button alone, no time behind. */
  tiny: boolean;
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
      {/* Short, it reads "Live": the tooltip says what it does. */}
      <Tooltip content={short ? t('goLive') : null} tone="glass" describe={false}>
        <button
          type="button"
          data-ctl="golive"
          onMouseDown={pressKeepsFocus}
          onClick={(e) => {
            // At the edge this button gives way to the LIVE badge: hand focus to play/pause
            // first, or it would fall to the page and the player's keys would stop working.
            // A pointer press never took focus here (pressKeepsFocus).
            if (document.activeElement === e.currentTarget) {
              const bar = e.currentTarget.closest('[data-player-controls]');
              bar?.querySelector<HTMLElement>('[data-ctl="play"]')?.focus({ preventScroll: true });
            }
            usePlayerStore.getState().seekTo(mpv ? liveWindow.end - 1 : liveWindow.end);
          }}
          aria-label={t('goLive')}
          className={cn(
            'ms-1 inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-caption font-medium text-on-glass ring-1 ring-white/30 hover:bg-white/12 hover:ring-white/50 motion-safe:transition-colors [[data-big]_&]:h-9 [[data-big]_&]:px-3.5 [[data-big]_&]:text-body-sm',
            !short && 'pointer-coarse:h-9',
          )}
        >
          <span className="size-2 rounded-full bg-white/50" aria-hidden />
          {short ? t('live') : t('goLive')}
        </button>
      </Tooltip>
      {!tiny && (
        <span
          className={cn(
            'ms-1.5 min-w-0 truncate font-numeric text-body-sm whitespace-nowrap text-on-glass tabular-nums [[data-big]_&]:text-body',
            narrow && NARROW_YIELD_TO_VOLUME,
          )}
          data-testid="behind-live"
        >
          {short ? `-${formatTime(behindLive)}` : t('behindLive', { time: formatTime(behindLive) })}
        </span>
      )}
    </>
  );
}

/** The record toggle as a row of the options menu. */
function RecordMenuAction({ onDone }: { onDone(): void }) {
  const { t } = useTranslation('player');
  const { recording, busy, toggle } = useRecordToggle();
  return (
    <MenuAction
      icon={<CircleDot aria-hidden className={recording ? 'text-danger' : undefined} />}
      label={recording ? t('recordStop') : t('recordStart')}
      disabled={busy}
      onClick={() => {
        toggle();
        onDone();
      }}
    />
  );
}

/**
 * While the volume slider is out in a narrow bar, the live badge or the time steps aside for it
 * (the row has no room for both).
 */
const NARROW_YIELD_TO_VOLUME = '[[data-ctl-row]:has([data-vol]:hover)_&]:hidden [[data-ctl-row]:has([data-vol]:focus-within)_&]:hidden [[data-ctl-row]:has([data-vol][data-dragging])_&]:hidden';

/** The buttons a narrow row can do without (the options menu takes them), by group. */
type Spare = 'zap' | 'jump' | 'captions' | 'pip' | 'skip';
/** A spare button's room in the row: 40 px and the row's 4 px gap. */
const SPARE_SLOT_PX = 44;
/** What the dock's readout keeps for itself (typed channel digits, the volume level). */
const READOUT_KEEP_PX = 72;

/**
 * The spare groups a narrow row keeps, given room for `slots` buttons. `groups` come most useful
 * first with their button counts; one that does not fit is skipped and a smaller one may follow.
 */
export function keepSpares<S extends string>(groups: readonly (readonly [S, number])[], slots: number): Set<S> {
  const kept = new Set<S>();
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
 * show, so it settles in one pass. Read in the row's ResizeObserver callback, after layout (where
 * there is none, in the next frame), never during a render. Not measured while the volume slider is
 * out: the row lends it room then (the spares step aside), and it is measured again when the
 * pointer or focus leaves.
 */
function useSpareSlots(row: HTMLElement | null, active: boolean): { slots: number; showing: { current: number } } {
  const [slots, setSlots] = useState(0);
  // How many spares the render being measured shows (set by the caller once it has picked them).
  const showing = useRef(0);
  const measure = useRef<() => void>(() => undefined);
  measure.current = () => {
    if (!row || !active) return;
    if (row.querySelector('[data-vol]')?.matches(':hover, :focus-within, [data-dragging]')) return;
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
  const observer = useRef<{ ro: ResizeObserver; row: HTMLElement } | null>(null);
  /**
   * Measures after the next layout. The row observed anew makes its ResizeObserver call back
   * then, with layout done. A read in the next frame's callback instead forced that layout itself,
   * ahead of the browser's own, after every render of a narrow bar (P2-PLAYER-1).
   */
  const later = useRef((): void => {
    const o = observer.current;
    if (o) {
      o.ro.unobserve(o.row);
      o.ro.observe(o.row);
      return;
    }
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => measure.current());
  });
  useEffect(() => {
    if (!row) return;
    const again = later.current;
    row.addEventListener('pointerout', again);
    row.addEventListener('focusout', again);
    const ro = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => measure.current());
    ro?.observe(row);
    observer.current = ro ? { ro, row } : null;
    return () => {
      cancelAnimationFrame(frame.current);
      row.removeEventListener('pointerout', again);
      row.removeEventListener('focusout', again);
      ro?.disconnect();
      observer.current = null;
    };
  }, [row]);
  // What the row holds changes with the render (a badge, Retry, a caption track). After the
  // effect above, so the first render already has the row's observer.
  useEffect(() => {
    if (active) later.current();
  });
  return { slots: active ? slots : 0, showing };
}

/** 10 s back or ahead, as J and L do. */
function jump(seconds: number): void {
  usePlayerStore.getState().seekBy(seconds);
}

/**
 * The control bar. Memoized: it follows the stores itself, and the surface around it re-renders for
 * what the bar does not show (the pointer resting on it, the chrome's idle timer, a stall), which
 * re-rendered every button, tooltip and icon with it (P2-PLAYER-3).
 */
export const Controls = memo(function Controls({ variant, visible, compact, short, onMenuOpenChange, onVolumeDragChange, readoutIdle, channelPanel = false }: ControlsProps) {
  const { t } = useTranslation('player');
  const source = usePlayerStore((s) => s.source);
  const status = usePlayerStore((s) => s.status);
  // The position, buffer and live window are read by the leaves that show them (PositionSeekBar,
  // TimeReadout, LiveEdge): the bar itself re-renders only when what it lays out changes.
  const hasPosition = usePlayerStore((s) => s.positionSeconds > 0);
  const duration = usePlayerStore((s) => s.durationSeconds);
  const isFullscreen = usePlayerStore((s) => s.isFullscreen);
  const isWindowFilled = usePlayerStore((s) => s.isWindowFilled);
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
  /** What opened the menu: Playback options, or the sleep chip (straight to its view). */
  const [opener, setOpener] = useState<'options' | 'sleep'>('options');
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const menuId = useId();
  // A phone-width player (not the mini one, which has its own compact set): the row keeps its
  // core controls and the options menu takes the rest.
  const narrow = useNarrow(root) && !compact;
  // A phone's mini player (PlayerDock below sm, 190 px at least): the compact row drops
  // picture-in-picture and the duration, so play, mute, the time or live badge, and fullscreen fit.
  const tiny = useNarrow(root, TINY_MINI_PX) && !!compact;
  const [row, setRow] = useState<HTMLDivElement | null>(null);
  const spareRoom = useSpareSlots(row, narrow);

  const setMenu = (v: MenuView | null): void => {
    setMenuState(v);
    if (v !== null) setHistoryOpen(false);
    onMenuOpenChange?.(v !== null || useHistoryStore.getState().open);
  };

  /**
   * The menu asks to change view or close. Closing with focus inside it hands focus back to the
   * control that opened it: dropped on the page, the player's keys would stop working and the
   * page's own Escape (close the player) would be next in line. After a pointer pick it goes to
   * the player itself instead, so the next Space is play/pause, not the menu reopening
   * (PL-SPACE-CLICKED-CONTROL).
   */
  const setMenuView = (v: MenuView | null): void => {
    if (v === null && root) {
      // By id: a sheet is portalled out of the bar.
      const open = document.getElementById(menuId);
      if (open?.contains(document.activeElement)) {
        const trigger = focusFromPointer()
          ? root.closest<HTMLElement>('[data-player-focus]')
          : (root.querySelector<HTMLElement>(`[data-ctl="${opener}"]`) ??
            root.querySelector<HTMLElement>('[data-ctl="options"]') ??
            root.querySelector<HTMLElement>('[data-ctl="play"]'));
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
    if (Date.now() - subtitleMenuAt < 1000) {
      setOpener('options');
      setMenu('text');
    }
  }, [subtitleMenuAt]);
  // The error screen's "Other sources" (PL-ERROR-DEAD-ENDS): the channel's other copies, to pick
  // from. A compact bar has no options menu, and the error strip over it does not offer the action
  // (ErrorActions `menu`); a request still pending when the bar grows is taken then.
  const sourcesMenuAt = useMediaStore((s) => s.sourcesMenuAt);
  useEffect(() => {
    if (sourcesMenuAt === undefined || compact) return;
    useMediaStore.setState({ sourcesMenuAt: undefined });
    if (Date.now() - sourcesMenuAt < 1000) {
      setOpener('options');
      setMenu('sources');
    }
  }, [sourcesMenuAt, compact]);

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

  // A press outside an open menu or the history closes it (PL-MENU-OUTSIDE-CLICK), as the video's
  // context menu does. The press is noted, so the click on the picture that follows does only
  // that: it neither pauses nor, doubled, goes fullscreen (`consumeMenuDismiss`).
  const popupOpen = menu !== null || showHistory;
  useEffect(() => {
    if (!popupOpen || !root) return;
    const onPress = (e: PointerEvent): void => {
      const target = e.target instanceof Element ? e.target : null;
      // The menus themselves, the triggers, which toggle them on their own click, and a sheet's
      // scrim, which closes it on its click (so the click never lands on the page under it).
      if (target?.closest('[data-testid="player-options-menu"], [data-testid="channel-history"], [data-ctl="options"], [data-ctl="sleep"], [data-menu-scrim]')) return;
      noteMenuDismissed(e.target);
      if (menu !== null) setMenuView(null);
      if (useHistoryStore.getState().open) setHistoryOpen(false);
    };
    document.addEventListener('pointerdown', onPress, true);
    return () => document.removeEventListener('pointerdown', onPress, true);
  }, [popupOpen, root, menu]);

  if (!source) return null;
  const isLive = source.isLive;
  const isVod = !isLive && !source.isRadio;
  const playing = status === 'playing' || status === 'loading';
  const failed = status === 'error';
  // Over a failed stream the overlay's error panel owns the actions (Retry, Other sources and so
  // on), so the bar keeps only what still works there: the queue, a running sleep timer, the
  // options menu, leaving picture-in-picture and fullscreen. A second Retry, a volume for nothing
  // and a "No signal" badge under "This stream did not play" were noise. The dock bar (embedded
  // mpv, whose error strip may leave Retry out) keeps them.
  const panelOwnsError = failed && variant === 'overlay';
  const prev = prevInQueue();
  const next = nextInQueue();
  const captionsOn = tracks.text.some((x) => x.selected);
  const episodic = !!source.episodeId;

  // mpv's cache runs a few seconds ahead of playback even at the live edge.
  const edgeSlack = mode === 'embedded-mpv' ? LIVE_EDGE_SLACK_MPV : LIVE_EDGE_SLACK;
  const showSeek = isVod ? !!duration : isLive && liveWindowed;
  // Nothing known yet: no "0:00 / 0:00" while the stream (or the mpv session) is still starting.
  const showTime = !!duration || hasPosition || status !== 'loading';
  const canRecord = isDesktop && mode === 'embedded-mpv' && isLive && mpvAttached;
  const showPip = canPip && (variant === 'overlay' || !compact) && !tiny && (!panelOwnsError || inPip);
  // An iPhone has no element fullscreen; its video goes fullscreen natively (PL-IOS-FULLSCREEN).
  const showFullscreen = !windowPip && canEnterFullscreen();
  // Fullscreen: larger controls, further in from the edges, read from across a room.
  const scale: ChromeScale = compact ? 'mini' : (isFullscreen || isWindowFilled) && !windowPip ? 'big' : 'normal';
  const big = scale === 'big';
  // The 10 s skips (PL-BAR-HIERARCHY): VOD with a known length, outside the mini player.
  const canJump = isVod && !!duration && !compact && !ended && !failed;
  // Fullscreen live TV (C5): channel up and down on the bar, and the channel list's button (it
  // replaced a lone disc at the screen's edge), so changing channel needs no keyboard. Over a
  // failed stream too: zapping away is often the way out. Elsewhere the page's own list is beside
  // the stage.
  const canZapHere = variant === 'overlay' && big && canZap({ source });

  const store = usePlayerStore.getState();
  // Overlay: controls laid on an edge-to-edge scrim over the picture, no pane. Dock: a strong glass
  // strip under the native video.
  const floating = variant === 'overlay' && !compact;

  // A narrow row keeps the spares it has room for, most useful first; the menu takes the rest.
  const kept = narrow
    ? keepSpares<Spare>(
        [
          ['zap', canZapHere ? 2 : 0],
          ['jump', canJump ? 2 : 0],
          ['captions', tracks.text.length > 0 ? 1 : 0],
          ['pip', showPip && !windowPip ? 1 : 0],
          ['skip', (prev ? 1 : 0) + (next ? 1 : 0)],
        ],
        spareRoom.slots,
      )
    : undefined;
  const inRow = (spare: Spare): boolean => !kept || kept.has(spare);
  spareRoom.showing.current = kept
    ? (kept.has('zap') && canZapHere ? 2 : 0) +
      (kept.has('jump') && canJump ? 2 : 0) +
      (kept.has('captions') && tracks.text.length > 0 ? 1 : 0) +
      (kept.has('pip') ? 1 : 0) +
      (kept.has('skip') ? (prev ? 1 : 0) + (next ? 1 : 0) : 0)
    : 0;
  // A kept spare steps aside while the volume slider is out, like the live badge.
  const spareClass = narrow ? NARROW_YIELD_TO_VOLUME : undefined;

  const prevButton = prev && (
    <CtlButton id="prev" className={spareClass} shortcut="previousItem" label={episodic ? t('previousEpisode') : t('previous')} onClick={() => store.prev()}>
      {ICON.previous}
    </CtlButton>
  );
  const nextButton = next && (
    <CtlButton id="next" className={spareClass} shortcut="nextItem" label={episodic ? t('nextEpisode') : t('next')} onClick={() => store.next()}>
      {ICON.next}
    </CtlButton>
  );
  const jumpButtons = canJump && (
    <>
      <CtlButton id="back10" className={spareClass} shortcut="skipBack" label={t('seekBack', { count: SEEK_STEP_JL })} onClick={() => jump(-SEEK_STEP_JL)}>
        {ICON.back10}
      </CtlButton>
      <CtlButton id="fwd10" className={spareClass} shortcut="skipForward" label={t('seekForward', { count: SEEK_STEP_JL })} onClick={() => jump(SEEK_STEP_JL)}>
        {ICON.forward10}
      </CtlButton>
    </>
  );

  const zapButtons = canZapHere && (
    <>
      <CtlButton id="channel-up" className={spareClass} shortcut="channelUp" label={t('previousChannel')} onClick={() => void zap('up').catch(() => undefined)}>
        {ICON.channelUp}
      </CtlButton>
      <CtlButton id="channel-down" className={spareClass} shortcut="channelDown" label={t('nextChannel')} onClick={() => void zap('down').catch(() => undefined)}>
        {ICON.channelDown}
      </CtlButton>
    </>
  );
  const channelsButton = channelPanel && (
    <CtlButton id="channels" className={spareClass} shortcut="channelPanel" label={t('openChannelPanel')} onClick={() => useMediaStore.setState({ channelPanelOpen: true })}>
      {ICON.channels}
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
  const movedZap = canZapHere && !inRow('zap');
  const movedJump = canJump && !inRow('jump');
  const movedPip = showPip && !windowPip && !inRow('pip');
  const movedSkip = (prev || next) && !inRow('skip');
  const moved =
    narrow && (movedZap || movedJump || movedPip || movedSkip) ? (
      <>
        {movedZap && (
          <>
            <CtlButton role="menuitem" label={t('previousChannel')} shortcut="channelUp" onClick={closeThen(() => void zap('up').catch(() => undefined))}>
              {ICON.channelUp}
            </CtlButton>
            <CtlButton role="menuitem" label={t('nextChannel')} shortcut="channelDown" onClick={closeThen(() => void zap('down').catch(() => undefined))}>
              {ICON.channelDown}
            </CtlButton>
          </>
        )}
        {movedJump && (
          <>
            <CtlButton role="menuitem" label={t('seekBack', { count: SEEK_STEP_JL })} shortcut="skipBack" onClick={() => jump(-SEEK_STEP_JL)}>
              {ICON.back10}
            </CtlButton>
            <CtlButton role="menuitem" label={t('seekForward', { count: SEEK_STEP_JL })} shortcut="skipForward" onClick={() => jump(SEEK_STEP_JL)}>
              {ICON.forward10}
            </CtlButton>
          </>
        )}
        {prev && movedSkip && (
          <CtlButton role="menuitem" label={episodic ? t('previousEpisode') : t('previous')} shortcut="previousItem" onClick={closeThen(() => store.prev())}>
            {ICON.previous}
          </CtlButton>
        )}
        {next && movedSkip && (
          <CtlButton role="menuitem" label={episodic ? t('nextEpisode') : t('next')} shortcut="nextItem" onClick={closeThen(() => store.next())}>
            {ICON.next}
          </CtlButton>
        )}
        {movedPip && (
          <CtlButton role="menuitem" label={inPip ? t('exitPip') : t('pip')} onClick={closeThen(() => commands?.togglePip())}>
            {ICON.pip}
          </CtlButton>
        )}
      </>
    ) : undefined;

  const commandsShown: MenuCommands = {
    screenshot: mode !== 'radio',
    history: isLive,
    record: canRecord,
    stop: true,
  };

  const playButton = ended ? (
    <CtlButton id="play" primary={!compact} label={t('replay')} onClick={replay}>
      {ICON.replay}
    </CtlButton>
  ) : failed ? (
    // Nothing to play or pause after a failure: the same spot tries the stream again.
    <CtlButton id="play" primary={!compact} label={t('retry')} onClick={retryPlayback}>
      {ICON.replay}
    </CtlButton>
  ) : (
    <CtlButton id="play" primary={!compact} shortcut="playPause" label={playing ? t('pause') : t('play')} onClick={() => store.togglePlay()}>
      {playing ? ICON.pause : ICON.play}
    </CtlButton>
  );

  const overlay = variant === 'overlay';
  /** The player itself, which takes focus after a pointer closes a menu (PL-SPACE-CLICKED-CONTROL). */
  const focusPlayer = (): void => root?.closest<HTMLElement>('[data-player-focus]')?.focus({ preventScroll: true });
  // Overlay: the menus open from the top of the bar's pane, whatever scrim pads it (none over an
  // error), so the gap above the bar is always the same and a menu never covers it. Too short a
  // player for that, they are sheets. Dock: above the strip, over the picture. Over mpv the native
  // window leaves an open menu (role="menu" or "dialog") out of its region (mpvBounds), so the
  // strip it reserves for the bar keeps the bar's height and the video keeps its size.
  const menuPopup = menu && (
    <PlayerPopup className={overlay ? cn('end-0 bottom-full', compact ? 'mb-1' : 'mb-2') : 'end-1.5 bottom-full mb-1'} sheet={overlay} onScrim={() => setMenuView(null)}>
      {(fit) => <OptionsMenu id={menuId} view={menu} setView={setMenuView} isVod={isVod} moved={moved} commandsShown={commandsShown} fit={fit} />}
    </PlayerPopup>
  );
  const historyPopup = showHistory && (
    <PlayerPopup
      className={overlay ? cn('start-0 bottom-full', compact ? 'mb-1' : 'mb-2') : 'start-1.5 bottom-full mb-1'}
      sheet={overlay}
      onScrim={() => {
        setHistoryOpen(false);
        focusPlayer();
      }}
    >
      {(fit) => <ChannelHistory fit={fit} />}
    </PlayerPopup>
  );

  return (
    <ChromeScaleContext.Provider value={scale}>
      <div
        ref={setRoot}
        data-player-controls=""
        data-narrow={narrow ? '' : undefined}
        data-big={big ? '' : undefined}
        className={cn(
          'player-chrome relative',
          // Over a failed stream the error screen has darkened the picture already: no scrim
          // rising over its buttons (a short player's error sits right above the bar). A short
          // player takes the mini player's shorter fade.
          overlay
            ? compact
              ? cn('px-1', failed ? 'pt-1' : 'player-scrim-bottom player-scrim-compact pt-8')
              : big
                ? cn('px-4 pb-4 sm:px-10 sm:pb-8', failed ? 'pt-4' : 'player-scrim-bottom player-scrim-big pt-24')
                : cn('px-2 pb-1.5 sm:px-4 sm:pb-3', failed ? 'pt-2' : short ? 'player-scrim-bottom player-scrim-compact pt-8' : 'player-scrim-bottom pt-16')
            : cn('player-glass-strong border-t py-1.5', big ? 'px-6' : 'px-3'),
          variant === 'overlay' && 'motion-safe:transition-opacity motion-safe:duration-(--duration-base)',
          // The scrim's padding is only shade: the pointer goes through it to what is under it (a
          // stream error's Retry, the picture), and only the pane and its menus take it.
          variant !== 'overlay' ? 'pointer-events-auto' : visible ? 'pointer-events-none *:pointer-events-auto' : 'pointer-events-none opacity-0',
        )}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        {!overlay && menuPopup}
        {!overlay && historyPopup}

        {/* The pane's box: the overlay's menus float up from its top edge. */}
        <div className="relative">
          {overlay && menuPopup}
          {overlay && historyPopup}
          <div
            data-testid="controls-pane"
            role="toolbar"
            aria-label={t('playerControls')}
            // The arrow keys stay the player's (seek, volume): a toolbar here does not move focus with them.
            className={cn('flex flex-col', floating && (big ? 'gap-3' : 'gap-1'), variant === 'overlay' && compact && 'px-0.5')}
          >
            {showSeek && (
              <PositionSeekBar
                shown={visible}
                live={isLive}
                duration={duration}
                edgeSlack={edgeSlack}
                times={!compact}
                onSeek={(s, step) => store.seekTo(s, { step })}
              />
            )}
            <div ref={setRow} data-ctl-row="" className={cn('flex min-w-0 items-center', compact ? 'gap-0.5' : big ? 'gap-2' : 'gap-1')}>
              {!compact && !narrow && prevButton}
              {!panelOwnsError && playButton}
              {!compact && !narrow && nextButton}
              {!narrow && jumpButtons}
              {/* Over an error a narrow row has no volume, so nothing makes the channel buttons step aside:
                  they stay together at the start, as on a wide bar. */}
              {(!narrow || panelOwnsError) && channelsButton}
              {(!narrow || (panelOwnsError && inRow('zap'))) && zapButtons}
              {!panelOwnsError && <VolumeControl compact={compact || narrow} onDragChange={onVolumeDragChange} />}
              {/* With the volume, the channel list steps aside while its slider is out. Right of it, like
                  the spares, so the volume button does not move under the finger that opened it. */}
              {narrow && !panelOwnsError && channelsButton}

              {panelOwnsError ? null : isLive ? (
                <LiveEdge
                  shown={visible}
                  status={status}
                  pulseKey={source.url}
                  short={!!compact || narrow}
                  narrow={narrow}
                  tiny={tiny}
                  edgeSlack={edgeSlack}
                  mpv={mode === 'embedded-mpv'}
                />
              ) : source.isRadio ? (
                <span className="ms-1 inline-flex items-center gap-1.5 text-caption text-on-glass-muted">
                  <Radio className="size-4" aria-hidden />
                  {t('radio')}
                </span>
              ) : showTime && (compact || !showSeek) ? (
                <TimeReadout shown={visible} duration={duration} tiny={tiny} />
              ) : null}
              {/* Sleep timer (C5): the countdown while one runs; opens its menu. */}
              <SleepChip
                compact={compact || narrow}
                expanded={menu !== null && opener === 'sleep'}
                menuId={menuId}
                onOpen={() => {
                  setOpener('sleep');
                  setMenu(menu === 'sleep' ? null : 'sleep');
                }}
              />
              {canRecord && <RecordControl compact={compact || narrow} />}

              <div data-row-free="" className="flex-1" />
              {variant === 'dock' && !compact && <BarReadout fallback={readoutIdle} />}
              {/* A narrow row keeps its spares right of the volume, so they can step aside when it opens. */}
              {narrow && !panelOwnsError && inRow('zap') && zapButtons}
              {narrow && inRow('jump') && jumpButtons}
              {narrow && inRow('skip') && prevButton}
              {narrow && inRow('skip') && nextButton}

              <div className={cn('flex items-center', big ? 'gap-2' : 'gap-1')}>
                {tracks.text.length > 0 && !compact && inRow('captions') && (
                  <CtlButton
                    id="captions"
                    className={spareClass}
                    // In live fullscreen, C opens the channel list instead.
                    shortcut={isLive && (isFullscreen || isWindowFilled) ? undefined : 'captions'}
                    label={t('captions')}
                    tooltip={captionsOn ? t('captionsOn') : t('captionsOff')}
                    pressed={captionsOn}
                    onClick={() => {
                      const first = tracks.text[0];
                      commands?.setText(captionsOn || !first ? null : first.id);
                    }}
                  >
                    {captionsOn ? ICON.captionsOn : ICON.captionsOff}
                  </CtlButton>
                )}
                {!compact && (
                  <CtlButton
                    id="options"
                    label={t('settingsMenu')}
                    popup={{ expanded: menu !== null && opener === 'options', controls: menuId }}
                    onClick={() => {
                      setOpener('options');
                      setMenu(menu ? null : 'root');
                    }}
                  >
                    {ICON.options}
                  </CtlButton>
                )}
              </div>
              {(showPip && (windowPip || inRow('pip'))) || showFullscreen || (!compact && !windowPip) ? (
                <div className={cn('flex items-center', big ? 'ms-4 gap-2' : 'gap-1', !compact && !big && 'ms-1 sm:ms-2')}>
                  {showPip && (windowPip || inRow('pip')) && (
                    <CtlButton
                      id="pip"
                      className={windowPip ? undefined : spareClass}
                      shortcut={windowPip ? 'exitPip' : undefined}
                      label={inPip ? t('exitPip') : t('pip')}
                      onClick={() => commands?.togglePip()}
                    >
                      {ICON.pip}
                    </CtlButton>
                  )}
                  {!compact && !windowPip && (
                    <CtlButton
                      id="window-fill"
                      label={isWindowFilled ? t('exitWindowFill') : t('windowFill')}
                      onClick={() => store.toggleWindowFill()}
                    >
                      {isWindowFilled ? <Minimize2 /> : <Maximize2 />}
                    </CtlButton>
                  )}
                  {showFullscreen && (
                    <CtlButton
                      id="fullscreen"
                      shortcut="fullscreen"
                      label={isFullscreen ? t('exitFullscreen') : t('fullscreen')}
                      onClick={() => store.toggleFullscreen()}
                    >
                      {isFullscreen ? ICON.exitFullscreen : ICON.fullscreen}
                    </CtlButton>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </ChromeScaleContext.Provider>
  );
});
