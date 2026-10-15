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
  it('asks the cache with the channel source, falls back to the original once, then shows initials', () => {
    const logo = 'http://logos.example.test/bbc-one.png';
    const { container } = render(<ChannelMark src={logo} sourceId="portal-a" name="BBC One" />);
    const first = new URL(img(container)!.getAttribute('src')!, 'http://app.test');
    expect(first.pathname).toBe('/api/img');
    expect(first.searchParams.get('url')).toBe(logo);
    expect(first.searchParams.get('sourceId')).toBe('portal-a');

    fireEvent.error(img(container)!);
    expect(img(container)!.getAttribute('src')).toBe(logo);

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
    expect(img(container)).toBeNull();

    rerender(<ChannelMark src={good} sourceId="portal-a" name="New Channel" />);
    expect(new URL(img(container)!.getAttribute('src')!, 'http://app.test').searchParams.get('url')).toBe(good);
  });

  it('shows initials without a logo', () => {
    const { container } = render(<ChannelMark name="Sky News" />);
    expect(img(container)).toBeNull();
    expect(container.textContent).toBe('SN');
  });
});
