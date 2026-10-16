import { act, cleanup, render, screen, within } from '@testing-library/react';
import { Profiler } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';

import { ShortcutOverlay } from '../ShortcutOverlay';
import { shortcutRegistry } from '../shortcuts';
import { useShellStore } from '../store';

// XB2-7 (L2-perf-ui-8, L2-live-12): the closed `?` overlay must not follow the shortcut registry.
// Every register/unregister used to re-render it and rebuild the whole reference.

afterEach(() => {
  cleanup();
  act(() => useShellStore.getState().setHelpOpen(false));
  shortcutRegistry.reset();
});

describe('ShortcutOverlay while closed (XB2-7)', () => {
  it('does not re-render when shortcuts register or unregister', () => {
    const onRender = vi.fn();
    render(
      <Profiler id="overlay" onRender={onRender}>
        <ShortcutOverlay />
      </Profiler>,
    );
    const mounts = onRender.mock.calls.length;
    act(() => {
      // What a held key does when a shortcut's `enabled` follows it: register, then unregister.
      const off = shortcutRegistry.register('pagedown', () => {}, { description: 'Held', area: 'Live' });
      off();
      shortcutRegistry.register('x', () => {}, { description: 'Another', area: 'Live' });
    });
    expect(onRender.mock.calls.length).toBe(mounts);
    expect(screen.queryByTestId('shortcut-overlay')).toBeNull();
  });

  it('opening still lists registered and documented shortcuts, and follows the registry while open', () => {
    render(<ShortcutOverlay />);
    act(() => {
      shortcutRegistry.register('shift+x', () => {}, { description: 'Registered while closed', area: 'Live' });
    });
    act(() => useShellStore.getState().setHelpOpen(true));
    const overlay = screen.getByTestId('shortcut-overlay');
    expect(within(overlay).getByText('Registered while closed')).toBeTruthy();
    // Documented entries (not registered here) are listed too.
    expect(overlay.querySelector('[data-combo="mod+k"]')).toBeTruthy();
    expect(overlay.querySelector('[data-combo="f11"]')).toBeTruthy();
    act(() => {
      shortcutRegistry.register('shift+y', () => {}, { description: 'Registered while open', area: 'Live' });
    });
    expect(within(overlay).getByText('Registered while open')).toBeTruthy();
    act(() => useShellStore.getState().setHelpOpen(false));
    expect(screen.queryByTestId('shortcut-overlay')).toBeNull();
  });

  it('lists the search page keys under Search (XB2-26)', () => {
    render(<ShortcutOverlay />);
    act(() => useShellStore.getState().setHelpOpen(true));
    const overlay = screen.getByTestId('shortcut-overlay');
    const section = within(overlay).getByRole('heading', { name: 'Search' }).closest('section')!;
    expect(within(section).getByText('In the search box: move to the first result').closest('[data-combo]')?.getAttribute('data-combo')).toBe('arrowdown');
    expect(within(section).getByText('On the first result: back to the search box').closest('[data-combo]')?.getAttribute('data-combo')).toBe('arrowup');
  });
});
