/**
 * The sleep timer's words and readout, kept apart from `components/SleepTimer.tsx` so the `Z`
 * shortcut can announce a new setting without loading the timer's menus and prompts.
 */

import type { TFunction } from 'i18next';

import { formatClock } from '@/features/live/lib/epgTime';

import { formatTime } from './format';
import { showOsd } from './media';
import { useSleepTimer, type SleepTarget } from './sleepTimer';
import { usePlayerStore } from './store';

/** Time left on the timer as the chip and the warning show it (m:ss, h:mm:ss past an hour). */
export function sleepLeftText(endsAt: number, now: number): string {
  return formatTime(Math.ceil(Math.max(0, endsAt - now) / 1000));
}

/** What the timer is set to, in words: "30 min", "Until the programme ends", "Off". */
export function sleepTargetLabel(target: SleepTarget | null, t: TFunction<'player'>, episodic = true): string {
  if (!target) return t('sleepOffValue');
  if (target.kind === 'minutes') return t('sleepMinutes', { minutes: Math.round(target.minutes) });
  if (target.kind === 'programmeEnd') return t('sleepProgrammeEnd');
  return episodic ? t('sleepEpisodeEnd') : t('sleepMovieEnd');
}

/** Readout after `Z` or a menu pick: "Sleep timer" and the new setting (with its end time). */
export function announceSleep(t: TFunction<'player'>, locale?: string): void {
  const { target, endsAt } = useSleepTimer.getState();
  if (!target) {
    showOsd(t('sleepTimer'), t('sleepOffValue'));
    return;
  }
  const episodic = !!usePlayerStore.getState().source?.episodeId;
  const label = sleepTargetLabel(target, t, episodic);
  showOsd(t('sleepTimer'), endsAt !== null && target.kind === 'minutes' ? `${label}, ${t('sleepStopsAt', { time: formatClock(endsAt, locale) })}` : label);
}
