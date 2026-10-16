/**
 * Stream error classification. Every failed playback lands in one class, and each class has
 * its own headline and next step in the error UI (inline overlay and the embedded mpv strip).
 *
 * Inputs, strongest first: the browser's connectivity, the core's RPC error code, an HTTP
 * status in the message (hls.js, mpegts.js, shaka and our proxy all write `HTTP <code>`),
 * known phrases from engines and mpv, then the engine's coarse error kind.
 *
 * account: a provider that refuses a stream because every connection of the subscription is
 * in use answers with a plain 403 (or 458/509) more often than with a readable body, so the
 * player asks `account.status` right after the failure and passes the counts in `connections`.
 * Connections the app itself holds (`own`: the stream that just dropped, running recordings)
 * may be among them. Only the rest, when they fill the limit, relabel a failure for certain;
 * when the limit is only full counting our own, a refused stream (auth class) reads "may be
 * reached" and every other class keeps its own text.
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
  | 'generic'
  // account:
  | 'connectionLimit';

export interface StreamErrorInput {
  message?: string | undefined;
  kind?: EngineError['kind'] | null | undefined;
  code?: RpcErrorCode | undefined;
  /** `navigator.onLine`; only `false` means offline. */
  online?: boolean | undefined;
  // account: connections in use and the limit, from `account.status` checked after the failure;
  // `own` = how many of them may be this app's (its dropped stream, its recordings).
  connections?: { active: number; max: number; own?: number } | null | undefined;
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

/**
 * The core's refusal of an item parental controls hide (`parental::refuse_hidden`): a
 * `not_found` whose copy says why instead of "this stream no longer exists".
 */
const PARENTAL_LOCKED = /locked by parental controls/i;

/**
 * The built-in player's message for media the element took but could not show (no video or
 * audio track it can decode, and no engine error to say why). Classifies as `unsupported`.
 */
export const NO_VIDEO_MESSAGE = 'The stream has no video or audio the player can decode';
const NO_VIDEO = /no video or audio the player can decode/i;

const PHRASES: readonly [RegExp, StreamErrorClass][] = [
  [/mpv stopped unexpectedly|lost the connection to mpv|mpv could not be monitored|mpv exited during startup/i, 'crashed'],
  [/timed?[\s_-]?out|timeout/i, 'timeout'],
  [/forbidden|unauthori[sz]ed|access denied|authentication|expired subscription|account (?:is )?(?:expired|disabled|banned)/i, 'auth'],
  [/not found|no such (?:file|stream)|\bgone\b/i, 'notFound'],
  [/unrecognized file format|codec|unsupported|not supported|no audio or video data|cannot play this stream type|SRC_NOT_SUPPORTED/i, 'unsupported'],
  [/ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|name not resolved|\bdns\b/i, 'offline'],
];

// account: provider wording for "every connection is in use", and the classes a full account hides behind.
const CONNECTION_LIMIT = /max(?:imum)?[\s_-]*connections?|connections? limit|too many (?:connections|streams|devices)|connection limit|max_connections/i;
const CONNECTION_LIMIT_STATUSES: readonly number[] = [458, 509];
const MASKED_BY_FULL_ACCOUNT: readonly StreamErrorClass[] = ['auth', 'server', 'network', 'timeout', 'generic'];

/** The provider's own words or status say the limit is reached. */
function providerSaysLimit(message: string | undefined, status: number | undefined): boolean {
  return CONNECTION_LIMIT.test(message ?? '') || (status !== undefined && CONNECTION_LIMIT_STATUSES.includes(status));
}

/** Every connection of the account is in use by someone other than this app. */
export function connectionsFull(c: StreamErrorInput['connections']): boolean {
  return !!c && c.max > 0 && c.active - (c.own ?? 0) >= c.max;
}

/** The limit is reached only if this app's own connections are still counted. */
export function connectionsMaybeFull(c: StreamErrorInput['connections']): boolean {
  return !!c && c.max > 0 && c.active >= c.max && !connectionsFull(c);
}

/** One class per failure; see the module comment for the order of evidence. */
export function classifyStreamError(input: StreamErrorInput): StreamErrorClass {
  // A missing player fails the same way online or offline, whatever code it came with.
  if (input.code === 'engine_missing' || ENGINE_MISSING.test(input.message ?? '')) return 'engineMissing';
  if (input.online === false) return 'offline';
  // account:
  const status = httpStatusOf(input.message);
  if (providerSaysLimit(input.message, status)) return 'connectionLimit';
  const base = classifyBase(input, status);
  if (connectionsFull(input.connections) && MASKED_BY_FULL_ACCOUNT.includes(base)) return 'connectionLimit';
  return connectionsMaybeFull(input.connections) && base === 'auth' ? 'connectionLimit' : base;
}

function classifyBase(input: StreamErrorInput, status: number | undefined): StreamErrorClass {
  const byCode = input.code ? fromCode(input.code) : undefined;
  if (byCode) return byCode;
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

/**
 * i18n keys (namespace `player`) for a class: the headline and what to do next. `params`
 * (account: the connection counts) go to both keys when present.
 */
export function errorCopyKeys(
  cls: StreamErrorClass,
  input?: Pick<StreamErrorInput, 'connections' | 'message'> & {
    /** A live channel: a missing stream is the channel being unavailable, not a removed file. */
    live?: boolean | undefined;
  },
): { title: string; hint: string; params?: Record<string, number> } {
  switch (cls) {
    case 'engineMissing':
      // The surface falls back to the built-in player, which this text says.
      return { title: 'mpvFailed', hint: 'mpvUnavailable' };
    case 'offline':
      return { title: 'errorOfflineTitle', hint: 'errorOffline' };
    case 'auth':
      return { title: 'errorAuthTitle', hint: 'errorAuth' };
    case 'notFound':
      if (PARENTAL_LOCKED.test(input?.message ?? '')) return { title: 'parentalHiddenTitle', hint: 'parentalHidden' };
      if (input?.live) return { title: 'errorChannelUnavailableTitle', hint: 'errorChannelUnavailable' };
      return { title: 'errorNotFoundTitle', hint: 'errorNotFound' };
    case 'timeout':
      return { title: 'errorTimeoutTitle', hint: 'errorTimeout' };
    case 'server':
      // 503: the provider says it is overloaded or down for a moment.
      if (httpStatusOf(input?.message) === 503) return { title: 'errorBusyTitle', hint: 'errorBusy' };
      return { title: 'errorServerTitle', hint: 'errorServer' };
    case 'unsupported':
      if (NO_VIDEO.test(input?.message ?? '')) return { title: 'errorNoVideoTitle', hint: 'errorNoVideo' };
      return { title: 'errorUnsupportedTitle', hint: 'errorUnsupportedCodec' };
    case 'network':
      return { title: 'errorTitle', hint: 'errorNetwork' };
    case 'media':
      return { title: 'errorTitle', hint: 'errorMedia' };
    case 'crashed':
      return { title: 'errorCrashedTitle', hint: 'errorCrashed' };
    case 'generic':
      return { title: 'errorTitle', hint: 'errorGeneric' };
    // account:
    case 'connectionLimit': {
      const c = input?.connections;
      if (!c || c.max <= 0) return { title: 'errorConnLimitTitle', hint: 'errorConnLimit' };
      const params = { active: c.active, max: c.max };
      // The provider said so, or nobody else could fill the limit: say it plainly.
      const certain = connectionsFull(c) || providerSaysLimit(input?.message, httpStatusOf(input?.message));
      if (certain) return c.active >= c.max ? { title: 'errorConnLimitTitleCount', hint: 'errorConnLimit', params } : { title: 'errorConnLimitTitle', hint: 'errorConnLimit' };
      return connectionsMaybeFull(c) ? { title: 'errorConnLimitMaybeTitle', hint: 'errorConnLimitMaybe', params } : { title: 'errorConnLimitTitle', hint: 'errorConnLimit' };
    }
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
