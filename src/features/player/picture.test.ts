import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_PICTURE, mpvPictureProperties, PICTURE_KEY, pictureStyle, setPicture, usePictureStore } from './picture';

afterEach(() => {
  setPicture(DEFAULT_PICTURE);
  localStorage.clear();
});

describe('picture controls in the built-in player', () => {
  it('leaves the element alone at the defaults', () => {
    expect(pictureStyle(DEFAULT_PICTURE)).toBeUndefined();
  });

  it('a forced aspect is the largest box of that shape, the picture stretched into it', () => {
    expect(pictureStyle({ ...DEFAULT_PICTURE, aspect: '4:3' })).toMatchObject({
      position: 'absolute',
      width: 'min(100cqw, 100cqh * 4 / 3)',
      height: 'min(100cqh, 100cqw * 3 / 4)',
      objectFit: 'fill',
    });
    // With crop: the smallest box of that shape that covers the frame.
    expect(pictureStyle({ ...DEFAULT_PICTURE, aspect: '16:9', zoom: 'crop' })).toMatchObject({
      width: 'max(100cqw, 100cqh * 16 / 9)',
      height: 'max(100cqh, 100cqw * 9 / 16)',
    });
  });

  it('stretch fills the frame, crop covers it, zoom scales from the centre', () => {
    expect(pictureStyle({ ...DEFAULT_PICTURE, aspect: 'fill' })).toEqual({ objectFit: 'fill' });
    expect(pictureStyle({ ...DEFAULT_PICTURE, zoom: 'crop' })).toEqual({ objectFit: 'cover' });
    expect(pictureStyle({ ...DEFAULT_PICTURE, zoom: '125' })).toEqual({ transform: 'scale(1.25)' });
  });
});

describe('picture controls in embedded mpv', () => {
  it('sends every property, so going back to the defaults resets mpv', () => {
    expect(mpvPictureProperties(DEFAULT_PICTURE)).toEqual([
      { name: 'video-aspect-override', value: '-1' },
      { name: 'keepaspect', value: 'yes' },
      { name: 'panscan', value: 0 },
      { name: 'video-zoom', value: 0 },
      { name: 'deinterlace', value: 'no' },
    ]);
    const props = mpvPictureProperties({ aspect: '4:3', zoom: '150', deinterlace: true });
    expect(props).toContainEqual({ name: 'video-aspect-override', value: '4:3' });
    expect(props).toContainEqual({ name: 'video-zoom', value: Math.log2(1.5) });
    expect(props).toContainEqual({ name: 'deinterlace', value: 'yes' });
    expect(mpvPictureProperties({ ...DEFAULT_PICTURE, aspect: 'fill', zoom: 'crop' })).toEqual(
      expect.arrayContaining([
        { name: 'keepaspect', value: 'no' },
        { name: 'panscan', value: 1 },
      ]),
    );
  });
});

describe('the choice is global and kept', () => {
  it('stores the choice, which the next start reads back', () => {
    setPicture({ aspect: '16:9' });
    expect(usePictureStore.getState().aspect).toBe('16:9');
    expect(JSON.parse(localStorage.getItem(PICTURE_KEY) ?? '{}')).toMatchObject({ aspect: '16:9', zoom: 'none' });
  });
});
