/**
 * F4-5: My Videos' recordings.
 *
 * - The All tab's rail asks the catalog for its channels' logos in one `catalog.items` call: each
 *   card asked `catalog.item` for its channel, after observing `recordings.list` and searching it.
 * - A keystroke in the page's search re-renders the Recordings tab's rows it changes only: the rows
 *   are memoized and share the panel's play handler and toast.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Channel, ItemRef, Recording, RecordingFile } from '@/api/types';
import { usePendingRemovals } from '@/features/sources/lib/pendingRemoval';

import { RecordingsPanel } from '../components/RecordingsPanel';
import { MyVideosPage } from '../pages/MyVideosPage';
import { installDomStubs, renderAt } from './harness';

const rpcMock = vi.hoisted(() => ({ current: null as null | ReturnType<typeof import('./harness')['createRpcMock']> }));
const counts = vi.hoisted(() => ({ rowSizes: 0 }));

vi.mock('@/api/transport', () => {
  class RpcError extends Error {
    code = 'internal';
    static from(err: unknown) {
      return err instanceof RpcError ? err : Object.assign(new RpcError(String(err)), {});
    }
  }
  return {
    rpc: (cmd: string, args?: unknown) => rpcMock.current!.call(cmd, args),
    rpcRaw: (cmd: string, args?: unknown) => rpcMock.current!.call(cmd, args),
    isDesktop: true,
    RpcError,
    proxiedUrl: (s: { url: string }) => s.url,
  };
});
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));
vi.mock('@/shell', async () => (await import('./harness')).shellModule);
vi.mock('@/features/player', async () => (await import('./harness')).playerModule);
// Each recording row formats its file size once per render: a count of the rows' renders.
vi.mock('../lib/format', async (orig) => {
  const real = await orig<typeof import('../lib/format')>();
  return { ...real, formatBytes: (...args: Parameters<typeof real.formatBytes>) => (counts.rowSizes++, real.formatBytes(...args)) };
});

const harness = await import('./harness');
rpcMock.current = harness.createRpcMock();
const rpc = rpcMock.current;

const FILES = 300;
const CHANNELS = 25;
const channelRef = (c: number): ItemRef => ({ sourceId: 's1', contentType: 'live', itemId: `ch${c}` });
const recordingOf = (i: number) => `rec${i % 60}`;
const files: RecordingFile[] = Array.from({ length: FILES }, (_, i) => ({
  id: `r.${i}`,
  fileName: `News ${i}.ts`,
  recordingId: recordingOf(i),
  channelName: `Channel ${i % CHANNELS}`,
  title: `News ${i}`,
  sizeBytes: 2_500_000,
  date: new Date(Date.UTC(2026, 9, 1) + i * 60_000).toISOString(),
  fileAvailable: true,
  status: 'completed',
}));
// 60 recordings over 25 channels.
const recordings = Array.from({ length: 60 }, (_, r) => ({ id: `rec${r}`, ref: channelRef(r % CHANNELS), channelName: `Channel ${r % CHANNELS}` }) as Recording);

beforeAll(installDomStubs);
beforeEach(() => {
  rpc.reset();
  counts.rowSizes = 0;
  usePendingRemovals.setState({ ids: new Set() });
  rpc.handlers['sources.list'] = () => [];
  rpc.handlers['settings.get'] = () => ({ epgOffsetMinutes: 0, coverSize: 'medium' });
  rpc.handlers['downloads.dir'] = () => ({ path: 'D:/Videos' });
  rpc.handlers['downloads.list'] = () => [];
  rpc.handlers['myvideos.list'] = () => [];
  rpc.handlers['recordings.library'] = () => files;
  rpc.handlers['recordings.list'] = () => recordings;
  rpc.handlers['catalog.items'] = (args) =>
    (args as { refs: ItemRef[] }).refs.map((ref) => ({ item: { ref, name: ref.itemId, categoryId: 'g', isRadio: false, logoUrl: `http://logos/${ref.itemId}.png` } as Channel }));
});
afterEach(cleanup);

describe('F4-5: My Videos recordings', () => {
  it('asks the logos of the rail’s 25 channels in one catalog.items call', async () => {
    renderAt('/my-videos', [{ path: '/my-videos', element: <MyVideosPage /> }]);
    const rail = await screen.findByRole('list', { name: 'Recordings' });
    expect(within(rail).getAllByTestId('library-card')).toHaveLength(FILES);
    await waitFor(() => expect(rpc.callsOf('catalog.items')).toHaveLength(1));
    expect((rpc.callsOf('catalog.items')[0] as { refs: ItemRef[] }).refs).toHaveLength(CHANNELS);
    expect(rpc.callsOf('catalog.item')).toEqual([]);
    await waitFor(() => expect(rail.querySelectorAll('img').length).toBeGreaterThan(0));
  });

  it('a search keystroke re-renders only the rows it changes', async () => {
    function Searchable() {
      const [search, setSearch] = useState('');
      return (
        <>
          <input aria-label="Search recordings" value={search} onChange={(e) => setSearch(e.target.value)} />
          <RecordingsPanel search={search} />
        </>
      );
    }
    renderAt('/', [{ path: '/', element: <Searchable /> }]);
    await waitFor(() => expect(screen.getAllByTestId('recording-file')).toHaveLength(FILES));
    const mounted = counts.rowSizes;
    // Every file still matches: no row changes, so none renders again (300 did).
    fireEvent.change(screen.getByLabelText('Search recordings'), { target: { value: 'n' } });
    expect(screen.getAllByTestId('recording-file')).toHaveLength(FILES);
    expect(counts.rowSizes - mounted).toBe(0);
    // A narrower query drops rows; the rows it keeps do not render again either.
    fireEvent.change(screen.getByLabelText('Search recordings'), { target: { value: 'news 29' } });
    expect(screen.getAllByTestId('recording-file').length).toBe(11);
    expect(counts.rowSizes - mounted).toBe(0);
  });
});
