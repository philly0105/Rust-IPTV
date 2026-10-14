/**
 * What a failed tile says. Classification is the player's (`classifyStreamError`, read only);
 * the copy is the wall's own: a tile is small, so each class gets a short headline and one
 * line of next step, in the `multiview` namespace.
 *
 * Connection limit: when the tiles of one account outnumber its connection limit, a tile
 * that the provider refused (or that failed to load at all) is most likely the one over the
 * limit, and says so.
 */

import type { RpcErrorCode } from '@/api/types';
import { browserOnline, classifyStreamError, type StreamErrorClass } from '@/features/player/errors';

import type { EngineError } from './engine';

/** Why a tile stopped: what the engine, the element or the core said. */
export interface TileFault {
  message?: string;
  kind?: EngineError['kind'];
  code?: RpcErrorCode;
}

/** Classes a tile over its account's limit most likely shows instead of the real reason. */
const MASKED_OVER_LIMIT: readonly StreamErrorClass[] = ['auth', 'server', 'network', 'timeout', 'generic', 'notFound'];

export function classifyTileFault(fault: TileFault, overLimit: boolean): StreamErrorClass {
  const cls = classifyStreamError({ ...fault, online: browserOnline() });
  if (overLimit && MASKED_OVER_LIMIT.includes(cls)) return 'connectionLimit';
  return cls;
}

/** i18n keys (namespace `multiview`) of a class: headline and next step. */
export function tileFaultCopy(cls: StreamErrorClass): { title: string; hint: string } {
  switch (cls) {
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
      return { title: 'errorUnsupportedTitle', hint: 'errorUnsupported' };
    case 'network':
      return { title: 'errorNetworkTitle', hint: 'errorNetwork' };
    case 'media':
      return { title: 'errorMediaTitle', hint: 'errorMedia' };
    case 'connectionLimit':
      return { title: 'errorLimitTitle', hint: 'errorLimit' };
    case 'engineMissing':
    case 'crashed':
    case 'generic':
      return { title: 'errorGenericTitle', hint: 'errorGeneric' };
    default: {
      const _exhaustive: never = cls;
      return _exhaustive;
    }
  }
}

/** Classes worth retrying on their own when the network comes back. */
export function retriesWhenOnline(cls: StreamErrorClass): boolean {
  return cls === 'offline' || cls === 'network' || cls === 'timeout';
}
