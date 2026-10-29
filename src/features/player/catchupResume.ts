import { sameRef, type EpgProgram, type ItemRef, type PlayerSource } from '@/api/types';
import { isValidProgram, ms } from '@/features/live/lib/epgTime';

export const CATCHUP_RESUME_KEY = 'player.catchupResume';

export interface CatchupResume {
  ref: ItemRef;
  program: EpgProgram;
  positionSeconds: number;
}

/** Keep only the programme identity and position; archive URLs can expire or contain credentials. */
export function readCatchupResume(): CatchupResume | null {
  try {
    const raw = localStorage.getItem(CATCHUP_RESUME_KEY);
    if (!raw) return null;
    const rec = JSON.parse(raw) as Partial<CatchupResume>;
    if (
      rec.ref?.contentType !== 'live' || !rec.ref.sourceId || !rec.ref.itemId ||
      !rec.program || typeof rec.program.title !== 'string' || !rec.program.title ||
      typeof rec.program.start !== 'string' || typeof rec.program.end !== 'string' ||
      !isValidProgram(rec.program) ||
      typeof rec.positionSeconds !== 'number' || !Number.isFinite(rec.positionSeconds) ||
      rec.positionSeconds <= 5 || rec.positionSeconds >= (ms(rec.program.end) - ms(rec.program.start)) / 1000 * 0.95
    ) return null;
    return {
      ref: rec.ref,
      program: { channelId: rec.ref.itemId, title: rec.program.title, start: rec.program.start, end: rec.program.end },
      positionSeconds: rec.positionSeconds,
    };
  } catch {
    return null;
  }
}

export function catchupResumeFor(ref: ItemRef | undefined): CatchupResume | null {
  const rec = readCatchupResume();
  return ref && rec && sameRef(ref, rec.ref) ? rec : null;
}

/** Called with the current player state on each progress save and on every source switch. */
export function syncCatchupResume(source: PlayerSource | undefined, positionSeconds: number, ended = false): void {
  if (!source) return;
  try {
    const start = ms(source.catchupProgramStart);
    const duration = source.durationSeconds;
    if (
      source.isLive || source.ref?.contentType !== 'live' || !start ||
      !source.subtitle || !duration || !Number.isFinite(duration) ||
      ended || !Number.isFinite(positionSeconds) || positionSeconds <= 5 || positionSeconds >= duration * 0.95
    ) {
      localStorage.removeItem(CATCHUP_RESUME_KEY);
      return;
    }
    const rec: CatchupResume = {
      ref: source.ref,
      program: {
        channelId: source.ref.itemId,
        start: source.catchupProgramStart!,
        end: new Date(start + duration * 1000).toISOString(),
        title: source.subtitle,
      },
      positionSeconds,
    };
    localStorage.setItem(CATCHUP_RESUME_KEY, JSON.stringify(rec));
  } catch {
    // Storage can be unavailable in private browsing.
  }
}

export function clearCatchupResume(): void {
  try {
    localStorage.removeItem(CATCHUP_RESUME_KEY);
  } catch {
    // Storage unavailable.
  }
}
