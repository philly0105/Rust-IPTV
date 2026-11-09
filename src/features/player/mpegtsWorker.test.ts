import { createRequire } from 'node:module';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The patched mpegts.js worker factory (`patches/mpegts.js@1.8.2.patch`,
 * `src/utils/webworkify-webpack.js`; the bundle the app loads carries the same change): the
 * transmuxing worker's script is built once per session, and a booted worker waits for the next
 * player.
 */
const require = createRequire(import.meta.url);
const FACTORY = 'mpegts.js/src/utils/webworkify-webpack.js';

type Work = (moduleId: number | string, options?: { all?: boolean; bare?: boolean }) => FakeWorker;

class FakeWorker {
  static made: FakeWorker[] = [];
  objectURL?: string;
  constructor(public url: string) {
    FakeWorker.made.push(this);
  }
}

let blobs = 0;
let work: Work;

function loadFactory(): Work {
  delete require.cache[require.resolve(FACTORY)];
  return require(FACTORY) as Work;
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWorker.made = [];
  blobs = 0;
  // A webpack module that requires another one, as the transmuxing worker does.
  vi.stubGlobal('__webpack_modules__', {
    1: function (_module: unknown, _exports: unknown, __webpack_require__: (id: number) => unknown) {
      __webpack_require__(2);
    },
    2: function () {},
  });
  vi.stubGlobal('Worker', FakeWorker);
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:worker-${++blobs}`);
  work = loadFactory();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('mpegts.js worker factory', () => {
  it('builds the worker script once and reuses its URL', () => {
    const first = work(1);
    const second = work(1);
    expect(blobs).toBe(1);
    expect(first.url).toBe('blob:worker-1');
    expect(second.url).toBe('blob:worker-1');
    // A shared URL is never handed to the transmuxer to revoke.
    expect(first.objectURL).toBeUndefined();
    expect(second.objectURL).toBeUndefined();
  });

  it('starts a spare worker after a start and hands it to the next player', () => {
    const first = work(1);
    expect(FakeWorker.made).toEqual([first]);
    vi.advanceTimersByTime(500);
    expect(FakeWorker.made).toHaveLength(2);
    const spare = FakeWorker.made[1];
    expect(work(1)).toBe(spare);
    // The next spare follows, and only one waits at a time.
    vi.advanceTimersByTime(500);
    vi.advanceTimersByTime(500);
    expect(FakeWorker.made).toHaveLength(3);
  });

  it('builds a worker of its own while the spare is not up yet', () => {
    work(1);
    const second = work(1);
    expect(FakeWorker.made).toHaveLength(2);
    expect(second).toBe(FakeWorker.made[1]);
    vi.advanceTimersByTime(500);
    // Both starts asked for a spare: one is made.
    expect(FakeWorker.made).toHaveLength(3);
  });

  it('keeps the old behaviour for a worker of all modules', () => {
    const all = work(1, { all: true });
    expect(all.objectURL).toBe('blob:worker-1');
    work(1, { all: true });
    expect(blobs).toBe(2);
    vi.advanceTimersByTime(1000);
    expect(FakeWorker.made).toHaveLength(2);
  });

  it('carries on when a spare cannot start', () => {
    work(1);
    vi.stubGlobal('Worker', function () {
      throw new Error('blocked');
    });
    expect(() => vi.advanceTimersByTime(500)).not.toThrow();
  });
});
