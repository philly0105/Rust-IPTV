import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import { useShortcut } from '@/shell/shortcuts';
import { LIVE_EDGE_SLACK, LIVE_EDGE_SLACK_MPV, positionReadout, SEEK_STEP, SEEK_STEP_LARGE, targetOwnsKey, type KeyKind } from './format';
import { showOsd, useMediaStore } from './media';
import { exitPip, usePipStore } from './pip';
import { nextInQueue, usePlayerStore, zap } from './store';

const AREA = 'Playback';
/** Seconds the left and right arrows skip (shared with the seek bar). */
export { SEEK_STEP };
/** Volume change per arrow press or wheel notch. */
export const VOLUME_STEP = 0.05;

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
 * Playback shortcuts (C16: space/k, f, arrows, m; plus c, page up/down).
 * Registered once by the dock; active while something plays in-app.
 */
export function usePlaybackShortcuts(opts: { channelPanelAvailable: boolean }): void {
  const { t } = useTranslation('player');
  const active = usePlayerStore((s) => !!s.source && s.mode !== 'external');
  const live = usePlayerStore((s) => !!s.source?.isLive);
  const seekable = usePlayerStore((s) => !!s.source && !s.source.isLive && !s.source.isRadio);
  const hasNext = usePlayerStore((s) => s.queue.length > 1 && !!s.source && !!nextInQueue());

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
  useShortcut('space', guard('space', () => s().togglePlay()), { ...base, description: t('shortcutPlayPause') });
  useShortcut('k', guard('letter', () => s().togglePlay()), { ...base, description: t('shortcutPlayPauseK') });
  // In picture-in-picture, f returns to the full app window instead.
  useShortcut('f', guard('letter', () => (usePipStore.getState().active ? void exitPip() : s().toggleFullscreen())), { ...base, description: t('shortcutFullscreen') });
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
    guard('letter', () => {
      const next = nextInQueue();
      if (!next) return;
      showOsd(t('next'), next.subtitle ? `${next.subtitle} ${next.title}` : next.title);
      s().next();
    }),
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
    guard('letter', () => {
      s().toggleMute();
      volumeOsd();
    }),
    { ...base, description: t('shortcutMute') },
  );
  useShortcut(
    'c',
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
    { ...base, description: opts.channelPanelAvailable ? t('shortcutChannelPanel') : t('shortcutCaptions') },
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
