// L3-visual-7: on a phone an episode row gave its title about 29 px ('Cr…'): a fixed
// 160 px thumbnail plus the menu and download buttons in the same line. The row now
// narrows the thumbnail below sm and lets the title take two lines with the whole title
// as a tooltip. Round 3: the actions no longer wrap onto a line of their own under the
// text (a 112 px row with an empty strip under the thumbnail); they end the row's one
// line, and a phone row is 84 px. In that row the facts above the title keep to one line
// (code, runtime, Now playing, the downloaded icon), so a long title still fits.
import { cleanup, render, screen, within } from '@testing-library/react';
import { useEffect, useRef, useState } from 'react';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Download, Episode, PlaybackPosition } from '@/api/types';

import { EpisodeList } from '../components/detail/EpisodeList';
import { i18n, installDomStubs } from './harness';

vi.mock('@/api/transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/transport')>()),
  rpc: async () => undefined,
  rpcRaw: async () => undefined,
}));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));

const LONG = 'Crossing the Line of Fire at the Edge of the Northern Sea';
const episode = (n: number, title: string): Episode => ({
  id: `e${n}`,
  seriesRef: { sourceId: 's1', contentType: 'series', itemId: 'show' },
  season: 1,
  episode: n,
  title,
  plot: 'A plot that runs long enough to need clamping.',
  durationSeconds: 2520,
});

interface HarnessProps {
  canDownload?: boolean;
  withMenu?: boolean;
  positions?: Map<string, PlaybackPosition>;
  downloads?: Map<string, Download>;
}

function Harness({ canDownload = true, withMenu = true, positions = new Map(), downloads = new Map() }: HarnessProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // The scroll box's ref attaches after the list's layout effects; one more render lets the virtualizer find it, as the page's own renders do.
  const [, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <div ref={scrollRef}>
      <EpisodeList
        episodes={[episode(1, LONG), episode(2, 'Short')]}
        positions={positions}
        downloads={downloads}
        onPlay={() => undefined}
        canDownload={canDownload}
        pendingDownload={null}
        onDownload={() => undefined}
        {...(withMenu ? { onToggleWatched: () => undefined } : {})}
        scrollRef={scrollRef}
      />
    </div>
  );
}

function renderList(props: HarnessProps = {}) {
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>
        <Harness {...props} />
      </MemoryRouter>
    </I18nextProvider>,
  );
}

const ref = { sourceId: 's1', contentType: 'series' as const, itemId: 'show' };
const watchedAndResumed = new Map<string, PlaybackPosition>([
  ['e1', { ref, episodeId: 'e1', positionSeconds: 2520, durationSeconds: 2520, updatedAt: '2026-10-01T00:00:00Z', watched: true }],
  ['e2', { ref, episodeId: 'e2', positionSeconds: 932, durationSeconds: 2520, updatedAt: '2026-10-01T00:00:00Z', watched: false }],
]);
const done = (id: number, episodeId: string): Download => ({
  id,
  ref,
  episodeId,
  title: 'Show',
  url: 'http://x',
  status: 'completed',
  bytesDownloaded: 1,
  totalBytes: 1,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  fileAvailable: true,
  positionSeconds: 0,
});
const bothDownloaded = new Map([
  ['e1', done(1, 'e1')],
  ['e2', done(2, 'e2')],
]);

/** Runs `body` with the window at Tailwind's sm breakpoint or wider. */
async function atSm(body: () => Promise<void>) {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({ ...original(query), matches: query === '(min-width: 40rem)' })) as typeof window.matchMedia;
  try {
    await body();
  } finally {
    window.matchMedia = original;
  }
}

beforeAll(installDomStubs);
afterEach(cleanup);

describe('episode rows on a phone (L3-visual-7)', () => {
  it('narrows the thumbnail below sm and keeps the 160 px one from sm up', async () => {
    renderList();
    const thumb = (await screen.findAllByTestId('episode-thumb'))[0]!;
    expect(thumb.className.split(' ')).toEqual(expect.arrayContaining(['w-28', 'sm:w-40']));
    expect(thumb.className.split(' ')).not.toContain('w-40');
  });

  it('keeps the watched and download buttons at the end of the row\'s one line below sm, both reachable', async () => {
    renderList();
    const row = (await screen.findAllByTestId('episode-row'))[0]!;
    const classes = row.className.split(' ');
    expect(classes).not.toContain('flex-wrap');
    expect(classes).toEqual(expect.arrayContaining(['flex', 'items-center']));
    const play = within(row).getByRole('button', { name: new RegExp(`^Play .*${LONG}$`) });
    expect(play.className.split(' ')).not.toContain('max-sm:basis-full');
    const actions = within(row).getByTestId('episode-actions');
    // The play button and the actions share the line: the actions come last and never shrink.
    expect(row.lastElementChild).toBe(actions);
    expect(actions.className.split(' ')).toContain('shrink-0');
    expect(within(actions).getByRole('button', { name: /^Mark S\d+E\d+ as watched$/ })).toBeTruthy();
    expect(within(actions).getAllByRole('button').length).toBe(2);
  });

  it('gives a phone row 84 px instead of the 112 px it takes from sm up', async () => {
    renderList();
    const item = (await screen.findAllByRole('listitem'))[0]!;
    expect(item.style.height).toBe('84px');
    const second = (await screen.findAllByRole('listitem'))[1]!;
    expect(second.style.top).toBe('84px');
  });

  it('keeps the 112 px row from sm up', async () => {
    await atSm(async () => {
      renderList();
      const item = (await screen.findAllByRole('listitem'))[0]!;
      expect(item.style.height).toBe('112px');
    });
  });

  it('keeps a phone row\'s facts to the code and the runtime, the downloaded icon after them, on a line one line high', async () => {
    renderList({ positions: watchedAndResumed, downloads: bothDownloaded });
    const rows = await screen.findAllByTestId('episode-row');
    for (const row of rows) {
      const meta = within(row).getByTestId('episode-title').previousElementSibling as HTMLElement;
      // A wrapped line (S01E01 · 42m / · Watched / · Downloaded) pushed the title out of the 84 px row.
      // Now an item that does not fit wraps whole onto a second line the box cuts off.
      expect(meta.className.split(' ')).toEqual(expect.arrayContaining(['max-sm:h-[1lh]', 'max-sm:overflow-hidden', 'max-sm:whitespace-nowrap']));
      // The facts in words, each after its drawn dot and spoken comma; the downloaded icon has none.
      expect(meta.textContent!.split('·, ').filter(Boolean)).toEqual([expect.stringMatching(/^S01E0\d$/), '42m']);
      expect(within(meta).getByTestId('episode-offline').querySelector('svg')).toBeTruthy();
    }
    // The watched episode: no Watched in its facts; the thumbnail's tick and the play button's name say it.
    expect(within(rows[0]!).queryByTestId('episode-watched')).toBeNull();
    expect(within(rows[0]!).getByTestId('episode-watched-chip')).toBeTruthy();
    expect(within(rows[0]!).getByRole('button', { name: `Play S01E01 ${LONG}, Watched, Downloaded` })).toBeTruthy();
    // The one 37 % in: no percent in its row's text; the thumbnail's bar shows it and the play button's name says it.
    expect(rows[1]!.textContent).not.toContain('37% watched');
    expect(within(rows[1]!).getByRole('button', { name: 'Resume S01E02 Short, 37% watched, Downloaded' })).toBeTruthy();
  });

  it('keeps Watched, the percent and Downloaded in words in the facts from sm up', async () => {
    await atSm(async () => {
      renderList({ positions: watchedAndResumed, downloads: bothDownloaded });
      const rows = await screen.findAllByTestId('episode-row');
      expect(within(rows[0]!).getByTestId('episode-watched').textContent).toBe('Watched');
      expect(within(rows[1]!).getByText('37% watched')).toBeTruthy();
      expect(within(rows[1]!).getByTestId('episode-offline').textContent).toBe('Downloaded');
      expect(within(rows[1]!).getByRole('button', { name: 'Resume S01E02 Short, 37% watched, Downloaded' })).toBeTruthy();
    });
  });

  it('lets the title take two lines on a phone, with the whole title as a tooltip', async () => {
    renderList();
    const title = (await screen.findAllByTestId('episode-title'))[0]!;
    expect(title.textContent).toBe(LONG);
    expect(title.getAttribute('title')).toBe(LONG);
    expect(title.className.split(' ')).toEqual(expect.arrayContaining(['line-clamp-2', 'sm:line-clamp-1']));
    expect(title.className.split(' ')).not.toContain('truncate');
  });

  it('renders no empty actions line when a row has no actions', async () => {
    renderList({ canDownload: false, withMenu: false });
    expect(await screen.findAllByTestId('episode-row')).toHaveLength(2);
    expect(screen.queryAllByTestId('episode-actions')).toHaveLength(0);
  });
});
