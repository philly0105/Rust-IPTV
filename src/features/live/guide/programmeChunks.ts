import type { EpgProgram } from '@/api/types';

import { MINUTE, ms, type Block } from '../lib/epgTime';

/** Small, fixed time groups survive a rolling guide-buffer replacement. */
export const PROGRAMME_CHUNK_MS = 30 * MINUTE;

export interface ProgrammeChunk {
  key: number;
  left: number;
  width: number;
  blocks: Block[];
}

/**
 * A programme belongs to its start-time group only, even when it spans several groups.
 * Its group's bounds include the entire programme, so a long cell is never clipped or split.
 * The surrounding native scroll track keeps its fixed origin and width.
 */
export function programmeChunks(blocks: readonly Block[]): ProgrammeChunk[] {
  const chunks: ProgrammeChunk[] = [];
  let chunk: ProgrammeChunk | undefined;
  for (const block of blocks) {
    const key = Math.floor(ms(block.program.start) / PROGRAMME_CHUNK_MS);
    if (!chunk || chunk.key !== key) {
      chunk = { key, left: block.left, width: block.width, blocks: [] };
      chunks.push(chunk);
    }
    chunk.blocks.push(block);
    chunk.width = Math.max(chunk.width, block.left + block.width - chunk.left);
  }
  return chunks;
}

function sameProgram(a: EpgProgram, b: EpgProgram): boolean {
  return a === b || (a.channelId === b.channelId && a.start === b.start && a.end === b.end &&
    a.title === b.title && a.description === b.description && a.category === b.category &&
    a.icon === b.icon && a.fromProvider === b.fromProvider);
}

/** RPC slices and provider merges create fresh objects for unchanged overlapping programmes. */
export function sameProgrammeChunk(a: ProgrammeChunk, b: ProgrammeChunk): boolean {
  return a === b || (a.key === b.key && a.left === b.left && a.width === b.width &&
    a.blocks.length === b.blocks.length && a.blocks.every((p, i) => {
      const q = b.blocks[i]!;
      return p.left === q.left && p.width === q.width && p.when === q.when &&
        p.clipStart === q.clipStart && p.clipEnd === q.clipEnd && sameProgram(p.program, q.program);
    }));
}
