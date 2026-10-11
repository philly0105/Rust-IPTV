import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';

import { DEFAULT_SETTINGS, type Settings } from '@/api/types';

const rpcMock = vi.fn(async (name: string, _args?: unknown): Promise<unknown> => {
  if (name === 'settings.get') return { ...DEFAULT_SETTINGS, player: 'vlc' };
  if (name === 'player.openExternal') return { pid: 7 };
  if (name === 'player.stopExternal') return { stopped: true };
  return undefined;
});
vi.mock('@/api/transport', () => ({
  rpc: (name: string, args?: unknown) => rpcMock(name, args),
  isDesktop: true,
  proxiedUrl: (s: { url: string }) => s.url,
}));
const eventHandlers = new Map<string, (payload: unknown) => void>();
vi.mock('@/api/events', () => ({
  onAppEvent: (type: string, handler: (payload: unknown) => void) => {
    eventHandlers.set(type, handler);
    return () => undefined;
  },
}));

const { usePlayerStore, setSettingsCache, __resetPlayerForTests } = await import('../store');
const { useMediaStore } = await import('../media');
const { PlayerStage } = await import('./PlayerStage');
const { ExternalPlaybackFooter } = await import('./ExternalPlaybackFooter');
const { bindExternalEvents } = await import('../external');
const { useToastStore } = await import('@/ui/Toast');

/** Lets pending promise callbacks run. */
const flush = () => act(async () => {
  await new Promise((r) => setTimeout(r, 0));
});

const source = { url: 'http://h/live/1.ts', kind: 'direct' as const, title: 'Arena Sport 1', isLive: true, isRadio: false };

beforeEach(() => {
  __resetPlayerForTests();
  rpcMock.mockClear();
  setSettingsCache({ ...DEFAULT_SETTINGS, player: 'vlc' });
});
afterEach(() => {
  cleanup();
  __resetPlayerForTests();
  useMediaStore.setState({ externalRuns: [] });
});

describe('external playback in the stage', () => {
  it('shows the title and player instead of the page empty state, with Reopen and Stop', async () => {
    act(() => {
      usePlayerStore.setState({ source, mode: 'external', status: 'playing', dock: 'hidden' });
      useMediaStore.setState({ externalRuns: [{ player: 'vlc', title: source.title, pid: 7, startedAt: 1 }] });
    });
    render(
      <PlayerStage>
        <p>Nothing playing</p>
      </PlayerStage>,
    );
    expect(screen.queryByText('Nothing playing')).toBeNull();
    expect(screen.getByTestId('external-stage').textContent).toContain('Arena Sport 1');
    expect(screen.getByText('Playing in VLC')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reopen in VLC' }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(rpcMock).toHaveBeenCalledWith('player.openExternal', { player: 'vlc', source });

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await flush();
    expect(rpcMock).toHaveBeenCalledWith('player.stopExternal', undefined);
    expect(usePlayerStore.getState().source).toBeUndefined();
    expect(screen.getByText('Nothing playing')).toBeTruthy();
  });

  it('shows a failed launch with a retry', () => {
    act(() => usePlayerStore.setState({ source, mode: 'external', status: 'error', error: 'vlc.exe not found' }));
    render(<PlayerStage />);
    expect(screen.getByRole('alert').textContent).toContain('vlc.exe not found');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});

describe('external playback footer', () => {
  beforeEach(() => {
    act(() => {
      usePlayerStore.setState({ source, mode: 'external', status: 'playing' });
      useMediaStore.setState({ externalRuns: [{ player: 'vlc', title: source.title, pid: 7, startedAt: 1 }] });
    });
  });

  it('shows by default', () => {
    render(<ExternalPlaybackFooter />);
    expect(screen.getByText('Playing in VLC')).toBeTruthy();
  });

  it('hides when settings.showExternalBar is false', () => {
    act(() => setSettingsCache({ ...DEFAULT_SETTINGS, showExternalBar: false } as Settings));
    render(<ExternalPlaybackFooter />);
    expect(screen.queryByText('Playing in VLC')).toBeNull();
  });

  it('Stop closes the external player before ending the session', async () => {
    const order: string[] = [];
    rpcMock.mockImplementationOnce(async (name: string) => {
      order.push(`${name}:${usePlayerStore.getState().source ? 'session' : 'none'}`);
      return { stopped: true };
    });
    render(<ExternalPlaybackFooter />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop VLC' }));
    await flush();
    expect(order).toEqual(['player.stopExternal:session']);
    expect(usePlayerStore.getState().source).toBeUndefined();
    expect(usePlayerStore.getState().mode).toBe('inline');
  });

  it('Stop is a keyboard-reachable button that works with Enter', async () => {
    render(<ExternalPlaybackFooter />);
    const stop = screen.getByRole('button', { name: 'Stop VLC' });
    stop.focus();
    expect(document.activeElement).toBe(stop);
    // Native buttons turn Enter/Space into click; jsdom does not, so dispatch the click it would.
    fireEvent.keyDown(stop, { key: 'Enter' });
    fireEvent.click(stop);
    await flush();
    expect(rpcMock).toHaveBeenCalledWith('player.stopExternal', undefined);
  });

  it('a failed close shows a toast and still ends the session', async () => {
    useToastStore.setState({ toasts: [] });
    rpcMock.mockImplementationOnce(async () => {
      throw new Error('access denied');
    });
    render(<ExternalPlaybackFooter />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop VLC' }));
    await flush();
    expect(usePlayerStore.getState().source).toBeUndefined();
    const last = useToastStore.getState().toasts.at(-1);
    expect(last).toMatchObject({ title: 'VLC did not close', variant: 'error' });
    expect(last?.description).toContain('access denied');
  });
});

describe('player.external events', () => {
  const emit = (payload: unknown) => act(() => eventHandlers.get('player.external')?.(payload));

  beforeEach(() => {
    bindExternalEvents();
    act(() => {
      usePlayerStore.setState({ source, mode: 'external', status: 'playing' });
      useMediaStore.setState({ externalRuns: [{ player: 'vlc', title: source.title, pid: 7, startedAt: 1 }] });
    });
  });

  it('the last process exiting ends the session without another stop request', () => {
    emit({ state: 'exited', player: 'vlc', title: source.title, pid: 7, exitCode: 0 });
    expect(useMediaStore.getState().externalRuns).toEqual([]);
    expect(usePlayerStore.getState().source).toBeUndefined();
    expect(rpcMock).not.toHaveBeenCalledWith('player.stopExternal', undefined);
  });

  it('the previous player closing during a new launch keeps the new session', () => {
    act(() => usePlayerStore.setState({ status: 'loading' }));
    emit({ state: 'exited', player: 'vlc', title: source.title, pid: 7, exitCode: 0 });
    expect(usePlayerStore.getState().source).toBe(source);
  });
});
