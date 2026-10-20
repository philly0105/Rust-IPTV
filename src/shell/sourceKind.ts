import type { SourceKind } from '@/api/types';

/**
 * The one short name of each source kind (SH-kind-labels-copy): "M3U", "Xtream", "Stalker",
 * translated in the sources namespace. The rail said "XC" and "STB", Home "Xtream" and
 * "Stalker"; "STB" never said Stalker. Use it with any `t`: the key carries its namespace.
 */
export function kindShortKey(kind: SourceKind): string {
  return kind === 'xtream' ? 'sources:kindXtreamShort' : kind === 'stalker' ? 'sources:kindStalkerShort' : 'sources:kindM3uShort';
}
