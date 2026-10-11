import type { RpcError } from '@/api/transport';

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
