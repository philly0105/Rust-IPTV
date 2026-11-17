/**
 * Faster downloads (SC8, library): a running row says how many connections and sources it uses
 * (nothing for one on one), which source serves it, and its latest note in a quiet tone; the
 * Speed details dialog breaks the speed down by source and connection, says what limits it in
 * one sentence, opens from the keyboard and closes on Escape, and is a sheet on a phone; the
 * header's sparkline sums the live speeds.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { queryClient } from '@/api/query';
import type { Download, Limiting, Source, TransferStats } from '@/api/types';

import { DownloadDetailsPopover } from '../components/DownloadDetailsPopover';
import { DownloadRow } from '../components/DownloadRow';
import { SpeedSparkline, speedHistory } from '../components/SpeedSparkline';
import { formatBytes, formatSpeed, formatSpeedLimit } from '../lib/format';
import { STALE_MS, progressStore, statsStore } from '../lib/progress';
import { hasActivity, SpeedHistory } from '../lib/speedHistory';
import { countsText, limitingText, limitText } from '../lib/transferText';
import { DownloadsPage } from '../pages/DownloadsPage';
import { makeDownload, makeStats } from './fixtures';
import { i18n, installDomStubs, renderAt } from './harness';

const rpcMock = vi.hoisted(() => ({ current: null as null | ReturnType<typeof import('./harness')['createRpcMock']> }));

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
    isDesktop: false,
    RpcError,
    proxiedUrl: (s: { url: string }) => s.url,
  };
});
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));
vi.mock('@/shell', async () => (await import('./harness')).shellModule);
vi.mock('@/features/player', async () => (await import('./harness')).playerModule);

const harness = await import('./harness');
rpcMock.current = harness.createRpcMock();
const rpc = rpcMock.current;

const MB = 1024 * 1024;
const t = i18n.getFixedT('en', 'library');

const sourceList: Source[] = [
  { id: 'src1', kind: 'xtream', name: 'Home portal' } as Source,
  { id: 'src2', kind: 'xtream', name: 'Backup portal' } as Source,
  { id: 'src3', kind: 'm3u', name: 'Spare list' } as Source,
];
const sourceMap: ReadonlyMap<string, Source> = new Map(sourceList.map((s) => [s.id, s]));
const nameOf = (id: string) => sourceMap.get(id)?.name ?? t('sourceRemoved');

const originalMatchMedia = window.matchMedia;
/** A phone-width window (Tailwind's sm does not match) or a wide one. */
function setPhone(phone: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('min-width: 40rem') ? !phone : false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

beforeAll(installDomStubs);
beforeEach(() => {
  rpc.reset();
  queryClient.clear();
  rpc.handlers['sources.list'] = () => sourceList;
  rpc.handlers['downloads.dir'] = () => ({ path: 'D:/Videos' });
  rpc.handlers['settings.get'] = () => ({ downloadRateLimitBps: 0 });
  rpc.handlers['downloads.stats'] = () => null;
});
afterEach(() => {
  cleanup();
  progressStore.prune([]);
  statsStore.prune([]);
  speedHistory.clear();
  window.matchMedia = originalMatchMedia;
  vi.useRealTimers();
});

function renderRow(d: Download, extra: { nameOf?: (id: string) => string } = {}) {
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <DownloadRow download={d} source={sourceMap.get(d.ref.sourceId)} actions={['pause', 'cancel']} busy={false} onAction={() => undefined} {...extra} />
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

function renderDetails(d: Download) {
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <DownloadDetailsPopover download={d} sources={sourceMap} onClose={() => undefined} />
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

const detail = () => screen.getByTestId('download-detail').textContent ?? '';

describe('row detail line', () => {
  it('says "4 connections · 3 sources" for a transfer spread over three sources', () => {
    renderRow(makeDownload({ id: 1, status: 'downloading', bytesDownloaded: 10 * MB, totalBytes: 100 * MB }));
    act(() => progressStore.ingest({ id: 1, bytesDownloaded: 20 * MB, totalBytes: 100 * MB, bytesPerSecond: 4 * MB, connections: 4, sources: 3 }));
    expect(detail()).toContain('4 connections · 3 sources');
  });

  it('says nothing about connections or sources for one source on one connection', () => {
    renderRow(makeDownload({ id: 2, status: 'downloading', bytesDownloaded: 10 * MB, totalBytes: 100 * MB }));
    act(() => progressStore.ingest({ id: 2, bytesDownloaded: 20 * MB, totalBytes: 100 * MB, bytesPerSecond: MB }));
    expect(detail()).not.toMatch(/connection|source/);
    // An event that sends 1 (or later leaves the count out) reads the same way.
    act(() => progressStore.ingest({ id: 2, bytesDownloaded: 21 * MB, totalBytes: 100 * MB, bytesPerSecond: MB, connections: 1, sources: 1 }));
    expect(detail()).not.toMatch(/connection|source/);
  });

  it('names only the parts above one, and drops a count the transfer stopped sending', () => {
    renderRow(makeDownload({ id: 3, status: 'downloading', bytesDownloaded: 0, totalBytes: 100 * MB }));
    act(() => progressStore.ingest({ id: 3, bytesDownloaded: MB, totalBytes: 100 * MB, bytesPerSecond: MB, connections: 2 }));
    expect(detail()).toContain('2 connections');
    expect(detail()).not.toContain('source');
    act(() => progressStore.ingest({ id: 3, bytesDownloaded: 2 * MB, totalBytes: 100 * MB, bytesPerSecond: MB }));
    expect(detail()).not.toContain('connections');
    expect(countsText(t, 1, 3)).toBe('3 sources');
    expect(countsText(t, 1, 1)).toBe('');
    expect(countsText(t, undefined, undefined)).toBe('');
  });

  it('says which source serves a spread download, by name', () => {
    renderRow(makeDownload({ id: 4, status: 'downloading', bytesDownloaded: 0, totalBytes: 100 * MB, servedBy: 'src2' }), { nameOf });
    act(() => progressStore.ingest({ id: 4, bytesDownloaded: MB, totalBytes: 100 * MB, bytesPerSecond: MB }));
    expect(detail()).toContain('From Backup portal');
  });

  it('shows the latest note in a quiet tone, never as an error', () => {
    const stats = makeStats(5, {
      bytesPerSecond: MB,
      notes: [
        { kind: 'mirrorAdded', sourceId: 'src2' },
        { kind: 'mirrorDropped', sourceId: 'src2', reason: 'refused' },
      ],
    });
    renderRow(makeDownload({ id: 5, status: 'downloading', bytesDownloaded: 0, totalBytes: 100 * MB, stats }), { nameOf });
    act(() => progressStore.ingest({ id: 5, bytesDownloaded: MB, totalBytes: 100 * MB, bytesPerSecond: MB }));
    const note = screen.getByTestId('download-note');
    expect(note.textContent?.trim()).toBe('Stopped using Backup portal: it refused the connection');
    expect(note.className).not.toMatch(/danger|error/);
    expect(note.className).toContain('text-fg-subtle');
    expect(screen.getByTestId('download-detail').className).not.toMatch(/danger/);
    // The progress keeps the running tone.
    expect(screen.getByTestId('dial-fill').className).toContain('bg-accent-mark');
  });
});

const BIG: TransferStats = makeStats(7, {
  bytesPerSecond: 9 * MB,
  connections: [
    { sourceId: 'src1', host: 'a.example.test', address: '203.0.113.5', bytesPerSecond: 3.5 * MB, bytes: 120 * MB, ageMs: 65_000 },
    { sourceId: 'src1', host: 'a.example.test', bytesPerSecond: 2.5 * MB, bytes: 80 * MB, ageMs: 30_000 },
    { sourceId: 'src2', host: 'b.example.test', bytesPerSecond: 3 * MB, bytes: 64 * MB, ageMs: 12_000 },
  ],
  sources: [
    { sourceId: 'src1', role: 'primary', connections: 2, bytesPerSecond: 6 * MB, bytes: 200 * MB, limit: 2, limitKind: 'reported' },
    { sourceId: 'src2', role: 'mirror', connections: 1, bytesPerSecond: 3 * MB, bytes: 64 * MB, limit: 3, limitKind: 'learned' },
    { sourceId: 'src3', role: 'mirror', connections: 0, bytesPerSecond: 0, bytes: 0, limitKind: 'unknown' },
  ],
  limiting: { kind: 'perConnection', bytesPerSecond: 6.1 * MB },
  notes: [
    { kind: 'probeAccepted', sourceId: 'src2', limit: 3 },
    { kind: 'mirrorAdded', sourceId: 'src2' },
  ],
});

describe('Speed details dialog', () => {
  it('breaks the speed down per source and per connection in the row units', async () => {
    renderDetails(makeDownload({ id: 7, status: 'downloading', bytesDownloaded: 264 * MB, totalBytes: 1000 * MB, title: 'Arrival', stats: BIG }));
    const dialog = await screen.findByTestId('download-details');
    expect(within(dialog).getByRole('heading', { name: 'Speed details' })).toBeTruthy();
    expect(within(dialog).getByTestId('details-total').textContent).toBe(formatSpeed(9 * MB, 'en'));
    expect(within(dialog).getByTestId('details-counts').textContent).toBe('3 connections · 2 sources');

    const sources = within(dialog).getAllByTestId('details-source');
    expect(sources.map((s) => s.dataset['sourceId'])).toEqual(['src1', 'src2', 'src3']);
    expect(sources[0]!.textContent).toContain('Home portal');
    expect(sources[0]!.textContent).toContain(formatSpeed(6 * MB, 'en'));
    expect(sources[0]!.textContent).toContain(`${formatBytes(200 * MB, 'en')} this run`);
    // Each source's limit, as the account reports it, as a test learned it, or unknown.
    expect(sources[0]!.textContent).toContain('Account allows 2');
    expect(sources[1]!.textContent).toContain('Tested: 3 allowed');
    expect(sources[1]!.textContent).toContain('Identical copy');
    expect(sources[2]!.textContent).toContain('Limit unknown');
    expect(sources[2]!.textContent).toContain(t('detailsIdleSpeed'));
    expect(limitText(t, { limit: 4, limitKind: 'unknown' })).toBe('Limit unknown');

    const connections = within(dialog).getAllByTestId('details-connection');
    expect(connections).toHaveLength(3);
    expect(connections[0]!.textContent).toContain('a.example.test');
    expect(connections[0]!.textContent).toContain('203.0.113.5');
    expect(connections[0]!.textContent).toContain(formatSpeed(3.5 * MB, 'en'));
    expect(connections[0]!.textContent).toContain(`${formatBytes(120 * MB, 'en')} this run`);
    expect(connections[2]!.textContent).toContain('Backup portal');
    expect(connections[2]!.textContent).toContain(formatSpeed(3 * MB, 'en'));

    expect(within(dialog).getByTestId('details-limiting').textContent).toBe(`Provider caps each connection at about ${formatSpeed(6.1 * MB, 'en')}`);
    expect(formatSpeed(6.1 * MB, 'en')).toBe('6.1 MB/s');

    // Recent notes, newest first, in a quiet tone.
    const notes = within(dialog).getByTestId('details-notes');
    expect(within(notes).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Also downloading from Backup portal', 'Backup portal allows 3 connections']);
    expect(notes.className).not.toMatch(/danger|error/);
  });

  it('follows downloads.stats events over the row copy', async () => {
    renderDetails(makeDownload({ id: 7, status: 'downloading', bytesDownloaded: 0, totalBytes: 1000 * MB, stats: BIG }));
    await screen.findByTestId('download-details');
    act(() => statsStore.ingest(makeStats(7, { bytesPerSecond: 2 * MB, limiting: { kind: 'line', bytesPerSecond: 2 * MB } })));
    expect(screen.getByTestId('details-limiting').textContent).toBe('Your internet connection is the limit');
    expect(screen.getByTestId('details-total').textContent).toBe(formatSpeed(2 * MB, 'en'));
  });

  it('asks downloads.stats when neither an event nor the row has a breakdown', async () => {
    rpc.handlers['downloads.stats'] = (args) => makeStats((args as { id: number }).id, { bytesPerSecond: MB, limiting: { kind: 'smallFile' } });
    renderDetails(makeDownload({ id: 8, status: 'downloading', bytesDownloaded: 0, totalBytes: 10 * MB }));
    await waitFor(() => expect(screen.getByTestId('details-limiting').textContent).toBe(t('limitingSmallFile')));
    expect(rpc.callsOf('downloads.stats')).toContainEqual({ id: 8 });
  });

  it('says so when the download is not running', async () => {
    renderDetails(makeDownload({ id: 9, status: 'paused' }));
    expect((await screen.findByTestId('details-idle')).textContent).toBe(t('detailsNotRunning'));
    expect(rpc.callsOf('downloads.stats')).toEqual([]);
  });

  it('has one plain sentence for every limiting kind', () => {
    const cases: [Limiting, string][] = [
      [{ kind: 'speedLimit', bytesPerSecond: 2 * MB }, `Your speed limit of ${formatSpeedLimit(2 * MB, 'en')} is the limit`],
      [{ kind: 'noRanges' }, t('limitingNoRanges')],
      [{ kind: 'smallFile' }, t('limitingSmallFile')],
      [{ kind: 'singleConnection', sourceId: 'src1' }, t('limitingSingleConnection', { name: 'Home portal' })],
      [{ kind: 'maxConnections', max: 4 }, t('limitingMaxConnections', { count: 4 })],
      [{ kind: 'playback', sourceId: 'src1' }, t('limitingPlayback', { name: 'Home portal' })],
      [{ kind: 'otherDownloads', sourceId: 'src2' }, t('limitingOtherDownloads', { name: 'Backup portal' })],
      [{ kind: 'refused', sourceId: 'src2' }, t('limitingRefused', { name: 'Backup portal' })],
      [{ kind: 'line', bytesPerSecond: 9 * MB }, 'Your internet connection is the limit'],
      [{ kind: 'perConnection', bytesPerSecond: 6.1 * MB }, 'Provider caps each connection at about 6.1 MB/s'],
      [{ kind: 'accountLimit', sourceId: 'src1', limit: 2 }, t('limitingAccountLimit', { name: 'Home portal', count: 2 })],
    ];
    const seen = new Set<string>();
    for (const [limiting, expected] of cases) {
      const text = limitingText(t, limiting, nameOf, 'en');
      expect(text, limiting.kind).toBe(expected);
      expect(text, limiting.kind).not.toMatch(/limiting|\{\{/);
      seen.add(text);
    }
    expect(seen.size).toBe(cases.length);
    expect(limitingText(t, { kind: 'maxConnections', max: 4 }, nameOf, 'en')).toContain('4');
    expect(limitingText(t, { kind: 'singleConnection', sourceId: 'gone' }, nameOf, 'en')).toContain(t('sourceRemoved'));
  });
});

describe('opening the dialog from the Downloads page', () => {
  const running = makeDownload({ id: 21, status: 'downloading', bytesDownloaded: 10 * MB, totalBytes: 100 * MB, title: 'Arrival', stats: { ...BIG, id: 21 } });

  it('opens from the focused button, closes on Escape and gives focus back', async () => {
    rpc.handlers['downloads.list'] = () => [running];
    renderAt('/downloads', [{ path: '/downloads', element: <DownloadsPage /> }]);
    const button = await screen.findByRole('button', { name: 'Speed details for Arrival' });
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    button.focus();
    expect(document.activeElement).toBe(button);
    // A focused native button activates on Enter or Space as a click.
    fireEvent.click(button);
    const dialog = await screen.findByTestId('download-details');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('download-details')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(button));
  });

  it('is a bottom sheet opened from the row menu at phone width', async () => {
    setPhone(true);
    rpc.handlers['downloads.list'] = () => [running];
    renderAt('/downloads', [{ path: '/downloads', element: <DownloadsPage /> }]);
    await screen.findAllByTestId('download-row');
    expect(screen.queryByRole('button', { name: 'Speed details for Arrival' })).toBeNull();
    const triggers = screen.getAllByRole('button', { name: t('entryMenu', { title: 'Arrival' }) });
    fireEvent.click(triggers.at(-1)!);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Speed details' }));
    const dialog = await screen.findByTestId('download-details');
    // The kit dialog's sheet: fixed to the bottom edge, full width, below sm.
    expect(dialog.className).toContain('max-sm:fixed');
    expect(dialog.className).toContain('max-sm:inset-x-0');
    expect(dialog.className).toContain('max-sm:rounded-b-none');
  });

  it('puts the total-speed sparkline in the header while something downloads', async () => {
    rpc.handlers['downloads.list'] = () => [running];
    progressStore.ingest({ id: 21, bytesDownloaded: 10 * MB, totalBytes: 100 * MB, bytesPerSecond: 2 * MB });
    renderAt('/downloads', [{ path: '/downloads', element: <DownloadsPage /> }]);
    const spark = await within(screen.getByTestId('fake-header')).findByTestId('downloads-sparkline');
    expect(spark.getAttribute('role')).toBe('img');
    expect(spark.getAttribute('aria-label')).toBe(`Total download speed ${formatSpeed(2 * MB, 'en')}`);
  });
});

describe('total-speed sparkline', () => {
  it('sums the live speeds of every running transfer', () => {
    progressStore.ingest({ id: 31, bytesDownloaded: MB, bytesPerSecond: 1.5 * MB });
    progressStore.ingest({ id: 32, bytesDownloaded: MB, bytesPerSecond: 2.5 * MB });
    render(
      <I18nextProvider i18n={i18n}>
        <SpeedSparkline />
      </I18nextProvider>,
    );
    const spark = screen.getByTestId('downloads-sparkline');
    expect(Number(spark.dataset['total'])).toBe(4 * MB);
    expect(screen.getByTestId('downloads-sparkline-total').textContent).toBe(formatSpeed(4 * MB, 'en'));
    expect(spark.getAttribute('aria-label')).toBe(`Total download speed ${formatSpeed(4 * MB, 'en')}`);
    expect(screen.getByTestId('downloads-sparkline-line').getAttribute('d')).toMatch(/^M/);
  });

  it('leaves out stale transfers, keeps about a minute and hides when nothing moved', () => {
    const now = 1_000_000;
    progressStore.ingest({ id: 41, bytesDownloaded: MB, bytesPerSecond: MB }, now - STALE_MS - 1);
    progressStore.ingest({ id: 42, bytesDownloaded: MB, bytesPerSecond: 3 * MB }, now);
    expect(progressStore.totalSpeed(now)).toBe(3 * MB);

    let speed = 0;
    const history = new SpeedHistory(() => speed);
    for (let i = 0; i < 90; i += 1) history.sample(now + i * 1000);
    expect(hasActivity(history.list(now + 89_000))).toBe(false);
    speed = 5 * MB;
    const samples = history.sample(now + 90_000);
    expect(samples.at(-1)!.bytesPerSecond).toBe(5 * MB);
    expect(samples.every((s) => s.at >= now + 30_000)).toBe(true);
    expect(hasActivity(samples)).toBe(true);
  });

  it('renders nothing while no transfer moves', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <SpeedSparkline />
      </I18nextProvider>,
    );
    expect(screen.queryByTestId('downloads-sparkline')).toBeNull();
  });
});
