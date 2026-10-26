import { describe, expect, it, vi } from 'vitest';

type Controller = {
  _pendingArchiveSeek: Record<string, unknown> | null;
  _ioctl: Record<string, unknown>;
  _demuxer: Record<string, unknown>;
  _remuxer: Record<string, unknown>;
  _config: Record<string, unknown>;
  _trace: (message: string) => void;
  _onRemuxerMediaSegmentArrival: (type: string, segment: Record<string, unknown>) => void;
};
const vendorModule = '../../../vendor/mpegts.js/src/core/' + 'transmuxing-controller';
const { default: TransmuxingController } = await vi.importActual<{ default: { prototype: Controller } }>(vendorModule);

describe('archive byte-range seek with a reset TS clock', () => {
  it('reuses the valid range with a rebased clock instead of seeking past EOF', async () => {
    const target = 8_348_000;
    const actual = -34_452_340;
    const from = 4_957_936_000;
    const seek = { target, from, attempts: 0, correcting: false, lower: null, upper: null, waitingForSync: false, clockRebases: 0 };
    const ioSeek = vi.fn();
    const shift = vi.fn(() => true);
    const controller = Object.create(TransmuxingController.prototype) as Controller;
    controller._pendingArchiveSeek = seek;
    controller._ioctl = { currentRangeEnd: from + 39_104, totalLength: 8_567_332_208, seek: ioSeek };
    controller._demuxer = { resetAfterSeek: vi.fn() };
    controller._remuxer = { seek: vi.fn(), insertDiscontinuity: vi.fn(), shiftTimestampBase: shift };
    controller._config = { expectedDuration: 14_400_000, archiveScanMaxGap: 30_000 };
    controller._trace = vi.fn();

    controller._onRemuxerMediaSegmentArrival('video', {
      info: { beginDts: actual, endDts: actual + 80, syncPoints: [{ dts: actual, pts: actual, fileposition: from + 188 }] },
    });
    await Promise.resolve();

    expect(shift).toHaveBeenCalledWith(actual - target);
    expect(ioSeek).toHaveBeenCalledWith(from);
    expect(seek.clockRebases).toBe(1);
    expect(seek.correcting).toBe(false);
  });
});
