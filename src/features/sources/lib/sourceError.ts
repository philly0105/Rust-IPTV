/**
 * Turns a source's `lastError` into a translatable category.
 *
 * The core stores `lastError` as the plain English message of its error
 * (`sources::error_text` strips the category). When the text is a JSON object
 * with a `code` (a future core may store one), the code decides. Otherwise the
 * known English shapes from `crates/iptv-core/src/http.rs` (`transport_error`,
 * `send_within`, `status_error`, the body idle timeout), the playlist importer
 * and the Xtream / Stalker auth checks are matched. Anything else stays
 * `unknown` and the card shows the raw text, which then carries the only
 * useful detail. A coded `invalid` without a known shape is `invalid`: the card
 * shows a plain sentence and keeps the parser text in Technical details.
 */

import type { RpcErrorCode } from '@/api/types';

import { WRONG_URL } from './errors';

export type SourceErrorKind = 'wrongUrl' | 'refused' | 'dns' | 'network' | 'timeout' | 'auth' | 'notFound' | 'server' | 'invalid' | 'unreadable' | 'unknown';

export interface SourceErrorInfo {
  kind: SourceErrorKind;
  /** Host named by the message ("Could not reach <host>."), when it names one. */
  host?: string;
}

/** Locale key in the `sources` namespace for each mapped kind. */
export const SOURCE_ERROR_KEYS: Record<Exclude<SourceErrorKind, 'unknown'>, string> = {
  wrongUrl: 'sourceErrorWrongUrl',
  refused: 'sourceErrorRefused',
  dns: 'sourceErrorDns',
  network: 'sourceErrorNetwork',
  timeout: 'sourceErrorTimeout',
  auth: 'sourceErrorAuth',
  notFound: 'sourceErrorNotFound',
  server: 'sourceErrorServer',
  invalid: 'sourceErrorInvalid',
  unreadable: 'sourceErrorUnreadable',
};

const CODE_KINDS: Record<string, SourceErrorKind> = {
  network: 'network',
  refused: 'refused',
  dns: 'dns',
  timeout: 'timeout',
  auth: 'auth',
  not_found: 'notFound',
  notFound: 'notFound',
  server: 'server',
  wrongUrl: 'wrongUrl',
  invalid: 'invalid',
};

// "<host> ..." prefixes, in http.rs and m3u/importer.rs order.
const HOST_PATTERNS: readonly RegExp[] = [
  /^Could not reach (\S+?)\. /,
  /^(\S+?) did not respond in time\./,
  /^(\S+?) accepted the connection but did not answer/,
  /^(\S+?) stopped sending data/,
  /^(\S+?) answered the playlist download: HTTP/,
  /^(\S+?) sent /,
  /^(\S+?) is sending /,
  /^(\S+?) answered with a web page/,
];

const AUTH = /HTTP 40[13]\b|rejected the username or password|refused the request after a fresh login|refused the handshake|Authorization failed/i;
const NOT_FOUND = /HTTP 404\b|HTTP 410\b|\bfile not found\b/i;
const TIMEOUT = /sending the playlist too slowly|did not respond in time|did not answer within|stopped sending data|HTTP 408\b|HTTP 504\b|timed out/i;
const SERVER = /HTTP 429\b|HTTP 5\d\d\b/;
/** An upstream 5xx other than 504 (a gateway timeout, which TIMEOUT covers), or a 429 rate limit (B9: code `server`). */
const HTTP_5XX = /HTTP (?:429|5(?!04)\d\d)\b/;
const REFUSED = /connection refused|actively refused|os error 10061|os error 111\b|ECONNREFUSED/i;
const DNS = /dns error|failed to lookup address|No such host|os error 11001|Name or service not known|nodename nor servname/i;
const NETWORK = /^Could not reach |error sending request|connection (reset|closed|aborted)|os error 1005[34]/i;

function hostOf(text: string): string | undefined {
  for (const re of HOST_PATTERNS) {
    const host = re.exec(text)?.[1];
    // "The server ..." is the core's fallback when the URL had no host.
    if (host && /^[\w.\-:[\]]+$/.test(host) && !/^the$/i.test(host)) return host;
  }
  return undefined;
}

function codeOf(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const code = typeof parsed === 'object' && parsed !== null ? (parsed as { code?: unknown }).code : undefined;
    return typeof code === 'string' ? code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Between a core error's plain message and its technical detail (`xtream::client::DETAIL_SEPARATOR`):
 * "The server sent a reply the app could not read. ...\n\nTechnical detail: Xtream <label>: <serde error>".
 */
export const DETAIL_SEPARATOR = '\n\nTechnical detail: ';
/** Start of `xtream::client::UNREADABLE_REPLY`, the plain message for a reply that is not the expected JSON. */
const UNREADABLE = /^The server sent a reply the app could not read\b/;
/** The category prefix `CoreError::Server`'s Display adds ("server: ..."), which `sources::error_text` may keep. */
const SERVER_PREFIX = /^server:\s*/i;

/**
 * A core error text as its plain message (for the main line) and, when the core split it off, its
 * technical detail (for the disclosure). Drops a leading "server: " category prefix.
 */
export function splitErrorText(text: string): { plain: string; detail?: string } {
  const body = text.replace(SERVER_PREFIX, '');
  const at = body.indexOf(DETAIL_SEPARATOR);
  if (at < 0) return { plain: body };
  return { plain: body.slice(0, at).trim(), detail: body.slice(at + DETAIL_SEPARATOR.length).trim() };
}

/** Raw text to show behind the disclosure: the JSON `message` when the error is JSON, else the text itself. */
export function sourceErrorDetail(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return text;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const message = typeof parsed === 'object' && parsed !== null ? (parsed as { message?: unknown }).message : undefined;
    return typeof message === 'string' && message ? message : text;
  } catch {
    return text;
  }
}

/**
 * `lastErrorCode` is the source's classified code (C10). It decides first; the text only refines
 * it (refused or DNS for a network code, a host to name) and is the fallback for cores that store
 * no code.
 */
export function classifySourceError(text: string, lastErrorCode?: RpcErrorCode): SourceErrorInfo {
  // Without the "server: " prefix, so the "<host> ..." patterns still match from the start.
  const detail = sourceErrorDetail(text).replace(SERVER_PREFIX, '');
  // `invalid` with the wrong-URL wording names that cause; any other `invalid` is a plain "couldn't read".
  const given: string | undefined = lastErrorCode ?? codeOf(text);
  const code = given === 'invalid' && WRONG_URL.test(detail) ? 'wrongUrl' : given;
  const host = hostOf(detail);
  const withHost = (kind: SourceErrorKind): SourceErrorInfo => (host ? { kind, host } : { kind });
  // The core's own plain "unreadable reply" message says what to check (the server URL); keep that advice.
  if ((code === undefined || code === 'invalid' || code === 'internal') && UNREADABLE.test(detail)) return withHost('unreadable');
  // An upstream 5xx is the server's trouble, not a reachability problem, even under a `network` code
  // (cores before C12 had no `server` code).
  if ((code === undefined || code === 'network' || code === 'internal') && HTTP_5XX.test(detail)) return withHost('server');
  if (code && CODE_KINDS[code]) {
    // A generic network code still says more when the OS text names the cause.
    const kind = CODE_KINDS[code]!;
    if (kind === 'network' && REFUSED.test(detail)) return withHost('refused');
    if (kind === 'network' && DNS.test(detail)) return withHost('dns');
    return withHost(kind);
  }
  // First: the web-page text also says "login", and none of these is a connection problem.
  if (WRONG_URL.test(detail)) return withHost('wrongUrl');
  if (AUTH.test(detail)) return withHost('auth');
  if (NOT_FOUND.test(detail)) return withHost('notFound');
  if (TIMEOUT.test(detail)) return withHost('timeout');
  if (SERVER.test(detail)) return withHost('server');
  if (REFUSED.test(detail)) return withHost('refused');
  if (DNS.test(detail)) return withHost('dns');
  if (NETWORK.test(detail)) return withHost('network');
  return { kind: 'unknown' };
}
