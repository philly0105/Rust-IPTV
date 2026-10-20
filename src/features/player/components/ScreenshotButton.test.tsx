/**
 * The screenshot entry points (C6): the `s` shortcut while a video plays, and the camera
 * button, which stays focusable but disabled with its reason for radio and external players.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';

vi.mock('@/api/transport', () => ({
  rpc: vi.fn(() => Promise.reject(new Error('offline'))),
  isDesktop: false,
  proxiedUrl: (s: { url: string }) => s.url,
}));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined }));
vi.mock('../screenshot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../screenshot')>()),
  takeScreenshot: vi.fn(async () => undefined),
  explainBlock: vi.fn(),
}));

const { usePlayerStore, __resetPlayerForTests } = await import('../store');
const { resetMedia } = await import('../media');
const { usePlaybackShortcuts } = await import('../usePlaybackShortcuts');
const { takeScreenshot, explainBlock } = await import('../screenshot');
const { ScreenshotButton } = await import('./ScreenshotButton');

const vod = { url: 'http://h/m.mp4', kind: 'direct' as const, title: 'Movie', isLive: false, isRadio: false };
const live = { url: 'http://h/live.m3u8', kind: 'hls' as const, title: 'News', isLive: true, isRadio: false };
const radio = { url: 'http://h/r.mp3', kind: 'direct' as const, title: 'Jazz FM', isLive: true, isRadio: true };

function Shortcuts() {
  usePlaybackShortcuts({ channelPanelAvailable: false });
  return null;
}

/** Presses `k` on the window like the shell registry sees it; returns whether it was claimed. */
const press = async (k: string, init: KeyboardEventInit = {}, target: EventTarget = window): Promise<boolean> => {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  await act(async () => {
    target.dispatchEvent(e);
    // The shortcut loads the capture module on demand.
    await import('../screenshot');
    await Promise.resolve();
  });
  return e.defaultPrevented;
};

beforeEach(() => {
  __resetPlayerForTests();
  resetMedia();
  vi.mocked(takeScreenshot).mockClear();
  vi.mocked(explainBlock).mockClear();
});

afterEach(() => {
  cleanup();
  __resetPlayerForTests();
  resetMedia();
});

describe('the s shortcut', () => {
  it('takes a screenshot while a video plays, live or on demand', async () => {
    act(() => usePlayerStore.setState({ source: vod, mode: 'inline', status: 'playing' }));
    render(<Shortcuts />);
    expect(await press('s')).toBe(true);
    await vi.waitFor(() => expect(takeScreenshot).toHaveBeenCalledTimes(1));

    act(() => usePlayerStore.setState({ source: live, mode: 'embedded-mpv' }));
    await press('s');
    await vi.waitFor(() => expect(takeScreenshot).toHaveBeenCalledTimes(2));
  });

  it('takes one screenshot for a held S, not one per key repeat', async () => {
    act(() => usePlayerStore.setState({ source: vod, mode: 'inline', status: 'playing' }));
    render(<Shortcuts />);
    await press('s');
    // The OS repeats a held key about 30 times a second; the repeats stay claimed but do nothing.
    for (let i = 0; i < 30; i++) expect(await press('s', { repeat: true })).toBe(true);
    expect(takeScreenshot).toHaveBeenCalledTimes(1);
    // The next press is a new screenshot.
    await press('s');
    await vi.waitFor(() => expect(takeScreenshot).toHaveBeenCalledTimes(2));
  });

  it('is off for radio, external players and when nothing plays', async () => {
    render(<Shortcuts />);
    await press('s');
    act(() => usePlayerStore.setState({ source: radio, mode: 'radio', status: 'playing' }));
    expect(await press('s')).toBe(false);
    act(() => usePlayerStore.setState({ source: vod, mode: 'external', status: 'playing' }));
    expect(await press('s')).toBe(false);
    expect(takeScreenshot).not.toHaveBeenCalled();
  });

  it('leaves s to a text field and to modified keys', async () => {
    act(() => usePlayerStore.setState({ source: vod, mode: 'inline', status: 'playing' }));
    render(
      <>
        <Shortcuts />
        <input aria-label="search" />
      </>,
    );
    const input = screen.getByLabelText('search');
    input.focus();
    await press('s', {}, input);
    input.blur();
    await press('s', { ctrlKey: true });
    expect(takeScreenshot).not.toHaveBeenCalled();
  });
});

/** Hovers `el` and returns its kit tooltip's text and key caps (the tooltip replaced the native title). */
async function tooltipOf(el: HTMLElement): Promise<{ text: string; keys: string[] }> {
  expect(el.hasAttribute('title')).toBe(false);
  fireEvent.mouseEnter(el);
  const tip = await screen.findByRole('tooltip');
  const keys = [...tip.querySelectorAll('kbd')].map((k) => k.textContent ?? '');
  const text = [...tip.childNodes].filter((n) => !(n instanceof HTMLElement && n.querySelector('kbd'))).map((n) => n.textContent).join('');
  fireEvent.mouseLeave(el);
  return { text, keys };
}

describe('the camera button', () => {
  it('takes a screenshot and names its key', async () => {
    act(() => usePlayerStore.setState({ source: vod, mode: 'inline', status: 'playing' }));
    render(<ScreenshotButton />);
    const btn = screen.getByTestId('screenshot-button');
    expect(btn.getAttribute('aria-label')).toBe('Take screenshot');
    expect(await tooltipOf(btn)).toEqual({ text: 'Take screenshot', keys: ['S'] });
    expect(btn.getAttribute('aria-keyshortcuts')).toBe('S');
    expect(btn.getAttribute('aria-disabled')).toBeNull();
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(takeScreenshot).toHaveBeenCalledTimes(1);
  });

  it('is disabled with the reason for radio, and says it when pressed', async () => {
    act(() => usePlayerStore.setState({ source: radio, mode: 'radio', status: 'playing' }));
    render(<ScreenshotButton />);
    const btn = screen.getByTestId('screenshot-button');
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(await tooltipOf(btn)).toEqual({ text: 'Take screenshot: Radio has no picture to capture.', keys: [] });
    const describedBy = btn.getAttribute('aria-describedby');
    expect(describedBy && document.getElementById(describedBy)?.textContent).toBe('Radio has no picture to capture.');
    fireEvent.click(btn);
    expect(explainBlock).toHaveBeenCalledWith('radio');
    expect(takeScreenshot).not.toHaveBeenCalled();
  });

  it("points an external player's viewer at that player's own key", async () => {
    act(() => usePlayerStore.setState({ source: vod, mode: 'external', status: 'playing' }));
    render(<ScreenshotButton stage />);
    const btn = screen.getByTestId('screenshot-button');
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(await tooltipOf(btn)).toEqual({ text: 'Take screenshot: This plays in an external player. Use its own screenshot key.', keys: [] });
    expect(btn.getAttribute('aria-keyshortcuts')).toBeNull();
    fireEvent.click(btn);
    expect(explainBlock).toHaveBeenCalledWith('external');
  });
});
