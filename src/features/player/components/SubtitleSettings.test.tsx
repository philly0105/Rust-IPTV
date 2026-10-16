import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import type { Settings } from '@/api/types';

vi.mock('@/api/transport', () => ({
  rpc: vi.fn(() => Promise.reject(new Error('offline'))),
  isDesktop: false,
  proxiedUrl: (s: { url: string }) => s.url,
}));

const { PlaybackSection } = await import('@/features/settings/sections/PlaybackSection');

const base = {
  player: 'html5',
  streamFormat: 'm3u8',
  subtitleSize: 'medium',
  subtitleColor: 'white',
  subtitleBackground: 'box',
  subtitlePosition: 0,
} as unknown as Settings;

function renderSection(settings: Settings = base) {
  const update = vi.fn(async () => true);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <PlaybackSection settings={settings} update={update} />
    </QueryClientProvider>,
  );
  return { update, view, client };
}

afterEach(cleanup);

describe('Playback settings: Subtitles group', () => {
  it('shows the four controls and a preview drawn with the saved look', () => {
    renderSection({ ...base, subtitleColor: 'cyan', subtitleBackground: 'shadow', subtitlePosition: 20 } as Settings);
    expect(screen.getByRole('heading', { name: 'Subtitles' })).toBeTruthy();
    const preview = screen.getByTestId('subtitle-preview');
    expect(preview.style.getPropertyValue('--sub-color')).toBe('#00E5FF');
    expect(preview.style.getPropertyValue('--sub-bg')).toBe('transparent');
    expect(preview.style.getPropertyValue('--sub-shadow')).not.toBe('none');
    // 10 % up plus the position, like the player's cue line.
    expect(screen.getByTestId('subtitle-preview-line').parentElement?.style.bottom).toBe('30%');
    expect(screen.getByTestId('subtitle-position-value').textContent).toBe('Raised 20%');
    for (const id of ['subtitle-size', 'subtitle-color', 'subtitle-background']) {
      const group = screen.getByTestId(id);
      expect(within(group).getAllByRole('radio').filter((r) => r.getAttribute('tabindex') === '0')).toHaveLength(1);
    }
  });

  it('saves a choice made by click or by arrow key', () => {
    const { update } = renderSection();
    fireEvent.click(within(screen.getByTestId('subtitle-color')).getByRole('radio', { name: 'Yellow' }));
    expect(update).toHaveBeenCalledWith({ subtitleColor: 'yellow' });
    const medium = within(screen.getByTestId('subtitle-size')).getByRole('radio', { name: 'Medium' });
    fireEvent.keyDown(medium, { key: 'ArrowRight' });
    expect(update).toHaveBeenCalledWith({ subtitleSize: 'large' });
    fireEvent.keyDown(within(screen.getByTestId('subtitle-background')).getByRole('radio', { name: 'Box' }), { key: 'End' });
    expect(update).toHaveBeenCalledWith({ subtitleBackground: 'solid' });
  });

  it('the position slider previews while it moves and saves once at the end', () => {
    const { update } = renderSection();
    const slider = screen.getByTestId('subtitle-position');
    act(() => {
      fireEvent.change(slider, { target: { value: '12' } });
    });
    expect(update).not.toHaveBeenCalled();
    expect(screen.getByTestId('subtitle-preview-line').parentElement?.style.bottom).toBe('22%');
    expect(screen.getByTestId('subtitle-position-value').textContent).toBe('Raised 12%');
    fireEvent.pointerUp(slider);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({ subtitlePosition: 12 });
    // A blur after the save writes nothing more.
    fireEvent.blur(slider);
    expect(update).toHaveBeenCalledTimes(1);
  });
});
