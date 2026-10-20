/**
 * Guide search (Run 2 C5): the field and its results panel. One debounced `epg.search` per
 * pause in typing, for the selected source and from now to 14 days ahead in raw guide time;
 * the hint, loading, error, empty and "guide not loaded" states; hits grouped by day in display
 * time (EPG offset applied); select, Watch on an airing hit, the keyboard and Escape.
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EpgSourceStatus, GuideSearchHit } from '@/api/types';

import { DAY, HOUR, MINUTE } from '../../lib/epgTime';
import { GuideSearch, GuideSearchPanel, SEARCH_DEBOUNCE_MS } from '../GuideSearchPanel';
import { SEARCH_LIMIT } from '../search';
import { createRpcMock, hit, i18n, installDomStubs, renderGuide, settings } from './harness';

const rpcMock = vi.hoisted(() => ({ current: null as null | ReturnType<typeof import('./harness')['createRpcMock']> }));
vi.mock('@/api/transport', async (orig) => ({
  ...(await orig<object>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.current!.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.current!.call(cmd, args),
  isDesktop: true,
}));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));
vi.mock('@/shell', async () => await import('../../test/fakes'));
vi.mock('@/features/player', async () => await import('../../test/fakes'));
vi.mock('@/features/player/remote', async () => await import('../../test/fakes'));

rpcMock.current = createRpcMock();
const rpc = rpcMock.current;

const ORIGINAL_TZ = process.env.TZ;
// Wed 14 Oct 2026, 10:02 local (UTC here): hits today, tomorrow and next week.
let NOW = 0;
beforeAll(() => {
  process.env.TZ = 'UTC';
  installDomStubs();
  NOW = Date.UTC(2026, 9, 14, 10, 2);
});
afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

const guideLoaded: EpgSourceStatus[] = [{ url: 'http://x/epg.xml', status: 'ok', programCount: 1200, channelCount: 40, enabled: true, origin: 'settings' }];

beforeEach(() => {
  rpc.reset();
  rpc.handlers['epg.sources'] = () => guideLoaded;
  rpc.handlers['epg.search'] = () => [];
  rpc.handlers['reminders.list'] = () => [];
  rpc.handlers['recordings.list'] = () => [];
  rpc.handlers['recordings.rules'] = () => [];
  rpc.handlers['recordings.capabilities'] = () => ({ supported: true });
  rpc.handlers['settings.get'] = () => settings();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const HITS: GuideSearchHit[] = [
  hit('Evening News', NOW_PLUS(-12 * MINUTE), NOW_PLUS(18 * MINUTE), { channelName: 'Alpha', channelNumber: 1, ref: { sourceId: 'src1', contentType: 'live', itemId: 'a' } }),
  hit('Evening News', NOW_PLUS(8 * HOUR - 2 * MINUTE), NOW_PLUS(9 * HOUR - 2 * MINUTE), { channelName: 'Beta', channelNumber: 2, ref: { sourceId: 'src1', contentType: 'live', itemId: 'b' } }),
  hit('Evening News Late', NOW_PLUS(DAY + 10 * HOUR), NOW_PLUS(DAY + 11 * HOUR), { channelName: 'Alpha', channelNumber: 1, ref: { sourceId: 'src1', contentType: 'live', itemId: 'a' } }),
  hit('Weekend News', NOW_PLUS(5 * DAY), NOW_PLUS(5 * DAY + HOUR), { channelName: 'Gamma', ref: { sourceId: 'src1', contentType: 'live', itemId: 'g' } }),
];
// Built lazily: NOW is set in beforeAll, after this module's top level ran.
function NOW_PLUS(delta: number) {
  return Date.UTC(2026, 9, 14, 10, 2) + delta;
}

function panel(props: Partial<Parameters<typeof GuideSearchPanel>[0]> = {}) {
  const onSelect = vi.fn();
  const onWatch = vi.fn();
  const onClose = vi.fn();
  renderGuide(
    <GuideSearchPanel query="news" sourceId="src1" offsetMinutes={0} now={NOW} onSelect={onSelect} onWatch={onWatch} onClose={onClose} {...props} />,
  );
  return { onSelect, onWatch, onClose, el: () => screen.getByTestId('guide-search-panel') };
}
const state = () => screen.getByTestId('guide-search-panel').getAttribute('data-state');

describe('GuideSearchPanel states', () => {
  it('asks for two characters before searching', async () => {
    panel({ query: 'n' });
    expect(state()).toBe('hint');
    expect(screen.getByText('Type at least 2 characters.')).toBeTruthy();
    await new Promise((r) => setTimeout(r, SEARCH_DEBOUNCE_MS + 50));
    expect(rpc.of('epg.search')).toEqual([]);
  });

  it('shows a skeleton while the search runs', async () => {
    rpc.handlers['epg.search'] = () => new Promise(() => undefined);
    panel();
    expect(state()).toBe('loading');
    await waitFor(() => expect(rpc.of('epg.search')).toHaveLength(1));
    expect(state()).toBe('loading');
    expect(screen.getByTestId('guide-search-panel').getAttribute('aria-busy')).toBe('true');
  });

  it('shows the error with Retry, and Retry searches again', async () => {
    let fail = true;
    rpc.handlers['epg.search'] = () => {
      if (fail) throw new Error('The guide store is busy');
      return HITS;
    };
    panel();
    await waitFor(() => expect(state()).toBe('error'));
    expect(screen.getByText(/The guide store is busy/)).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: /try again|retry/i }));
    await waitFor(() => expect(state()).toBe('results'));
    expect(rpc.of('epg.search')).toHaveLength(2);
  });

  it('says when nothing matches', async () => {
    panel({ query: '  zzz  ' });
    await waitFor(() => expect(state()).toBe('empty'));
    expect(screen.getByText('Nothing matches “zzz”')).toBeTruthy();
    expect(screen.getByText('Searches titles for the next 14 days.')).toBeTruthy();
  });

  it('without a loaded guide it says so, links to the guide settings and does not search', async () => {
    rpc.handlers['epg.sources'] = () => [{ ...guideLoaded[0]!, programCount: 0 }];
    panel();
    await waitFor(() => expect(state()).toBe('noGuide'));
    expect(screen.getByText('No guide loaded')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Guide settings' }).getAttribute('href')).toBe('/settings/epg');
    await new Promise((r) => setTimeout(r, SEARCH_DEBOUNCE_MS + 50));
    expect(rpc.of('epg.search')).toEqual([]);
  });

  it('a disabled guide does not count as loaded', async () => {
    rpc.handlers['epg.sources'] = () => [{ ...guideLoaded[0]!, enabled: false }];
    panel();
    await waitFor(() => expect(state()).toBe('noGuide'));
  });
});

describe('GuideSearchPanel results', () => {
  it('sends the selected source, the trimmed query and a 14-day raw-time window', async () => {
    rpc.handlers['epg.search'] = () => HITS;
    panel({ query: ' news ', offsetMinutes: 60 });
    await waitFor(() => expect(state()).toBe('results'));
    const args = rpc.of('epg.search')[0] as { sourceId: string; query: string; from: string; to: string; limit: number };
    expect(args.sourceId).toBe('src1');
    expect(args.query).toBe('news');
    expect(args.limit).toBe(SEARCH_LIMIT);
    // From what airs now (10:00, floored to 5 minutes) moved back by the 60-minute offset.
    expect(args.from).toBe('2026-10-14T09:00:00.000Z');
    expect(Date.parse(args.to) - Date.parse(args.from)).toBe(14 * DAY);
  });

  it('groups hits by day with channel, time and title, in display time', async () => {
    rpc.handlers['epg.search'] = () => HITS;
    panel({ offsetMinutes: 60 });
    await waitFor(() => expect(state()).toBe('results'));
    const days = screen.getAllByTestId('guide-search-day').map((h) => h.textContent);
    expect(days).toHaveLength(3);
    expect(days[0]).toMatch(/^Today, /);
    expect(days[1]).toMatch(/^Tomorrow, /);
    expect(days[2]).not.toMatch(/Today|Tomorrow/);
    const rows = screen.getAllByTestId('guide-search-hit');
    expect(rows).toHaveLength(4);
    // 18:00 raw + 60 min offset = 19:00 on screen.
    expect(within(rows[1]!).getByText('Beta')).toBeTruthy();
    expect(within(rows[1]!).getByText('Evening News')).toBeTruthy();
    expect(rows[1]!.textContent).toMatch(/7:00\s?PM|19:00/);
    expect(screen.getByTestId('guide-search-count').textContent).toBe('4 results');
  });

  it('Watch is offered only while a hit airs', async () => {
    rpc.handlers['epg.search'] = () => HITS;
    const { onWatch } = panel();
    await waitFor(() => expect(state()).toBe('results'));
    const rows = screen.getAllByTestId('guide-search-hit');
    expect(within(rows[0]!).getByText('On now')).toBeTruthy();
    expect(rows.filter((r) => within(r).queryByTestId('guide-search-watch'))).toEqual([rows[0]]);
    fireEvent.click(within(rows[0]!).getByTestId('guide-search-watch'));
    expect(onWatch).toHaveBeenCalledWith(HITS[0]);
  });

  it('each hit offers Remind, Record and Record series', async () => {
    rpc.handlers['epg.search'] = () => HITS;
    panel();
    await waitFor(() => expect(state()).toBe('results'));
    const future = screen.getAllByTestId('guide-search-hit')[1]!;
    await waitFor(() => expect(within(future).getByTestId('program-record-series')).toBeTruthy());
    expect(within(future).getByRole('button', { name: 'Remind me' })).toBeTruthy();
    expect(within(future).getByTestId('program-record')).toBeTruthy();
    expect(within(future).getByRole('button', { name: 'Record series' })).toBeTruthy();
  });

  it('choosing a hit hands over the display-time hit', async () => {
    rpc.handlers['epg.search'] = () => HITS;
    const { onSelect } = panel({ offsetMinutes: 30 });
    await waitFor(() => expect(state()).toBe('results'));
    fireEvent.click(screen.getAllByRole('button', { name: /^Evening News, Beta, / })[0]!);
    const chosen = onSelect.mock.calls[0]![0] as GuideSearchHit;
    expect(chosen.ref.itemId).toBe('b');
    expect(Date.parse(chosen.program.start)).toBe(Date.parse(HITS[1]!.program.start) + 30 * MINUTE);
  });

  it('says when the results are cut at the limit', async () => {
    rpc.handlers['epg.search'] = () =>
      Array.from({ length: SEARCH_LIMIT }, (_, i) =>
        hit(`News ${i}`, NOW_PLUS(HOUR + i * MINUTE), NOW_PLUS(2 * HOUR + i * MINUTE), { ref: { sourceId: 'src1', contentType: 'live', itemId: `c${i}` } }),
      );
    panel();
    await waitFor(() => expect(state()).toBe('results'));
    expect(screen.getByText(`First ${SEARCH_LIMIT} shown. Refine the search.`)).toBeTruthy();
  });

  // Review round 1: the heading's join came from code (`${rel}, ${date}`), so ja, zh and ar showed
  // an ASCII comma. It is now the locale's `dayHeading` string.
  it('day headings are joined by the locale string, not a hardcoded comma', async () => {
    const original = i18n.getResource('en', 'guide', 'dayHeading') as string;
    expect(original).toBe('{{rel}}, {{date}}');
    i18n.addResource('en', 'guide', 'dayHeading', '{{rel}} · {{date}}');
    try {
      rpc.handlers['epg.search'] = () => HITS;
      panel();
      await waitFor(() => expect(state()).toBe('results'));
      const days = screen.getAllByTestId('guide-search-day').map((h) => h.textContent);
      expect(days[0]).toMatch(/^Today · /);
      expect(days[1]).toMatch(/^Tomorrow · /);
      // A day with no relative name is the date alone, with no joiner.
      expect(days[2]).not.toContain('·');
    } finally {
      i18n.addResource('en', 'guide', 'dayHeading', original);
    }
  });

  // Review round 1: "05:00 AM" wrapped in the old w-12 column. The time never wraps now and the
  // column is wide enough for a 12-hour clock.
  it('the time column keeps a 12-hour time on one line', async () => {
    rpc.handlers['epg.search'] = () => HITS;
    panel();
    await waitFor(() => expect(state()).toBe('results'));
    const row = screen.getAllByTestId('guide-search-hit')[1]!;
    const time = within(row).getByText(/6:00\s?PM|18:00/);
    expect(time.className).toContain('whitespace-nowrap');
    expect(time.parentElement!.className).toContain('min-w-[4.5rem]');
    expect(time.parentElement!.className).not.toMatch(/(^|\s)w-12(\s|$)/);
  });
});

describe('GuideSearch field', () => {
  function field() {
    const onSelect = vi.fn();
    const onWatch = vi.fn();
    const inputRef = { current: null as HTMLInputElement | null };
    renderGuide(<GuideSearch inputRef={inputRef} sourceId="src1" offsetMinutes={0} now={NOW} onSelect={onSelect} onWatch={onWatch} />);
    const input = screen.getByRole('searchbox', { name: 'Search the guide' }) as HTMLInputElement;
    return { onSelect, onWatch, input, inputRef };
  }

  it('debounces typing into one search for the final text', async () => {
    rpc.handlers['epg.search'] = () => HITS;
    const { input, inputRef } = field();
    expect(inputRef.current).toBe(input);
    expect(screen.queryByTestId('guide-search-panel')).toBeNull();
    for (const v of ['n', 'ne', 'new', 'news']) fireEvent.change(input, { target: { value: v } });
    expect(screen.getByTestId('guide-search-panel')).toBeTruthy();
    await waitFor(() => expect(state()).toBe('results'));
    expect(rpc.of('epg.search').map((a) => (a as { query: string }).query)).toEqual(['news']);
  });

  it('ArrowDown goes to the hits, arrows move between them, Escape closes and returns to the field', async () => {
    rpc.handlers['epg.search'] = () => HITS;
    const { input } = field();
    input.focus();
    fireEvent.change(input, { target: { value: 'news' } });
    await waitFor(() => expect(state()).toBe('results'));
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const mains = () => [...screen.getByTestId('guide-search-panel').querySelectorAll<HTMLElement>('[data-hit]')];
    await waitFor(() => expect(document.activeElement).toBe(mains()[0]));
    fireEvent.keyDown(mains()[0]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(mains()[1]);
    fireEvent.keyDown(mains()[1]!, { key: 'End' });
    expect(document.activeElement).toBe(mains()[3]);
    fireEvent.keyDown(mains()[3]!, { key: 'Home' });
    expect(document.activeElement).toBe(mains()[0]);
    // Up from the first hit: back to the field, panel still open.
    fireEvent.keyDown(mains()[0]!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(mains()[0]!, { key: 'Escape' });
    expect(screen.queryByTestId('guide-search-panel')).toBeNull();
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('news');
  });

  it('Escape in the field closes the panel first, then clears the text', async () => {
    const { input } = field();
    fireEvent.change(input, { target: { value: 'news' } });
    expect(screen.getByTestId('guide-search-panel')).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByTestId('guide-search-panel')).toBeNull();
    expect(input.value).toBe('news');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe('');
  });

  it('a press outside closes the panel; a press inside does not', async () => {
    rpc.handlers['epg.search'] = () => HITS;
    const { input } = field();
    fireEvent.change(input, { target: { value: 'news' } });
    await waitFor(() => expect(state()).toBe('results'));
    fireEvent.mouseDown(screen.getByTestId('guide-search-panel'));
    expect(screen.getByTestId('guide-search-panel')).toBeTruthy();
    act(() => {
      fireEvent.mouseDown(document.body);
    });
    expect(screen.queryByTestId('guide-search-panel')).toBeNull();
    // Focus brings it back with the same text.
    fireEvent.focus(input);
    expect(screen.getByTestId('guide-search-panel')).toBeTruthy();
  });

  it('choosing a hit closes the panel and hands over the hit', async () => {
    rpc.handlers['epg.search'] = () => HITS;
    const { input, onSelect } = field();
    fireEvent.change(input, { target: { value: 'news' } });
    await waitFor(() => expect(state()).toBe('results'));
    fireEvent.click(screen.getAllByRole('button', { name: /^Weekend News, / })[0]!);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('guide-search-panel')).toBeNull();
  });
});
