import { beforeEach, describe, expect, it } from 'vitest';

import {
  __reloadMultiviewForTests,
  AUDIO_STORAGE_KEY,
  normalizeWall,
  parseAudio,
  parseWall,
  reinsertTile,
  restoreClearedWall,
  snapshotWall,
  STORAGE_KEY,
  useMultiviewAudio,
  useMultiviewStore,
} from '../store';
import type { MultiviewTile } from '../types';
import { input, ref } from './harness';

const store = () => useMultiviewStore.getState();
const keys = () => store().tiles.map((t) => t.key);
const titles = () => store().tiles.map((t) => t.title);

beforeEach(() => {
  localStorage.clear();
  __reloadMultiviewForTests();
});

describe('useMultiviewStore: adding', () => {
  it('adds up to four channels, then reports full', () => {
    for (let i = 1; i <= 4; i++) expect(store().add(input(i))).toBe('added');
    expect(store().add(input(5))).toBe('full');
    expect(titles()).toEqual(['Channel 1', 'Channel 2', 'Channel 3', 'Channel 4']);
  });

  it('refuses a channel already on the wall, even under another title', () => {
    store().add(input(1));
    expect(store().add({ ...input(1), title: 'Renamed' })).toBe('duplicate');
    expect(store().tiles).toHaveLength(1);
  });

  it('tells channels of different sources apart', () => {
    store().add(input(1, 'a'));
    expect(store().add(input(1, 'b'))).toBe('added');
  });

  it('gives the first tile the sound and keeps it there as more arrive', () => {
    store().add(input(1));
    const first = store().tiles[0]!.key;
    expect(store().audioKey).toBe(first);
    store().add(input(2));
    expect(store().audioKey).toBe(first);
  });

  it('keeps only the C4 fields, trimmed', () => {
    store().add({ ...input(1), title: '  News 24  ', logo: ' ', extra: 'x' } as never);
    const tile = store().tiles[0]!;
    expect(tile.title).toBe('News 24');
    expect(tile.logo).toBeUndefined();
    expect(Object.keys(tile).sort()).toEqual(['key', 'number', 'ref', 'title']);
  });

  it('switches 1x2 to the grid when a third channel arrives', () => {
    store().setLayout('1x2');
    store().add(input(1));
    store().add(input(2));
    expect(store().layout).toBe('1x2');
    store().add(input(3));
    expect(store().layout).toBe('2x2');
  });
});

describe('useMultiviewStore: layout', () => {
  it('cannot choose 1x2 while more than two tiles are up', () => {
    for (let i = 1; i <= 3; i++) store().add(input(i));
    store().setLayout('1x2');
    expect(store().layout).toBe('2x2');
    store().setLayout('1+3');
    expect(store().layout).toBe('1+3');
  });

  it('ignores an unknown layout', () => {
    store().setLayout('3x3' as never);
    expect(store().layout).toBe('2x2');
  });
});

describe('useMultiviewStore: sound, close, replace, swap, clear', () => {
  beforeEach(() => {
    for (let i = 1; i <= 3; i++) store().add(input(i));
  });

  it('moves the sound to exactly one tile', () => {
    const [, second] = keys();
    store().setAudio(second!);
    expect(store().audioKey).toBe(second);
    store().setAudio('nope');
    expect(store().audioKey).toBe(second);
  });

  it('hands the sound to the first tile left when the tile with sound closes', () => {
    const [first, second] = keys();
    store().setAudio(second!);
    store().remove(second!);
    expect(store().audioKey).toBe(first);
  });

  it('keeps the sound where it is when another tile closes', () => {
    const [first, , third] = keys();
    store().remove(third!);
    expect(store().audioKey).toBe(first);
  });

  it('has no sound once the wall is empty', () => {
    for (const k of keys()) store().remove(k);
    expect(store().audioKey).toBeNull();
  });

  it('replaces the channel of a tile and keeps its key and slot', () => {
    const [, second] = keys();
    store().replace(second!, input(9));
    expect(store().tiles[1]).toMatchObject({ key: second, title: 'Channel 9', ref: ref('c9') });
  });

  it('refuses to replace with a channel already on another tile', () => {
    const [, second] = keys();
    store().replace(second!, input(1));
    expect(store().tiles[1]!.title).toBe('Channel 2');
  });

  it('swaps two tiles and the sound stays with its channel', () => {
    const [first, , third] = keys();
    store().swap(first!, third!);
    expect(titles()).toEqual(['Channel 3', 'Channel 2', 'Channel 1']);
    expect(store().tiles.find((t) => t.key === store().audioKey)!.title).toBe('Channel 1');
  });

  it('clears the wall', () => {
    store().clear();
    expect(store().tiles).toEqual([]);
    expect(store().audioKey).toBeNull();
  });
});

describe('persistence', () => {
  it("saves to localStorage 'tsrust.multiview' and reads it back", () => {
    store().add(input(1));
    store().add(input(2));
    store().setLayout('1x2');
    store().setAudio(store().tiles[1]!.key);
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(saved).toMatchObject({ v: 1, layout: '1x2' });
    expect(saved.tiles).toHaveLength(2);

    useMultiviewStore.setState({ tiles: [], layout: '2x2', audioKey: null });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
    __reloadMultiviewForTests();
    expect(titles()).toEqual(['Channel 1', 'Channel 2']);
    expect(store().layout).toBe('1x2');
    expect(store().audioKey).toBe(store().tiles[1]!.key);
  });

  it('removes the entry once the wall is empty in the default layout', () => {
    store().add(input(1));
    store().remove(store().tiles[0]!.key);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('reads garbage as an empty wall', () => {
    expect(parseWall('{not json').tiles).toEqual([]);
    expect(parseWall('null').tiles).toEqual([]);
    expect(parseWall('[1,2]').tiles).toEqual([]);
  });

  it('keeps the valid part of a hand-edited wall', () => {
    const raw = JSON.stringify({
      tiles: [
        { key: 'a', ref: ref('c1'), title: 'One' },
        { key: 'b', ref: { sourceId: '', contentType: 'live', itemId: 'x' }, title: 'Bad ref' },
        { key: 'c', ref: ref('c1'), title: 'Duplicate' },
        { key: 'd', ref: ref('c2'), title: '' },
        { ref: ref('c3'), title: 'No key' },
        { key: 'e', ref: ref('c4'), title: 'Four' },
        { key: 'f', ref: ref('c5'), title: 'Five, one too many' },
      ],
      layout: '1x2',
      audioKey: 'missing',
    });
    const wall = parseWall(raw);
    expect(wall.tiles.map((t) => t.title)).toEqual(['One', 'c2', 'No key', 'Four']);
    expect(wall.tiles[2]!.key).toMatch(/\S/);
    // Four tiles do not fit 1x2; the sound goes to the first tile when its key is unknown.
    expect(wall.layout).toBe('2x2');
    expect(wall.audioKey).toBe('a');
  });

  it('normalizes duplicate keys away', () => {
    const t = (key: string, id: string): MultiviewTile => ({ key, ref: ref(id), title: id });
    expect(normalizeWall({ tiles: [t('a', '1'), t('a', '2')], layout: '2x2', audioKey: 'a' }).tiles).toHaveLength(1);
  });
});

describe('undo', () => {
  it('puts a closed tile back in its slot, with its sound', () => {
    for (let i = 1; i <= 3; i++) store().add(input(i));
    const closed = store().tiles[1]!;
    store().setAudio(closed.key);
    store().remove(closed.key);
    expect(reinsertTile(closed, 1, true)).toBe(true);
    expect(titles()).toEqual(['Channel 1', 'Channel 2', 'Channel 3']);
    expect(store().audioKey).toBe(closed.key);
  });

  it('cannot put a tile back on a full wall or next to the same channel', () => {
    for (let i = 1; i <= 4; i++) store().add(input(i));
    const closed = store().tiles[0]!;
    store().remove(closed.key);
    store().add(input(1));
    expect(reinsertTile(closed, 0, false)).toBe(false);
  });

  it('brings a cleared wall back, merged with channels added since', () => {
    store().add(input(1));
    store().add(input(2));
    store().setLayout('1+3');
    const before = snapshotWall();
    store().clear();
    store().add(input(3));
    restoreClearedWall(before);
    expect(titles()).toEqual(['Channel 1', 'Channel 2', 'Channel 3']);
    expect(store().layout).toBe('1+3');
    expect(store().audioKey).toBe(before.audioKey);
  });
});

describe('useMultiviewAudio', () => {
  it('clamps the volume and unmutes when it is turned up', () => {
    const a = () => useMultiviewAudio.getState();
    a().setMuted(true);
    a().setVolume(2);
    expect(a().volume).toBe(1);
    expect(a().muted).toBe(false);
    a().setMuted(true);
    a().setVolume(0);
    expect(a().muted).toBe(true);
  });

  it('persists and parses defensively', () => {
    useMultiviewAudio.getState().setVolume(0.4);
    expect(JSON.parse(localStorage.getItem(AUDIO_STORAGE_KEY)!)).toEqual({ volume: 0.4, muted: false });
    expect(parseAudio('{"volume":"loud","muted":"yes"}')).toEqual({ volume: 1, muted: false });
    expect(parseAudio('garbage')).toEqual({ volume: 1, muted: false });
  });
});
