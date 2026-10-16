/**
 * PIN rules and error mapping for parental controls (contract C2).
 *
 * The core accepts 4 to 8 ASCII digits. People type PINs on whatever keyboard
 * they have, so input is normalized first: Arabic-Indic, Persian, Devanagari
 * and full-width digits become ASCII, everything else is dropped.
 */

import { RpcError } from '@/api/transport';
import type { RpcErrorCode } from '@/api/types';

/** Shortest PIN the core accepts. */
export const PIN_MIN = 4;
/** Longest PIN the core accepts. */
export const PIN_MAX = 8;
/** Consecutive wrong PINs before the core starts a lockout (C2: the 5th). */
export const MAX_PIN_ATTEMPTS = 5;
/** Lockout the core starts with when it does not say (C2: 30 s, doubling to 300 s). */
export const DEFAULT_LOCKOUT_SECONDS = 30;

/** Code point of the digit zero in every script whose digits we accept. */
const ZEROS = [
  0x30, // ASCII
  0x660, // Arabic-Indic
  0x6f0, // Extended Arabic-Indic (Persian, Urdu)
  0x966, // Devanagari
  0xff10, // Full-width (Japanese, Chinese and Korean IMEs)
] as const;

/** Every digit in `text` as ASCII, in order; anything that is not a digit is dropped. */
export function normalizeDigits(text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    const zero = ZEROS.find((z) => cp >= z && cp <= z + 9);
    if (zero !== undefined) out += String(cp - zero);
  }
  return out;
}

/** What a PIN field keeps of typed or pasted text: its digits, at most {@link PIN_MAX}. */
export function sanitizePin(text: string): string {
  return normalizeDigits(text).slice(0, PIN_MAX);
}

export function isValidPin(pin: string): boolean {
  return new RegExp(`^\\d{${PIN_MIN},${PIN_MAX}}$`).test(pin);
}

/**
 * True for PINs a child guesses first: one digit repeated (0000) or a straight
 * run up or down (1234, 87654). Only a hint; the core accepts them.
 */
export function isWeakPin(pin: string): boolean {
  if (!isValidPin(pin)) return false;
  const d = [...pin].map(Number);
  const steps = new Set(d.slice(1).map((v, i) => v - d[i]!));
  if (steps.size !== 1) return false;
  const [step] = steps;
  return step === 0 || step === 1 || step === -1;
}

/** Why the core refused a PIN. */
export type PinFailure =
  | { kind: 'wrong' }
  | { kind: 'lockout'; seconds: number }
  | { kind: 'invalid' }
  | { kind: 'mismatch' }
  | { kind: 'other'; code: RpcErrorCode; message: string };

/** `details.retryAfterSeconds` of a lockout error, rounded up, or null. */
export function retryAfterOf(details: unknown): number | null {
  if (typeof details !== 'object' || details === null) return null;
  const v = (details as { retryAfterSeconds?: unknown }).retryAfterSeconds;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.ceil(v) : null;
}

/**
 * Maps a rejected PIN command to what the dialog shows: `auth` is a wrong PIN,
 * `conflict` the wrong-PIN lockout (C2), `invalid` a PIN of the wrong shape.
 */
export function classifyPinError(err: unknown): PinFailure {
  const e = RpcError.from(err);
  switch (e.code) {
    case 'auth':
      return { kind: 'wrong' };
    case 'conflict':
      return { kind: 'lockout', seconds: retryAfterOf(e.details) ?? DEFAULT_LOCKOUT_SECONDS };
    case 'invalid':
      return { kind: 'invalid' };
    default:
      return { kind: 'other', code: e.code, message: e.message };
  }
}

/** `m:ss` for a countdown, `h:mm:ss` from an hour up. */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  const pad = (n: number) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}
