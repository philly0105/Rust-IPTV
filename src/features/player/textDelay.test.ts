import { describe, expect, it } from 'vitest';

import { applyCueDelay, type CueLike, type TrackLike } from './textDelay';

function track(cues: CueLike[], mode = 'showing'): TrackLike & { list: CueLike[] } {
  const t = {
    mode,
    list: cues,
    get cues() {
      return t.list;
    },
    removeCue(cue: CueLike) {
      t.list = t.list.filter((c) => c !== cue);
    },
  };
  return t;
}

const cue = (startTime: number, endTime: number, text = 'line'): CueLike => ({ startTime, endTime, text });

describe('subtitle cue delay', () => {
  it('shifts cues from their original times, so repeated changes never drift', () => {
    const a = cue(10, 12);
    const t = track([a]);
    applyCueDelay([t], 0.3);
    expect([a.startTime, a.endTime]).toEqual([10.3, 12.3]);
    applyCueDelay([t], -0.5);
    expect([a.startTime, a.endTime]).toEqual([9.5, 11.5]);
    applyCueDelay([t], 0);
    expect([a.startTime, a.endTime]).toEqual([10, 12]);
  });

  it('never moves a cue before zero', () => {
    const a = cue(0.2, 1);
    applyCueDelay([track([a])], -0.5);
    expect(a.startTime).toBe(0);
    expect(a.endTime).toBe(0.5);
  });

  it('skips disabled tracks', () => {
    const a = cue(5, 6);
    applyCueDelay([track([a], 'disabled')], 1);
    expect(a.startTime).toBe(5);
  });

  it('shifts cues added later and drops a copy an engine adds again', () => {
    const a = cue(1, 2);
    const t = track([a]);
    applyCueDelay([t], 1);
    const later = cue(20, 21, 'new');
    const copy = cue(1, 2);
    t.list = [...t.list, later, copy];
    applyCueDelay([t], 1);
    expect(later.startTime).toBe(21);
    expect(t.list).toEqual([a, later]);
  });
});
