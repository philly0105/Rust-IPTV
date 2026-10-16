/**
 * What happens when a guide reminder is due (`reminders.fire`).
 *
 * - `notify`: a native Windows notification on the desktop (a browser
 *   notification in server mode, only when permission was already granted;
 *   it is never requested) plus an in-app toast with "Watch now".
 * - `switch`: tune to the channel (the desktop shell brings the window
 *   forward) and offer Undo, which puts back what was playing.
 *
 * Side effects come in through `FireDeps` so the logic is testable.
 */

import type { PlayerSource, ReminderFiredEvent, SourceKind } from '@/api/types';

export interface FireText {
  /** Toast and notification title. */
  title: string;
  /** Notification body / toast description. */
  body: string;
  watchNow: string;
  switched: string;
  undo: string;
  switchFailed: string;
}

export interface FireDeps {
  isDesktop(): boolean;
  /** Native toast through the desktop shell. */
  nativeNotify(title: string, body: string): Promise<void>;
  /** `Notification.permission` in a browser, undefined when there is no API. */
  browserPermission(): NotificationPermission | undefined;
  browserNotify(title: string, body: string): void;
  toast(opts: { title: string; description?: string; variant?: 'info' | 'success' | 'error'; action?: { label: string; onClick(): void }; duration?: number }): void;
  sourceKind(sourceId: string): Promise<SourceKind | undefined>;
  currentSource(): PlayerSource | undefined;
  tune(args: { ref: ReminderFiredEvent['reminder']['ref']; title: string; subtitle: string; sourceKind: SourceKind }): Promise<void>;
  restore(previous: PlayerSource | undefined): void;
}

/** How long the reminder toast stays (ms). */
export const FIRE_TOAST_MS = 30_000;

/** Firings (reminder id + fire time) this window already handled. */
const claimed = new Set<string>();

/**
 * True the first time a firing is seen in this window. The live event and the
 * mount-time `reminders.unhandled` fetch can both deliver it; a re-armed
 * reminder that fires again has a new `firedAt` and is handled again.
 */
export function claimFiring(e: ReminderFiredEvent): boolean {
  const key = `${e.reminder.id}@${e.firedAt ?? ''}`;
  if (claimed.has(key)) return false;
  claimed.add(key);
  return true;
}

async function tune(e: ReminderFiredEvent, deps: FireDeps): Promise<boolean> {
  const kind = await deps.sourceKind(e.reminder.ref.sourceId);
  if (!kind) return false;
  await deps.tune({ ref: e.reminder.ref, title: e.reminder.channelName, subtitle: e.reminder.title, sourceKind: kind });
  return true;
}

export async function handleReminderFired(e: ReminderFiredEvent, text: FireText, deps: FireDeps): Promise<void> {
  const watch = () => {
    void tune(e, deps)
      .then((ok) => {
        if (!ok) deps.toast({ variant: 'error', title: text.switchFailed });
      })
      .catch(() => deps.toast({ variant: 'error', title: text.switchFailed }));
  };

  if (e.action === 'switch') {
    const previous = deps.currentSource();
    try {
      if (!(await tune(e, deps))) throw new Error('source gone');
    } catch {
      deps.toast({ variant: 'error', title: text.switchFailed, description: text.title });
      return;
    }
    deps.toast({
      title: text.switched,
      description: text.body,
      duration: FIRE_TOAST_MS,
      action: { label: text.undo, onClick: () => deps.restore(previous) },
    });
    return;
  }

  if (deps.isDesktop()) {
    await deps.nativeNotify(text.title, text.body).catch(() => undefined);
  } else if (deps.browserPermission() === 'granted') {
    try {
      deps.browserNotify(text.title, text.body);
    } catch {
      // Some browsers only allow notifications from a service worker; the toast still shows.
    }
  }
  deps.toast({ title: text.title, description: text.body, duration: FIRE_TOAST_MS, action: { label: text.watchNow, onClick: watch } });
}
