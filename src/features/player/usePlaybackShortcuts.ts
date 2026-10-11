import { useTranslation } from 'react-i18next';

import { useShortcut } from './_shim';
import { targetOwnsKey, type KeyKind } from './format';
import { showOsd, useMediaStore } from './media';
import { usePlayerStore, zap } from './store';

const AREA = 'Playback';

/**
 * Playback shortcuts (C16: space/k, f, arrows, m; plus c, page up/down).
 * Registered once by the dock; active while something plays in-app.
 */
export function usePlaybackShortcuts(opts: { channelPanelAvailable: boolean }): void {
  const { t } = useTranslation('player');
  const active = usePlayerStore((s) => !!s.source && s.mode !== 'external');
  const live = usePlayerStore((s) => !!s.source?.isLive);
  const seekable = usePlayerStore((s) => !!s.source && !s.source.isLive && !s.source.isRadio);

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
  const seekWindow = (): boolean => {
    if (seekable) return true;
    const w = useMediaStore.getState().seekable;
    return !!w && w.end - w.start >= 30;
  };

  const base = { area: AREA, enabled: active };
  useShortcut('space', guard('space', () => s().togglePlay()), { ...base, description: t('shortcutPlayPause') });
  useShortcut('k', guard('letter', () => s().togglePlay()), { ...base, description: t('shortcutPlayPauseK') });
  useShortcut('f', guard('letter', () => s().toggleFullscreen()), { ...base, description: t('shortcutFullscreen') });
  useShortcut(
    'arrowleft',
    guard('arrow', () => {
      if (seekWindow()) s().seekBy(-5);
    }),
    { ...base, description: t('shortcutSeekBack') },
  );
  useShortcut(
    'arrowright',
    guard('arrow', () => {
      if (seekWindow()) s().seekBy(5);
    }),
    { ...base, description: t('shortcutSeekForward') },
  );
  useShortcut(
    'arrowup',
    guard('arrow', () => {
      s().adjustVolume(0.05);
      volumeOsd();
    }),
    { ...base, description: t('shortcutVolumeUp') },
  );
  useShortcut(
    'arrowdown',
    guard('arrow', () => {
      s().adjustVolume(-0.05);
      volumeOsd();
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
