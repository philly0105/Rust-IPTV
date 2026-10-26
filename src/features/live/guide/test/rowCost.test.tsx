/**
 * Guide rows (P2-GUIDE-5): their words come from the page, so a row mounts no translation hook,
 * and fitting the cell text writes no style to a cell that was never capped.
 */
import { cleanup, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildScheduleIndex } from '@/features/recording/lib/schedule';

import { defaultStart, GRID_ROW } from '../../components/EpgGridPage';
import { HOUR, MINUTE } from '../../lib/epgTime';
import { createStickyTitleManager, GuideRow, type GuideRowProps } from '../GuideRow';
import { createRpcMock, i18n, installDomStubs, makeChannel, program, renderGuide } from './harness';

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

beforeAll(() => {
  installDomStubs();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('rows (P2-GUIDE-5)', () => {
  function rowProps(i: number): GuideRowProps {
    const at = defaultStart(Date.now());
    return {
      index: i,
      top: i * GRID_ROW,
      height: GRID_ROW,
      channel: makeChannel(i),
      programs: [program(`c${i} P0`, at, at + HOUR), program(`c${i} P1`, at + HOUR, at + 2 * HOUR)],
      origin: at,
      now: at + 10 * MINUTE,
      pxPerMin: 5,
      channelCol: 220,
      compact: false,
      rtl: false,
      kind: 'm3u',
      highlighted: false,
      playing: i === 1,
      genreFilter: null,
      genreNames: { movie: 'Movies', sports: 'Sports', news: 'News', kids: 'Kids', series: 'Series & shows' },
      labels: { onNow: 'On now', archive: 'Archive', playingNow: 'Playing now', noGuideShort: 'No guide', playChannel: (name) => `Play ${name}` },
      cursorStart: null,
      lang: 'en',
      stripCountryPrefix: false,
      schedule: buildScheduleIndex(),
      handlers: { play: vi.fn(), open: vi.fn(), focusCell: vi.fn(), menu: vi.fn(), trackTitles: vi.fn(() => vi.fn()), press: vi.fn(), hover: vi.fn() },
    };
  }

  it('a row mounts no translation hook: its words come from the page', () => {
    const fixed = vi.spyOn(i18n, 'getFixedT');
    renderGuide(
      <>
        {[0, 1, 2].map((i) => (
          <GuideRow key={i} {...rowProps(i)} />
        ))}
      </>,
    );
    expect(fixed).not.toHaveBeenCalled();
    expect(screen.getByTitle('Play Channel 1')).toBeTruthy();
    expect(screen.getByLabelText('Playing now')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^c0 P0, .*, On now$/ })).toBeTruthy();
  });

  it('primes only titles near the visible edge for native sticky positioning', () => {
    const root = document.createElement('div');
    root.innerHTML = '<span data-pad-left="600" data-pad-width="300"></span><span data-pad-left="900" data-pad-width="300"></span>';
    const cells = root.querySelectorAll('span');
    const titles = createStickyTitleManager();
    const unregister = titles.register(root, 0);
    expect(cells[0]!.classList.contains('sticky')).toBe(false);
    titles.update(700);
    expect(cells[0]!.classList.contains('sticky')).toBe(true);
    titles.update(1500);
    expect(cells[0]!.classList.contains('sticky')).toBe(false);
    unregister();
  });
});
