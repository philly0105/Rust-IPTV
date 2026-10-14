import type { APIRequestContext, Page } from '@playwright/test';

import type { Channel, Page as RpcPage } from '../src/api/types';
import { ensureSource, resetApp, rpc } from './helpers/api';
import { MOCK, XTREAM } from './helpers/env';
import { expect, test } from './helpers/fixtures';

// Multi-view (contract C4, check 4): a wall of up to four live tiles. Every tile
// plays at once, exactly one has sound, and a tile whose stream fails shows its
// own error while the others keep playing.
//
// The tiles come from an M3U playlist added as text: four channels that point at
// the mock's live HLS (`/xtream/live/demo/secret/{id}.m3u8`) and one that points
// at the same route with a wrong password, which the mock answers with 401. An
// M3U source has no account limit, so the connection banner stays out of the
// way until the Xtream test asks for it (the demo account allows 2 streams).

const WALL_KEY = 'tsrust.multiview';
const PLAYLIST = 'Multiview Playlist';
const XTREAM_NAME = 'Multiview Xtream';

const liveUrl = (id: number) => `${MOCK}/xtream/live/${XTREAM.username}/${XTREAM.password}/${id}.m3u8`;
const BROKEN_URL = `${MOCK}/xtream/live/${XTREAM.username}/not-the-password/109.m3u8`;

const GOOD = ['Wall One', 'Wall Two', 'Wall Three', 'Wall Four'] as const;
const BROKEN = 'Wall Broken';

function playlistText(): string {
  const entries = [
    ...GOOD.map((name, i) => ({ name, url: liveUrl(101 + i) })),
    { name: BROKEN, url: BROKEN_URL },
  ];
  return [
    '#EXTM3U',
    ...entries.flatMap(({ name, url }, i) => [`#EXTINF:-1 tvg-id="wall.${i + 1}" tvg-chno="${i + 1}" group-title="Wall",${name}`, url]),
    '',
  ].join('\n');
}

let playlist: Channel[] = [];
let xtream: Channel[] = [];

async function liveChannels(request: APIRequestContext, sourceId: string): Promise<Channel[]> {
  const res = await rpc<RpcPage<Channel>>(request, 'catalog.channels', {
    sourceId,
    query: { offset: 0, limit: 50, sort: 'number', dir: 'asc' },
  });
  return res.items.filter((c) => !c.isRadio);
}

function byName(name: string): Channel {
  const ch = playlist.find((c) => c.name === name);
  if (!ch) throw new Error(`playlist has no channel named ${name}`);
  return ch;
}

interface SeedTile {
  key: string;
  channel: Channel;
}

/** Puts a wall into localStorage the way the store saves it, then opens /multiview. */
async function openWall(page: Page, tiles: SeedTile[], layout: '1x2' | '2x2' | '1+3' = '2x2'): Promise<void> {
  await page.goto('/');
  const value = JSON.stringify({
    v: 1,
    tiles: tiles.map(({ key, channel }) => ({ key, ref: channel.ref, title: channel.name })),
    layout,
    audioKey: tiles[0]?.key ?? null,
  });
  await page.evaluate(([k, v]) => {
    localStorage.setItem(k, v);
    localStorage.removeItem(`${k}.audio`);
  }, [WALL_KEY, value] as const);
  await page.goto('/multiview');
  await expect(page.getByTestId('multiview-wall')).toBeVisible();
  await expect(page.getByTestId('multiview-tile')).toHaveCount(tiles.length);
}

function tile(page: Page, key: string) {
  return page.locator(`[data-testid="multiview-tile"][data-tile-key="${key}"]`);
}

/** Waits until every listed tile has data and its clock moves forward by `advance` seconds. */
async function expectTilesPlaying(page: Page, keys: readonly string[], advance = 1): Promise<void> {
  const start = new Map<string, number>();
  await expect
    .poll(
      async () => {
        const states = await page.evaluate((ks) => {
          return ks.map((k) => {
            const v = document.querySelector<HTMLVideoElement>(`[data-testid="multiview-tile"][data-tile-key="${k}"] video`);
            if (!v) return { k, t: -1, ready: 0, paused: true, error: 'no video element' };
            return { k, t: v.currentTime, ready: v.readyState, paused: v.paused, error: v.error ? `media error ${v.error.code}` : null };
          });
        }, keys);
        const lagging: string[] = [];
        for (const s of states) {
          if (s.error) {
            lagging.push(`${s.k}: ${s.error}`);
            continue;
          }
          if (s.ready < 3 || s.paused) {
            lagging.push(`${s.k}: readyState ${s.ready}${s.paused ? ', paused' : ''}`);
            continue;
          }
          const first = start.get(s.k) ?? s.t;
          start.set(s.k, first);
          if (s.t - first < advance) lagging.push(`${s.k}: t=${s.t.toFixed(2)}`);
        }
        return lagging.length ? lagging.join('; ') : 'playing';
      },
      { timeout: 45_000, intervals: [250, 500, 1000], message: `tiles ${keys.join(', ')} should play and advance ${advance}s` },
    )
    .toBe('playing');
}

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Boxes of every slot on the wall (tiles and free frames), in slot order. */
function slotRects(page: Page): Promise<Rect[]> {
  return page.locator('[data-testid="multiview-wall"] > [data-slot]').evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    }),
  );
}

/** Whether two boxes share more than a rounding pixel. */
function intersects(a: Rect, b: Rect): boolean {
  return Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
}

/** No two slots overlap, and stacked slots follow each other without a band between them. */
async function expectSlotsTiled(page: Page, count: number): Promise<void> {
  await expect.poll(async () => (await slotRects(page)).length).toBe(count);
  const rects = await slotRects(page);
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      expect(intersects(rects[i]!, rects[j]!), `slot ${i + 1} overlaps slot ${j + 1}: ${JSON.stringify([rects[i], rects[j]])}`).toBe(false);
    }
  }
  // Stacked in one column: each slot starts within a gap of the one above.
  const oneColumn = rects.every((r) => Math.abs(r.left - rects[0]!.left) < 1);
  if (oneColumn) {
    for (let i = 1; i < rects.length; i++) {
      expect(rects[i]!.top - rects[i - 1]!.bottom, `gap above slot ${i + 1}`).toBeLessThan(12);
    }
  }
}

async function setUiScale(page: Page, uiScale: number): Promise<void> {
  await rpc(page.request, 'settings.update', { patch: { uiScale } });
}

/** `muted` of every tile's video, in slot order. */
function mutedStates(page: Page): Promise<boolean[]> {
  return page.getByTestId('multiview-video').evaluateAll((els) => els.map((el) => (el as HTMLVideoElement).muted));
}

test.describe.serial('multi-view', () => {
  test.beforeAll(async ({ request }) => {
    await resetApp(request);
    const m3u = await rpc<{ id: string }>(request, 'sources.add', {
      kind: 'm3u',
      name: PLAYLIST,
      m3u: { origin: 'text', text: playlistText(), headers: {} },
    });
    playlist = await liveChannels(request, m3u.id);
    expect(playlist.map((c) => c.name).sort()).toEqual([...GOOD, BROKEN].sort());
    const xt = await ensureSource(request, 'xtream', XTREAM_NAME);
    xtream = (await liveChannels(request, xt.id)).slice(0, 4);
    expect(xtream).toHaveLength(4);
  });

  test('four tiles play at once and exactly one has sound', async ({ page }) => {
    const tiles = GOOD.map((name, i) => ({ key: `good-${i + 1}`, channel: byName(name) }));
    await openWall(page, tiles);
    const keys = tiles.map((t) => t.key);

    await expectTilesPlaying(page, keys);

    // Clicking a tile is the gesture that lets its sound play; the others stay muted.
    await tile(page, 'good-3').getByTestId('multiview-tile-main').click();
    await expect(tile(page, 'good-3')).toHaveAttribute('data-sound', 'true');
    await expect.poll(() => mutedStates(page)).toEqual([true, true, false, true]);
    await expect(page.locator('[data-testid="multiview-tile"][data-sound="true"]')).toHaveCount(1);

    // The number keys move the sound; still exactly one tile is audible.
    await page.keyboard.press('1');
    await expect(tile(page, 'good-1')).toHaveAttribute('data-sound', 'true');
    await expect.poll(() => mutedStates(page)).toEqual([false, true, true, true]);

    // Moving the sound did not stop anyone.
    await expectTilesPlaying(page, keys);
  });

  test('a broken stream shows its own error while the other three keep playing', async ({ page }) => {
    const tiles = [
      { key: 'ok-1', channel: byName(GOOD[0]) },
      { key: 'broken', channel: byName(BROKEN) },
      { key: 'ok-2', channel: byName(GOOD[1]) },
      { key: 'ok-3', channel: byName(GOOD[2]) },
    ];
    await openWall(page, tiles);

    const broken = tile(page, 'broken');
    await expect(broken.getByTestId('multiview-tile-error')).toBeVisible({ timeout: 30_000 });
    await expect(broken).toHaveAttribute('data-phase', 'error');
    await expect(broken.getByTestId('multiview-tile-retry')).toBeVisible();

    await expectTilesPlaying(page, ['ok-1', 'ok-2', 'ok-3']);
    for (const key of ['ok-1', 'ok-2', 'ok-3']) {
      await expect(tile(page, key).getByTestId('multiview-tile-error')).toHaveCount(0);
    }

    // Retrying the broken tile fails again on its own; the others are untouched.
    await broken.getByTestId('multiview-tile-retry').click();
    await expect(broken.getByTestId('multiview-tile-error')).toBeVisible({ timeout: 30_000 });
    await expectTilesPlaying(page, ['ok-1', 'ok-2', 'ok-3']);

    // Closing the broken tile leaves three playing tiles.
    await broken.getByTestId('multiview-tile-close').click();
    await expect(page.getByTestId('multiview-tile')).toHaveCount(3);
    await expectTilesPlaying(page, ['ok-1', 'ok-2', 'ok-3']);
  });

  test('more tiles than the account allows raise the connection warning', async ({ page }) => {
    // The demo account allows 2 connections; four of its channels go up.
    await openWall(
      page,
      xtream.map((channel, i) => ({ key: `xt-${i + 1}`, channel })),
    );
    const banner = page.getByTestId('multiview-limit-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(XTREAM_NAME);
    await expect(banner).toContainText('allows 2 streams');
  });

  test('stacked walls tile their slots: no overlap, no gaps (390 px and 1024x768 at 125 %)', async ({ page }) => {
    const four = GOOD.map((name, i) => ({ key: `stack-${i + 1}`, channel: byName(name) }));
    const two = four.slice(0, 2);

    await page.setViewportSize({ width: 390, height: 844 });
    for (const layout of ['2x2', '1+3'] as const) {
      await openWall(page, four, layout);
      await expectSlotsTiled(page, 4);
    }
    await openWall(page, two, '1x2');
    await expectSlotsTiled(page, 2);
    await openWall(page, two, '2x2');
    await expectSlotsTiled(page, 4);

    // The empty wall: free frames keep their "Add channel" label clear of the next frame.
    await page.evaluate((k) => localStorage.removeItem(k), WALL_KEY);
    await page.reload();
    await expect(page.getByTestId('multiview-empty')).toBeVisible();
    await expectSlotsTiled(page, 4);
    // The layout choice fits the phone: no button past the viewport, no label spilling out of its pill.
    for (const l of ['1x2', '2x2', '1+3']) {
      const box = (await page.getByTestId(`multiview-empty-layout-${l}`).boundingBox())!;
      expect(box.x + box.width, `layout ${l} inside the viewport`).toBeLessThanOrEqual(390);
      expect(box.height).toBeLessThan(48);
    }

    // 125 % UI scale on a 1024x768 window stays below the wall's 42rem breakpoint: stacked too.
    await setUiScale(page, 1.25);
    try {
      await page.setViewportSize({ width: 1024, height: 768 });
      await openWall(page, four, '2x2');
      await expectSlotsTiled(page, 4);
    } finally {
      await setUiScale(page, 1);
    }
  });

  test('a broken small tile keeps its buttons clear of the label strip (1280x800, 1+3)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const tiles = [
      { key: 'big', channel: byName(GOOD[0]) },
      { key: 'side-1', channel: byName(GOOD[1]) },
      { key: 'side-broken', channel: byName(BROKEN) },
      { key: 'side-3', channel: byName(GOOD[2]) },
    ];
    await openWall(page, tiles, '1+3');
    const broken = tile(page, 'side-broken');
    await expect(broken.getByTestId('multiview-tile-error')).toBeVisible({ timeout: 30_000 });
    const strip = (await broken.getByTestId('multiview-tile-strip').boundingBox())!;
    for (const button of await broken.getByTestId('multiview-tile-error').getByRole('button').all()) {
      const b = (await button.boundingBox())!;
      const r = { left: b.x, top: b.y, right: b.x + b.width, bottom: b.y + b.height };
      const s = { left: strip.x, top: strip.y, right: strip.x + strip.width, bottom: strip.y + strip.height };
      expect(intersects(r, s), `${await button.textContent()} under the label strip: ${JSON.stringify([r, s])}`).toBe(false);
    }
  });

  test('channels go on the wall from the picker, and keys drive the wall', async ({ page }) => {
    await page.goto('/');
    await page.evaluate((k) => localStorage.removeItem(k), WALL_KEY);
    await page.goto('/multiview');

    const empty = page.getByTestId('multiview-empty');
    await expect(empty).toBeVisible();
    await expect(empty.getByRole('heading', { name: 'Watch up to four channels at once' })).toBeVisible();

    await page.getByTestId('multiview-pick').click();
    const picker = page.getByTestId('multiview-picker');
    await expect(picker).toBeVisible();
    await picker.getByRole('searchbox').or(picker.getByRole('textbox', { name: 'Search channels' })).first().fill('Wall');

    for (const name of [GOOD[0], GOOD[1]]) {
      const row = picker.getByRole('button', { name: `Add ${name} to the wall` });
      await row.click();
      await expect(picker.getByRole('button', { name: new RegExp(`^${name}, In slot \\d$`) })).toBeVisible();
    }
    await picker.getByRole('button', { name: 'Done' }).click();
    await expect(picker).toBeHidden();

    await expect(page.getByTestId('multiview-tile')).toHaveCount(2);
    await expect(page.getByTestId('multiview-empty')).toHaveCount(0);

    // Two tiles fit side by side.
    await page.getByTestId('multiview-layout-1x2').click();
    await expect(page.getByTestId('multiview-wall')).toHaveAttribute('data-layout', '1x2');

    // Arrow keys move focus between tiles; Delete closes the focused one.
    const firstMain = page.getByTestId('multiview-tile-main').first();
    await firstMain.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('multiview-tile-main').nth(1)).toBeFocused();
    await page.keyboard.press('Delete');
    await expect(page.getByTestId('multiview-tile')).toHaveCount(1);
    await expect(page.getByTestId('multiview-announcer')).toContainText(`Closed ${GOOD[1]}`);

    // The wall survives a reload.
    await page.reload();
    await expect(page.getByTestId('multiview-tile')).toHaveCount(1);
    await expect(page.getByTestId('multiview-tile')).toContainText(GOOD[0]);
  });
});
