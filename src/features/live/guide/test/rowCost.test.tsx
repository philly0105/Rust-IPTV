/**
 * Guide rows (P2-GUIDE-5): their words come from the page, so a row mounts no translation hook,
 * and fitting the cell text writes no style to a cell that was never capped.
 */
import { cleanup, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildScheduleIndex } from '@/features/recording/lib/schedule';

import { defaultStart, GRID_ROW } from '../../components/EpgGridPage';
import { HOUR, MINUTE } from '../../lib/epgTime';
import { fitCellText, GuideRow, type GuideRowProps } from '../GuideRow';
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
      trackWidth: 1800,
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
      handlers: { play: vi.fn(), open: vi.fn(), focusCell: vi.fn(), menu: vi.fn(), fitText: vi.fn(), press: vi.fn(), hover: vi.fn() },
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

  it('fitCellText writes no style to a cell it never capped while the cell stays clear of the edge', () => {
    const root = document.createElement('div');
    root.innerHTML = '<span data-pad-left="600" data-pad-width="300"></span>';
    const el = root.querySelector('span')!;
    const writes: string[] = [];
    const style = el.style;
    Object.defineProperty(el, 'style', {
      value: new Proxy(style, {
        set(target, prop, value) {
          writes.push(`${String(prop)}=${String(value)}`);
          (target as unknown as Record<string | symbol, unknown>)[prop] = value;
          return true;
        },
      }),
    });
    fitCellText(root, 0);
    fitCellText(root, 300);
    expect(writes).toEqual([]);
    fitCellText(root, 700);
    expect(writes).toEqual(['maxWidth=182px']);
    fitCellText(root, 0);
    expect(writes).toEqual(['maxWidth=182px', 'maxWidth=']);
  });
});
