import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';

const env = vi.hoisted(() => ({ desktop: false }));
const rpcMock = vi.hoisted(() => vi.fn(async (_name: string, _args?: unknown): Promise<unknown> => undefined));
const pickPath = vi.hoisted(() => vi.fn(async (_opts: unknown): Promise<string | null> => null));

vi.mock('@/api/transport', () => ({
  rpc: (name: string, args?: unknown) => rpcMock(name, args),
  get isDesktop() {
    return env.desktop;
  },
  proxiedUrl: (s: { url: string }) => s.url,
}));
vi.mock('@/features/sources/lib/files', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/sources/lib/files')>()),
  pickPathDesktop: (opts: unknown) => pickPath(opts),
}));

const i18n = (await import('i18next')).default;
const { usePlayerStore, __resetPlayerForTests, setSettingsCache } = await import('../store');
const { useMediaStore, resetMedia } = await import('../media');
const { Controls } = await import('../components/Controls');
const lazyParts = await import('../components/lazyParts');
const tracks = await import('./tracks');
const load = await import('./load');

/** jsdom has no TextTrack or VTTCue: small stand-ins with the parts the player uses. */
class FakeCue {
  snapToLines = true;
  line: number | 'auto' = 'auto';
  lineAlign = 'start';
  constructor(
    public startTime: number,
    public endTime: number,
    public text: string,
  ) {}
}

interface FakeTrack {
  kind: string;
  label: string;
  mode: TextTrackMode;
  cues: FakeCue[] | null;
  addCue(c: FakeCue): void;
  removeCue(c: FakeCue): void;
}

function fakeElement(): { el: HTMLMediaElement; added: FakeTrack[] } {
  const added: FakeTrack[] = [];
  const el = {
    addTextTrack(kind: string, label: string) {
      const store: FakeCue[] = [];
      const t: FakeTrack = {
        kind,
        label,
        mode: 'hidden',
        // Like the real thing, a disabled track hides its cue list.
        get cues() {
          return this.mode === 'disabled' ? null : store;
        },
        addCue(c) {
          if (this.mode === 'disabled') throw new Error('InvalidStateError');
          store.push(c);
        },
        removeCue(c) {
          store.splice(store.indexOf(c), 1);
        },
      };
      added.push(t);
      return t as unknown as TextTrack;
    },
  } as unknown as HTMLMediaElement;
  return { el, added };
}

const engineTracks = { qualities: [], qualityAuto: true, audio: [], text: [{ id: '1', label: 'English', selected: true }] };

function target(el: HTMLMediaElement) {
  const engine = { setText: vi.fn() };
  const t = {
    el,
    engine: () => engine as never,
    publish: () => useMediaStore.setState({ tracks: tracks.withExternal(el, engineTracks) }),
  };
  return { t, engine };
}

const commands = { setQuality: vi.fn(), setAudio: vi.fn(), setText: vi.fn(), setRate: vi.fn(), togglePip: vi.fn(), retry: vi.fn() };
const srt = '1\n00:00:01,000 --> 00:00:02,500\nHello <i>there</i> & you\n\n2\n00:00:03,000 --> 00:00:04,000\nSecond\n';
let unTarget: (() => void) | null = null;

beforeAll(async () => {
  vi.stubGlobal('VTTCue', FakeCue);
  await Promise.all([lazyParts.SubtitleTrackMenu.preload(), lazyParts.SubtitleStyleMenu.preload()]);
});

beforeEach(() => {
  __resetPlayerForTests();
  resetMedia();
  vi.clearAllMocks();
  env.desktop = false;
  setSettingsCache({ subtitleSize: 'medium', subtitleColor: 'white', subtitleBackground: 'box', subtitlePosition: 10 } as never);
  act(() => {
    usePlayerStore.setState({
      source: { url: 'http://v/movie.mp4', kind: 'direct', title: 'Movie', isLive: false, isRadio: false },
      status: 'playing',
      positionSeconds: 10,
      durationSeconds: 600,
    });
    useMediaStore.setState({ commands, tracks: engineTracks });
  });
});

afterEach(() => {
  cleanup();
  unTarget?.();
  unTarget = null;
  __resetPlayerForTests();
  resetMedia();
  useMediaStore.setState({ commands: null });
});

describe('loaded subtitle files in the built-in player', () => {
  it('adds the file as a selected text track, turning the engine track off', () => {
    const { el, added } = fakeElement();
    const { t, engine } = target(el);
    const id = load.showCues(t, 'movie.srt', [
      { start: 1, end: 2.5, text: 'Hello <there> & you' },
      { start: 3, end: 4, text: 'Second' },
    ]);
    expect(id).toBe('ext:0');
    expect(engine.setText).toHaveBeenCalledWith(null);
    const track = added[0]!;
    expect(track.kind).toBe('subtitles');
    expect(track.mode).toBe('showing');
    expect(track.cues?.map((c) => [c.startTime, c.endTime, c.text])).toEqual([
      [1, 2.5, 'Hello &lt;there&gt; &amp; you'],
      [3, 4, 'Second'],
    ]);
    // Placed at the user's position (10): line 80, measured from the cue's bottom edge.
    expect(track.cues?.[0]).toMatchObject({ snapToLines: false, line: 80, lineAlign: 'end' });
    expect(useMediaStore.getState().tracks.text).toEqual([
      { id: '1', label: 'English', selected: false },
      { id: 'ext:0', label: 'movie.srt', selected: true },
    ]);
    expect(useMediaStore.getState().captionsOn).toBe(true);
  });

  it('switches between the file and the stream track, and a new item empties the files', () => {
    const { el, added } = fakeElement();
    const { t, engine } = target(el);
    load.showCues(t, 'a.srt', [{ start: 0, end: 1, text: 'A' }]);
    load.showCues(t, 'b.vtt', [{ start: 0, end: 1, text: 'B' }]);
    expect(added.map((x) => x.mode)).toEqual(['disabled', 'showing']);

    tracks.selectText(el, engine as never, '1');
    expect(engine.setText).toHaveBeenLastCalledWith('1');
    expect(added.map((x) => x.mode)).toEqual(['disabled', 'disabled']);

    tracks.selectText(el, engine as never, 'ext:0');
    expect(engine.setText).toHaveBeenLastCalledWith(null);
    expect(added.map((x) => x.mode)).toEqual(['showing', 'disabled']);

    tracks.clearExternal(el);
    expect(added.map((x) => x.mode)).toEqual(['disabled', 'disabled']);
    for (const x of added) x.mode = 'hidden';
    expect(added.map((x) => x.cues?.length)).toEqual([0, 0]);
    expect(tracks.externalTracks(el)).toEqual([]);
    expect(tracks.withExternal(el, engineTracks)).toBe(engineTracks);
  });

  it('shows the file in the Subtitles menu with load and style entries, and picks tracks from it', () => {
    const { el } = fakeElement();
    const { t } = target(el);
    act(() => {
      load.showCues(t, 'movie.srt', [{ start: 1, end: 2, text: 'Hi' }]);
    });
    render(<Controls variant="dock" visible />);
    fireEvent.click(screen.getByRole('button', { name: 'Playback options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /^subtitles/i }));

    expect(screen.getByRole('menuitemradio', { name: 'movie.srt' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('menuitemradio', { name: 'English' }).getAttribute('aria-checked')).toBe('false');
    expect(screen.getByRole('menuitemradio', { name: 'Off' }).getAttribute('aria-checked')).toBe('false');
    expect(screen.getByTestId('subtitle-load').textContent).toBe(i18n.t('player:subtitleLoad'));

    fireEvent.click(screen.getByRole('menuitemradio', { name: 'English' }));
    expect(commands.setText).toHaveBeenCalledWith('1');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('keeps the Subtitles row for streams without tracks and opens the compact style view', () => {
    act(() => useMediaStore.setState({ tracks: { qualities: [], qualityAuto: true, audio: [], text: [] } }));
    render(<Controls variant="dock" visible />);
    fireEvent.click(screen.getByRole('button', { name: 'Playback options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /^subtitles/i }));
    expect(screen.getByTestId('subtitle-menu-empty')).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: i18n.t('player:subtitleStyle.menu') }));
    expect(screen.getByTestId('subtitle-style-menu')).toBeTruthy();
    expect(screen.getByTestId('subtitle-size').querySelector('[aria-checked="true"]')?.getAttribute('data-value')).toBe('medium');

    // A choice saves through settings.update and shows at once.
    fireEvent.click(screen.getByRole('radio', { name: i18n.t('player:subtitleStyle.colorYellow') }));
    expect(rpcMock).toHaveBeenCalledWith('settings.update', { patch: { subtitleColor: 'yellow' } });
    expect(screen.getByTestId('subtitle-color').querySelector('[aria-checked="true"]')?.getAttribute('data-value')).toBe('yellow');

    // Escape steps back to the track list, not out of the menu.
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.getByTestId('subtitle-menu')).toBeTruthy();
  });

  it('Shift+C asks the controls to open the Subtitles menu', () => {
    render(<Controls variant="dock" visible />);
    act(() => useMediaStore.setState({ subtitleMenuAt: Date.now() }));
    expect(screen.getByTestId('subtitle-menu')).toBeTruthy();
    expect(useMediaStore.getState().subtitleMenuAt).toBeUndefined();
  });
});

describe('reading subtitle files', () => {
  const file = (text: string, name: string): File => new File([text], name, { type: 'text/plain' });

  it('parses a picked file and reports why a file was refused', async () => {
    await expect(load.readSubtitleFile(file(srt, 'movie.srt'))).resolves.toHaveLength(2);
    const big = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'huge.srt');
    await expect(load.readSubtitleFile(big)).rejects.toMatchObject({ problem: 'tooLarge' });
    await expect(load.readSubtitleFile(file('hello', 'notes.txt'))).rejects.toMatchObject({ problem: 'unknownFormat' });
    await expect(load.readSubtitleFile(file('nothing here', 'empty.srt'))).rejects.toMatchObject({ problem: 'noCues' });
  });

  it('loads into the showing player and ignores a file that arrives after the item changed', async () => {
    const { el, added } = fakeElement();
    const { t } = target(el);
    unTarget = tracks.setInlineSubtitleTarget(t);
    const tr = i18n.getFixedT('en', 'player');
    await expect(load.loadIntoInline(t, file(srt, 'movie.srt'), tr)).resolves.toBe(true);
    expect(added).toHaveLength(1);

    unTarget();
    unTarget = null;
    await expect(load.loadIntoInline(t, file(srt, 'late.srt'), tr)).resolves.toBe(false);
    expect(added).toHaveLength(1);
    await expect(load.loadIntoInline(t, file('nothing', 'bad.srt'), tr)).resolves.toBe(false);
  });

  it('embedded mpv: picks a path in the native dialog and hands it to mpv.addSubtitle', async () => {
    env.desktop = true;
    usePlayerStore.setState({ mode: 'embedded-mpv' });
    pickPath.mockResolvedValueOnce('C:\\Subs\\film.ass');
    const tr = i18n.getFixedT('en', 'player');
    await expect(load.loadSubtitleFile(tr)).resolves.toBe(true);
    expect(pickPath).toHaveBeenCalledWith(expect.objectContaining({ extensions: ['srt', 'vtt', 'ass', 'ssa'] }));
    expect(rpcMock).toHaveBeenCalledWith('mpv.addSubtitle', { path: 'C:\\Subs\\film.ass' });

    // Cancelled dialog: nothing is sent.
    rpcMock.mockClear();
    pickPath.mockResolvedValueOnce(null);
    await expect(load.loadSubtitleFile(tr)).resolves.toBe(false);
    expect(rpcMock).not.toHaveBeenCalledWith('mpv.addSubtitle', expect.anything());
  });

  it('embedded mpv: the subtitle look goes out as checked properties, again when it changes', async () => {
    const { sendSubtitleStyle, bindMpvExtras } = await import('../mpvExtras');
    const sent = (): unknown[] => rpcMock.mock.calls.filter((c) => c[0] === 'mpv.setProperty').map((c) => c[1]);
    await sendSubtitleStyle();
    expect(sent()).toEqual([
      { name: 'sub-ass-override', value: 'scale' },
      { name: 'sub-scale', value: 1 },
      { name: 'sub-color', value: '#FFFFFF' },
      { name: 'sub-border-style', value: 'background-box' },
      { name: 'sub-back-color', value: '#B8000000' },
      { name: 'sub-border-size', value: 3 },
      { name: 'sub-shadow-offset', value: 0 },
      { name: 'sub-pos', value: 90 },
    ]);

    const unbind = bindMpvExtras();
    await vi.waitFor(() => expect(sent()).toHaveLength(16));
    // Another setting changing sends nothing; a style change sends the set again.
    setSettingsCache({ subtitleSize: 'medium', subtitleColor: 'white', subtitleBackground: 'box', subtitlePosition: 10, zapBanner: false } as never);
    setSettingsCache({ subtitleSize: 'large', subtitleColor: 'white', subtitleBackground: 'box', subtitlePosition: 10 } as never);
    await vi.waitFor(() => expect(sent()).toHaveLength(24));
    expect(sent()).toContainEqual({ name: 'sub-scale', value: 1.25 });
    unbind();
  });

  it('with no video showing, says so instead of opening a file chooser', async () => {
    const tr = i18n.getFixedT('en', 'player');
    const click = vi.spyOn(HTMLInputElement.prototype, 'click');
    await expect(load.loadSubtitleFile(tr)).resolves.toBe(false);
    expect(click).not.toHaveBeenCalled();
    click.mockRestore();
  });
});
