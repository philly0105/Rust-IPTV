// The /stats page (contract C7): range in the URL and on 7/3, the headline
// and split, the per-day chart (keyboard and table), the top lists with Play
// and Open, Clear stats behind a confirm, and every designed state.
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const rpcMock = vi.hoisted(() => ({ current: null as null | { call: (cmd: string, args?: unknown) => Promise<unknown> } }));
const played = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock('@/api/transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/transport')>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.current!.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.current!.call(cmd, args),
  isDesktop: false,
}));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));
vi.mock('@/features/player/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/player/store')>()),
  playItem: (args: unknown) => {
    played.list.push(args);
    return Promise.resolve();
  },
}));

const h = await import('./harness');
const rpc = h.createRpcMock();
rpcMock.current = rpc;
const { StatsPage } = await import('../pages/StatsPage');
const { RpcError } = await import('@/api/transport');
const { useShellStore } = await import('@/shell/store');
const { localDay } = await import('../reporter');

const NEWS = h.ref('live', '7');
const JAZZ = h.ref('radio', '9');
const GONE = h.ref('live', '8', 'src9');
const FILM = h.ref('movie', '201');
const SHOW = h.ref('series', '55');

const FULL = (count: 7 | 30 = 7) =>
  h.summary(
    count,
    { 0: { live: 3600, vod: 1200 }, 1: { live: 5400 }, 6: { vod: 1800 } },
    {
      channels: [
        h.topItem(NEWS, 'BBC One', 7200, { posterUrl: 'http://img/bbc.png' }),
        h.topItem(JAZZ, 'Jazz FM', 1800),
        h.topItem(GONE, 'Old Channel', 600),
      ],
      titles: [h.topItem(FILM, 'Black Harbor', 1800, { posterUrl: 'http://img/201.jpg' }), h.topItem(SHOW, 'Dark', 1200)],
    },
  );

function open(path = '/stats') {
  return h.renderAt(path, [{ path: '/stats', element: <StatsPage /> }]);
}

async function loaded(data = FULL(), path?: string) {
  rpc.handlers['stats.summary'] = (raw) => {
    const a = raw as { days: 7 | 30 };
    return a.days === 30 && data.days.length === 7 ? FULL(30) : data;
  };
  open(path);
  await screen.findByTestId('stats-total');
}

beforeAll(h.installDomStubs);
beforeEach(() => {
  rpc.reset();
  h.resetShared();
  played.list.length = 0;
  rpc.handlers['sources.list'] = () => h.SOURCES;
});
afterEach(() => {
  cleanup();
});

describe('stats page', () => {
  it('asks for the last 7 local days and sets the header', async () => {
    await loaded();
    expect(rpc.callsOf('stats.summary')[0]).toEqual({ days: 7, today: localDay(), top: 10 });
    expect(useShellStore.getState().header?.title).toBe('Watch stats');
    expect(screen.getByRole('heading', { level: 1, name: 'Watch stats' })).toBeTruthy();
  });

  it('shows the total as a sentence and the live and VOD split', async () => {
    await loaded();
    expect(screen.getByTestId('stats-total').textContent).toBe('3 hr 20 min watched in the last 7 days');
    const split = screen.getByTestId('stats-split');
    expect(within(split).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Live 2 hr 30 min', 'Movies and series 50 min']);
  });

  it('shows a skeleton while loading', () => {
    rpc.handlers['stats.summary'] = () => new Promise(() => undefined);
    open();
    expect(screen.getByRole('status', { name: 'Loading watch stats' })).toBeTruthy();
  });

  it('shows the error with a working retry', async () => {
    let fail = true;
    rpc.handlers['stats.summary'] = () => {
      if (fail) throw new RpcError('db', 'database is locked');
      return FULL();
    };
    open();
    expect(await screen.findByText('Stats are stored on this device.')).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('stats-total')).toBeTruthy();
  });

  it('offers 30 days from an empty week, and Home from an empty month', async () => {
    rpc.handlers['stats.summary'] = (raw) => h.summary((raw as { days: 7 | 30 }).days);
    open();
    expect(await screen.findByText('Nothing watched yet')).toBeTruthy();
    expect(screen.getByText('Nothing played in the last 7 days.')).toBeTruthy();
    fireEvent.click(screen.getByTestId('stats-show-month'));
    await waitFor(() => expect(h.location.current).toBe('/stats?range=30'));
    expect(await screen.findByText('Time spent on live TV, movies and series shows up here.')).toBeTruthy();
    expect(screen.getByTestId('stats-go-home').getAttribute('href')).toBe('/');
    expect(screen.queryByTestId('stats-clear')).toBeNull();
  });

  it('keeps the range in the URL, from the tabs and from 7 and 3', async () => {
    await loaded();
    fireEvent.click(screen.getByRole('tab', { name: '30 days' }));
    await waitFor(() => expect(h.location.current).toBe('/stats?range=30'));
    await waitFor(() => expect(screen.getByTestId('stats-total').textContent).toContain('in the last 30 days'));
    expect(rpc.callsOf('stats.summary').at(-1)).toEqual({ days: 30, today: localDay(), top: 10 });
    expect(screen.getAllByTestId('stats-bars')[0]!.children).toHaveLength(30);

    fireEvent.keyDown(document.body, { key: '7' });
    await waitFor(() => expect(h.location.current).toBe('/stats'));
    expect(await screen.findByText('3 hr 20 min watched in the last 7 days')).toBeTruthy();
    fireEvent.keyDown(document.body, { key: '3' });
    await waitFor(() => expect(h.location.current).toBe('/stats?range=30'));
  });

  it('opens on 30 days from the URL', async () => {
    await loaded(FULL(30), '/stats?range=30');
    expect(rpc.callsOf('stats.summary')[0]).toMatchObject({ days: 30 });
    expect(screen.getByRole('tab', { name: '30 days' }).getAttribute('aria-selected')).toBe('true');
  });

  it('draws one bar per day and moves between days with the keyboard', async () => {
    await loaded();
    const slider = screen.getByRole('slider', { name: 'Watch time per day' });
    expect(slider.children).toHaveLength(7);
    expect(slider.getAttribute('aria-valuenow')).toBe('6');
    expect(slider.getAttribute('aria-valuetext')).toMatch(/: 1 hr 20 min \(1 hr live, 20 min movies and series\)$/);

    slider.focus();
    fireEvent.keyDown(slider, { key: 'ArrowLeft' });
    expect(slider.getAttribute('aria-valuenow')).toBe('5');
    expect(screen.getByTestId('stats-readout').textContent).toMatch(/: 1 hr 30 min \(1 hr 30 min live, 0 min movies and series\)$/);
    fireEvent.keyDown(slider, { key: 'Home' });
    expect(slider.getAttribute('aria-valuenow')).toBe('0');
    expect(screen.getByTestId('stats-readout').textContent).toMatch(/: 30 min \(0 min live, 30 min movies and series\)$/);
    fireEvent.keyDown(slider, { key: 'ArrowLeft' });
    expect(slider.getAttribute('aria-valuenow')).toBe('0');
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(slider.getAttribute('aria-valuetext')).toMatch(/: nothing watched$/);
    fireEvent.keyDown(slider, { key: 'End' });
    expect(slider.getAttribute('aria-valuenow')).toBe('6');

    fireEvent.click(slider.children[2]!);
    expect(slider.getAttribute('aria-valuenow')).toBe('2');
  });

  it('mirrors the arrow keys in RTL', async () => {
    await loaded();
    const slider = screen.getByRole('slider');
    slider.style.direction = 'rtl';
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(slider.getAttribute('aria-valuenow')).toBe('5');
    fireEvent.keyDown(slider, { key: 'ArrowLeft' });
    expect(slider.getAttribute('aria-valuenow')).toBe('6');
  });

  it('has the same numbers in a table the toggle shows', async () => {
    await loaded();
    const toggle = screen.getByTestId('stats-table-toggle');
    const table = screen.getByTestId('stats-table');
    expect(table.parentElement!.className).toContain('sr-only');
    expect(within(table).getAllByRole('row')).toHaveLength(8);
    const today = within(table).getAllByRole('row').at(-1)!;
    expect(within(today).getAllByRole('cell').map((c) => c.textContent)).toEqual(['1 hr', '20 min', '1 hr 20 min']);
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.textContent).toBe('Hide table');
    expect(table.parentElement!.className).not.toContain('sr-only');
  });

  it('lists top channels with Play, and only where the source still exists', async () => {
    await loaded();
    const list = screen.getByTestId('stats-top-channels');
    const rows = within(list).getAllByTestId('stats-channel');
    expect(rows.map((r) => r.querySelector('p')!.textContent)).toEqual(['BBC One', 'Jazz FM', 'Old Channel']);
    expect(rows[0]!.textContent).toContain('2 hr');
    expect(rows[0]!.textContent).toContain('Home portal');
    await waitFor(() => expect(within(list).getAllByTestId('stats-play')).toHaveLength(2));
    expect(within(rows[2]!).queryByTestId('stats-play')).toBeNull();

    fireEvent.click(within(rows[1]!).getByRole('button', { name: 'Play Jazz FM' }));
    expect(played.list).toEqual([{ ref: JAZZ, title: 'Jazz FM', isLive: true, isRadio: true, sourceKind: 'xtream' }]);
    fireEvent.click(within(rows[0]!).getByRole('button', { name: 'Play BBC One' }));
    expect(played.list[1]).toMatchObject({ ref: NEWS, posterUrl: 'http://img/bbc.png', isRadio: false });
  });

  it('lists top titles that open their page', async () => {
    await loaded();
    const list = screen.getByTestId('stats-top-titles');
    const links = within(list).getAllByTestId('stats-open');
    expect(links.map((a) => a.getAttribute('aria-label'))).toEqual(['Open Black Harbor', 'Open Dark']);
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/s/src1/movie/201', '/s/src1/series/55']);
    expect(links[0]!.textContent).toContain('30 min');
  });

  it('says so when one list is empty', async () => {
    await loaded({ ...FULL(), topTitles: [] });
    expect(within(screen.getByTestId('stats-top-titles')).getByText('No movies or series watched in this range.')).toBeTruthy();
    expect(within(screen.getByTestId('stats-top-channels')).getAllByTestId('stats-channel')).toHaveLength(3);
  });

  it('clears stats after a confirm', async () => {
    let cleared = false;
    rpc.handlers['stats.summary'] = () => (cleared ? h.summary(7) : FULL());
    rpc.handlers['stats.clear'] = () => {
      cleared = true;
    };
    open();
    await screen.findByTestId('stats-total');

    fireEvent.click(screen.getByTestId('stats-clear'));
    const dialog = await screen.findByRole('dialog', { name: 'Clear watch stats?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(rpc.callsOf('stats.clear')).toHaveLength(0);

    fireEvent.click(screen.getByTestId('stats-clear'));
    await act(async () => {
      fireEvent.click(await screen.findByTestId('stats-clear-confirm'));
    });
    expect(rpc.callsOf('stats.clear')).toHaveLength(1);
    expect(await screen.findByText('Nothing watched yet')).toBeTruthy();
    expect(h.lastToast()).toMatchObject({ variant: 'success', title: 'Watch stats cleared' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('keeps the dialog and reports a failed clear', async () => {
    rpc.handlers['stats.summary'] = () => FULL();
    rpc.handlers['stats.clear'] = () => {
      throw new RpcError('db', 'disk full');
    };
    open();
    await screen.findByTestId('stats-total');
    fireEvent.click(screen.getByTestId('stats-clear'));
    await act(async () => {
      fireEvent.click(await screen.findByTestId('stats-clear-confirm'));
    });
    await waitFor(() => expect(h.lastToast()).toMatchObject({ variant: 'error', title: "Couldn't clear stats" }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByTestId('stats-total')).toBeTruthy();
  });
});
