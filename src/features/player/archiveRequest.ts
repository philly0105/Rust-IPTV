import type { PlayerSource } from '@/api/types';

/** Reopen an Xtream archive at a requested programme minute instead of scanning its TS bytes. */
export function archiveRequest(source: PlayerSource, seconds: number): { url: string; offset: number; duration: number } | null {
  if (!source.catchupProgramStart || source.isLive || !source.durationSeconds || !Number.isFinite(seconds)) return null;
  const offset = Math.floor(Math.max(0, seconds) / 60) * 60;
  if (offset >= source.durationSeconds) return null;
  let url: URL;
  try {
    url = new URL(source.url);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;
  const match = url.pathname.match(/^(.*\/timeshift\/[^/]+\/[^/]+\/)(\d+)\/(\d{4}-\d{2}-\d{2}:\d{2}-\d{2})(\/[^/]+\.ts)$/i);
  if (!match) return null;
  const [, prefix, providerDuration, stamp, suffix] = match;
  const parts = stamp!.match(/^(\d{4})-(\d{2})-(\d{2}):(\d{2})-(\d{2})$/)!;
  const date = new Date(Date.UTC(+parts[1]!, +parts[2]! - 1, +parts[3]!, +parts[4]!, +parts[5]!));
  if (`${date.toISOString().slice(0, 10)}:${date.toISOString().slice(11, 16).replace(':', '-')}` !== stamp) return null;
  date.setUTCMinutes(date.getUTCMinutes() + offset / 60);
  const shifted = `${date.toISOString().slice(0, 10)}:${date.toISOString().slice(11, 16).replace(':', '-')}`;
  const duration = source.durationSeconds - offset;
  // TiviMate keeps this field fixed when it moves the start timestamp. Preserve the provider's
  // original window rather than changing two URL parameters at once.
  url.pathname = `${prefix}${providerDuration}/${shifted}${suffix}`;
  return { url: url.href, offset, duration };
}
