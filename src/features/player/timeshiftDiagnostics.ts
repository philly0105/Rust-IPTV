import type { PlayerSource } from '@/api/types';
import { redactText } from '@/features/sources/lib/redact';

type Field = string | number | boolean | null | undefined;

/** Development-only capture for a local timeshift reproduction. Never include a stream URL. */
export function traceTimeshift(source: PlayerSource | undefined, event: string, fields: Record<string, Field> = {}): void {
  if (!import.meta.env.DEV || import.meta.env.MODE === 'test' || !source?.catchupProgramStart) return;
  write({ event, ...fields });
}

function write(entry: Record<string, Field>): void {
  if (typeof fetch !== 'function') return;
  const safe = Object.fromEntries(Object.entries(entry).map(([key, value]) => [
    key,
    typeof value === 'string' ? redactText(value).slice(0, 300) : value,
  ]));
  const line = JSON.stringify({ at: new Date().toISOString(), ...safe });
  void fetch('/__timeshift_trace', { method: 'POST', headers: { 'content-type': 'application/json' }, body: line }).catch(() => undefined);
}

/** The patched mpegts.js bundle reports archive range and buffer activity through console.info. */
export function captureMpegtsArchiveTrace(): void {
  if (!import.meta.env.DEV || import.meta.env.MODE === 'test') return;
  const original = console.info.bind(console);
  console.info = (...args: unknown[]) => {
    original(...args);
    const message = args[0];
    if (typeof message === 'string' && message.startsWith('[IPTV-TS]')) write({ event: 'mpegts trace', message });
  };
}
