import type { RpcError } from '@/api/transport';
import type { M3uOrigin, RpcErrorCode, SourceKind } from '@/api/types';

/** What the error helpers read: the code, plus the core's text when there is one. */
type ErrLike = Pick<RpcError, 'code'> & { message?: string };

/**
 * The core's `Invalid` texts for an address that does not lead to a channel list: a single
 * stream (MPEG-TS, HLS media playlist, video data), binary data, a web page (login or error
 * page), or a download over the 1 GiB playlist cap (`crates/iptv-core/src/m3u/body.rs`), plus
 * an Xtream server that answers with HTML. All mean the URL is the wrong one.
 */
export const WRONG_URL = /not a channel list|not an M3U playlist|web page instead of|too large to be a channel list/i;

/** True when the error says the address points at something that is not a playlist. */
export function isWrongUrl(err: ErrLike): boolean {
  return (err.code === 'invalid' || err.code === 'internal') && WRONG_URL.test(err.message ?? '');
}

/** i18n key (sources ns) with the next action for a failed source operation. */
export function nextStepKey(err: ErrLike): string {
  if (isWrongUrl(err)) return 'hintWrongUrl';
  switch (err.code) {
    case 'network':
      return 'hintNetwork';
    case 'timeout':
      return 'hintTimeout';
    case 'auth':
      return 'hintAuth';
    case 'invalid':
      return 'hintInvalid';
    case 'unsupported':
      return 'hintUnsupported';
    case 'conflict':
      return 'hintConflict';
    case 'not_found':
      return 'hintNotFound';
    default:
      return 'hintGeneric';
  }
}

/** i18n key (sources ns) with a plain summary of what went wrong; the raw message is only technical detail. */
export function summaryKey(err: ErrLike): string {
  if (isWrongUrl(err)) return 'errorSummaryWrongUrl';
  switch (err.code) {
    case 'network':
      return 'errorSummaryNetwork';
    case 'timeout':
      return 'errorSummaryTimeout';
    case 'auth':
      return 'errorSummaryAuth';
    case 'invalid':
      return 'errorSummaryInvalid';
    case 'unsupported':
      return 'errorSummaryUnsupported';
    case 'conflict':
      return 'errorSummaryConflict';
    case 'not_found':
      return 'errorSummaryNotFound';
    default:
      return 'errorSummaryGeneric';
  }
}

/**
 * The form field a failed add or save most likely points at, so the dialog can mark it and move
 * focus there: the login for rejected credentials, the address for a missing or unreachable server.
 * Null when the failure says nothing about a single field (or the field is not in the form).
 */
export function fieldForError(
  err: Pick<RpcError, 'code' | 'details'> & { message?: string },
  kind: SourceKind,
  m3uOrigin: M3uOrigin = 'url',
): string | null {
  // The app could not reach its own backend: nothing in the form is wrong.
  const d = err.details;
  if (d && typeof d === 'object' && 'transport' in d) return null;
  // A stream, web page or oversized file instead of a playlist: the address is the thing to fix.
  const code = isWrongUrl(err) ? 'not_found' : err.code;
  switch (code) {
    case 'auth':
      if (kind === 'xtream') return 'xtream.password';
      if (kind === 'stalker') return 'stalker.macAddress';
      return null;
    case 'not_found':
    case 'network':
      if (kind === 'xtream') return 'xtream.serverUrl';
      if (kind === 'stalker') return 'stalker.portalUrl';
      return m3uOrigin === 'url' ? 'm3u.url' : null;
    default:
      return null;
  }
}

/** Id of the source `sources.add` created before its import failed (the core keeps it, with `lastError`). */
export function failedSourceId(err: Pick<RpcError, 'details'>): string | null {
  const d = err.details;
  if (d && typeof d === 'object' && 'sourceId' in d) {
    const id = (d as { sourceId: unknown }).sourceId;
    if (typeof id === 'string' && id) return id;
  }
  return null;
}

/**
 * Error class of an `import.progress` error, guessed from its message: the event carries
 * only the core's text, not the RpcError code. Unknown text maps to `internal` (generic).
 */
export function importErrorCode(message: string | undefined): RpcErrorCode {
  const m = (message ?? '').toLowerCase();
  if (!m) return 'internal';
  // Before the auth check: the web-page text mentions a "login or error page".
  if (WRONG_URL.test(m)) return 'invalid';
  if (/timed? ?out|timeout|deadline|sending the playlist too slowly/.test(m)) return 'timeout';
  if (/\b40[13]\b|unauthori[sz]ed|forbidden|authenticat|credential|password|login|account (is )?(expired|disabled|banned)/.test(m)) return 'auth';
  if (/\b404\b|not found|no such file/.test(m)) return 'not_found';
  if (/already exists|duplicate|conflict/.test(m)) return 'conflict';
  if (/unsupported|not supported/.test(m)) return 'unsupported';
  if (/sending request|connect|dns|resolv|unreachable|refused|reset by peer|network|tls|certificate|\b5\d\d\b|upstream/.test(m)) return 'network';
  if (/pars|invalid|malformed|decode|unexpected|not a playlist|extm3u|xml|json|utf-?8/.test(m)) return 'invalid';
  return 'internal';
}

/** i18n key (sources ns) summarizing an `import.progress` error message. */
export function importSummaryKey(message: string | undefined): string {
  return summaryKey({ code: importErrorCode(message), message });
}

type ImportErrorClaim = (sourceId: string) => boolean;
const claims = new Set<ImportErrorClaim>();

/**
 * A surface that shows a source's import error itself (the open Add Source dialog) claims
 * it, so the shell does not toast the same failure a second time. Returns the release.
 */
export function claimImportErrors(claim: ImportErrorClaim): () => void {
  claims.add(claim);
  return () => {
    claims.delete(claim);
  };
}

/** Whether an open surface already reports this source's import error. */
export function importErrorClaimed(sourceId: string): boolean {
  for (const claim of claims) if (claim(sourceId)) return true;
  return false;
}
