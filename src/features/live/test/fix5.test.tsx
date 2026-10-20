import { cleanup, fireEvent, screen, waitFor, within, configure } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Channel, EpgProgram, ItemRef, Page, PageQuery, Settings } from '@/api/types';

import { EpgGridPage } from '../components/EpgGridPage';
import { LivePage } from '../components/LivePage';
import { HOUR, MINUTE, ms } from '../lib/epgTime';
import { playChannel, resolveChannelSource } from '../lib/playback';
import { StalkerPreviewQueue, isTransientEpgError } from '../lib/stalkerPreviewQueue';
import { installDomStubs, makeChannel, program, renderAt, settings } from './harness';

// Under CPU load (a cargo build alongside) the 1 s findBy/waitFor default and the 5 s test default
// time out before the mocked queries settle; these waits only ever succeed, so give them room.
configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

// Fix wave 5: EPG offset in epg.nowNext, per-channel headers and display names for playback,
// and a silent Stalker portal (stalker.epg timeout) as a recoverable state.

const rpcMock = vi.hoisted(() => {
  const handlers: Record<string, (args: unknown) => unknown> = {};
  const calls: { cmd: string; args: unknown }[] = [];
  const call = async (cmd: string, args?: unknown) => {
    calls.push({ cmd, args });
    const h = handlers[cmd];
    if (!h) throw new Error(`unmocked rpc ${cmd}`);
    return h(args);
  };
  return { handlers, calls, call };
});

vi.mock('@/api/transport', () => ({
  rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  isDesktop: false,
  RpcError: class RpcError extends Error {},
  proxiedUrl: (s: { url: string }) => s.url,
}));
vi.mock('@/api/events', () => ({
  onAppEvent: () => () => undefined,
  onAnyAppEvent: () => () => undefined,
}));
vi.mock('@/ui', async (orig) => ({ ...(await orig<object>()), ...(await import('./fakes')) }));
vi.mock('@/shell', async () => await import('./fakes'));
vi.mock('@/features/player', async () => await import('./fakes'));
vi.mock('@/features/player/remote', async () => await import('./fakes'));

const fakes = await import('./fakes');

const TOTAL = 40;

/** A silent portal as the transport reports it: a retryable timeout. */
function portalTimeout(): Error {
  return Object.assign(new Error('The portal did not answer within 20 s.'), { code: 'timeout', retryable: true });
}

function handlers(kind: 'stalker' | 'xtream' | 'm3u', s: Partial<Settings> = {}, name = (i: number) => `Channel ${i}`) {
  const h = rpcMock.handlers;
  for (const k of Object.keys(h)) delete h[k];
  rpcMock.calls.length = 0;
  const src = { id: 'src1', kind, name: 'Demo', epg: { detectedUrls: [], manualUrls: [], disabledUrls: [] } };
  h['sources.get'] = () => src;
  h['sources.list'] = () => [src];
  h['settings.get'] = () => settings(s);
  h['settings.update'] = () => settings(s);
  h['catalog.categories'] = () => [{ id: 'g1', sourceId: 'src1', contentType: 'live', name: 'News', hidden: false, itemCount: TOTAL, position: 0 }];
  const channel = (i: number): Channel => ({ ...makeChannel(i), name: name(i), archive: undefined });
  h['catalog.channels'] = (a) => {
    const q = (a as { query: PageQuery }).query;
    const items = Array.from({ length: Math.max(0, Math.min(q.limit, TOTAL - q.offset)) }, (_, i) => channel(q.offset + i));
    return { items, total: TOTAL, offset: q.offset, limit: q.limit } satisfies Page<Channel>;
  };
  h['catalog.item'] = (a) => channel(Number((a as { ref: ItemRef }).ref.itemId.slice(1)));
  h['epg.nowNext'] = () => ({});
  h['epg.programs'] = () => [];
  h['epg.grid'] = () => ({});
  h['favorites.contains'] = () => [];
  h['remote.status'] = () => ({ running: false, port: 7310 });
}

const callsOf = (cmd: string) => rpcMock.calls.filter((c) => c.cmd === cmd);

beforeAll(installDomStubs);
beforeEach(() => {
  handlers('xtream');
  fakes.usePlayerStore.setState({ source: undefined, zapContext: undefined });
  fakes.recorded.playItem.length = 0;
  fakes.recorded.playSource.length = 0;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('EPG offset: the row and the ribbon agree on what is airing', () => {
  /** The raw guide (as published) for every channel: three two-hour programmes around now. */
  function rawGuide(now: number): EpgProgram[] {
    return [
      program('Earlier show', now - 3 * HOUR, now - HOUR),
      program('Current show', now - HOUR, now + HOUR),
      program('Later show', now + HOUR, now + 3 * HOUR),
    ];
  }

  it('asks epg.nowNext on the shifted clock under +120 and shows the same programme as the ribbon', async () => {
    handlers('xtream', { epgOffsetMinutes: 120 });
    const now = Date.now();
    const guide = rawGuide(now);
    // The core's rule: "now" is the programme airing at `now - offset`; times come back unshifted.
    rpcMock.handlers['epg.nowNext'] = (a) => {
      const { refs, offsetMinutes = 0 } = a as { refs: ItemRef[]; offsetMinutes?: number };
      const at = now - offsetMinutes * MINUTE;
      const i = guide.findIndex((p) => ms(p.start) <= at && at < ms(p.end));
      const nn = i >= 0 ? { now: guide[i], next: guide[i + 1] } : {};
      return Object.fromEntries(refs.map((r) => [`${r.sourceId}|${r.contentType}|${r.itemId}`, nn]));
    };
    rpcMock.handlers['epg.programs'] = () => guide;

    renderAt('/s/src1/live', [{ path: '/s/:sourceId/live', element: <LivePage /> }]);
    const row = await screen.findByRole('button', { name: /^1, Channel 0, now: / });
    expect(row.getAttribute('aria-label')).toContain('now: Earlier show');
    expect(callsOf('epg.nowNext').some((c) => (c.args as { offsetMinutes?: number }).offsetMinutes === 120)).toBe(true);

    // The ribbon (shifts the list, then picks now) shows the same programme as airing.
    const ribbon = await screen.findByTestId('epg-ribbon');
    expect(await within(ribbon).findByRole('button', { name: /^Earlier show,.*on now/ })).toBeTruthy();
    // Shifted by +2 h, "Earlier show" ends an hour from now: the row counts down to that.
    expect(within(row.parentElement!).getByText('60m')).toBeTruthy();
  });

  it('sends no offset when the setting is 0', async () => {
    renderAt('/s/src1/live', [{ path: '/s/:sourceId/live', element: <LivePage /> }]);
    await screen.findByText('Channel 0');
    await waitFor(() => expect(callsOf('epg.nowNext').length).toBeGreaterThan(0));
    expect(callsOf('epg.nowNext').every((c) => !('offsetMinutes' in (c.args as object)))).toBe(true);
  });
});

describe('playback helpers', () => {
  const m3uSource = { kind: 'm3u' as const, m3u: { origin: 'url' as const, url: 'http://x/list.m3u', headers: { userAgent: 'List/1', referrer: 'http://list/' } } };

  it('merges per-channel #EXTVLCOPT headers over the playlist headers for external players', async () => {
    const ch: Channel = { ...makeChannel(11), url: 'http://x/espn.m3u8', headers: { userAgent: 'IPTVMockAgent/1.0' } };
    const s = await resolveChannelSource(ch, m3uSource);
    expect(s.headers).toEqual({ userAgent: 'IPTVMockAgent/1.0', referrer: 'http://list/' });
    expect(s.kind).toBe('hls');
  });

  it('takes the headers from catalog.item when the row has no url', async () => {
    rpcMock.handlers['catalog.item'] = () => ({ ...makeChannel(11), url: 'http://x/espn.ts', headers: { referrer: 'http://referer.mock/' } });
    const s = await resolveChannelSource(makeChannel(11), { kind: 'm3u', m3u: { origin: 'url', url: 'http://x', headers: {} } });
    expect(s.headers).toEqual({ referrer: 'http://referer.mock/' });
  });

  it('leaves headers out when neither level sets any', async () => {
    const s = await resolveChannelSource({ ...makeChannel(1), url: 'http://x/a.ts' }, { kind: 'm3u', m3u: { origin: 'text', headers: {} } });
    expect(s.headers).toBeUndefined();
  });

  it('titles the player with the display name', async () => {
    const ch: Channel = { ...makeChannel(6), name: 'UK | Gamma One', url: 'http://x/g.ts' };
    expect((await resolveChannelSource(ch, m3uSource, 'Gamma One')).title).toBe('Gamma One');
    expect((await resolveChannelSource(ch, m3uSource)).title).toBe('UK | Gamma One');
    await playChannel(ch, 'm3u', 'News at Six', 'Gamma One');
    expect(fakes.recorded.playItem[0]).toMatchObject({ title: 'Gamma One', subtitle: 'News at Six' });
  });

  it('LivePage plays a prefixed channel under its stripped name when the setting is on', async () => {
    handlers('m3u', { stripCountryPrefix: true }, (i) => `UK | Channel ${i}`);
    renderAt('/s/src1/live', [{ path: '/s/:sourceId/live', element: <LivePage /> }]);
    const row = await screen.findByRole('button', { name: /^1, Channel 0/ });
    fireEvent.click(row);
    await waitFor(() => expect(fakes.recorded.playItem.length).toBe(1));
    expect(fakes.recorded.playItem[0]?.title).toBe('Channel 0');
  });
});

describe('StalkerPreviewQueue on a silent portal', () => {
  const ref = (i: number): ItemRef => ({ sourceId: 's', contentType: 'live', itemId: `c${i}` });

  it('classifies timeout and network errors as transient', () => {
    expect(isTransientEpgError(portalTimeout())).toBe(true);
    expect(isTransientEpgError({ code: 'network' })).toBe(true);
    expect(isTransientEpgError(new Error('bad channel'))).toBe(false);
    expect(isTransientEpgError(undefined)).toBe(false);
  });

  it('backs the whole source off with a doubling pause, and recovers on an answer', async () => {
    vi.useFakeTimers();
    let clock = 1_000_000;
    let failing = true;
    const fetch = vi.fn(async () => {
      if (failing) throw portalTimeout();
      return [program('Back', clock - MINUTE, clock + HOUR)];
    });
    const q = new StalkerPreviewQueue(fetch, () => undefined, { delayMs: 0, concurrency: 1, clock: () => clock, backoffMs: 30_000, maxBackoffMs: 120_000 });
    const refs = [ref(0), ref(1), ref(2), ref(3)];
    q.sync(refs);
    await vi.advanceTimersByTimeAsync(0);
    // One timeout stops the queue: the other rows are not asked.
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(q.unavailable).toBe(true);
    expect(q.retryAt).toBe(clock + 30_000);

    // Re-renders (now ticks, scrolling) during the pause ask nothing.
    q.sync(refs);
    q.sync([ref(5)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);

    // The pause ends: the last wanted set is asked again; another timeout doubles the pause.
    clock += 30_000;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(q.retryAt).toBe(clock + 60_000);

    // A manual retry ends the pause at once; the portal answers and the outage clears.
    failing = false;
    q.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(q.unavailable).toBe(false);
    expect(q.get(ref(5))?.[0]?.title).toBe('Back');
    q.destroy();
  });

  it('a per-row error does not pause the source', async () => {
    const fetch = vi.fn(async (r: ItemRef) => {
      if (r.itemId === 'c0') throw new Error('no such channel');
      return [];
    });
    const q = new StalkerPreviewQueue(fetch, () => undefined, { delayMs: 0, concurrency: 1 });
    q.sync([ref(0), ref(1)]);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(q.unavailable).toBe(false);
    q.destroy();
  });
});

describe('Stalker guide timeouts in the views', () => {
  function silentPortal() {
    handlers('stalker');
    rpcMock.handlers['stalker.epg'] = () => {
      throw portalTimeout();
    };
  }

  it('channel rows say the guide is not answering, with one retry and no request storm', async () => {
    silentPortal();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      renderAt('/s/src1/live', [{ path: '/s/:sourceId/live', element: <LivePage /> }]);
      const notice = await screen.findByTestId('guide-unavailable');
      expect(notice.textContent).toContain("The portal's guide isn't answering");
      await waitFor(() => expect(screen.getAllByTestId('row-guide-unavailable').length).toBeGreaterThan(0));
      const rowCalls = () => callsOf('stalker.epg').filter((c) => (c.args as { limit: number }).limit === 3).length;
      // At most the requests already in flight when the first timed out (two workers).
      expect(rowCalls()).toBeLessThanOrEqual(2);

      // Try again asks once more; the portal answers and the rows fill in.
      const now = Date.now();
      rpcMock.handlers['stalker.epg'] = (a) => [program(`Portal ${(a as { ref: ItemRef }).ref.itemId}`, now - 10 * MINUTE, now + 20 * MINUTE)];
      fireEvent.click(within(notice).getByRole('button', { name: 'Try again' }));
      await waitFor(() => expect(screen.getAllByText('Portal c0').length).toBeGreaterThan(0));
      await waitFor(() => expect(screen.queryByTestId('guide-unavailable')).toBeNull());
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('the ribbon shows the timeout with a retry button instead of loading forever', async () => {
    silentPortal();
    renderAt('/s/src1/live', [{ path: '/s/:sourceId/live', element: <LivePage /> }]);
    const ribbon = await screen.findByTestId('epg-ribbon');
    expect(await within(ribbon).findByText(/did not answer within 20 s/)).toBeTruthy();
    expect(within(ribbon).getByRole('button', { name: /try again|retry/i })).toBeTruthy();
  });

  it('the /epg grid shows the same notice', async () => {
    silentPortal();
    renderAt('/epg?source=src1', [{ path: '/epg', element: <EpgGridPage /> }]);
    const notice = await screen.findByTestId('guide-unavailable');
    expect(within(notice).getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

describe('R6 round 2: layout fixes', () => {
  it('the /epg window fills wide screens in whole slots and never drops below 6 h', async () => {
    const { gridWindowFor, stalkerGridLimit, stalkerArchiveQuery, GRID_WINDOW } = await import('../components/EpgGridPage');
    expect(gridWindowFor(0, 220)).toBe(GRID_WINDOW);
    expect(gridWindowFor(1366 - 64, 220)).toBe(GRID_WINDOW); // 1082 px of track: 6 h already overflows
    // 2560 px page: 2340 px of track = 15.6 slots -> 16 slots = 8 h, no gap at the right edge.
    const wide = gridWindowFor(2560, 220);
    expect(wide).toBe(8 * HOUR);
    expect((wide / MINUTE) * (150 / 30)).toBeGreaterThanOrEqual(2560 - 220);
    expect(stalkerGridLimit(GRID_WINDOW)).toBe(12);
    expect(stalkerGridLimit(wide)).toBe(16);
    const now = Date.now();
    expect(stalkerArchiveQuery(now - HOUR, now - HOUR + wide, now, 16)).toEqual({ from: now - HOUR, limit: 16 });
  });

  it('the ribbon live button keeps its name when the label is hidden on narrow panes', async () => {
    renderAt('/s/src1/live', [{ path: '/s/:sourceId/live', element: <LivePage /> }]);
    const btn = await screen.findByTestId('ribbon-back-to-live');
    // The name starts with the label's words (and names the channel it starts).
    expect(btn.getAttribute('aria-label')).toMatch(/^Watch live, /);
    expect(btn.querySelector('span.hidden')?.textContent).toBe('Watch live');
  });

  it('live components use logical, not physical, direction classes', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = path.resolve(__dirname, '../components');
    const physical = /(?<![\w:-])(?:text-(?:left|right)|border-[lr](?:-\S+)?|[mp][lr]-\S+|-?(?:left|right)-\S+|rounded-[lr](?:-(?!g\b)\S+)?)(?=["'\s`])/g;
    const hits: string[] = [];
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.tsx'))) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      for (const m of src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
        const cls = ` ${m[1] ?? m[2] ?? ''} `;
        for (const h of cls.matchAll(physical)) hits.push(`${f}: ${h[0]}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
