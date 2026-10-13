/**
 * Pure helpers for the LAN part of Settings > Remote: which state to show,
 * which network address to pair on, and device labels.
 */

import type { RemoteDevice, RemoteLanAddress, RemotePairing, RemoteServerStatus } from '@/api/rpc';

export type LanView =
  /** Server (PWA) mode: pairing is desktop only. */
  | { kind: 'server' }
  /** LAN access is off. */
  | { kind: 'off' }
  /** LAN access is on but the remote control itself is stopped. */
  | { kind: 'stopped' }
  /** LAN access is on, but nothing listens on the network. */
  | { kind: 'error'; message: string }
  /** Listening on the network; `warning` when some addresses failed. */
  | { kind: 'ready'; addresses: RemoteLanAddress[]; warning?: string };

export function lanView(isDesktop: boolean, lanEnabled: boolean, status: RemoteServerStatus | undefined): LanView {
  if (!isDesktop) return { kind: 'server' };
  if (!lanEnabled) return { kind: 'off' };
  if (!status?.running) return { kind: 'stopped' };
  const addresses = status.lanAddresses ?? [];
  if (addresses.length === 0) return { kind: 'error', message: status.lanError ?? '' };
  return status.lanError ? { kind: 'ready', addresses, warning: status.lanError } : { kind: 'ready', addresses };
}

/** The chosen address while it is still offered, else the first (best) one. */
export function pickAddress(addresses: readonly RemoteLanAddress[], chosen: string | undefined): string | undefined {
  if (chosen && addresses.some((a) => a.ip === chosen)) return chosen;
  return addresses[0]?.ip;
}

/** Option label for the address picker: "192.168.1.5 (Wi-Fi)". */
export function addressLabel(a: RemoteLanAddress): string {
  return a.interface ? `${a.ip} (${a.interface})` : a.ip;
}

type T = (key: string, opts?: Record<string, unknown>) => string;

/** "Safari on iPhone", "Chrome", or the unknown-browser text. */
export function deviceLabel(name: RemoteDevice['name'], t: T): string {
  const browser = name.browser.trim();
  if (!browser) return name.os ? t('remoteDeviceName', { browser: t('remoteDeviceUnknown'), os: name.os }) : t('remoteDeviceUnknown');
  return name.os ? t('remoteDeviceName', { browser, os: name.os }) : browser;
}

/** The one-time code in a pairing URL (`?pair=`), or '' when absent. */
export function pairCode(url: string): string {
  try {
    return new URL(url).searchParams.get('pair') ?? '';
  } catch {
    return '';
  }
}

/**
 * A revealed pairing code. `code` and `until` are pinned by the first fresh
 * response after the user chose to show it.
 */
export interface Reveal {
  /** When the user chose to show the code (ms epoch); older responses are ignored. */
  since: number;
  code?: string;
  /** When the shown code expires (ms epoch). */
  until?: number;
}

/**
 * Next reveal state after a pairing-code response fetched at `fetchedAt`.
 * The first fresh response pins the code and its expiry; `null` (hide) once
 * that code was used by a phone (the server hands out a new one) or expired.
 */
export function nextReveal(r: Reveal, p: RemotePairing, fetchedAt: number, now: number): Reveal | null {
  if (fetchedAt < r.since) return r;
  const code = pairCode(p.url);
  if (r.code === undefined) return { ...r, code, until: fetchedAt + p.expiresInSecs * 1000 };
  if (code !== r.code || (r.until !== undefined && now >= r.until)) return null;
  return r;
}

/** SVG viewBox for a QR grid of `size` modules with the standard 4-module quiet zone. */
export function qrViewBox(size: number): string {
  return `-4 -4 ${size + 8} ${size + 8}`;
}
