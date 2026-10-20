import { Check, Moon } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { formatClock, ms } from '@/features/live/lib/epgTime';
import { dismissToast, toast } from '@/ui/Toast';
import { Tooltip } from '@/ui/Tooltip';

import { cn } from '../cn';
import { focusIfPlayerOwnsFocus } from '../format';
import { fetchNowNext, peekNowNext } from '../nowNext';
import { usePipStore } from '../pip';
import { announceSleep, sleepLeftText } from '../sleepReadout';
import {
  episodeEndsAt,
  SLEEP_EXTEND_MINUTES,
  SLEEP_PRESETS,
  SLEEP_WARNING_MS,
  SLEEP_WARNING_TOAST,
  useSleepTimer,
  useSleepTimerExtras,
} from '../sleepTimer';
import { selectEnded, usePlayerStore } from '../store';
import { InlineSpinner } from './InlineSpinner';

export { sleepLeftText };

/** Re-renders every `ms` while `active`; the countdowns read the time from it. */
function useTick(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [active, ms]);
  return now;
}

/**
 * The countdown in the control bar while a timer runs: a moon and the time left. Opens the
 * sleep menu. Accent in the last minute; breathes (motion-safe) while the volume fades.
 */
export function SleepChip({ compact, onOpen }: { compact?: boolean; onOpen(): void }) {
  const { t } = useTranslation('player');
  const target = useSleepTimer((s) => s.target);
  const endsAt = useSleepTimer((s) => s.endsAt);
  const fading = useSleepTimer((s) => s.fading);
  const now = useTick(!!target);
  if (!target) return null;
  const left = endsAt === null ? null : Math.max(0, endsAt - now);
  const last = left !== null && left <= SLEEP_WARNING_MS;
  const text = endsAt === null ? null : sleepLeftText(endsAt, now);
  const label = text === null ? t('sleepChipWaiting') : t('sleepChipLabel', { time: text });
  return (
    <Tooltip content={label} tone="glass" describe={false}>
      <button
        type="button"
        data-ctl="sleep"
        data-testid="sleep-chip"
        aria-label={label}
        aria-keyshortcuts="Z"
        onClick={onOpen}
        className={cn(
          'ms-1 inline-flex shrink-0 items-center rounded-full font-numeric font-semibold tabular-nums ring-1 hover:bg-white/12 motion-safe:transition-colors',
          compact ? 'h-6 gap-1 px-1.5 text-[calc(11rem/15)]' : 'h-7 gap-1.5 px-2 text-xs',
          // The last minute lights up: the dial's accent on the dark themes, a brighter edge on the light one.
          last ? 'bg-white/10 text-white ring-white/70 dark:text-accent-hover dark:ring-accent/70' : 'text-white ring-white/25 hover:ring-white/45',
          fading && 'player-sleep-fading',
        )}
      >
        <Moon className={cn('shrink-0', compact ? 'size-3' : 'size-3.5')} aria-hidden />
        {text === null ? <InlineSpinner /> : text}
      </button>
    </Tooltip>
  );
}

/** The root menu row's value: the countdown while on, else "Off". */
export function SleepRowValue() {
  const { t } = useTranslation('player');
  const target = useSleepTimer((s) => s.target);
  const endsAt = useSleepTimer((s) => s.endsAt);
  const now = useTick(!!target);
  if (!target) return <>{t('sleepOffValue')}</>;
  if (endsAt === null) return <InlineSpinner />;
  return <span className="tabular-nums">{sleepLeftText(endsAt, now)}</span>;
}

function SleepChoice({
  label,
  value,
  selected,
  disabled,
  onClick,
}: {
  label: string;
  value?: ReactNode;
  selected: boolean;
  disabled?: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-sm px-3 py-2 text-start text-sm hover:bg-white/10 disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent',
        selected ? 'text-white dark:text-accent-hover' : 'text-white',
      )}
    >
      <Check className={cn('size-4 shrink-0', !selected && 'invisible')} aria-hidden />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {value !== undefined && <span className="player-on-glass-muted flex shrink-0 items-center gap-1 text-xs tabular-nums">{value}</span>}
    </button>
  );
}

type ProgrammeEnd = { state: 'loading' } | { state: 'none' } | { state: 'known'; at: number };

/** The airing programme's end on the live channel playing now, looked up when the menu opens. */
function useProgrammeEnd(enabled: boolean): ProgrammeEnd {
  const ref = usePlayerStore((s) => s.source?.ref);
  const live = usePlayerStore((s) => !!s.source?.isLive);
  const [end, setEnd] = useState<ProgrammeEnd>({ state: 'loading' });
  useEffect(() => {
    if (!enabled || !ref || !live) return;
    let stale = false;
    const read = (nn: ReturnType<typeof peekNowNext>): ProgrammeEnd => {
      if (nn === undefined) return { state: 'loading' };
      const at = nn?.now ? ms(nn.now.end) : 0;
      return Number.isFinite(at) && at > Date.now() ? { state: 'known', at } : { state: 'none' };
    };
    const cached = read(peekNowNext(ref));
    setEnd(cached);
    if (cached.state === 'loading') {
      void fetchNowNext(ref).then((nn) => {
        if (!stale) setEnd(read(nn));
      });
    }
    return () => {
      stale = true;
    };
  }, [enabled, ref, live]);
  return end;
}

/**
 * The sleep timer's submenu in the player's options menu: off, the presets, and "until the
 * programme ends" (live, with a guide) or "until the episode/movie ends" (VOD with a length).
 * Picking closes the menu and shows the new setting in the readout.
 */
export function SleepMenu({ onDone }: { onDone(): void }) {
  const { t, i18n } = useTranslation('player');
  const target = useSleepTimer((s) => s.target);
  const endsAt = useSleepTimer((s) => s.endsAt);
  const source = usePlayerStore((s) => s.source);
  const ended = usePlayerStore(selectEnded);
  usePlayerStore((s) => s.durationSeconds);
  const now = useTick(true, 1000);
  const live = !!source?.isLive;
  const vod = !!source && !source.isLive && !source.isRadio;
  const programme = useProgrammeEnd(live);
  const episodeEnd = vod && !ended ? episodeEndsAt(now) : null;
  const lang = i18n.language;

  const pick = (run: () => void): void => {
    run();
    onDone();
    announceSleep(t, lang);
  };
  const timer = useSleepTimer.getState();

  return (
    <>
      <SleepChoice label={t('sleepOffValue')} selected={!target} onClick={() => pick(() => timer.cancel())} />
      {SLEEP_PRESETS.map((m) => (
        <SleepChoice
          key={m}
          label={t('sleepMinutes', { minutes: m })}
          value={formatClock(now + m * 60_000, lang)}
          selected={target?.kind === 'minutes' && target.minutes === m}
          onClick={() => pick(() => timer.start({ kind: 'minutes', minutes: m }))}
        />
      ))}
      {live && (
        <SleepChoice
          label={t('sleepProgrammeEnd')}
          value={
            programme.state === 'loading' ? (
              <>
                <InlineSpinner />
                <span className="sr-only">{t('sleepLookingUp')}</span>
              </>
            ) : programme.state === 'known' ? (
              formatClock(programme.at, lang)
            ) : (
              t('sleepNoGuideShort')
            )
          }
          selected={target?.kind === 'programmeEnd'}
          disabled={programme.state !== 'known'}
          onClick={() => pick(() => timer.start({ kind: 'programmeEnd' }))}
        />
      )}
      {vod && (
        <SleepChoice
          label={source?.episodeId ? t('sleepEpisodeEnd') : t('sleepMovieEnd')}
          value={episodeEnd !== null ? formatClock(episodeEnd, lang) : undefined}
          selected={target?.kind === 'episodeEnd'}
          disabled={episodeEnd === null}
          onClick={() => pick(() => timer.start({ kind: 'episodeEnd' }))}
        />
      )}
      {target && endsAt !== null && (
        <p role="none" className="player-on-glass-muted mt-1 border-t border-white/10 px-3 pt-2 pb-1 text-xs">
          {t('sleepStopsAt', { time: formatClock(endsAt, lang) })}
        </p>
      )}
    </>
  );
}

/**
 * The warning's toast body. The toast stack also renders it in its screen-reader live region:
 * there it is one fixed sentence (a ticking countdown would be read out every second, and a
 * button in a hidden region would be a stray tab stop).
 */
function SleepWarningBody() {
  const { t } = useTranslation('player');
  const endsAt = useSleepTimer((s) => s.endsAt);
  const ref = useRef<HTMLSpanElement>(null);
  const [spoken, setSpoken] = useState(false);
  useLayoutEffect(() => {
    setSpoken(!!ref.current?.closest('[data-toast-live]'));
  }, []);
  const now = useTick(!spoken);
  if (spoken) return <span ref={ref}>{t('sleepWarningSpoken')}</span>;
  return (
    <span ref={ref} className="flex flex-col items-start gap-1">
      <span className="tabular-nums">{t('sleepWarningIn', { time: endsAt === null ? '0:00' : sleepLeftText(endsAt, now) })}</span>
      <button
        type="button"
        data-testid="sleep-toast-cancel"
        onClick={() => useSleepTimer.getState().cancel()}
        className="-ms-1.5 inline-flex min-h-8 items-center rounded-sm px-1.5 text-sm font-semibold text-fg hover:underline active:bg-pressed"
      >
        {t('sleepCancel')}
      </button>
    </span>
  );
}

/**
 * Raises and drops the one-minute warning toast with the timer. Mounted once by the dock.
 * "Keep watching" is the toast's action (it closes the toast); Cancel turns the timer off.
 */
export function SleepTimerHost() {
  const { t } = useTranslation('player');
  const warning = useSleepTimerExtras((s) => s.warning);
  useEffect(() => {
    if (!warning) {
      dismissToast(SLEEP_WARNING_TOAST);
      return;
    }
    toast({
      id: SLEEP_WARNING_TOAST,
      title: t('sleepWarningTitle'),
      description: <SleepWarningBody />,
      action: { label: t('sleepKeepWatching', { minutes: SLEEP_EXTEND_MINUTES }), onClick: () => useSleepTimer.getState().extend(SLEEP_EXTEND_MINUTES) },
      duration: 0,
    });
  }, [warning, t]);
  useEffect(() => () => dismissToast(SLEEP_WARNING_TOAST), []);
  return null;
}

/**
 * The warning inside the player where toasts cannot be seen: fullscreen (the top layer hides
 * the toast stack) and picture-in-picture (the player covers the window). Takes focus only
 * when the player has it. Cut out of embedded mpv's native video like the other overlays.
 */
export function SleepPrompt({ small = false, className }: { small?: boolean; className?: string }) {
  const { t } = useTranslation('player');
  const warning = useSleepTimerExtras((s) => s.warning);
  const endsAt = useSleepTimer((s) => s.endsAt);
  const isFullscreen = usePlayerStore((s) => s.isFullscreen);
  const pip = usePipStore((s) => s.active);
  const show = warning && (isFullscreen || pip);
  const now = useTick(show);
  const keepRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (show) focusIfPlayerOwnsFocus(keepRef.current);
  }, [show]);
  if (!show) return null;
  const left = endsAt === null ? '0:00' : sleepLeftText(endsAt, now);
  return (
    <div
      role="group"
      aria-label={t('sleepTimer')}
      data-testid="sleep-prompt"
      data-mpv-overlay=""
      data-mpv-reserved=""
      className={cn(
        'player-glass player-glass-edge glass-blur pointer-events-auto absolute inset-x-0 z-30 mx-auto w-fit max-w-[calc(100%-1.5rem)] border text-white motion-safe:animate-pop-in',
        small ? 'rounded-md px-2.5 py-2' : 'rounded-lg px-4 py-3',
        className,
      )}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <div className={cn('flex items-center', small ? 'gap-2' : 'gap-3')}>
        <Moon className={cn('shrink-0 text-white dark:text-accent-hover', small ? 'size-4' : 'size-5')} aria-hidden />
        <p role="status" className={cn('min-w-0 tabular-nums', small ? 'text-xs' : 'text-sm')}>
          {!small && <span className="me-1.5 font-medium">{t('sleepWarningTitle')}.</span>}
          <span className="player-on-glass-muted">{t('sleepWarningIn', { time: left })}</span>
        </p>
      </div>
      <div className={cn('flex flex-wrap justify-end gap-2', small ? 'mt-1.5' : 'mt-2.5')}>
        <button
          type="button"
          onClick={() => useSleepTimer.getState().cancel()}
          className={cn('rounded-md text-white hover:bg-white/10', small ? 'px-2 py-1 text-xs' : 'px-3 py-1.5 text-sm')}
        >
          {t('sleepCancel')}
        </button>
        <button
          ref={keepRef}
          type="button"
          onClick={() => useSleepTimer.getState().extend(SLEEP_EXTEND_MINUTES)}
          className={cn('rounded-md bg-accent-solid font-medium text-accent-solid-fg hover:bg-accent-solid-hover', small ? 'px-2 py-1 text-xs' : 'px-3 py-1.5 text-sm')}
        >
          {t('sleepKeepWatching', { minutes: SLEEP_EXTEND_MINUTES })}
        </button>
      </div>
    </div>
  );
}
