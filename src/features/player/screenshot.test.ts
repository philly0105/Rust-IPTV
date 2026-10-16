/**
 * Screenshots in server mode (C6): file names, why a capture is blocked, the canvas capture
 * (PNG, JPEG over the limit, a tainted frame), the download and its toast, and embedded mpv.
 * The desktop save path is in screenshot.desktop.test.ts (`isDesktop` is a module constant).
 */
import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import '@/i18n';

vi.mock('@/api/transport', () => ({
  rpc: vi.fn(() => Promise.reject(new Error('offline'))),
  isDesktop: false,
  proxiedUrl: (s: { url: string }) => s.url,
}));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined }));
vi.mock('@/ui/Toast', () => ({ toast: vi.fn(() => 'toast') }));

const { rpc } = await import('@/api/transport');
const { toast } = await import('@/ui/Toast');
const { usePlayerStore, __resetPlayerForTests } = await import('./store');
const { useMediaStore, resetMedia } = await import('./media');
const { usePipStore } = await import('./pip');
const shot = await import('./screenshot');

const rpcMock = rpc as unknown as Mock;
const toastMock = toast as unknown as Mock;

const vod = { url: 'http://h/m.mp4', kind: 'direct' as const, title: 'Movie', subtitle: 'Part 1', isLive: false, isRadio: false };
const radio = { url: 'http://h/r.mp3', kind: 'direct' as const, title: 'Jazz FM', isLive: true, isRadio: true };
const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A `<video data-player-video>` with a decoded frame of `w` x `h` (jsdom has no media). */
function playerVideo(w = 1280, h = 720, readyState = 4): HTMLVideoElement {
  const v = document.createElement('video');
  v.setAttribute('data-player-video', '');
  Object.defineProperties(v, {
    videoWidth: { value: w },
    videoHeight: { value: h },
    readyState: { value: readyState },
  });
  document.body.append(v);
  return v;
}

let drawImage: Mock;
/** What canvas.toBlob hands back per type; a function may throw (a tainted canvas). */
let blobFor: (type: string) => Blob;

beforeEach(() => {
  __resetPlayerForTests();
  resetMedia();
  useMediaStore.setState({ osd: undefined });
  rpcMock.mockReset();
  toastMock.mockClear();
  drawImage = vi.fn();
  blobFor = (type) => new Blob([new Uint8Array(PNG_BYTES)], { type });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({ drawImage }) as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (cb: BlobCallback, type?: string) {
    cb(blobFor(type ?? 'image/png'));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.replaceChildren();
  __resetPlayerForTests();
  resetMedia();
  usePipStore.setState({ active: false });
});

describe('file names', () => {
  it('is the title and the local time, with the characters Windows refuses replaced', () => {
    const at = new Date(2026, 9, 14, 9, 5, 3);
    expect(shot.screenshotFileName('News: 24/7 <HD>?', at, 'png')).toBe('News_ 24_7 _HD__ 2026-10-14 09-05-03.png');
    expect(shot.screenshotFileName('  Tab\there \n', at, 'jpg')).toBe('Tab here 2026-10-14 09-05-03.jpg');
  });

  it('cuts long titles at 80 characters, drops trailing dots, and names an empty title', () => {
    const at = new Date(2026, 0, 2, 3, 4, 5);
    const long = shot.screenshotFileName('x'.repeat(200), at, 'png');
    expect(long).toBe(`${'x'.repeat(80)} 2026-01-02 03-04-05.png`);
    expect(shot.screenshotFileName('Ends with dots...', at, 'png')).toBe('Ends with dots 2026-01-02 03-04-05.png');
    expect(shot.screenshotFileName(' ... ', at, 'png')).toBe('Screenshot 2026-01-02 03-04-05.png');
  });

  it('titles a picture with the programme or episode after the channel or show', () => {
    expect(shot.screenshotTitle(vod)).toBe('Movie - Part 1');
    expect(shot.screenshotTitle({ title: 'Same', subtitle: 'Same' })).toBe('Same');
    expect(shot.screenshotTitle({ title: ' Only ' })).toBe('Only');
  });
});

describe('what blocks a screenshot', () => {
  it('nothing playing, an external player, and radio', () => {
    expect(shot.screenshotBlock({ source: null, mode: 'inline' })).toBe('idle');
    expect(shot.screenshotBlock({ source: vod, mode: 'external' })).toBe('external');
    expect(shot.screenshotBlock({ source: radio, mode: 'radio' })).toBe('radio');
    expect(shot.screenshotBlock({ source: radio, mode: 'inline' })).toBe('radio');
    expect(shot.screenshotBlock({ source: vod, mode: 'inline' })).toBeNull();
    expect(shot.screenshotBlock({ source: vod, mode: 'embedded-mpv' })).toBeNull();
    expect(shot.blockReasonKey('external')).toBe('screenshotExternal');
    expect(shot.blockReasonKey('radio')).toBe('screenshotNoVideo');
  });

  it('explains the block instead of capturing', async () => {
    act(() => usePlayerStore.setState({ source: radio, mode: 'radio', status: 'playing' }));
    await shot.takeScreenshot();
    expect(rpcMock).not.toHaveBeenCalled();
    expect(toastMock).toHaveBeenCalledWith({ title: 'Radio has no picture to capture.', variant: 'info' });
    // One message: the toast shows in player full screen too, so no OSD copy (X-desk-3).
    expect(useMediaStore.getState().osd).toBeUndefined();

    act(() => usePlayerStore.setState({ source: vod, mode: 'external' }));
    await shot.takeScreenshot();
    expect(toastMock).toHaveBeenLastCalledWith({ title: 'This plays in an external player. Use its own screenshot key.', variant: 'info' });
  });

  it('repeats the reason on the OSD in picture-in-picture, where the player covers its toasts', () => {
    usePipStore.setState({ active: true });
    shot.explainBlock('radio');
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(useMediaStore.getState().osd).toMatchObject({ primary: 'Take screenshot', secondary: 'Radio has no picture to capture.' });
  });
});

describe('captureFrame', () => {
  it('draws the frame at the stream size and encodes PNG', async () => {
    const video = playerVideo(1920, 1080);
    const { blob, format } = await shot.captureFrame(video);
    expect(format).toBe('png');
    expect(blob.type).toBe('image/png');
    expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 1920, 1080);
  });

  it('falls back to JPEG when the PNG is over the core limit', async () => {
    blobFor = (type) =>
      type === 'image/png' ? ({ size: shot.MAX_SCREENSHOT_BYTES + 1, type } as Blob) : new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type });
    const { blob, format } = await shot.captureFrame(playerVideo());
    expect(format).toBe('jpeg');
    expect(blob.type).toBe('image/jpeg');
  });

  it('says there is no picture yet before the first frame', async () => {
    await expect(shot.captureFrame(playerVideo(0, 0, 4))).rejects.toMatchObject({ key: 'screenshotNotReady' });
    await expect(shot.captureFrame(playerVideo(640, 360, 1))).rejects.toMatchObject({ key: 'screenshotNotReady' });
    expect(drawImage).not.toHaveBeenCalled();
  });

  it('names CORS when the frame taints the canvas', async () => {
    blobFor = () => {
      throw new DOMException('The canvas has been tainted by cross-origin data.', 'SecurityError');
    };
    await expect(shot.captureFrame(playerVideo())).rejects.toMatchObject({ key: 'screenshotCors' });
  });
});

describe('takeScreenshot in server mode', () => {
  it('downloads the PNG and says it is in the downloads', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const created: Blob[] = [];
    const revoke = vi.fn();
    Object.assign(URL, {
      createObjectURL: (b: Blob) => (created.push(b), 'blob:shot'),
      revokeObjectURL: revoke,
    });
    const clicks: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push(this);
    });
    playerVideo();
    act(() => usePlayerStore.setState({ source: vod, mode: 'inline', status: 'playing' }));

    await shot.takeScreenshot();

    expect(rpcMock).not.toHaveBeenCalled();
    expect(clicks).toHaveLength(1);
    const name = clicks[0]!.download;
    expect(name).toMatch(/^Movie - Part 1 \d{4}-\d\d-\d\d \d\d-\d\d-\d\d\.png$/);
    expect(clicks[0]!.href).toBe('blob:shot');
    expect(created[0]!.size).toBe(PNG_BYTES.length);
    // The link is gone; the object URL lives a minute for slow download starts.
    expect(document.querySelector('a[download]')).toBeNull();
    expect(toastMock).toHaveBeenCalledWith({ title: 'Saved to your downloads', description: name, variant: 'success' });
    // The toast shows in player full screen too (ui/portal.ts): no second copy on the OSD.
    expect(useMediaStore.getState().osd).toBeUndefined();
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(revoke).toHaveBeenCalledWith('blob:shot');
  });

  it('names CORS in the failure toast (no mpv hint outside the desktop app)', async () => {
    blobFor = () => {
      throw new DOMException('tainted', 'SecurityError');
    };
    playerVideo();
    act(() => usePlayerStore.setState({ source: vod, mode: 'inline', status: 'playing' }));
    await shot.takeScreenshot();
    const cors = "The stream's server does not allow its picture to be copied (no CORS permission).";
    expect(toastMock).toHaveBeenCalledWith({ title: 'Screenshot not saved', description: cors, variant: 'error' });
    expect(useMediaStore.getState().osd).toBeUndefined();
  });

  it('repeats the result on the OSD in picture-in-picture, where the player covers its toasts', async () => {
    usePipStore.setState({ active: true });
    act(() => usePlayerStore.setState({ source: vod, mode: 'inline', status: 'loading' }));
    await shot.takeScreenshot();
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(useMediaStore.getState().osd).toMatchObject({
      primary: 'Screenshot not saved',
      secondary: 'There is no picture yet. Try again once the video plays.',
    });
  });

  it('says there is no picture when the player has no video yet', async () => {
    act(() => usePlayerStore.setState({ source: vod, mode: 'inline', status: 'loading' }));
    await shot.takeScreenshot();
    expect(toastMock).toHaveBeenCalledWith({
      title: 'Screenshot not saved',
      description: 'There is no picture yet. Try again once the video plays.',
      variant: 'error',
    });
  });
});

describe('takeScreenshot with embedded mpv', () => {
  it('asks the core for the frame with subtitles, and offers to open the file', async () => {
    rpcMock.mockImplementation(async (name: string) =>
      name === 'screenshot.mpv' ? { path: 'C:\\Pictures\\Tsrust IPTV\\Movie.png', fileName: 'Movie.png' } : undefined,
    );
    act(() => usePlayerStore.setState({ source: vod, mode: 'embedded-mpv', status: 'playing' }));
    await shot.takeScreenshot();
    expect(rpcMock).toHaveBeenCalledWith('screenshot.mpv', { title: 'Movie - Part 1', withSubtitles: true });
    const opts = toastMock.mock.calls[0]![0] as { title: string; description: string; variant: string; action: { label: string; onClick: () => void } };
    expect(opts).toMatchObject({ title: 'Screenshot saved', description: 'Movie.png', variant: 'success' });
    expect(opts.action.label).toBe('Open');
    opts.action.onClick();
    expect(rpcMock).toHaveBeenLastCalledWith('screenshot.open', { path: 'C:\\Pictures\\Tsrust IPTV\\Movie.png' });
  });

  it("shows the core's error, and takes one screenshot at a time", async () => {
    let fail!: (err: Error) => void;
    rpcMock.mockImplementation(() => new Promise((_, reject) => (fail = reject)));
    act(() => usePlayerStore.setState({ source: vod, mode: 'embedded-mpv', status: 'playing' }));
    const first = shot.takeScreenshot();
    expect(shot.screenshotBusy()).toBe(true);
    await shot.takeScreenshot();
    expect(rpcMock).toHaveBeenCalledTimes(1);
    fail(new Error('The video has no picture yet.'));
    await first;
    expect(shot.screenshotBusy()).toBe(false);
    expect(toastMock).toHaveBeenCalledWith({ title: 'Screenshot not saved', description: 'The video has no picture yet.', variant: 'error' });
  });
});
