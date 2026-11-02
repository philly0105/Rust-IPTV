/**
 * The patched mpegts.js bundle the app loads (`node_modules/mpegts.js/dist/mpegts.js`, built
 * from `patches/mpegts.js@1.8.2.patch`): one worker blob URL per page and a booted spare
 * transmuxing worker for the next start (F2-2, replacing PB-3's revoke on destroy). jsdom has
 * no MediaSource or Worker, so both are fakes that record what the bundle does with them.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

type Msg = { cmd: string };

class FakeWorker extends EventTarget {
  static all: FakeWorker[] = [];
  readonly messages: Msg[] = [];
  terminated = false;
  constructor(readonly url: string) {
    super();
    FakeWorker.all.push(this);
  }
  postMessage(m: Msg): void {
    this.messages.push(m);
    // The real worker answers a destroy once its controller is down.
    if (m.cmd === 'destroy') queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: { msg: 'destroyed' } })));
  }
  terminate(): void {
    this.terminated = true;
  }
}

class FakeMediaSource extends EventTarget {
  static isTypeSupported = (): boolean => true;
  readyState = 'closed';
  sourceBuffers = [];
}

const saved = { Worker: globalThis.Worker, MediaSource: globalThis.MediaSource, create: URL.createObjectURL, revoke: URL.revokeObjectURL };
const createObjectURL = vi.fn((o: Blob | MediaSource) => (o instanceof Blob ? `blob:worker-${createObjectURL.mock.calls.length}` : 'blob:media-source'));
const revokeObjectURL = vi.fn();

beforeAll(() => {
  Object.assign(globalThis, { Worker: FakeWorker, MediaSource: FakeMediaSource });
  Object.assign(URL, { createObjectURL, revokeObjectURL });
});

afterAll(() => {
  Object.assign(globalThis, { Worker: saved.Worker, MediaSource: saved.MediaSource });
  Object.assign(URL, { createObjectURL: saved.create, revokeObjectURL: saved.revoke });
});

const { default: mpegts } = await vi.importActual<typeof import('mpegts.js')>('mpegts.js');

const workerBlobs = () => createObjectURL.mock.calls.filter(([o]) => o instanceof Blob).length;
const live = () => FakeWorker.all.filter((w) => !w.terminated);
const cmds = (w: FakeWorker | undefined) => w?.messages.map((m) => m.cmd) ?? [];
/** The timers the bundle schedules its spares on (setTimeout 0). */
const settle = () => new Promise((r) => setTimeout(r, 5));

function start(n: number) {
  const player = mpegts.createPlayer(
    { type: 'mpegts', isLive: true, url: `http://h/live/${n}.ts` },
    { enableWorker: true, deferLoadAfterSourceOpen: false, lazyLoad: false },
  );
  player.attachMediaElement(document.createElement('video'));
  player.load();
  return player;
}

function stop(player: ReturnType<typeof start>): void {
  player.unload();
  player.detachMediaElement();
  player.destroy();
}

describe('mpegts.js transmuxing workers (F2-2)', () => {
  it('is the patched bundle', () => {
    expect((mpegts as typeof mpegts & { iptvPatchRevision?: string }).iptvPatchRevision).toBe('archive-seek-15');
  });

  it('a player takes the booted spare, the next start finds another, and the page builds one script URL', async () => {
    mpegts.prewarmWorkers(1);
    // In a later task, never inside the caller's.
    expect(FakeWorker.all).toHaveLength(0);
    await settle();
    expect(FakeWorker.all).toHaveLength(1);
    const spare = FakeWorker.all[0];
    // Booted but untouched: as fresh as a new worker.
    expect(cmds(spare)).toEqual([]);

    const first = start(1);
    // Before, every start built its own worker here and the request waited for it to boot.
    expect(FakeWorker.all).toHaveLength(1);
    expect(cmds(spare)).toEqual(['init', 'logging_config', 'start']);
    await settle();
    expect(FakeWorker.all).toHaveLength(2);
    const next = FakeWorker.all[1];
    expect(cmds(next)).toEqual([]);

    // A reconnect or a zap: the old pipeline goes, the new one takes the spare.
    stop(first);
    await settle();
    expect(spare?.terminated).toBe(true);
    const second = start(2);
    expect(cmds(next).slice(0, 1)).toEqual(['init']);
    // A worker that had 'init' is never handed out again.
    expect(cmds(spare).filter((c) => c === 'init')).toHaveLength(1);
    await settle();
    // In use plus one.
    expect(live()).toHaveLength(2);
    stop(second);
    await settle();

    // One generated script for the page, all workers on it, and nothing revokes it.
    expect(workerBlobs()).toBe(1);
    expect(new Set(FakeWorker.all.map((w) => w.url))).toEqual(new Set(['blob:worker-1']));
    expect(revokeObjectURL).not.toHaveBeenCalledWith('blob:worker-1');
  });

  it('a wall asks for up to 4 at once; spares no tile takes beyond one shut after 15 s', async () => {
    vi.useFakeTimers();
    try {
      const before = live().length;
      mpegts.prewarmWorkers(9);
      await vi.advanceTimersByTimeAsync(0);
      expect(live()).toHaveLength(4);
      expect(before).toBe(1);
      const tile = start(3);
      await vi.advanceTimersByTimeAsync(0);
      // The tile took one and three are left: no replacement needed.
      expect(live()).toHaveLength(4);
      await vi.advanceTimersByTimeAsync(15_000);
      // The tile's worker and one spare.
      expect(live()).toHaveLength(2);
      stop(tile);
      await vi.advanceTimersByTimeAsync(0);
      expect(live()).toHaveLength(1);
      expect(workerBlobs()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a worker script that cannot start stops the spares, and players build their own as before', async () => {
    const spare = live()[0];
    spare?.dispatchEvent(new Event('error'));
    expect(spare?.terminated).toBe(true);
    mpegts.prewarmWorkers(2);
    await settle();
    expect(live()).toHaveLength(0);
    const count = FakeWorker.all.length;
    const player = start(4);
    expect(FakeWorker.all).toHaveLength(count + 1);
    expect(cmds(FakeWorker.all.at(-1))).toEqual(['init', 'logging_config', 'start']);
    await settle();
    expect(live()).toHaveLength(1);
    stop(player);
  });
});
