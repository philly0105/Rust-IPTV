/** VD-4: each /downloads row follows its own live sample; a progress event re-renders that row only. */

import { act, cleanup, render, screen, within } from '@testing-library/react';
import { Profiler } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { DownloadRow } from '../components/DownloadRow';
import { STALE_MS, progressStore } from '../lib/progress';
import { makeDownload } from './fixtures';
import { i18n, installDomStubs } from './harness';

vi.mock('@/api/transport', () => ({
  rpc: async () => undefined,
  rpcRaw: async () => undefined,
  isDesktop: false,
  RpcError: class RpcError extends Error {},
  proxiedUrl: (s: { url: string }) => s.url,
}));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));
vi.mock('@/shell', async () => (await import('./harness')).shellModule);
vi.mock('@/features/player', async () => (await import('./harness')).playerModule);

beforeAll(installDomStubs);
afterEach(() => {
  cleanup();
  progressStore.prune([]);
  vi.useRealTimers();
});

const MB = 1024 * 1024;

function renderRows(renders: Map<string, number>) {
  const count = (id: string) => renders.set(id, (renders.get(id) ?? 0) + 1);
  const a = makeDownload({ id: 1, status: 'downloading', bytesDownloaded: 0, totalBytes: 100 * MB, title: 'Alpha' });
  const b = makeDownload({ id: 2, status: 'downloading', bytesDownloaded: 0, totalBytes: 100 * MB, title: 'Beta' });
  return render(
    <I18nextProvider i18n={i18n}>
      {[a, b].map((d) => (
        <Profiler key={d.id} id={String(d.id)} onRender={(id) => count(id)}>
          <DownloadRow download={d} source={undefined} actions={[]} busy={false} onAction={() => undefined} />
        </Profiler>
      ))}
    </I18nextProvider>,
  );
}

describe('DownloadRow live progress (VD-4)', () => {
  it('re-renders only the row whose transfer moved', () => {
    const renders = new Map<string, number>();
    renderRows(renders);
    const before = new Map(renders);
    act(() => progressStore.ingest({ id: 1, bytesDownloaded: 50 * MB, totalBytes: 100 * MB, bytesPerSecond: MB }));
    expect(renders.get('1')).toBeGreaterThan(before.get('1')!);
    expect(renders.get('2')).toBe(before.get('2'));
    const rows = screen.getAllByTestId('download-row');
    expect(within(rows[0]!).getByText('50%')).toBeTruthy();
    expect(within(rows[1]!).queryByText('50%')).toBeNull();
  });

  it('reads as stalled once its own sample goes stale', () => {
    vi.useFakeTimers();
    renderRows(new Map());
    act(() => progressStore.ingest({ id: 1, bytesDownloaded: 10 * MB, totalBytes: 100 * MB, bytesPerSecond: MB }));
    const detail = () => within(screen.getAllByTestId('download-row')[0]!).getByTestId('download-detail').textContent;
    expect(detail()).not.toBe(i18n.t('library:stalled'));
    act(() => vi.advanceTimersByTime(STALE_MS + 10));
    expect(detail()).toBe(i18n.t('library:stalled'));
  });
});
