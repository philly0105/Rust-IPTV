/**
 * Stream error classification. Every failed playback lands in one class, and each class has
 * its own headline and next step in the error UI (inline overlay and the embedded mpv strip).
 *
 * Inputs, strongest first: the browser's connectivity, the core's RPC error code, an HTTP
 * status in the message (hls.js, mpegts.js, shaka and our proxy all write `HTTP <code>`),
 * known phrases from engines and mpv, then the engine's coarse error kind.
 */

import type { RpcErrorCode } from '@/api/types';

import type { EngineError } from './engines';

export type StreamErrorClass =
  | 'engineMissing'
  | 'offline'
  | 'auth'
  | 'notFound'
  | 'timeout'
  | 'server'
  | 'unsupported'
  | 'network'
  | 'media'
  | 'crashed'
  | 'generic';

export interface StreamErrorInput {
  message?: string | undefined;
  kind?: EngineError['kind'] | null | undefined;
  code?: RpcErrorCode | undefined;
  /** `navigator.onLine`; only `false` means offline. */
  online?: boolean | undefined;
}

const RPC_CODES: readonly RpcErrorCode[] = [
  'not_found',
  'invalid',
  'network',
  'auth',
  'timeout',
  'io',
  'db',
  'unsupported',
  'conflict',
  'internal',
  'engine_missing',
  'server',
];

function isRpcErrorCode(v: unknown): v is RpcErrorCode {
  return typeof v === 'string' && (RPC_CODES as readonly string[]).includes(v);
}

/** The RPC error code carried by a rejected `rpc()` call (an `RpcError` or its JSON shape). */
export function rpcErrorCode(err: unknown): RpcErrorCode | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  const code = (err as { code: unknown }).code;
  return isRpcErrorCode(code) ? code : undefined;
}

/** The first HTTP status written in an engine or server message, if any. */
export function httpStatusOf(message: string | undefined): number | undefined {
  if (!message) return undefined;
  const m = /\bHTTP(?:\/\d(?:\.\d)?)?(?:\s+error)?[\s/:]*([1-5]\d\d)\b/i.exec(message) ?? /\b(40[13478]|410|5\d\d)\s+(?:forbidden|unauthori[sz]ed|not found|gone|timeout|request timeout|gateway|service unavailable|bad gateway|internal server error)/i.exec(message);
  return m?.[1] ? Number(m[1]) : undefined;
}

function fromStatus(status: number): StreamErrorClass | undefined {
  if (status === 401 || status === 403 || status === 407 || status === 451) return 'auth';
  if (status === 404 || status === 410) return 'notFound';
  if (status === 408 || status === 504 || status === 524) return 'timeout';
  if (status >= 500) return 'server';
  return undefined;
}

function fromCode(code: RpcErrorCode): StreamErrorClass | undefined {
  switch (code) {
    case 'engine_missing':
      return 'engineMissing';
    case 'server':
      return 'server';
    case 'auth':
      return 'auth';
    case 'not_found':
      return 'notFound';
    case 'timeout':
      return 'timeout';
    case 'unsupported':
      return 'unsupported';
    case 'network':
      return 'network';
    default:
      return undefined;
  }
}

/**
 * mpv itself is missing. Checked before the RPC code: until the core reports `engine_missing`,
 * a missing mpv.exe arrives as `not_found`, which would read as a missing stream.
 */
const ENGINE_MISSING = /\bmpv(?:\.exe)?\s+(?:was\s+|is\s+)?(?:not found|could not be found)|could not find mpv|mpv is not installed/i;

const PHRASES: readonly [RegExp, StreamErrorClass][] = [
  [/mpv stopped unexpectedly|lost the connection to mpv|mpv could not be monitored|mpv exited during startup/i, 'crashed'],
  [/timed?[\s_-]?out|timeout/i, 'timeout'],
  [/forbidden|unauthori[sz]ed|access denied|authentication|expired subscription|account (?:is )?(?:expired|disabled|banned)/i, 'auth'],
  [/not found|no such (?:file|stream)|\bgone\b/i, 'notFound'],
  [/unrecognized file format|codec|unsupported|not supported|no audio or video data|cannot play this stream type|SRC_NOT_SUPPORTED/i, 'unsupported'],
  [/ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|name not resolved|\bdns\b/i, 'offline'],
];

/** One class per failure; see the module comment for the order of evidence. */
export function classifyStreamError(input: StreamErrorInput): StreamErrorClass {
  // A missing player fails the same way online or offline, whatever code it came with.
  if (input.code === 'engine_missing' || ENGINE_MISSING.test(input.message ?? '')) return 'engineMissing';
  if (input.online === false) return 'offline';
  const byCode = input.code ? fromCode(input.code) : undefined;
  if (byCode) return byCode;
  const status = httpStatusOf(input.message);
  const byStatus = status !== undefined ? fromStatus(status) : undefined;
  if (byStatus) return byStatus;
  const message = input.message ?? '';
  for (const [re, cls] of PHRASES) if (re.test(message)) return cls;
  switch (input.kind) {
    case 'unsupported':
      return 'unsupported';
    case 'media':
      return 'media';
    case 'network':
      return 'network';
    default:
      return 'generic';
  }
}

/** i18n keys (namespace `player`) for a class: the headline and what to do next. */
export function errorCopyKeys(cls: StreamErrorClass): { title: string; hint: string } {
  switch (cls) {
    case 'engineMissing':
      // The surface falls back to the built-in player, which this text says.
      return { title: 'mpvFailed', hint: 'mpvUnavailable' };
    case 'offline':
      return { title: 'errorOfflineTitle', hint: 'errorOffline' };
    case 'auth':
      return { title: 'errorAuthTitle', hint: 'errorAuth' };
    case 'notFound':
      return { title: 'errorNotFoundTitle', hint: 'errorNotFound' };
    case 'timeout':
      return { title: 'errorTimeoutTitle', hint: 'errorTimeout' };
    case 'server':
      return { title: 'errorServerTitle', hint: 'errorServer' };
    case 'unsupported':
      return { title: 'errorUnsupportedTitle', hint: 'errorUnsupportedCodec' };
    case 'network':
      return { title: 'errorTitle', hint: 'errorNetwork' };
    case 'media':
      return { title: 'errorTitle', hint: 'errorMedia' };
    case 'crashed':
      return { title: 'errorCrashedTitle', hint: 'errorCrashed' };
    case 'generic':
      return { title: 'errorTitle', hint: 'errorGeneric' };
    default: {
      const _exhaustive: never = cls;
      return _exhaustive;
    }
  }
}

/** Current connectivity as the browser sees it; `undefined` where it cannot tell. */
export function browserOnline(): boolean | undefined {
  return typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean' ? navigator.onLine : undefined;
}
