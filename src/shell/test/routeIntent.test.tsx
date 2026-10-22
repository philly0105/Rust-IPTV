/**
 * NAV-1: a pointer or focus resting on a link to a page starts the page's chunk and its first data;
 * passing over it, touch, and links that scroll under a still pointer do not.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { prefetchScreenData } from '@/api/bootPrefetch';

import { resetRouteIntentForTests, ROUTE_REST_MS, setRouteWarmer, useRouteIntent } from '../routeIntent';

vi.mock('@/api/bootPrefetch', () => ({ prefetchScreenData: vi.fn() }));

const data = vi.mocked(prefetchScreenData);
const warm = vi.fn();
const asked = () => data.mock.calls.map(([path]) => path);

function Probe({ to }: { to: string }) {
  const intent = useRouteIntent(to);
  return (
    <a href={to} data-testid={to} {...intent}>
      {to}
    </a>
  );
}

const move = (x: number, y: number) => act(() => void window.dispatchEvent(new MouseEvent('pointermove', { clientX: x, clientY: y })));
const wait = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

beforeEach(() => {
  vi.useFakeTimers();
  setRouteWarmer(warm);
});
afterEach(() => {
  cleanup();
  resetRouteIntentForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  data.mockClear();
  warm.mockClear();
});

describe('useRouteIntent', () => {
  it("a pointer resting on a link starts the page's chunk and its data; one passing over it does not", async () => {
    render(
      <>
        <Probe to="/epg" />
        <Probe to="/s/s1/live" />
      </>,
    );
    move(1, 1);
    const live = screen.getByTestId('/s/s1/live');
    fireEvent.pointerEnter(live);
    await wait(ROUTE_REST_MS - 20);
    fireEvent.pointerLeave(live);
    fireEvent.pointerEnter(screen.getByTestId('/epg'));
    await wait(ROUTE_REST_MS - 1);
    expect(asked()).toEqual([]);
    await wait(1);
    expect(asked()).toEqual(['/epg']);
    expect(warm).toHaveBeenCalledExactlyOnceWith('/epg');
  });

  it('a focus that rests on a link counts; one an arrow key moves on does not', async () => {
    render(
      <>
        <Probe to="/a" />
        <Probe to="/b" />
      </>,
    );
    act(() => screen.getByTestId('/a').focus());
    await wait(ROUTE_REST_MS / 2);
    act(() => screen.getByTestId('/b').focus());
    await wait(ROUTE_REST_MS);
    expect(asked()).toEqual(['/b']);
  });

  it('touch is not intent', async () => {
    render(<Probe to="/epg" />);
    fireEvent.pointerEnter(screen.getByTestId('/epg'), { pointerType: 'touch' });
    await wait(ROUTE_REST_MS * 3);
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(pointer: coarse)', addEventListener() {}, removeEventListener() {} }));
    act(() => screen.getByTestId('/epg').focus());
    await wait(ROUTE_REST_MS * 3);
    expect(asked()).toEqual([]);
    expect(warm).not.toHaveBeenCalled();
  });

  it('a link that scrolls under a still pointer waits for the pointer to move', async () => {
    render(<Probe to="/s/s1/live/g7" />);
    move(10, 10);
    act(() => void window.dispatchEvent(new Event('scroll')));
    // Chromium's hover update after the scroll: pointerenter, and a move at the same spot.
    fireEvent.pointerEnter(screen.getByTestId('/s/s1/live/g7'));
    move(10, 10);
    await wait(ROUTE_REST_MS * 3);
    expect(asked()).toEqual([]);

    move(12, 10);
    await wait(ROUTE_REST_MS);
    expect(asked()).toEqual(['/s/s1/live/g7']);
  });
});
