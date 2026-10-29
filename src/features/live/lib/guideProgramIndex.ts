import type { EpgProgram } from '@/api/types';

import { ms } from './epgTime';

interface Entry {
  program: EpgProgram;
  start: number;
  end: number;
  order: number;
}

interface ProgramIndex {
  entries: Entry[];
  /** Maximum end in the balanced subtree whose root is this array position. */
  maximumEnd: Float64Array;
  ordered: boolean;
  last?: { from: number; to: number; programs: EpgProgram[] };
}

// Provider answers are immutable. An answer owns one index and at most one selected window;
// replacing/evicting that answer releases both, without retaining every visited time window.
const indexes = new WeakMap<readonly EpgProgram[], ProgramIndex>();
const EMPTY: EpgProgram[] = [];

function indexFor(programs: readonly EpgProgram[]): ProgramIndex {
  const cached = indexes.get(programs);
  if (cached) return cached;
  const entries = programs.map((program, order) => ({ program, order, start: ms(program.start), end: ms(program.end) }));
  const ordered = entries.every((entry, i) => i === 0 || entries[i - 1]!.start <= entry.start);
  if (!ordered) entries.sort((a, b) => a.start - b.start || a.order - b.order);
  const maximumEnd = new Float64Array(entries.length);
  const build = (lo: number, hi: number): number => {
    if (lo >= hi) return Number.NEGATIVE_INFINITY;
    const mid = (lo + hi) >>> 1;
    return maximumEnd[mid] = Math.max(entries[mid]!.end, build(lo, mid), build(mid + 1, hi));
  };
  build(0, entries.length);
  const index = { entries, maximumEnd, ordered };
  indexes.set(programs, index);
  return index;
}

/**
 * Programmes overlapping [from, to), preserving their original order and object identities.
 * Times are in the answer's clock: a caller displaying an EPG offset subtracts it from the
 * bounds. Parsing and indexing happen once per answer, so a horizontal move does not rescan
 * weeks of provider history. The interval index also keeps long/overlapping programmes that
 * started well before the window; a start-only binary search would lose them.
 */
export function programsInRange(programs: readonly EpgProgram[], from: number, to: number): EpgProgram[] {
  if (programs.length === 0 || !(to > from)) return EMPTY;
  const index = indexFor(programs);
  if (index.last?.from === from && index.last.to === to) return index.last.programs;
  const selected: Entry[] = [];
  const visit = (lo: number, hi: number) => {
    if (lo >= hi) return;
    const mid = (lo + hi) >>> 1;
    if (index.maximumEnd[mid]! <= from) return;
    const entry = index.entries[mid]!;
    visit(lo, mid);
    if (entry.start >= to) return;
    if (entry.end > from) selected.push(entry);
    visit(mid + 1, hi);
  };
  visit(0, index.entries.length);
  if (!index.ordered) selected.sort((a, b) => a.order - b.order);
  const previous = index.last?.programs;
  const result = previous && previous.length === selected.length && selected.every((entry, i) => entry.program === previous[i])
    ? previous
    : selected.length > 0 ? selected.map((entry) => entry.program) : EMPTY;
  index.last = { from, to, programs: result };
  return result;
}

/** The overlap probe used while the viewport moves; no result arrays or date parsing. */
export function hasProgramInRange(programs: readonly EpgProgram[], from: number, to: number): boolean {
  if (programs.length === 0 || !(to > from)) return false;
  const index = indexFor(programs);
  const visit = (lo: number, hi: number): boolean => {
    if (lo >= hi) return false;
    const mid = (lo + hi) >>> 1;
    if (index.maximumEnd[mid]! <= from) return false;
    const entry = index.entries[mid]!;
    if (entry.start >= to) return visit(lo, mid);
    return entry.end > from || visit(lo, mid) || visit(mid + 1, hi);
  };
  return visit(0, index.entries.length);
}
