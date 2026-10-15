import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import { useShortcut } from '@/shell/shortcuts';
import { LIVE_EDGE_SLACK, LIVE_EDGE_SLACK_MPV, positionReadout, SEEK_STEP, SEEK_STEP_LARGE, targetOwnsKey, type KeyKind } from './format';
import { playPreviousChannel, setHistoryOpen, useHistoryStore } from './history';
import { showOsd, useMediaStore } from './media';
import { exitPip, usePipStore } from './pip';
import { announceSleep } from './sleepReadout';
import { cycleSleepTimer } from './sleepTimer';
import { nextInQueue, prevInQueue, usePlayerStore, zap } from './store';
import { toggleStreamInfo } from './streamInfo';
import { adjustDelay, formatDelay, type DelayKind } from './sync';

const AREA = 'Playback';
/** Seconds the left and right arrows skip (shared with the seek bar). */
export { SEEK_STEP };
/** Seconds J and L skip. */
export const SEEK_STEP_JL = 10;
/** Volume change per arrow press or wheel notch. */
export const VOLUME_STEP = 0.05;

/** Takes a screenshot (C6), loading the capture code on first use so it stays out of the entry chunk. */
export function screenshot(): Promise<void> {
  return import('./screenshot').then((m) => m.takeScreenshot());
}

/**
 * Changes the volume by `steps` steps (negative = quieter) and shows the readout: the arrow
 * keys and the wheel over the native video both go through here.
 */
export function stepVolume(steps: number, t: TFunction<'player'>): void {
  const player = usePlayerStore.getState();
  player.adjustVolume(VOLUME_STEP * steps);
  const { volume, muted } = usePlayerStore.getState();
  showOsd(muted ? t('muted') : t('volumePercent', { percent: Math.round(volume * 100) }));
}

/**
 * Steps the audio or subtitle delay and shows the new value. When the current player cannot
 * apply it (audio delay outside embedded mpv, no subtitles), the readout says why instead.
 */
export function stepSyncDelay(kind: DelayKind, steps: number, t: TFunction<'player'>, locale?: string): void {
  const label = kind === 'audio' ? t('syncAudio') : t('syncSubtitles');
  if (kind === 'audio' && usePlayerStore.getState().mode !== 'embedded-mpv') {
    showOsd(label, t('syncAudioNeedsMpv'));
    return;
  }
  if (kind === 'sub' && useMediaStore.getState().tracks.text.length === 0) {
    showOsd(label, t('syncNoSubtitles'));
    return;
  }
  showOsd(label, formatDelay(adjustDelay(kind, steps), locale));
}

/**
 * Playback shortcuts (C16: space/k, f, arrows, m; plus c, page up/down; and the player
 * slice's j/l, g/h, i, b, shift+b, shift+p, z for the sleep timer, shift+c for the
 * Subtitles menu, and s for a screenshot). Registered once by the dock; active while
 * something plays in-app.
 */
export function usePlaybackShortcuts(opts: { channelPanelAvailable: boolean }): void {
  const { t, i18n } = useTranslation('player');
  const active = usePlayerStore((s) => !!s.source && s.mode !== 'external');
  const live = usePlayerStore((s) => !!s.source?.isLive);
  // Radio shows neither the history popover nor the stream info panel.
  const video = usePlayerStore((s) => s.mode !== 'radio');
  const seekable = usePlayerStore((s) => !!s.source && !s.source.isLive && !s.source.isRadio);
  const hasNext = usePlayerStore((s) => s.queue.length > 1 && !!s.source && !!nextInQueue());
  const hasPrev = usePlayerStore((s) => s.queue.length > 1 && !!s.source && !!prevInQueue());

  /** Wrap a handler: skip when the focused element owns the key, else prevent default and run. */
  const guard =
    (kind: KeyKind, fn: () => void) =>
    (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (targetOwnsKey(e, kind)) {
        // The shell registry already called preventDefault, which cancels a focused
        // button's own Space activation; perform it so Space still presses the button.
        if (kind === 'space') {
          const el = e.target as HTMLElement | null;
          if (el && (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' || el.tagName === 'A')) el.click();
        }
        return;
      }
      e.preventDefault();
      fn();
    };
  /**
   * One press, one action: a held key's auto-repeat (about 30 keydowns a second) is ignored.
   * For toggles, jumps and captures (a held S would save a file per repeat). Steps (seek,
   * volume, sync, channel up/down) keep the repeat, so holding them keeps stepping.
   */
  const once =
    (handler: (e: KeyboardEvent) => void) =>
    (e: KeyboardEvent): void => {
      if (!e.repeat) handler(e);
    };
  const s = (): ReturnType<typeof usePlayerStore.getState> => usePlayerStore.getState();
  const volumeOsd = (): void => {
    const { volume, muted } = s();
    showOsd(muted ? t('muted') : t('volumePercent', { percent: Math.round(volume * 100) }));
  };
  /** Transient readout after an arrow seek: the step, then where playback now is. */
  const seekOsd = (delta: number): void => {
    const { positionSeconds, durationSeconds, source, mode } = s();
    const w = useMediaStore.getState().seekable;
    showOsd(
      t(delta < 0 ? 'seekBack' : 'seekForward', { count: Math.abs(delta) }),
      positionReadout(t, {
        position: positionSeconds,
        duration: durationSeconds,
        liveEnd: source?.isLive && w ? w.end : undefined,
        edgeSlack: mode === 'embedded-mpv' ? LIVE_EDGE_SLACK_MPV : LIVE_EDGE_SLACK,
      }),
    );
  };
  const seekWindow = (): boolean => {
    if (seekable) return true;
    const w = useMediaStore.getState().seekable;
    return !!w && w.end - w.start >= 30;
  };

  const base = { area: AREA, enabled: active };
  useShortcut('space', once(guard('space', () => s().togglePlay())), { ...base, description: t('shortcutPlayPause') });
  useShortcut('k', once(guard('letter', () => s().togglePlay())), { ...base, description: t('shortcutPlayPauseK') });
  // In picture-in-picture, f returns to the full app window instead.
  useShortcut('f', once(guard('letter', () => (usePipStore.getState().active ? void exitPip() : s().toggleFullscreen()))), {
    ...base,
    description: t('shortcutFullscreen'),
  });
  const seek = (delta: number) => () => {
    if (!seekWindow()) return;
    s().seekBy(delta);
    seekOsd(delta);
  };
  useShortcut('arrowleft', guard('arrow', seek(-SEEK_STEP)), { ...base, description: t('shortcutSeekBack') });
  useShortcut('arrowright', guard('arrow', seek(SEEK_STEP)), { ...base, description: t('shortcutSeekForward') });
  useShortcut('shift+arrowleft', guard('arrow', seek(-SEEK_STEP_LARGE)), { ...base, description: t('shortcutSeekBackLarge') });
  useShortcut('shift+arrowright', guard('arrow', seek(SEEK_STEP_LARGE)), { ...base, description: t('shortcutSeekForwardLarge') });
  // Next episode (or the next item of whatever queue is playing), like the bar's Next button.
  useShortcut(
    'n',
    once(
      guard('letter', () => {
        const next = nextInQueue();
        if (!next) return;
        showOsd(t('next'), next.subtitle ? `${next.subtitle} ${next.title}` : next.title);
        s().next();
      }),
    ),
    { ...base, enabled: active && hasNext, description: t('shortcutNextItem') },
  );
  useShortcut(
    'arrowup',
    guard('arrow', () => {
      stepVolume(1, t);
    }),
    { ...base, description: t('shortcutVolumeUp') },
  );
  useShortcut(
    'arrowdown',
    guard('arrow', () => {
      stepVolume(-1, t);
    }),
    { ...base, description: t('shortcutVolumeDown') },
  );
  useShortcut(
    'm',
    once(
      guard('letter', () => {
        s().toggleMute();
        volumeOsd();
      }),
    ),
    { ...base, description: t('shortcutMute') },
  );
  useShortcut(
    'c',
    once(
      guard('letter', () => {
        const media = useMediaStore.getState();
        if (opts.channelPanelAvailable && s().isFullscreen) {
          useMediaStore.setState({ channelPanelOpen: !media.channelPanelOpen });
          return;
        }
        const on = media.tracks.text.some((x) => x.selected);
        const first = media.tracks.text[0];
        if (!first) return;
        media.commands?.setText(on ? null : first.id);
        showOsd(on ? t('captionsOff') : t('captionsOn'));
      }),
    ),
    { ...base, description: opts.channelPanelAvailable ? t('shortcutChannelPanel') : t('shortcutCaptions') },
  );
  // Subtitles (C6): Shift+C opens the control bar's Subtitles submenu (tracks, loading a file, style).
  useShortcut('shift+c', once(guard('letter', () => useMediaStore.setState({ subtitleMenuAt: Date.now() }))), {
    ...base,
    enabled: active && video,
    description: t('shortcutSubtitleMenu'),
  });
  // J/L: 10 s, like most video sites. Live only inside a rewind window.
  const seekJL = (delta: number) => () => {
    if (!seekWindow()) {
      showOsd(t('seekUnavailable'));
      return;
    }
    s().seekBy(delta);
    seekOsd(delta);
  };
  useShortcut('j', guard('letter', seekJL(-SEEK_STEP_JL)), { ...base, description: t('shortcutSeekBack10') });
  useShortcut('l', guard('letter', seekJL(SEEK_STEP_JL)), { ...base, description: t('shortcutSeekForward10') });
  // Previous episode (or item), mirroring N.
  useShortcut(
    'shift+p',
    once(
      guard('letter', () => {
        const prev = prevInQueue();
        if (!prev) return;
        showOsd(t('previous'), prev.subtitle ? `${prev.subtitle} ${prev.title}` : prev.title);
        s().prev();
      }),
    ),
    { ...base, enabled: active && hasPrev, description: t('shortcutPrevItem') },
  );
  // Sync: G/H move the subtitles, Shift+G/H the sound, 100 ms per press (VLC's keys).
  const locale = i18n.language;
  useShortcut('g', guard('letter', () => stepSyncDelay('sub', -1, t, locale)), { ...base, description: t('shortcutSubDelayDown') });
  useShortcut('h', guard('letter', () => stepSyncDelay('sub', 1, t, locale)), { ...base, description: t('shortcutSubDelayUp') });
  useShortcut('shift+g', guard('letter', () => stepSyncDelay('audio', -1, t, locale)), { ...base, description: t('shortcutAudioDelayDown') });
  useShortcut('shift+h', guard('letter', () => stepSyncDelay('audio', 1, t, locale)), { ...base, description: t('shortcutAudioDelayUp') });
  // Sleep timer (C5): Z steps off, 15, 30, 45, 60, 90 minutes, then off again.
  useShortcut(
    'z',
    once(
      guard('letter', () => {
        cycleSleepTimer();
        announceSleep(t, locale);
      }),
    ),
    { ...base, description: t('shortcutSleepTimer') },
  );
  useShortcut('i', once(guard('letter', () => void toggleStreamInfo())), { ...base, enabled: active && video, description: t('shortcutStreamInfo') });
  // Screenshot (C6): video only, one per press. A focused Live list row or multi-view tile keeps its own S.
  useShortcut('s', once(guard('letter', () => void screenshot().catch(() => showOsd(t('screenshotFailed'))))), {
    ...base,
    enabled: active && video,
    description: t('screenshot'),
  });
  useShortcut(
    'b',
    once(
      guard('letter', () => {
        if (!playPreviousChannel()) showOsd(t('lastChannel'), t('noPreviousChannel'));
      }),
    ),
    { ...base, description: t('shortcutPrevChannel') },
  );
  useShortcut(
    'shift+b',
    once(guard('letter', () => setHistoryOpen(!useHistoryStore.getState().open))),
    { ...base, enabled: active && live && video, description: t('shortcutChannelHistory') },
  );
  useShortcut('pageup', guard('arrow', () => void zap('up').catch(() => undefined)), {
    ...base,
    enabled: active && live,
    description: t('shortcutChannelUp'),
  });
  useShortcut('pagedown', guard('arrow', () => void zap('down').catch(() => undefined)), {
    ...base,
    enabled: active && live,
    description: t('shortcutChannelDown'),
  });
}
