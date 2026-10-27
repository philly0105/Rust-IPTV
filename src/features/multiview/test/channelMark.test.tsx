/** Run 3 review (wiring F4): wall logos load through the image cache with their source, then the original, then initials. */

import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/transport', async (orig) => ({ ...(await orig<typeof import('@/api/transport')>()), isDesktop: false }));
vi.mock('@/shell', () => ({ useShortcut: () => undefined, useShellHeader: () => undefined }));
vi.mock('@/features/player', () => ({ usePlayerStore: () => undefined }));

const { ChannelMark } = await import('../components/ChannelMark');

afterEach(cleanup);

const img = (c: HTMLElement) => c.querySelector('img');

describe('ChannelMark', () => {
  it('asks the cache with the channel source, falls back to the original once and the cache again, then shows initials', () => {
    const logo = 'http://logos.example.test/bbc-one.png';
    const { container } = render(<ChannelMark src={logo} sourceId="portal-a" name="BBC One" />);
    const firstSrc = img(container)!.getAttribute('src')!;
    const first = new URL(firstSrc, 'http://app.test');
    expect(first.pathname).toBe('/api/img');
    expect(first.searchParams.get('url')).toBe(logo);
    expect(first.searchParams.get('sourceId')).toBe('portal-a');

    fireEvent.error(img(container)!);
    expect(img(container)!.getAttribute('src')).toBe(logo);

    fireEvent.error(img(container)!);
    expect(img(container)!.getAttribute('src')).toBe(`${firstSrc}&retry=1`);

    fireEvent.error(img(container)!);
    expect(img(container)).toBeNull();
    expect(container.textContent).toBe('BO');
  });

  it('a replaced channel starts again from its own logo', () => {
    const broken = 'http://logos.example.test/broken.png';
    const good = 'http://logos.example.test/good.png';
    const { container, rerender } = render(<ChannelMark src={broken} sourceId="portal-a" name="Old Channel" />);
    fireEvent.error(img(container)!);
    fireEvent.error(img(container)!);
    fireEvent.error(img(container)!);
    expect(img(container)).toBeNull();

    rerender(<ChannelMark src={good} sourceId="portal-a" name="New Channel" />);
    expect(new URL(img(container)!.getAttribute('src')!, 'http://app.test').searchParams.get('url')).toBe(good);
  });

  it('keeps the deep stops by default and takes the theme tint where asked (the picker, the quick picks)', () => {
    const { container, rerender } = render(<ChannelMark name="Sky News" />);
    const mark = container.firstElementChild as HTMLElement;
    // The wall's tiles sit over video: deep in every theme.
    expect(mark.dataset['tint']).toBe('dark');
    expect(mark.className).not.toContain('var(--tint-light)');
    rerender(<ChannelMark name="Sky News" tint="theme" />);
    // Pale with the hue's ink in the light theme, as Live's monograms are.
    expect(mark.dataset['tint']).toBe('theme');
    expect(mark.className).toContain('light:not-in-data-player-stage:[background-image:var(--tint-light)]');
    expect(mark.style.getPropertyValue('--tint-light')).toContain('linear-gradient');
    expect(mark.textContent).toBe('SN');
  });

  it('shows initials without a logo', () => {
    const { container } = render(<ChannelMark name="Sky News" />);
    expect(img(container)).toBeNull();
    expect(container.textContent).toBe('SN');
  });
});
