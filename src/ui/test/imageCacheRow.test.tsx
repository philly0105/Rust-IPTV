import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { imageCacheGeneration, imageUrl } from '@/api/images';
import { queryClient, rpcKey } from '@/api/query';
import { RpcError } from '@/api/transport';
import type { ImageCacheStats, Settings } from '@/api/types';
import { i18nextLng, loadLanguage } from '@/i18n';
import i18next from 'i18next';

import { capOptions, formatCacheBytes, formatCacheMb, ImageCacheRow } from '@/features/settings/sections/ImageCacheRow';
import { installDomStubs, pending, renderAt, rpcMock, settings } from '@/features/sources/test/harness';
import { useToastStore } from '@/ui';

// Settings > General: the image cache row (Run 3 C3). I-integration mounts it; this renders it alone.

const mode = vi.hoisted(() => ({ desktop: false }));
const events = vi.hoisted(() => new Map<string, Set<(payload: unknown) => void>>());

vi.mock('@/api/transport', async (orig) => ({
  ...(await orig<typeof import('@/api/transport')>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  get isDesktop() {
    return mode.desktop;
  },
}));
vi.mock('@/api/events', () => ({
  onAppEvent: (type: string, handler: (payload: unknown) => void) => {
    const set = events.get(type) ?? new Set();
    events.set(type, set);
    set.add(handler);
    return () => set.delete(handler);
  },
  onAnyAppEvent: () => () => undefined,
  onConnectionState: () => () => undefined,
}));

const emit = (type: string, payload: unknown) => act(() => events.get(type)?.forEach((h) => h(payload)));

const MIB = 1024 * 1024;
let current: Settings;
let stats: ImageCacheStats;

const renderRow = () => renderAt([{ path: '/', element: <ImageCacheRow /> }], '/');
const toasts = () => useToastStore.getState().toasts;
const meter = () => screen.getByRole('meter', { name: 'Image cache' });

beforeAll(installDomStubs);
beforeEach(() => {
  rpcMock.reset();
  mode.desktop = false;
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
    expect(screen.getByTestId('image-cache-clear').getAttribute('aria-disabled')).toBeNull();
  });

  it('names the meter and the row from the heading, and leaves no label without a control', async () => {
    const { container } = renderRow();
    const labelsResolve = () =>
      [...container.querySelectorAll('label')].every((l) => {
        const control = l.htmlFor ? document.getElementById(l.htmlFor) : null;
        return !!control && ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'METER', 'OUTPUT', 'PROGRESS'].includes(control.tagName);
      });
    // Loading: no label points at nothing.
    expect(screen.getByTestId('image-cache-loading')).toBeTruthy();
    expect(labelsResolve()).toBe(true);
    await screen.findByTestId('image-cache-size');
    expect(labelsResolve()).toBe(true);
    const row = screen.getByRole('group', { name: 'Image cache' });
    expect(row.dataset.testid).toBe('image-cache-row');
    const m = meter();
    expect(m.hasAttribute('aria-label')).toBe(false);
    expect(document.getElementById(m.getAttribute('aria-labelledby')!)!.textContent).toBe('Image cache');
    expect(document.getElementById(m.getAttribute('aria-describedby')!)!.textContent).toContain('Posters, logos and backdrops');
  });

  it('says where the files live: this server in server mode, this device on desktop', async () => {
    renderRow();
    await screen.findByTestId('image-cache-size');
    const row = screen.getByTestId('image-cache-row');
    expect(row.textContent).toContain('kept on this server and shared by every browser that uses it');
    expect(row.textContent).not.toContain('this device');
    cleanup();
    mode.desktop = true;
    renderRow();
    await screen.findByTestId('image-cache-size');
    expect(screen.getByTestId('image-cache-row').textContent).toContain('kept on this device');
  });

  it('designs the empty state: no count, an empty meter and Clear disabled', async () => {
    stats = { bytes: 0, files: 0, maxBytes: 500 * MIB };
    renderRow();
    const files = await screen.findByTestId('image-cache-files');
    expect(files.textContent).toBe('Empty. Pictures are saved as you browse.');
    expect(screen.getByTestId('image-cache-size').textContent).toBe('0 MB of 500 MB');
    expect((screen.getByTestId('image-cache-meter').firstElementChild as HTMLElement).style.width).toBe('0%');
    // Unavailable but still focusable (see 'keeps keyboard focus on Clear after clearing').
    const clear = screen.getByTestId('image-cache-clear') as HTMLButtonElement;
    expect(clear.getAttribute('aria-disabled')).toBe('true');
    expect(clear.disabled).toBe(false);
    fireEvent.click(clear);
    expect(screen.queryByTestId('image-cache-clear-dialog')).toBeNull();
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
    expect(dialog.textContent).toContain('This removes 120 MB of saved pictures from the server.');
    expect(rpcMock.callsOf('images.clear')).toHaveLength(0);
    fireEvent.click(screen.getByTestId('image-cache-clear-confirm'));
    await waitFor(() => expect(rpcMock.callsOf('images.clear')).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId('image-cache-files').textContent).toBe('Empty. Pictures are saved as you browse.'));
    expect(screen.getByTestId('image-cache-size').textContent).toBe('0 MB of 500 MB');
    await waitFor(() => expect(screen.queryByTestId('image-cache-clear-dialog')).toBeNull());
    expect(toasts().map((t) => [t.variant, t.title])).toEqual([['success', 'Image cache cleared']]);
  });

  it('confirms like the other destructive clears: danger button, the text as the description, no empty band', async () => {
    mode.desktop = true;
    renderRow();
    fireEvent.click(await screen.findByTestId('image-cache-clear'));
    const dialog = await screen.findByTestId('image-cache-clear-dialog');
    expect(screen.getByTestId('image-cache-clear-confirm').className).toContain('bg-danger');
    const description = document.getElementById(dialog.getAttribute('aria-describedby')!)!;
    expect(description.textContent).toBe("This removes 120 MB of saved pictures. Each one downloads again the next time it's shown.");
    // Title row and footer only: no body wrapper padding out an empty band.
    expect(dialog.children).toHaveLength(2);
  });

  it('keeps keyboard focus on Clear after clearing, though there is nothing left to clear', async () => {
    rpcMock.handlers['images.clear'] = () => ({ bytes: 0, files: 0, maxBytes: 500 * MIB });
    renderRow();
    const clear = await screen.findByTestId('image-cache-clear');
    clear.focus();
    fireEvent.click(clear);
    await screen.findByTestId('image-cache-clear-dialog');
    expect(document.activeElement).not.toBe(clear);
    fireEvent.click(screen.getByTestId('image-cache-clear-confirm'));
    await waitFor(() => expect(screen.queryByTestId('image-cache-clear-dialog')).toBeNull());
    expect(screen.getByTestId('image-cache-clear').getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(screen.getByTestId('image-cache-clear'));
  });

  it('makes this browser fetch every picture again after a clear (new cache URLs)', async () => {
    rpcMock.handlers['images.clear'] = () => ({ bytes: 0, files: 0, maxBytes: 500 * MIB });
    const art = 'http://cdn.example/poster-after-clear.jpg';
    const gen = imageCacheGeneration();
    const before = imageUrl(art, 's1');
    renderRow();
    fireEvent.click(await screen.findByTestId('image-cache-clear'));
    fireEvent.click(await screen.findByTestId('image-cache-clear-confirm'));
    await waitFor(() => expect(imageCacheGeneration()).toBe(gen + 1));
    const after = imageUrl(art, 's1')!;
    expect(after).not.toBe(before);
    expect(new URL(after, 'http://app.test').searchParams.get('gen')).toBe(String(gen + 1));
    expect(localStorage.getItem('tsrust.imageCacheGen')).toBe(String(gen + 1));
  });

  it('a failed clear keeps the generation, so cached copies stay valid', async () => {
    rpcMock.handlers['images.clear'] = () => {
      throw new RpcError('io', 'locked');
    };
    const gen = imageCacheGeneration();
    renderRow();
    fireEvent.click(await screen.findByTestId('image-cache-clear'));
    fireEvent.click(await screen.findByTestId('image-cache-clear-confirm'));
    await waitFor(() => expect(toasts()).toHaveLength(1));
    expect(imageCacheGeneration()).toBe(gen);
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

  it('follows a cap changed without the select (Reset, Undo): the stats are read again', async () => {
    renderRow();
    await waitFor(() => expect(screen.getByTestId('image-cache-size').textContent).toBe('120 MB of 500 MB'));
    const before = rpcMock.callsOf('images.stats').length;
    // useResetSettings and the Undo toast write the settings cache, not this row.
    current = { ...current, imageCacheMaxMb: 2000 };
    stats = { bytes: 120 * MIB, files: 1234, maxBytes: 2000 * MIB };
    act(() => queryClient.setQueryData(rpcKey('settings.get'), current));
    await waitFor(() => expect(rpcMock.callsOf('images.stats').length).toBeGreaterThan(before));
    await waitFor(() => expect(screen.getByTestId('image-cache-size').textContent).toBe('120 MB of 2 GB'));
    expect(meter().getAttribute('aria-valuemax')).toBe(String(2000 * MIB));
    expect((screen.getByLabelText('Limit') as HTMLSelectElement).value).toBe('2000');
    // Settled: one refetch, no loop.
    const settled = rpcMock.callsOf('images.stats').length;
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(rpcMock.callsOf('images.stats')).toHaveLength(settled);
  });

  it('reads the stats again when another client changes the cap (settings.changed)', async () => {
    renderRow();
    await waitFor(() => expect(screen.getByTestId('image-cache-size').textContent).toBe('120 MB of 500 MB'));
    const before = rpcMock.callsOf('images.stats').length;
    // An unrelated settings change asks for nothing.
    emit('settings.changed', { ...current, theme: 'light' });
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(rpcMock.callsOf('images.stats')).toHaveLength(before);
    current = { ...current, imageCacheMaxMb: 250 };
    stats = { bytes: 120 * MIB, files: 1234, maxBytes: 250 * MIB };
    // The shell's own settings.changed handler (not mounted here) rewrites the settings cache; this row only has to
    // ask the core again, so the meter's maximum is the core's new figure.
    emit('settings.changed', current);
    await waitFor(() => expect(rpcMock.callsOf('images.stats').length).toBeGreaterThan(before));
    await waitFor(() => expect(meter().getAttribute('aria-valuemax')).toBe(String(250 * MIB)));
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
