/**
 * L3-live-guide-x2: short-EPG answers that land within one frame re-render the page once. Frames
 * are driven by hand (requestAnimationFrame is stubbed), and each answer is released on its own,
 * so the test waits on the queue's state, never on a timer.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EpgProgram, ItemRef } from '@/api/types';

const pending = new Map<string, (programs: EpgProgram[]) => void>();
vi.mock('@/api/transport', async (orig) => ({
  ...(await orig<object>()),
  rpc: (cmd: string, args: { ref: ItemRef }) => {
    if (cmd !== 'epg.shortEpg') throw new Error(`unexpected ${cmd}`);
    return new Promise<EpgProgram[]>((resolve) => pending.set(args.ref.itemId, resolve));
  },
}));

const { useShortEpgPreviews } = await import('../../hooks/useShortEpg');
const { resetStalkerPreviewSources } = await import('../../lib/stalkerPreviewQueue');

let frames: FrameRequestCallback[] = [];
beforeEach(() => {
  frames = [];
  pending.clear();
  resetStalkerPreviewSources();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    if (id > 0) frames[id - 1] = () => undefined;
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetStalkerPreviewSources();
});

const ref = (itemId: string): ItemRef => ({ sourceId: 'x2-src', contentType: 'live', itemId });
const airing = (id: string): EpgProgram[] => {
  const now = Date.now();
  return [{ channelId: id, start: new Date(now - 60_000).toISOString(), end: new Date(now + 3_600_000).toISOString(), title: `${id} now` }];
};

describe('useShortEpgPreviews (L3-live-guide-x2)', () => {
  it('two answers in one frame re-render once, with both', async () => {
    const refs = [ref('a'), ref('b')];
    const now = Date.now();
    let renders = 0;
    const { result } = renderHook(() => {
      renders++;
      return useShortEpgPreviews('x2-src', true, refs, now);
    });
    // Both requests go out together (two workers).
    await waitFor(() => expect([...pending.keys()].sort()).toEqual(['a', 'b']));
    const before = renders;

    // Each answer is stored in its own task; neither re-renders before the frame.
    await act(async () => pending.get('a')!(airing('a')));
    await waitFor(() => expect(frames).toHaveLength(1));
    await act(async () => pending.get('b')!(airing('b')));
    // The second answer is stored once its worker resumes; it joins the frame already asked for.
    await waitFor(() => expect(result.current(ref('b'))).toBeDefined());
    expect(frames).toHaveLength(1);
    expect(renders).toBe(before);

    act(() => frames.shift()!(performance.now()));
    expect(renders).toBe(before + 1);
    expect(result.current(ref('a'))?.[0]?.title).toBe('a now');
    expect(result.current(ref('b'))?.[0]?.title).toBe('b now');

    // A later answer asks for a new frame.
    expect(frames).toHaveLength(0);
  });

  it('an unmount cancels the frame it asked for', async () => {
    const refs = [ref('c')];
    const now = Date.now();
    let renders = 0;
    const { unmount } = renderHook(() => {
      renders++;
      return useShortEpgPreviews('x2-src', true, refs, now);
    });
    await waitFor(() => expect(pending.has('c')).toBe(true));
    await act(async () => pending.get('c')!(airing('c')));
    await waitFor(() => expect(frames).toHaveLength(1));
    const before = renders;
    unmount();
    act(() => frames.shift()!(performance.now()));
    expect(renders).toBe(before);
  });
});
