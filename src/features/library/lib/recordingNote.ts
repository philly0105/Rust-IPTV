import type { Recording } from '@/api/types';

import { k } from './keys';

/**
 * A recording's note in the UI language: the core's own messages carry a code
 * (`errorCode`, translated as `library:recError<Code>`); free-text stream
 * errors are shown as they are.
 */
export function recordingNote(r: Pick<Recording, 'error' | 'errorCode'>, t: (key: string) => string): string | undefined {
  if (r.errorCode === 'reconnecting') return t('scheduledReconnecting');
  if (r.errorCode) return t(k('recError', r.errorCode));
  return r.error;
}
