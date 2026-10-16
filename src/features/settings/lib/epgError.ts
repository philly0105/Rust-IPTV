import { formatCount } from '../../sources/lib/format';
import { redactText } from '../../sources/lib/redact';

/** C15: the core's code for a feed whose programmes were mostly unreadable. */
const UNREADABLE = /^epg_unreadable:(\d+):(\d+)$/;

/**
 * The text for a guide's stored error (or ingest warning). The C15 code
 * `epg_unreadable:<skipped>:<seen>` becomes the translated `epgUnreadable`;
 * anything else is shown as it is, with credentials redacted.
 */
export function epgErrorText(raw: string, t: (key: 'epgUnreadable', values: { skipped: string; seen: string }) => string, lang: string): string {
  const m = UNREADABLE.exec(raw);
  if (!m) return redactText(raw);
  return t('epgUnreadable', { skipped: formatCount(Number(m[1]), lang), seen: formatCount(Number(m[2]), lang) });
}
