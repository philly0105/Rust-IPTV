import { existsSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

type Controller = {
  _pendingArchiveSeek: Record<string, unknown> | null;
  _ioctl: Record<string, unknown>;
  _demuxer: Record<string, unknown>;
  _remuxer: Record<string, unknown>;
  _config: Record<string, unknown>;
  _trace: (message: string) => void;
  _onRemuxerMediaSegmentArrival: (type: string, segment: Record<string, unknown>) => void;
  seek: (milliseconds: number) => void;
  _mediaInfo: Record<string, unknown>;
  _emitter: { emit: ReturnType<typeof vi.fn> };
  _updateKeyframesIndex: ReturnType<typeof vi.fn>;
  _searchSegmentIndexContains: ReturnType<typeof vi.fn>;
};
const vendorModule = '../../../vendor/mpegts.js/src/core/' + 'transmuxing-controller';
// The fork checkout comes from `node tools/prepare-mpegts.mjs`; without it these tests skip.
const vendored = existsSync(new URL('../../../vendor/mpegts.js/src', import.meta.url));
const { default: TransmuxingController } = vendored
  ? await vi.importActual<{ default: { prototype: Controller } }>(vendorModule)
  : { default: undefined as unknown as { prototype: Controller } };

describe.skipIf(!vendored)('archive byte-range seek with a reset TS clock', () => {
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

describe.skipIf(!vendored)('archive URLs with their own seek position', () => {
  it('does not seek the old response by byte range', () => {
    const controller = Object.create(TransmuxingController.prototype) as Controller;
    controller._config = { expectedDuration: 14_400_000, enableArchiveByteRangeSeek: false };
    controller._mediaInfo = { isSeekable: () => true };
    controller._ioctl = { seek: vi.fn() };
    controller._searchSegmentIndexContains = vi.fn();
    controller.seek(8_340_000);
    expect(controller._searchSegmentIndexContains).not.toHaveBeenCalled();
    expect(controller._ioctl.seek).not.toHaveBeenCalled();
  });

  it('does not build the byte-position index while playing a URL-based archive', () => {
    const controller = Object.create(TransmuxingController.prototype) as Controller;
    controller._config = { expectedDuration: 14_400_000, enableArchiveByteRangeSeek: false };
    controller._mediaInfo = {};
    controller._emitter = { emit: vi.fn() };
    controller._pendingArchiveSeek = null;
    controller._updateKeyframesIndex = vi.fn();
    controller._onRemuxerMediaSegmentArrival('video', {
      info: { endDts: 1_000, syncPoints: [{ dts: 1_000, fileposition: 188 }] },
    });
    expect(controller._updateKeyframesIndex).not.toHaveBeenCalled();
    expect(controller._emitter.emit).toHaveBeenCalled();
  });
});
