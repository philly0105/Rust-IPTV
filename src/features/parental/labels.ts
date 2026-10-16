import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import type { ContentType, ParentalLockKind } from '@/api/types';

/** Unlock lengths offered in settings, in minutes (0 = until the app restarts; C2 allows 0..=720). */
export const UNLOCK_CHOICES = [0, 5, 15, 30, 60, 120, 240, 480, 720] as const;

/** Formats an unlock length: "15 minutes", "2 hours", "until the app restarts". */
export function useDurationText(): (minutes: number) => string {
  const { t } = useTranslation('parental');
  return useCallback(
    (minutes: number) => {
      if (minutes <= 0) return t('untilRestart');
      if (minutes >= 60 && minutes % 60 === 0) return t('hours', { count: minutes / 60 });
      return t('minutes', { count: minutes });
    },
    [t],
  );
}

/** {@link useDurationText} for one value. */
export function useUnlockDuration(minutes: number): string {
  return useDurationText()(minutes);
}

/** What a lock covers, as the lock list labels it ("TV group", "Channel", "Movie"). */
export function useLockKindText(): (kind: ParentalLockKind, contentType: ContentType) => string {
  const { t } = useTranslation('parental');
  return useCallback(
    (kind: ParentalLockKind, contentType: ContentType) => {
      if (kind === 'category') {
        switch (contentType) {
          case 'live':
            return t('kindGroupLive');
          case 'radio':
            return t('kindGroupRadio');
          case 'movie':
            return t('kindGroupMovie');
          case 'series':
            return t('kindGroupSeries');
        }
      }
      switch (contentType) {
        case 'live':
          return t('kindChannel');
        case 'radio':
          return t('kindStation');
        case 'movie':
          return t('kindMovie');
        case 'series':
          return t('kindSeries');
      }
    },
    [t],
  );
}

/** Name of a content type's tab in lock management ("Live TV", "Movies"). */
export function useContentTypeText(): (contentType: ContentType) => string {
  const { t } = useTranslation('parental');
  return useCallback(
    (contentType: ContentType) => {
      switch (contentType) {
        case 'live':
          return t('typeLive');
        case 'radio':
          return t('typeRadio');
        case 'movie':
          return t('typeMovie');
        case 'series':
          return t('typeSeries');
      }
    },
    [t],
  );
}
