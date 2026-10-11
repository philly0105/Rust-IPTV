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
 * useful detail.
 */

export type SourceErrorKind = 'refused' | 'dns' | 'network' | 'timeout' | 'auth' | 'notFound' | 'server' | 'unknown';

export interface SourceErrorInfo {
  kind: SourceErrorKind;
  /** Host named by the message ("Could not reach <host>."), when it names one. */
  host?: string;
}

/** Locale key in the `sources` namespace for each mapped kind. */
export const SOURCE_ERROR_KEYS: Record<Exclude<SourceErrorKind, 'unknown'>, string> = {
  refused: 'sourceErrorRefused',
  dns: 'sourceErrorDns',
  network: 'sourceErrorNetwork',
  timeout: 'sourceErrorTimeout',
  auth: 'sourceErrorAuth',
  notFound: 'sourceErrorNotFound',
  server: 'sourceErrorServer',
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
};

// "<host> ..." prefixes, in http.rs and m3u/importer.rs order.
const HOST_PATTERNS: readonly RegExp[] = [
  /^Could not reach (\S+?)\. /,
  /^(\S+?) did not respond in time\./,
  /^(\S+?) accepted the connection but did not answer/,
  /^(\S+?) stopped sending data/,
  /^(\S+?) answered the playlist download: HTTP/,
];

const AUTH = /HTTP 40[13]\b|rejected the username or password|refused the request after a fresh login|refused the handshake|Authorization failed/i;
const NOT_FOUND = /HTTP 404\b|HTTP 410\b|\bfile not found\b/i;
const TIMEOUT = /did not respond in time|did not answer within|stopped sending data|HTTP 408\b|HTTP 504\b|timed out/i;
const SERVER = /HTTP 429\b|HTTP 5\d\d\b/;
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

export function classifySourceError(text: string): SourceErrorInfo {
  const code = codeOf(text);
  const detail = sourceErrorDetail(text);
  const host = hostOf(detail);
  const withHost = (kind: SourceErrorKind): SourceErrorInfo => (host ? { kind, host } : { kind });
  if (code && CODE_KINDS[code]) {
    // A generic network code still says more when the OS text names the cause.
    const kind = CODE_KINDS[code]!;
    if (kind === 'network' && REFUSED.test(detail)) return withHost('refused');
    if (kind === 'network' && DNS.test(detail)) return withHost('dns');
    return withHost(kind);
  }
  if (AUTH.test(detail)) return withHost('auth');
  if (NOT_FOUND.test(detail)) return withHost('notFound');
  if (TIMEOUT.test(detail)) return withHost('timeout');
  if (SERVER.test(detail)) return withHost('server');
  if (REFUSED.test(detail)) return withHost('refused');
  if (DNS.test(detail)) return withHost('dns');
  if (NETWORK.test(detail)) return withHost('network');
  return { kind: 'unknown' };
}
