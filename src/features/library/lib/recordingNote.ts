import type { Recording } from '@/api/types';

import { k } from './keys';

/**
 * A recording's note in the UI language: the core's own messages carry a code
 * (`errorCode`, translated as `library:recError<Code>`); free-text stream
 * errors are shown as they are. A code the locale has no string for falls back
 * to the core's English text rather than a raw key.
 */
export function recordingNote(
  r: Pick<Recording, 'error' | 'errorCode'>,
  t: (key: string, opts?: { defaultValue?: string }) => string,
): string | undefined {
  if (r.errorCode === 'reconnecting') return t('scheduledReconnecting');
  if (r.errorCode) return t(k('recError', r.errorCode), { defaultValue: r.error });
  return r.error;
}
