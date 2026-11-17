/**
 * UI audit 2026-11-16, Live list lane: the group on search rows, "No guide data" inside a group,
 * provider heading rows, the number column's width, the name's tooltip, the arrows between the
 * group column and the channel list, one Tab stop for the group column, keys acting on the focused
 * row, the region options and the Manage dialog's region filter.
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { queryClient } from '@/api/query';
import type { Category, Channel, EpgNowNext } from '@/api/types';

import { CategorySidebar } from '../components/CategorySidebar';
import { ChannelList, resetChannelListMemory } from '../components/ChannelList';
import { ManageCategoriesDialog } from '../components/ManageCategoriesDialog';
import { QualityFilterButton } from '../components/QualityFilterButton';
import type { PagedChannels } from '../hooks/usePagedChannels';
import { i18n, installDomStubs, makeChannel, settings } from './harness';

const rpcMock = vi.hoisted(() => {
  const handlers: Record<string, (args: unknown) => unknown> = {};
  return { handlers, call: async (cmd: string, args?: unknown) => handlers[cmd]!(args) };
});
vi.mock('@/api/transport', () => ({
  rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  isDesktop: false,
  RpcError: class RpcError extends Error {},
  proxiedUrl: (s: { url: string }) => s.url,
}));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));

beforeAll(() => installDomStubs());
beforeEach(() => {
  rpcMock.handlers['settings.get'] = () => settings();
  resetChannelListMemory();
  queryClient.clear();
  queryClient.setDefaultOptions({ queries: { retry: false, gcTime: 0 } });
});
afterEach(cleanup);

function pagedOf(channels: Channel[], nowNext: (i: number) => EpgNowNext | undefined = () => undefined): PagedChannels {
  return {
    total: channels.length,
    getChannel: (i) => channels[i],
    getNowNext: nowNext,
    isFavorite: () => false,
    setVisibleRange: () => undefined,
    isLoading: false,
    refreshing: false,
    error: null,
    retry: () => undefined,
    loaded: channels.map((channel, index) => ({ index, channel })),
    pageSize: 120,
    guideUnavailable: false,
    retryGuide: () => undefined,
  };
}

function wrap(node: ReactNode) {
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter>{node}</MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

function list(channels: Channel[], extra: Partial<Parameters<typeof ChannelList>[0]> = {}) {
  const onPlay = vi.fn();
  wrap(
    <ChannelList
      paged={pagedOf(channels)}
      resetKey="k"
      openOnDoubleClick={false}
      now={Date.now()}
      onPlay={onPlay}
      onToggleFavorite={() => undefined}
      onContextMenu={() => undefined}
      {...extra}
    />,
  );
  return onPlay;
}

const row = (i: number) => document.querySelector<HTMLButtonElement>(`button[data-row-index="${i}"]`);
const airing = (title: string): EpgNowNext => ({
  now: { channelId: 'c', title, start: new Date(Date.now() - 600_000).toISOString(), end: new Date(Date.now() + 600_000).toISOString() },
});

describe('the second line of a row', () => {
  it('names the group once over each run of a search across groups, and to screen readers on each row (live-02, v-live-02)', () => {
    const channels = [
      { ...makeChannel(0), name: 'US| ESPN HD', categoryName: 'US| PRIME ᴿᴬᵂ' },
      { ...makeChannel(1), name: 'ESPN2 HD', categoryName: 'US| PRIME ᴿᴬᵂ' },
      { ...makeChannel(2), name: 'ESPNU', categoryName: 'Sports' },
    ];
    list(channels, { showGroup: true, paged: pagedOf(channels, (i) => (i < 2 ? airing('SportsCenter') : undefined)) });
    expect(screen.getAllByTestId('group-caption').map((c) => c.textContent)).toEqual(['US| PRIME ᴿᴬᵂ', 'Sports']);
    // The programme has the line to itself; a row without one says so instead of naming its group again.
    expect(screen.queryByTestId('row-group')).toBeNull();
    expect(screen.getAllByTestId('row-now-title')[0]!.textContent).toBe('SportsCenter');
    expect(within(row(2)!).getByTestId('row-no-guide')).toBeTruthy();
    // Read as drawn: the place after the name (v-live-12).
    expect(row(0)!.getAttribute('aria-label')).toBe('1, ESPN HD (US), PRIME ᴿᴬᵂ (US), now: SportsCenter');
  });

  it('in a gap in the guide says what comes next instead of the group (v-live-06)', () => {
    const later = new Date(Date.now() + 45 * 60_000);
    const next: EpgNowNext = { next: { channelId: 'c', title: 'NFL Football Pregame', start: later.toISOString(), end: new Date(later.getTime() + 3_600_000).toISOString() } };
    const channels = [makeChannel(0)];
    list(channels, { paged: pagedOf(channels, () => next) });
    const line = screen.getByTestId('row-next');
    expect(line.textContent).toContain('Up next');
    expect(line.textContent).toContain('NFL Football Pregame');
    expect(within(row(0)!).queryByText('News')).toBeNull();
  });

  it('leaves the group out when the list is not a search across groups', () => {
    const channels = [makeChannel(0)];
    list(channels, { paged: pagedOf(channels, () => airing('SportsCenter')) });
    expect(screen.queryByTestId('row-group')).toBeNull();
  });

  it('says there is no guide inside its own group instead of repeating the group (live-08)', () => {
    list([makeChannel(0), { ...makeChannel(1), categoryId: 'other', categoryName: 'Sports' }], { groupId: 'g1' });
    expect(within(row(0)!).getByTestId('row-no-guide').textContent).toBe('No guide data');
    expect(within(row(0)!).queryByText('News')).toBeNull();
    // A row from another group (a pinned view, a search) still names its group.
    expect(within(row(1)!).getByText('Sports')).toBeTruthy();
  });

  it('keeps the provider name as the tooltip of a name the column may cut (live-06)', () => {
    list([{ ...makeChannel(0), name: "ESPN+ 0123: NCAA Women's Volleyball - Kentucky vs Florida" }]);
    expect(row(0)!.querySelector('[title^="ESPN+ 0123"]')).toBeTruthy();
  });

  it('drops the heart mark in the Favorites view, where every row is one (live-16)', () => {
    const channels = [makeChannel(0)];
    const paged = { ...pagedOf(channels), isFavorite: () => true };
    list(channels, { paged, hideFavoriteMark: true });
    expect(screen.queryByTestId('row-favorite')).toBeNull();
  });
});

describe('provider heading rows (live-04)', () => {
  const channels = [makeChannel(0), { ...makeChannel(1), name: '#### PRIME ᴿᴬᵂ ⁶⁰ᶠᵖˢ #####' }, makeChannel(2)];

  it('draws a heading, not a playable row, and the arrows pass over it', () => {
    const onPlay = list(channels);
    const heading = screen.getByTestId('row-separator');
    expect(heading.textContent).toBe('PRIME ᴿᴬᵂ ⁶⁰ᶠᵖˢ');
    expect(row(1)).toBeNull();
    row(0)!.focus();
    fireEvent.keyDown(row(0)!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(row(2));
    fireEvent.keyDown(row(2)!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(row(0));
    fireEvent.click(heading);
    expect(onPlay).not.toHaveBeenCalled();
  });

  it('moves a cursor that opens on a heading to the next channel', async () => {
    list([{ ...makeChannel(0), name: '===== NFL =====' }, makeChannel(1)]);
    await waitFor(() => expect(row(1)!.tabIndex).toBe(0));
  });
});

describe('the number column (live-05)', () => {
  it('is as wide as the longest number the list holds', () => {
    list([{ ...makeChannel(0), number: 57012 }, makeChannel(1)]);
    expect(screen.getByTestId('channel-list').style.getPropertyValue('--num-w')).toBe('5ch');
  });

  it("starts as wide as the list's count, before the high numbers load (v-live-09)", () => {
    const channels = [makeChannel(0), makeChannel(1)];
    list(channels, { paged: { ...pagedOf(channels), total: 30132 } });
    expect(screen.getByTestId('channel-list').style.getPropertyValue('--num-w')).toBe('5ch');
  });

  it('keeps its 26 px for numbers up to three digits', () => {
    list([makeChannel(0), { ...makeChannel(1), number: 999 }]);
    expect(screen.getByTestId('channel-list').style.getPropertyValue('--num-w')).toBe('');
  });
});

describe('keys act on the row that has focus (a11y-keyboard-08)', () => {
  it('plays the focused row, not the list cursor, on Enter', () => {
    const onPlay = list([makeChannel(0), makeChannel(1), makeChannel(2)]);
    // Focus put on a row by something other than the list (a screen reader, the scroll memory).
    row(2)!.focus();
    fireEvent.keyDown(row(2)!, { key: 'Enter' });
    expect((onPlay.mock.calls[0]![0] as Channel).name).toBe('Channel 2');
  });
});

const groups: Category[] = [
  { id: 'g1', name: 'UK| NEWS', itemCount: 3 },
  { id: 'g2', name: 'UK| SPORTS', itemCount: 4 },
  { id: 'g3', name: 'US| NEWS', itemCount: 5 },
  { id: 'g4', name: 'US| SPORTS', itemCount: 6 },
] as Category[];

function sidebar(activeId?: string, inDrawer?: boolean) {
  return (
    <CategorySidebar
      inDrawer={inDrawer}
      categories={groups}
      hiddenCount={0}
      isLoading={false}
      error={null}
      onRetry={() => undefined}
      activeId={activeId}
      hrefFor={(id) => `/s/src1/live${id ? `/${id}` : ''}`}
      onManage={() => undefined}
      totalLabel="All channels"
      pinned={[
        { id: '@favorites', label: 'Favorites', icon: null },
        { id: '@recent', label: 'Recently watched', icon: null },
      ]}
      regionScope="src1:live"
    />
  );
}

describe('the group column', () => {
  it('is one Tab stop, on the open link, across the pinned views, All channels and the groups (a11y-keyboard-04)', () => {
    wrap(sidebar());
    const stops = [...document.querySelectorAll<HTMLElement>('[data-cat-index]')].filter((el) => el.tabIndex === 0);
    expect(stops.map((el) => el.dataset.catIndex)).toEqual(['all']);
    cleanup();
    wrap(sidebar('@recent'));
    const open = [...document.querySelectorAll<HTMLElement>('[data-cat-index]')].filter((el) => el.tabIndex === 0);
    expect(open.map((el) => el.dataset.catIndex)).toEqual(['pin-1']);
  });

  it('keeps the groups scroller out of the Tab order, so it is no unnamed stop (w-a11y-01)', () => {
    wrap(sidebar());
    expect(screen.getByTestId('group-list').getAttribute('tabindex')).toBe('-1');
  });

  it('names its region options by groups, and is as tall as the button beside it (live-15, live-03)', () => {
    wrap(sidebar());
    const select = screen.getByTestId('group-region') as HTMLSelectElement;
    // Closed in the column's narrow header, "All" (v-themes-locales-08).
    expect([...select.options].map((o) => o.text)).toEqual(['All', 'UK · United Kingdom · 2 groups', 'US · United States · 2 groups']);
    expect(select.className).toContain('h-8');
    expect(select.className).not.toContain('text-xs');
  });

  it('in the drawer says "Groups" once, for screen readers, and gives the region select the row in full words (v-phone-01, v-phone-12)', () => {
    wrap(sidebar(undefined, true));
    expect(screen.getByRole('heading', { name: 'Groups' }).className).toBe('sr-only');
    const select = screen.getByTestId('group-region') as HTMLSelectElement;
    expect(select.options[0]!.text).toBe('All regions');
    expect(select.className).toContain('flex-1');
    expect(select.className).not.toContain('max-w-28');
  });
});

describe('arrows between the group column and the channel list (a11y-keyboard-02)', () => {
  it('Right from a group goes to the list cursor, Left from a row back to the group column', async () => {
    wrap(
      <>
        {sidebar('g2')}
        <ChannelList
          paged={pagedOf([makeChannel(0), makeChannel(1)])}
          resetKey="k"
          openOnDoubleClick={false}
          now={Date.now()}
          onPlay={() => undefined}
          onToggleFavorite={() => undefined}
          onContextMenu={() => undefined}
        />
      </>,
    );
    const group = await screen.findByRole('link', { name: /UK\| SPORTS/ });
    group.focus();
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(row(0));
    fireEvent.keyDown(row(0)!, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(group);
  });
});

describe('Manage visible groups (live-10)', () => {
  it('filters by region, and its bulk buttons say they act on the rows shown', async () => {
    rpcMock.handlers['catalog.categories'] = () => groups;
    wrap(<ManageCategoriesDialog open onClose={() => undefined} sourceId="src1" contentType="live" />);
    const region = (await screen.findByTestId('manage-groups-region')) as HTMLSelectElement;
    expect(screen.getByRole('button', { name: 'Show all' })).toBeTruthy();
    await act(async () => {
      fireEvent.change(region, { target: { value: 'US' } });
    });
    expect(screen.getByRole('button', { name: 'Show these' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Hide these' }));
    expect(screen.getByText('2 of 4 groups visible')).toBeTruthy();
  });
});

describe('the quality filter button (live-09)', () => {
  it('is a quiet icon at rest and names the floor once one is set', () => {
    const { rerender } = wrap(<QualityFilterButton min={null} hideUntagged={false} onChange={() => undefined} />);
    const button = screen.getByTestId('live-quality-filter');
    expect(button.textContent).toBe('Channel quality, Any quality');
    expect(button.className).not.toContain('border-border');
    rerender(
      <QueryClientProvider client={queryClient}>
        <I18nextProvider i18n={i18n}>
          <MemoryRouter>
            <QualityFilterButton min="fhd" hideUntagged={false} onChange={() => undefined} />
          </MemoryRouter>
        </I18nextProvider>
      </QueryClientProvider>,
    );
    expect(screen.getByTestId('live-quality-filter').textContent).toContain('1080p+');
    expect(screen.getByTestId('live-quality-filter').className).toContain('bg-fg');
  });
});
