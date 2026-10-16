import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';

vi.mock('@/api/transport', () => ({
  rpc: vi.fn(() => Promise.reject(new Error('offline'))),
  isDesktop: false,
  proxiedUrl: (s: { url: string }) => s.url,
}));

const { usePlayerStore, __resetPlayerForTests } = await import('../store');
const { useMediaStore, resetMedia } = await import('../media');
const { RadioPlayer } = await import('./RadioPlayer');
const { useToastStore } = await import('@/ui/Toast');

const radio = { url: 'http://r/1.mp3', kind: 'direct' as const, title: 'Jazz FM', isLive: true, isRadio: true };

beforeEach(() => {
  __resetPlayerForTests();
  resetMedia();
});
afterEach(() => {
  cleanup();
  __resetPlayerForTests();
  resetMedia();
  act(() => useToastStore.setState({ toasts: [] }));
});

describe('RadioPlayer', () => {
  it('renders nothing while idle', () => {
    const { container } = render(<RadioPlayer />);
    expect(container.innerHTML).toBe('');
  });

  it('shows the station and toggles play and mute', () => {
    act(() => {
      usePlayerStore.setState({
        source: { url: 'http://r/1.mp3', kind: 'direct', title: 'Jazz FM', isLive: true, isRadio: true },
        mode: 'radio',
        status: 'playing',
      });
    });
    render(<RadioPlayer variant="bar" />);
    expect(screen.getByText('Jazz FM')).toBeTruthy();
    // No ref: no station zapping.
    expect(screen.queryByRole('button', { name: /next station/i })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /pause/i }));
    expect(usePlayerStore.getState().status).toBe('paused');

    fireEvent.click(screen.getByRole('button', { name: /^mute$/i }));
    expect(usePlayerStore.getState().muted).toBe(true);
  });

  it('keeps the camera on the stage, disabled with the reason, and says it when pressed (C6)', async () => {
    act(() => usePlayerStore.setState({ source: radio, mode: 'radio', status: 'playing' }));
    render(<RadioPlayer variant="stage" />);
    const camera = await screen.findByRole('button', { name: 'Take screenshot' });
    expect(camera.getAttribute('aria-disabled')).toBe('true');
    expect(camera.getAttribute('aria-keyshortcuts')).toBeNull();
    const describedBy = camera.getAttribute('aria-describedby');
    expect(describedBy && document.getElementById(describedBy)?.textContent).toBe('Radio has no picture to capture.');
    // Disabled but focusable: the keyboard reaches it and hears why.
    camera.focus();
    expect(document.activeElement).toBe(camera);
    fireEvent.click(camera);
    // The reason is a toast; the OSD repeats it only in picture-in-picture, where toasts cannot be seen (X-desk-3).
    expect(useToastStore.getState().toasts).toEqual([expect.objectContaining({ title: 'Radio has no picture to capture.', variant: 'info' })]);
    expect(useMediaStore.getState().osd).toBeUndefined();
  });

  it('leaves the camera off the compact strip, like the mini player bar', async () => {
    act(() => usePlayerStore.setState({ source: radio, mode: 'radio', status: 'playing' }));
    render(<RadioPlayer variant="bar" />);
    // Let the lazy part settle before asserting it is absent.
    await act(async () => {
      await import('./ScreenshotButton');
    });
    expect(screen.queryByRole('button', { name: 'Take screenshot' })).toBeNull();
  });
});
