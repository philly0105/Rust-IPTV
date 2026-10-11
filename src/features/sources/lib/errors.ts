import type { RpcError } from '@/api/transport';
import type { RpcErrorCode } from '@/api/types';

/** i18n key (sources ns) with the next action for a failed source operation. */
export function nextStepKey(err: Pick<RpcError, 'code'>): string {
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
export function summaryKey(err: Pick<RpcError, 'code'>): string {
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
  if (/timed? ?out|timeout|deadline/.test(m)) return 'timeout';
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
  return summaryKey({ code: importErrorCode(message) });
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
