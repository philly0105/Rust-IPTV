/**
 * The Downloads header's total speed over the last minute: one sample a second of the summed live
 * speeds in the progress store, kept while the page is open (and for a minute after, so going
 * back to the page does not start the line from nothing).
 */

/** How far back the sparkline reaches. */
export const HISTORY_MS = 60_000;
/** One sample every this often. */
export const SAMPLE_MS = 1_000;
/** A gap longer than this between two samples (the page was closed) breaks the line. */
export const GAP_MS = 3 * SAMPLE_MS;

export interface SpeedSample {
  at: number;
  bytesPerSecond: number;
}

export class SpeedHistory {
  private samples: SpeedSample[] = [];

  constructor(
    private readonly read: (now: number) => number,
    private readonly windowMs = HISTORY_MS,
  ) {}

  /** Takes one sample now and drops the ones that left the window. */
  sample(now = Date.now()): readonly SpeedSample[] {
    const raw = this.read(now);
    const bytesPerSecond = Number.isFinite(raw) && raw > 0 ? raw : 0;
    // A clock that went back (a resumed laptop, a test's fake timers) starts the line again.
    const last = this.samples.at(-1);
    if (last && now < last.at) this.samples = [];
    this.samples.push({ at: now, bytesPerSecond });
    this.trim(now);
    return this.samples;
  }

  /** The samples inside the window ending at `now`, oldest first. */
  list(now = Date.now()): readonly SpeedSample[] {
    this.trim(now);
    return this.samples;
  }

  clear(): void {
    this.samples = [];
  }

  private trim(now: number): void {
    const from = now - this.windowMs;
    let i = 0;
    while (i < this.samples.length && this.samples[i]!.at < from) i += 1;
    if (i > 0) this.samples = this.samples.slice(i);
  }
}

/** Whether anything moved in the window: the sparkline shows only then. */
export function hasActivity(samples: readonly SpeedSample[]): boolean {
  return samples.some((s) => s.bytesPerSecond > 0);
}

export interface SparklinePaths {
  /** The line, one subpath per unbroken run of samples. */
  line: string;
  /** The same runs closed down to the baseline, for the faint fill under the line. */
  area: string;
}

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * SVG paths for `samples` in a `width` x `height` box: time runs left to right over the window
 * ending at `now`, and the fastest sample in the window reaches the top (less `pad`). A lone
 * sample draws a short flat stroke, so a transfer that just started still shows.
 */
export function sparklinePaths(samples: readonly SpeedSample[], width: number, height: number, now: number, windowMs = HISTORY_MS, pad = 1.5): SparklinePaths {
  if (samples.length === 0) return { line: '', area: '' };
  const max = Math.max(...samples.map((s) => s.bytesPerSecond), 1);
  const base = height - pad;
  const x = (at: number) => round(Math.max(0, Math.min(width, width - ((now - at) / windowMs) * width)));
  const y = (bps: number) => round(base - (bps / max) * (height - 2 * pad));

  const runs: { x: number; y: number }[][] = [];
  let prev: SpeedSample | undefined;
  for (const s of samples) {
    if (!prev || s.at - prev.at > GAP_MS) runs.push([]);
    runs.at(-1)!.push({ x: x(s.at), y: y(s.bytesPerSecond) });
    prev = s;
  }

  const line: string[] = [];
  const area: string[] = [];
  for (const run of runs) {
    const points = run.length === 1 ? [{ x: Math.max(0, run[0]!.x - 2), y: run[0]!.y }, run[0]!] : run;
    line.push(points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' '));
    const first = points[0]!;
    const last = points.at(-1)!;
    area.push(`M${first.x} ${round(base)} ` + points.map((p) => `L${p.x} ${p.y}`).join(' ') + ` L${last.x} ${round(base)} Z`);
  }
  return { line: line.join(' '), area: area.join(' ') };
}
