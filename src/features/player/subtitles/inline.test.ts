import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setSettingsCache } from '../store';
import { bindSubtitleOverlay, overlayBottom, plainCueText } from './inline';
import { hideDrawnTracks, isShownTrack } from './tracks';

/** jsdom has no TextTrack: a stand-in with modes, active cues and `cuechange`. */
class FakeTrack extends EventTarget {
  mode: TextTrackMode = 'disabled';
  activeCues: unknown[] = [];
  constructor(
    public kind = 'subtitles',
    public label = 'English',
  ) {
    super();
  }
}

function fakeElement(tracks: FakeTrack[]): { el: HTMLMediaElement; list: EventTarget } {
  const list = new EventTarget() as EventTarget & Record<number, FakeTrack>;
  Object.defineProperty(list, 'length', { get: () => tracks.length });
  tracks.forEach((t, i) => (list[i] = t));
  const el = Object.assign(new EventTarget(), { textTracks: list });
  return { el: el as unknown as HTMLMediaElement, list };
}

const settings = (position: number) =>
  ({ subtitleSize: 'medium', subtitleColor: 'white', subtitleBackground: 'box', subtitlePosition: position }) as never;

let box: HTMLDivElement;
let stop: (() => void) | null = null;

beforeEach(() => {
  setSettingsCache(settings(0));
  box = document.createElement('div');
  document.body.appendChild(box);
});

afterEach(() => {
  stop?.();
  stop = null;
  box.remove();
  setSettingsCache(null);
});

const cueTexts = (): string[] => Array.from(box.querySelectorAll('.player-sub-cue')).map((n) => n.textContent ?? '');

describe('subtitle overlay', () => {
  it('takes a showing track over and draws its active cues as safe text', () => {
    const track = new FakeTrack();
    track.mode = 'showing';
    track.activeCues = [{ text: 'Hello <i>there</i> &amp; <b>you</b>\nsecond line' }];
    const { el } = fakeElement([track]);
    stop = bindSubtitleOverlay(el, box);

    // The browser no longer paints it; the player does, and it still counts as on.
    expect(track.mode).toBe('hidden');
    expect(isShownTrack(track as unknown as TextTrack)).toBe(true);
    expect(cueTexts()).toEqual(['Hello there & you\nsecond line']);
    const cue = box.querySelector<HTMLElement>('.player-sub-cue')!;
    expect(cue.dir).toBe('auto');
    expect(cue.querySelector('i, b')).toBeNull();
    expect(box.querySelector<HTMLElement>('.player-subs-line')!.style.bottom).toBe('10%');
  });

  it('uses the browser-parsed cue when there is one', () => {
    const track = new FakeTrack();
    track.mode = 'showing';
    const frag = document.createDocumentFragment();
    const i = document.createElement('i');
    i.textContent = 'italic';
    frag.append(i);
    track.activeCues = [{ getCueAsHTML: () => frag, text: '<i>italic</i>' }];
    stop = bindSubtitleOverlay(fakeElement([track]).el, box);
    expect(box.querySelector('.player-sub-cue i')?.textContent).toBe('italic');
  });

  it('follows cue changes, lets a disabled track go and ignores an engine hidden track', () => {
    const shown = new FakeTrack();
    const engineHidden = new FakeTrack('captions', 'CC');
    engineHidden.mode = 'hidden';
    engineHidden.activeCues = [{ text: 'not on screen' }];
    shown.mode = 'showing';
    const { el, list } = fakeElement([shown, engineHidden]);
    stop = bindSubtitleOverlay(el, box);
    expect(cueTexts()).toEqual([]);

    shown.activeCues = [{ text: 'One' }, { text: 'Two' }];
    shown.dispatchEvent(new Event('cuechange'));
    expect(cueTexts()).toEqual(['One', 'Two']);
    expect(box.dataset.cues).toBe('2');

    shown.mode = 'disabled';
    list.dispatchEvent(new Event('change'));
    expect(cueTexts()).toEqual([]);
    expect(isShownTrack(shown as unknown as TextTrack)).toBe(false);
    // Hidden again by an engine later: not drawn, it was let go.
    shown.mode = 'hidden';
    shown.dispatchEvent(new Event('cuechange'));
    expect(cueTexts()).toEqual([]);
  });

  it('moves the line when the position setting changes and empties the box on stop', () => {
    const track = new FakeTrack();
    track.mode = 'showing';
    track.activeCues = [{ text: 'Up' }];
    stop = bindSubtitleOverlay(fakeElement([track]).el, box);
    setSettingsCache(settings(25));
    expect(box.querySelector<HTMLElement>('.player-subs-line')!.style.bottom).toBe(overlayBottom(25));
    expect(overlayBottom(25)).toBe('35%');
    stop();
    stop = null;
    expect(box.childNodes.length).toBe(0);
  });

  describe('picture-in-picture', () => {
    afterEach(() => {
      Reflect.deleteProperty(document, 'pictureInPictureElement');
    });

    const on = (text: string): { track: FakeTrack; el: HTMLMediaElement; list: EventTarget } => {
      const track = new FakeTrack();
      track.mode = 'showing';
      track.activeCues = [{ text }];
      const { el, list } = fakeElement([track]);
      stop = bindSubtitleOverlay(el, box);
      expect(track.mode).toBe('hidden');
      return { track, el, list };
    };

    it('entering shows the track natively and hides the overlay; leaving draws it again', () => {
      const { track, el, list } = on('Hi');
      expect(cueTexts()).toEqual(['Hi']);

      el.dispatchEvent(new Event('enterpictureinpicture'));
      // The PiP window draws native cues only: the track is showing for the browser again.
      expect(track.mode).toBe('showing');
      expect(box.hidden).toBe(true);
      expect(cueTexts()).toEqual([]);
      expect(isShownTrack(track as unknown as TextTrack)).toBe(true);
      // The browser's own change event and new cues leave it that way.
      list.dispatchEvent(new Event('change'));
      track.activeCues = [{ text: 'Next' }];
      track.dispatchEvent(new Event('cuechange'));
      expect(track.mode).toBe('showing');
      expect(cueTexts()).toEqual([]);

      el.dispatchEvent(new Event('leavepictureinpicture'));
      expect(track.mode).toBe('hidden');
      expect(box.hidden).toBe(false);
      expect(cueTexts()).toEqual(['Next']);
      expect(isShownTrack(track as unknown as TextTrack)).toBe(true);
    });

    it.each([
      // Native engine and files disable the track; hls.js hides it (subtitleDisplay false);
      // shaka's Off goes through hideDrawnTracks.
      ['disabled', (t: FakeTrack) => (t.mode = 'disabled')],
      ['hidden by hls.js', (t: FakeTrack) => (t.mode = 'hidden')],
      ['hideDrawnTracks', (_t: FakeTrack, el: HTMLMediaElement) => hideDrawnTracks(el)],
    ] as const)('Off while in picture-in-picture (%s) stays off after leaving', (_name, off) => {
      const { track, el, list } = on('Hi');
      el.dispatchEvent(new Event('enterpictureinpicture'));
      off(track, el);
      list.dispatchEvent(new Event('change'));
      expect(isShownTrack(track as unknown as TextTrack)).toBe(false);

      el.dispatchEvent(new Event('leavepictureinpicture'));
      expect(track.mode).not.toBe('showing');
      expect(isShownTrack(track as unknown as TextTrack)).toBe(false);
      expect(cueTexts()).toEqual([]);
      track.dispatchEvent(new Event('cuechange'));
      expect(cueTexts()).toEqual([]);
    });

    it('a track turned on during picture-in-picture shows there and is drawn after leaving', () => {
      const track = new FakeTrack();
      track.activeCues = [{ text: 'Late' }];
      const { el, list } = fakeElement([track]);
      stop = bindSubtitleOverlay(el, box);
      el.dispatchEvent(new Event('enterpictureinpicture'));
      track.mode = 'showing';
      list.dispatchEvent(new Event('change'));
      expect(track.mode).toBe('showing');
      expect(isShownTrack(track as unknown as TextTrack)).toBe(true);
      el.dispatchEvent(new Event('leavepictureinpicture'));
      expect(track.mode).toBe('hidden');
      expect(cueTexts()).toEqual(['Late']);
    });

    it('bound while the video is already in picture-in-picture, the drawn track shows natively', () => {
      const { track, el } = on('Hi');
      stop?.();
      Object.defineProperty(document, 'pictureInPictureElement', { configurable: true, get: () => el });
      stop = bindSubtitleOverlay(el, box);
      expect(track.mode).toBe('showing');
      expect(box.hidden).toBe(true);
      expect(isShownTrack(track as unknown as TextTrack)).toBe(true);
      el.dispatchEvent(new Event('leavepictureinpicture'));
      expect(track.mode).toBe('hidden');
      expect(cueTexts()).toEqual(['Hi']);
    });
  });

  it('strips tags and decodes the escapes files are written with', () => {
    expect(plainCueText('a &lt;b&gt; &amp;amp; <c.x>c</c>')).toBe('a <b> &amp; c');
  });
});
