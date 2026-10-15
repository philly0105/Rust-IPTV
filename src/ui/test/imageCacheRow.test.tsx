import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { RpcError } from '@/api/transport';
import type { ImageCacheStats, Settings } from '@/api/types';
import { i18nextLng, loadLanguage } from '@/i18n';
import i18next from 'i18next';

import { capOptions, formatCacheBytes, formatCacheMb, ImageCacheRow } from '@/features/settings/sections/ImageCacheRow';
import { installDomStubs, pending, renderAt, rpcMock, settings } from '@/features/sources/test/harness';
import { useToastStore } from '@/ui';

// Settings > General: the image cache row (Run 3 C3). I-integration mounts it; this renders it alone.

vi.mock('@/api/transport', async (orig) => ({
  ...(await orig<typeof import('@/api/transport')>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  isDesktop: false,
}));
vi.mock('@/api/events', () => ({
  onAppEvent: () => () => undefined,
  onAnyAppEvent: () => () => undefined,
  onConnectionState: () => () => undefined,
}));

const MIB = 1024 * 1024;
let current: Settings;
let stats: ImageCacheStats;

const renderRow = () => renderAt([{ path: '/', element: <ImageCacheRow /> }], '/');
const toasts = () => useToastStore.getState().toasts;

beforeAll(installDomStubs);
beforeEach(() => {
  rpcMock.reset();
  useToastStore.setState({ toasts: [] });
  current = settings({ imageCacheMaxMb: 500 });
  stats = { bytes: 120 * MIB, files: 1234, maxBytes: 500 * MIB };
  rpcMock.handlers['settings.get'] = () => current;
  rpcMock.handlers['settings.update'] = (a) => {
    current = { ...current, ...(a as { patch: Partial<Settings> }).patch };
    return current;
  };
  rpcMock.handlers['images.stats'] = () => stats;
});
afterEach(cleanup);

describe('ImageCacheRow', () => {
  it('shows a skeleton while the stats load', () => {
    rpcMock.handlers['images.stats'] = () => pending();
    renderRow();
    expect(screen.getByTestId('image-cache-loading').getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByTestId('image-cache-clear')).toBeNull();
  });

  it('shows usage against the cap, the picture count and the cap choices', async () => {
    renderRow();
    const size = await screen.findByTestId('image-cache-size');
    await waitFor(() => expect(size.textContent).toBe('120 MB of 500 MB'));
    expect(size.dataset.bytes).toBe(String(120 * MIB));
    expect(screen.getByTestId('image-cache-files').textContent).toBe('1,234 pictures');
    const meter = screen.getByRole('meter', { name: 'Image cache' });
    expect(meter.getAttribute('aria-valuetext')).toBe('120 MB of 500 MB');
    expect((meter.firstElementChild as HTMLElement).style.width).toBe('24%');
    const cap = screen.getByLabelText('Limit') as HTMLSelectElement;
    expect(cap.value).toBe('500');
    expect([...cap.options].map((o) => o.textContent)).toEqual(['250 MB', '500 MB', '1 GB', '2 GB', '5 GB']);
    expect((screen.getByTestId('image-cache-clear') as HTMLButtonElement).disabled).toBe(false);
  });

  it('designs the empty state: no count, an empty meter and Clear disabled', async () => {
    stats = { bytes: 0, files: 0, maxBytes: 500 * MIB };
    renderRow();
    const files = await screen.findByTestId('image-cache-files');
    expect(files.textContent).toBe('Empty. Pictures are saved as you browse.');
    expect(screen.getByTestId('image-cache-size').textContent).toBe('0 MB of 500 MB');
    expect((screen.getByTestId('image-cache-meter').firstElementChild as HTMLElement).style.width).toBe('0%');
    expect((screen.getByTestId('image-cache-clear') as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps a sliver in the meter for a cache that holds anything', async () => {
    stats = { bytes: 20 * 1024, files: 1, maxBytes: 500 * MIB };
    renderRow();
    const size = await screen.findByTestId('image-cache-size');
    await waitFor(() => expect(size.textContent).toBe('20 kB of 500 MB'));
    expect(screen.getByTestId('image-cache-files').textContent).toBe('1 picture');
    expect((screen.getByTestId('image-cache-meter').firstElementChild as HTMLElement).style.width).toBe('1.5%');
  });

  it('says so when the server has no image cache', async () => {
    rpcMock.handlers['images.stats'] = () => {
      throw new RpcError('unsupported', 'images.stats is not available');
    };
    renderRow();
    const note = await screen.findByTestId('image-cache-unavailable');
    expect(note.textContent).toContain('This server has no image cache');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByTestId('image-cache-clear')).toBeNull();
  });

  it('shows a read failure with a working Retry', async () => {
    let fail = true;
    rpcMock.handlers['images.stats'] = () => {
      if (fail) throw new RpcError('io', 'disk unavailable');
      return stats;
    };
    renderRow();
    const error = await screen.findByTestId('image-cache-error');
    expect(error.getAttribute('role')).toBe('alert');
    expect(error.textContent).toContain("Couldn't read the image cache: disk unavailable");
    fail = false;
    fireEvent.click(within(error).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByTestId('image-cache-size').textContent).toBe('120 MB of 500 MB'));
  });

  it('clears after confirming, then shows the empty cache and a toast', async () => {
    rpcMock.handlers['images.clear'] = () => ({ bytes: 0, files: 0, maxBytes: 500 * MIB });
    renderRow();
    fireEvent.click(await screen.findByTestId('image-cache-clear'));
    const dialog = await screen.findByTestId('image-cache-clear-dialog');
    expect(dialog.textContent).toContain('Clear the image cache?');
    expect(dialog.textContent).toContain('This removes 120 MB of saved pictures.');
    expect(rpcMock.callsOf('images.clear')).toHaveLength(0);
    fireEvent.click(screen.getByTestId('image-cache-clear-confirm'));
    await waitFor(() => expect(rpcMock.callsOf('images.clear')).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId('image-cache-files').textContent).toBe('Empty. Pictures are saved as you browse.'));
    expect(screen.getByTestId('image-cache-size').textContent).toBe('0 MB of 500 MB');
    await waitFor(() => expect(screen.queryByTestId('image-cache-clear-dialog')).toBeNull());
    expect(toasts().map((t) => [t.variant, t.title])).toEqual([['success', 'Image cache cleared']]);
  });

  it('cancelling the confirm clears nothing', async () => {
    renderRow();
    fireEvent.click(await screen.findByTestId('image-cache-clear'));
    const dialog = await screen.findByTestId('image-cache-clear-dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByTestId('image-cache-clear-dialog')).toBeNull());
    expect(rpcMock.callsOf('images.clear')).toHaveLength(0);
    expect(screen.getByTestId('image-cache-size').textContent).toBe('120 MB of 500 MB');
  });

  it('a failed clear keeps the figures and offers a retry toast', async () => {
    let fail = true;
    rpcMock.handlers['images.clear'] = () => {
      if (fail) throw new RpcError('io', 'locked');
      return { bytes: 0, files: 0, maxBytes: 500 * MIB };
    };
    renderRow();
    fireEvent.click(await screen.findByTestId('image-cache-clear'));
    fireEvent.click(await screen.findByTestId('image-cache-clear-confirm'));
    await waitFor(() => expect(toasts()).toHaveLength(1));
    const [failed] = toasts();
    expect(failed?.variant).toBe('error');
    expect(failed?.title).toBe("Couldn't clear the image cache");
    expect(failed?.description).toBe('locked');
    expect(screen.getByTestId('image-cache-size').textContent).toBe('120 MB of 500 MB');
    fail = false;
    await act(async () => failed?.action?.onClick());
    await waitFor(() => expect(screen.getByTestId('image-cache-size').textContent).toBe('0 MB of 500 MB'));
    expect(rpcMock.callsOf('images.clear')).toHaveLength(2);
  });

  it('saves a new cap and refetches the stats', async () => {
    renderRow();
    await screen.findByTestId('image-cache-size');
    const before = rpcMock.callsOf('images.stats').length;
    stats = { bytes: 120 * MIB, files: 1234, maxBytes: 250 * MIB };
    fireEvent.change(screen.getByLabelText('Limit'), { target: { value: '250' } });
    await waitFor(() => expect(rpcMock.callsOf('settings.update')).toEqual([{ patch: { imageCacheMaxMb: 250 } }]));
    await waitFor(() => expect(rpcMock.callsOf('images.stats').length).toBeGreaterThan(before));
    await waitFor(() => expect(screen.getByTestId('image-cache-size').textContent).toBe('120 MB of 250 MB'));
    expect((screen.getByLabelText('Limit') as HTMLSelectElement).value).toBe('250');
  });

  it('lists a cap set elsewhere among the choices', async () => {
    current = settings({ imageCacheMaxMb: 750 });
    renderRow();
    await screen.findByTestId('image-cache-size');
    await waitFor(() => expect((screen.getByLabelText('Limit') as HTMLSelectElement).value).toBe('750'));
  });
});

describe('image cache formatting', () => {
  it('uses the cap units for sizes', () => {
    expect(formatCacheBytes(0, 'en')).toBe('0 MB');
    expect(formatCacheBytes(Number.NaN, 'en')).toBe('0 MB');
    expect(formatCacheBytes(300, 'en')).toBe('1 kB');
    expect(formatCacheBytes(640 * 1024, 'en')).toBe('640 kB');
    expect(formatCacheBytes(Math.round(2.5 * MIB), 'en')).toBe('2.5 MB');
    expect(formatCacheBytes(120 * MIB, 'en')).toBe('120 MB');
    expect(formatCacheBytes(1200 * MIB, 'en')).toBe('1.2 GB');
    expect(formatCacheMb(250, 'en')).toBe('250 MB');
    expect(formatCacheMb(1000, 'en')).toBe('1 GB');
    expect(formatCacheMb(2500, 'en')).toBe('2.5 GB');
    expect(formatCacheMb(2500, 'de')).toMatch(/^2,5\sGB$/u);
  });

  it('adds an in-range cap that is not a preset, in order, and ignores bad ones', () => {
    expect(capOptions(750, 'en').map((o) => o.value)).toEqual(['250', '500', '750', '1000', '2000', '5000']);
    expect(capOptions(10, 'en').map((o) => o.value)).toEqual(['250', '500', '1000', '2000', '5000']);
    expect(capOptions(undefined, 'en')).toHaveLength(5);
  });

  it('formats the picture count per locale with plural forms', async () => {
    await Promise.all(['ru', 'ar'].map((c) => loadLanguage(c)));
    const en = i18next.getFixedT('en', 'settings');
    expect(en('imageCachePictures', { count: 1 })).toBe('1 picture');
    expect(en('imageCachePictures', { count: 12345 })).toBe('12,345 pictures');
    const ru = i18next.getFixedT(i18nextLng('ru'), 'settings');
    expect(ru('imageCachePictures', { count: 5 })).toBe('5 изображений');
    expect(ru('imageCachePictures', { count: 22 })).toBe('22 изображения');
    const ar = i18next.getFixedT(i18nextLng('ar'), 'settings');
    expect(ar('imageCachePictures', { count: 2 })).toBe('صورتان');
  });
});
