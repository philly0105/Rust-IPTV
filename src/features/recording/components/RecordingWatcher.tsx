/**
 * App-wide listener for reminder and recording events. Mounted once in the
 * shell: it keeps the reminder/recording queries fresh, tracks live byte
 * counts, and acts on due reminders (see `lib/fire.ts`). On mount it also
 * picks up reminders that fired before it listened (at launch, or with no
 * browser tab open) and acknowledges each one it handles.
 *
 * It also carries the download watcher (VL-download-feedback), the other
 * piece of the offline library that has to listen app-wide; both mount with
 * the player, which their actions (play a reminder's channel, a download's
 * file) need anyway.
 */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { onAppEvent } from '@/api/events';
import { invalidate } from '@/api/query';
import { isDesktop, rpc } from '@/api/transport';
import type { ReminderFiredEvent } from '@/api/types';
import { playItem, playSource, usePlayerStore } from '@/features/player';
import { toast } from '@/ui';
import { intlLocale } from '@/lib/intl';

import { DownloadWatcher } from '@/features/library/components/DownloadWatcher';

import { setRecordingProgress } from '../hooks';
import { claimFiring, handleReminderFired, type FireDeps } from '../lib/fire';

async function nativeNotify(title: string, body: string): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('native_notify', { title, body });
}

const deps: FireDeps = {
  isDesktop: () => isDesktop,
  nativeNotify,
  browserPermission: () => (typeof Notification === 'undefined' ? undefined : Notification.permission),
  browserNotify: (title, body) => {
    new Notification(title, { body });
  },
  toast: (opts) => {
    toast(opts);
  },
  sourceKind: async (id) => (await rpc('sources.list')).find((s) => s.id === id)?.kind,
  currentSource: () => usePlayerStore.getState().source,
  tune: ({ ref, title, subtitle, sourceKind }) => playItem({ ref, title, subtitle, isLive: true, sourceKind }),
  restore: (previous) => {
    if (previous) void playSource(previous);
    else usePlayerStore.getState().stop();
  },
};

export function RecordingWatcher() {
  const { t, i18n } = useTranslation('live');

  useEffect(() => {
    const fire = (e: ReminderFiredEvent) => {
      // The event and the mount-time fetch can both bring the same firing.
      if (!claimFiring(e)) return;
      const time = new Date(e.reminder.start).toLocaleTimeString(intlLocale(i18n.language), { hour: '2-digit', minute: '2-digit' });
      void handleReminderFired(
        e,
        {
          title: t('reminderTitle', { title: e.reminder.title }),
          body: t('reminderBody', { channel: e.reminder.channelName, time }),
          watchNow: t('watchNow'),
          switched: t('reminderSwitched', { channel: e.reminder.channelName }),
          undo: t('undoSwitch'),
          switchFailed: t('reminderSwitchFailed'),
        },
        deps,
      ).finally(() => {
        rpc('reminders.ack', { id: e.reminder.id }).catch(() => undefined);
      });
    };
    const offs = [
      onAppEvent('reminders.update', () => void invalidate('reminders.')),
      onAppEvent('recordings.update', () => {
        void invalidate('recordings.');
      }),
      onAppEvent('recordings.progress', setRecordingProgress),
      onAppEvent('reminders.fire', fire),
    ];
    rpc('reminders.unhandled')
      .then((list) => list.forEach(fire))
      .catch(() => undefined);
    return () => offs.forEach((off) => off());
  }, [t, i18n.language]);

  return <DownloadWatcher />;
}
