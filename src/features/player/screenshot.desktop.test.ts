/**
 * Screenshots in the desktop app (C6): the built-in player's frame goes to `screenshot.save`
 * as base64, the toast offers Open, and a tainted frame points at embedded MPV.
 */
import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import '@/i18n';

vi.mock('@/api/transport', () => ({
  rpc: vi.fn(() => Promise.reject(new Error('offline'))),
  isDesktop: true,
  proxiedUrl: (s: { url: string }) => s.url,
}));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined }));
vi.mock('@/ui/Toast', () => ({ toast: vi.fn(() => 'toast') }));

const { rpc } = await import('@/api/transport');
const { toast } = await import('@/ui/Toast');
const { usePlayerStore, __resetPlayerForTests } = await import('./store');
const { resetMedia, useMediaStore } = await import('./media');
const shot = await import('./screenshot');

const rpcMock = rpc as unknown as Mock;
const toastMock = toast as unknown as Mock;

const vod = { url: 'http://h/m.mp4', kind: 'direct' as const, title: 'Movie', isLive: false, isRadio: false };
const SAVED = { path: 'C:\\Users\\me\\Pictures\\Tsrust IPTV\\Movie 2026-10-14 21-00-00.png', fileName: 'Movie 2026-10-14 21-00-00.png' };

let blobFor: (type: string) => Blob;

beforeEach(() => {
  __resetPlayerForTests();
  resetMedia();
  rpcMock.mockReset();
  toastMock.mockClear();
  blobFor = (type) => new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({ drawImage: vi.fn() }) as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (cb: BlobCallback, type?: string) {
    cb(blobFor(type ?? 'image/png'));
  });
  const v = document.createElement('video');
  v.setAttribute('data-player-video', '');
  Object.defineProperties(v, { videoWidth: { value: 1280 }, videoHeight: { value: 720 }, readyState: { value: 4 } });
  document.body.append(v);
  act(() => usePlayerStore.setState({ source: vod, mode: 'inline', status: 'playing' }));
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
  __resetPlayerForTests();
  resetMedia();
});

describe('takeScreenshot in the desktop app', () => {
  it('saves the frame through the core and offers to open it', async () => {
    rpcMock.mockImplementation(async (name: string) => (name === 'screenshot.save' ? SAVED : undefined));
    await shot.takeScreenshot();
    // 89 50 4E 47 in base64, without a data-URL prefix.
    expect(rpcMock).toHaveBeenCalledWith('screenshot.save', { dataBase64: 'iVBORw==', format: 'png', title: 'Movie' });
    const opts = toastMock.mock.calls[0]![0] as { title: string; description: string; action: { label: string; onClick: () => void } };
    expect(opts).toMatchObject({ title: 'Screenshot saved', description: SAVED.fileName, variant: 'success' });
    // One report: the toast shows in player full screen too, so the OSD stays quiet.
    expect(useMediaStore.getState().osd).toBeUndefined();
    opts.action.onClick();
    expect(rpcMock).toHaveBeenLastCalledWith('screenshot.open', { path: SAVED.path });
  });

  it('says so when the saved file cannot be opened', async () => {
    rpcMock.mockImplementation(async (name: string) => {
      if (name === 'screenshot.save') return SAVED;
      throw new Error('No app is set to open PNG files.');
    });
    await shot.takeScreenshot();
    const opts = toastMock.mock.calls[0]![0] as { action: { onClick: () => void } };
    opts.action.onClick();
    await vi.waitFor(() =>
      expect(toastMock).toHaveBeenLastCalledWith({
        title: 'Could not open the screenshot',
        description: 'No app is set to open PNG files.',
        variant: 'error',
      }),
    );
  });

  it('points a tainted frame at embedded MPV', async () => {
    blobFor = () => {
      throw new DOMException('tainted', 'SecurityError');
    };
    await shot.takeScreenshot();
    expect(rpcMock).not.toHaveBeenCalled();
    expect(toastMock).toHaveBeenCalledWith({
      title: 'Screenshot not saved',
      description:
        "The stream's server does not allow its picture to be copied (no CORS permission). Embedded MPV can capture it: choose it in Settings > Players.",
      variant: 'error',
    });
  });
});
