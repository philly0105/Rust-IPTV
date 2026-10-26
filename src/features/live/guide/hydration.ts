/** Bounds on the guide's fixed, logical horizontal track; no DOM measurement is needed. */
export interface HydrationBounds {
  left: number;
  right: number;
  row: number;
}

export interface HydrationViewport {
  left: number;
  right: number;
  firstRow: number;
  lastRow: number;
}

export interface HydrationTicket {
  /** The component committed its programme cells. The next background chunk may now run. */
  committed(): void;
  /** Its component unmounted or no longer needs this request. */
  cancel(): void;
}

export interface GuideHydrator {
  isVisible(bounds: HydrationBounds): boolean;
  /** Visible work activates synchronously; offscreen work shares one queue across all rows. */
  enqueue(bounds: HydrationBounds, activate: (ticket: HydrationTicket) => void): HydrationTicket;
  /** Native scroll handlers publish cached coordinates here, without waiting for React state. */
  setViewport(viewport: HydrationViewport): void;
  /** Cancel this mount's work while allowing StrictMode to replay effects on the same instance. */
  reset(): void;
  dispose(): void;
}

interface HydrationClock {
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
}

interface Job {
  bounds: HydrationBounds;
  activate: (ticket: HydrationTicket) => void;
  ticket: HydrationTicket;
  state: 'pending' | 'active' | 'done';
}

/**
 * Replenish offscreen programme groups one commit at a time. An animation-frame callback alone
 * is not a sufficient budget: React could collect several callbacks into one large commit.
 * The mounted group acknowledges its layout effect before another frame is scheduled.
 *
 * This queue is only for new offscreen groups. The caller renders visible groups,
 * existing groups, and keyboard targets immediately. A native scroll promotes newly visible work.
 */
export function createGuideHydrator(clock: HydrationClock = {}): GuideHydrator {
  const requestFrame = clock.requestFrame ?? ((callback) => requestAnimationFrame(callback));
  const cancelFrame = clock.cancelFrame ?? ((handle) => cancelAnimationFrame(handle));
  const jobs = new Set<Job>();
  let viewport: HydrationViewport | undefined;
  let frame: number | null = null;
  let inFlight: Job | undefined;
  let disposed = false;

  const isVisible = (bounds: HydrationBounds): boolean => !viewport || (
    bounds.row >= viewport.firstRow && bounds.row <= viewport.lastRow &&
    bounds.left < viewport.right && bounds.right > viewport.left
  );
  const pending = () => [...jobs].filter((job) => job.state === 'pending');

  const priority = (job: Job): [number, number, number] => {
    if (!viewport) return [0, 0, 0];
    const vertical = Math.max(viewport.firstRow - job.bounds.row, job.bounds.row - viewport.lastRow, 0);
    const horizontal = Math.max(viewport.left - job.bounds.right, job.bounds.left - viewport.right, 0);
    // Fill the surrounding hours of visible channels before the vertically overscanned rows.
    return [vertical === 0 ? 0 : 1, horizontal, vertical];
  };
  const nearest = (a: Job, b: Job): number => {
    const ap = priority(a);
    const bp = priority(b);
    return ap[0] - bp[0] || ap[1] - bp[1] || ap[2] - bp[2];
  };

  const activate = (job: Job, background: boolean) => {
    if (disposed || job.state !== 'pending') return;
    job.state = 'active';
    if (background) inFlight = job;
    try {
      job.activate(job.ticket);
    } catch (error) {
      job.ticket.cancel();
      throw error;
    }
  };

  const schedule = () => {
    const queued = pending();
    if (disposed || inFlight || queued.length === 0) {
      if (frame !== null) cancelFrame(frame);
      frame = null;
      return;
    }
    if (frame !== null) return;
    frame = requestFrame(() => {
      frame = null;
      if (disposed || inFlight) return;
      const next = pending().sort(nearest)[0];
      if (next) activate(next, true);
    });
  };

  const finish = (job: Job) => {
    if (job.state === 'done') return;
    job.state = 'done';
    jobs.delete(job);
    if (inFlight === job) inFlight = undefined;
    schedule();
  };

  const reset = () => {
    if (frame !== null) cancelFrame(frame);
    frame = null;
    for (const job of jobs) job.state = 'done';
    jobs.clear();
    inFlight = undefined;
  };

  return {
    isVisible,
    enqueue(bounds, onReady) {
      const job: Job = {
        bounds: { ...bounds },
        activate: onReady,
        ticket: { committed: () => finish(job), cancel: () => finish(job) },
        state: disposed ? 'done' : 'pending',
      };
      if (disposed) return job.ticket;
      jobs.add(job);
      if (isVisible(bounds)) activate(job, false);
      schedule();
      return job.ticket;
    },
    setViewport(next) {
      if (disposed) return;
      viewport = { ...next };
      // A background commit never holds newly visible programmes behind it.
      for (const job of pending()) if (isVisible(job.bounds)) activate(job, false);
      schedule();
    },
    reset,
    dispose() {
      disposed = true;
      reset();
    },
  };
}
