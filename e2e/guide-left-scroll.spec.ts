import type { GuideSearchHit } from '../src/api/types';
import { ensureSource, resetApp, rpc } from './helpers/api';
import { expect, test } from './helpers/fixtures';

async function openGuide(page: import('@playwright/test').Page, request: import('@playwright/test').APIRequestContext, name: string) {
  await resetApp(request);
  const source = await ensureSource(request, 'm3u', name);
  await expect.poll(async () => (await rpc<GuideSearchHit[]>(request, 'epg.search', { sourceId: source.id, query: 'news' })).length, { timeout: 30_000 }).toBeGreaterThan(0);
  await page.goto(`/epg?source=${encodeURIComponent(source.id)}`);
  const grid = page.getByTestId('epg-grid');
  await expect(grid.locator('button[data-start]').first()).toBeVisible();
  const box = await grid.boundingBox();
  if (!box) throw new Error('Guide grid has no box');
  await page.mouse.move(box.x + box.width / 2, box.y + 100);
  return grid;
}

async function sampleTimeline(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    const grid = document.querySelector<HTMLElement>('[data-testid="epg-grid"]')!;
    const state = window as Window & { guideScrollSamples?: { left: number; width: number; time: number }[] };
    state.guideScrollSamples = [];
    const sample = () => {
      state.guideScrollSamples!.push({ left: grid.scrollLeft, width: grid.scrollWidth, time: Number(grid.dataset.viewAt) });
      if (state.guideScrollSamples!.length < 240) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}

test('fast left wheel steps stay native and never jump back while guide data loads', async ({ page, request }) => {
  const grid = await openGuide(page, request, 'Guide fast left scroll');
  await page.route('**/api/rpc/epg.grid', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.continue();
  });
  const before = await grid.evaluate((el) => ({ left: el.scrollLeft, width: el.scrollWidth, time: Number(el.dataset.viewAt) }));
  expect(before.left).toBeGreaterThan(7000);
  await sampleTimeline(page);
  for (let i = 0; i < 20; i++) await page.mouse.wheel(-350, 0);
  await expect.poll(() => grid.evaluate((el) => el.scrollLeft)).toBeLessThanOrEqual(before.left - 6900);
  await page.waitForTimeout(300);
  const samples = await page.evaluate(() => (window as Window & { guideScrollSamples?: { left: number; width: number; time: number }[] }).guideScrollSamples ?? []);
  expect(samples.length).toBeGreaterThan(10);
  for (let i = 1; i < samples.length; i++) {
    expect(samples[i]!.left).toBeLessThanOrEqual(samples[i - 1]!.left + 5);
    expect(samples[i]!.time).toBeLessThanOrEqual(samples[i - 1]!.time);
    expect(samples[i]!.width).toBe(before.width);
  }
  const after = await grid.evaluate((el) => ({ left: el.scrollLeft, width: el.scrollWidth, time: Number(el.dataset.viewAt) }));
  expect(after.time).toBeLessThan(before.time);
  expect(after.width).toBe(before.width);
  await expect.poll(() => new URL(page.url()).searchParams.get('at')).not.toBeNull();
  const settled = await grid.evaluate((el) => ({ left: el.scrollLeft, width: el.scrollWidth, time: Number(el.dataset.viewAt) }));
  expect(settled).toEqual(after);
});

test('Shift plus mouse wheel uses the browser horizontal scroll path', async ({ page, request }) => {
  const grid = await openGuide(page, request, 'Guide Shift wheel scroll');
  const before = await grid.evaluate((el) => ({ left: el.scrollLeft, time: Number(el.dataset.viewAt) }));
  await sampleTimeline(page);
  await page.keyboard.down('Shift');
  for (let i = 0; i < 10; i++) await page.mouse.wheel(0, -300);
  await page.keyboard.up('Shift');
  await expect.poll(() => grid.evaluate((el) => el.scrollLeft)).toBeLessThanOrEqual(before.left - 2900);
  const after = await grid.evaluate((el) => ({ left: el.scrollLeft, time: Number(el.dataset.viewAt) }));
  expect(after.time).toBeLessThan(before.time);
  const samples = await page.evaluate(() => (window as Window & { guideScrollSamples?: { left: number }[] }).guideScrollSamples ?? []);
  for (let i = 1; i < samples.length; i++) expect(samples[i]!.left).toBeLessThanOrEqual(samples[i - 1]!.left + 5);
});

test('vertical channel scrolling keeps a virtual row list without changing horizontal time', async ({ page, request }) => {
  const grid = await openGuide(page, request, 'Guide virtual rows');
  const before = await grid.evaluate((el) => ({ left: el.scrollLeft, time: Number(el.dataset.viewAt) }));
  await grid.evaluate((el) => { el.scrollTop = 5000; });
  await expect.poll(() => grid.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect(await grid.evaluate((el) => el.scrollLeft)).toBe(before.left);
  expect(Number(await grid.getAttribute('data-view-at'))).toBe(before.time);
  const totalRows = Number(await grid.getAttribute('aria-rowcount'));
  expect(totalRows).toBeGreaterThan(10);
  expect(await grid.locator('[role="row"]').count()).toBeLessThan(totalRows);
});

test.describe('visible tile request', () => {
  test.use({ serviceWorkers: 'block' });
  test('visible tiles arrive before a delayed full guide request after a fast left scroll', async ({ page, request }) => {
    let fullCalls = 0;
    let quickCalls = 0;
    await page.route('**/api/rpc/epg.grid', async (route) => {
      const args = route.request().postDataJSON() as { from: string; to: string };
      if (Date.parse(args.to) - Date.parse(args.from) >= 24 * 60 * 60_000) {
        fullCalls++;
        if (fullCalls > 1) await new Promise((resolve) => setTimeout(resolve, 3000));
      } else {
        quickCalls++;
      }
      await route.continue();
    });
    const grid = await openGuide(page, request, 'Guide visible tiles first');
    quickCalls = 0;
    const before = Number(await grid.getAttribute('data-view-at'));
    await grid.evaluate((el) => { el.scrollLeft -= 4500; });
    await expect.poll(async () => Number(await grid.getAttribute('data-view-at'))).toBeLessThan(before - 14 * 60 * 60_000);
    await expect.poll(() => quickCalls, { timeout: 1400 }).toBeGreaterThan(0);
    await expect.poll(() => grid.evaluate((el) => {
      const viewport = el.getBoundingClientRect();
      return [...el.querySelectorAll<HTMLElement>('button[data-start]')].filter((cell) => {
        const box = cell.getBoundingClientRect();
        return box.right > viewport.left + 250 && box.left < viewport.right && box.bottom > viewport.top + 40 && box.top < viewport.bottom;
      }).length;
    }), { timeout: 1400 }).toBeGreaterThan(0);
    expect(fullCalls).toBeGreaterThan(0);
  });
});

test('rapid Shift wheel bursts never trigger a programme re-anchor', async ({ page, request }) => {
  const grid = await openGuide(page, request, 'Guide rapid Shift wheel');
  // Native smooth scrolling can still be completing its last notch when the distance
  // assertion passes. Compare anchors after that motion, not against a mid-animation sample.
  const settle = () => grid.evaluate((el) => new Promise<void>((resolve) => {
    let previous = el.scrollLeft;
    let unchanged = 0;
    const frame = () => {
      const next = el.scrollLeft;
      unchanged = next === previous ? unchanged + 1 : 0;
      previous = next;
      if (unchanged >= 4) resolve();
      else requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }));
  const focusedCell = grid.locator('button[data-start]').first();
  await focusedCell.scrollIntoViewIfNeeded();
  await focusedCell.focus();
  const before = await grid.evaluate((el) => ({ left: el.scrollLeft, width: el.scrollWidth, time: Number(el.dataset.viewAt) }));
  await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('[data-testid="epg-grid"]')!;
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollLeft')!;
    const state = window as Window & { guideWrites?: number[]; guideOriginalGrid?: HTMLElement };
    state.guideOriginalGrid = root;
    state.guideWrites = [];
    Object.defineProperty(root, 'scrollLeft', {
      configurable: true,
      get: () => descriptor.get!.call(root) as number,
      set: (value: number) => { state.guideWrites!.push(value); descriptor.set!.call(root, value); },
    });
  });
  await page.keyboard.down('Shift');
  for (let i = 0; i < 8; i++) await Promise.all(Array.from({ length: 5 }, () => page.mouse.wheel(0, -800)));
  await page.keyboard.up('Shift');
  await expect.poll(() => grid.evaluate((el) => el.scrollLeft)).toBeLessThanOrEqual(before.left - 30_000);
  await settle();
  const after = await grid.evaluate((el) => ({ left: el.scrollLeft, width: el.scrollWidth, time: Number(el.dataset.viewAt) }));
  expect(after.time).toBeLessThan(before.time);
  await page.waitForTimeout(500);
  expect(await grid.evaluate((el) => ({ left: el.scrollLeft, width: el.scrollWidth }))).toEqual({ left: after.left, width: before.width });
  expect(await page.evaluate(() => document.querySelector('[data-testid="epg-grid"]') === (window as Window & { guideOriginalGrid?: HTMLElement }).guideOriginalGrid)).toBe(true);
  expect((await page.evaluate(() => (window as Window & { guideWrites?: number[] }).guideWrites ?? [])).every((x) => x <= before.left)).toBe(true);
  await page.keyboard.down('Shift');
  for (let i = 0; i < 3; i++) await Promise.all(Array.from({ length: 4 }, () => page.mouse.wheel(0, -800)));
  await page.keyboard.up('Shift');
  await expect.poll(() => grid.evaluate((el) => el.scrollLeft)).toBeLessThanOrEqual(after.left - 8000);
  await settle();
  const second = await grid.evaluate((el) => el.scrollLeft);
  await page.waitForTimeout(1000);
  expect(await grid.evaluate((el) => el.scrollLeft)).toBe(second);
});
