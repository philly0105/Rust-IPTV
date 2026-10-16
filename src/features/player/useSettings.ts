import { useEffect, useSyncExternalStore } from 'react';

import { onAppEvent } from '@/api/events';
import type { Settings } from '@/api/types';

import { forgetKnownChannels, getSettings, peekSettings, refreshPlayingChannel, setSettingsCache, subscribeSettings } from './store';
import { forgetChannelInfo } from './zapBanner';

let eventBound = false;

/**
 * Keeps the player's settings cache in sync with `settings.changed`, and the playing channel's
 * name (title, zap banner) with `channels.changed` (a rename, a new number or logo). Idempotent.
 */
export function bindSettingsEvents(): void {
  if (eventBound) return;
  eventBound = true;
  onAppEvent('settings.changed', (s) => setSettingsCache(s));
  onAppEvent('channels.changed', (e) => {
    forgetKnownChannels(e.sourceId);
    forgetChannelInfo();
    void refreshPlayingChannel(e.sourceId);
  });
}

/** Current settings for the player (null until first load). */
export function usePlayerSettings(): Settings | null {
  const settings = useSyncExternalStore(subscribeSettings, peekSettings, peekSettings);
  useEffect(() => {
    bindSettingsEvents();
    if (!peekSettings()) void getSettings();
  }, []);
  return settings;
}
