import { useEffect, useSyncExternalStore } from 'react';

import { onAppEvent } from '@/api/events';
import type { Settings } from '@/api/types';

import { getSettings, peekSettings, setSettingsCache, subscribeSettings } from './store';

let eventBound = false;

/** Keeps the player's settings cache in sync with `settings.changed`. Idempotent. */
export function bindSettingsEvents(): void {
  if (eventBound) return;
  eventBound = true;
  onAppEvent('settings.changed', (s) => setSettingsCache(s));
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
