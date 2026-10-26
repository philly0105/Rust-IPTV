import { writeFile } from 'node:fs/promises';
import type { APIRequestContext, Page } from '@playwright/test';

import { ensureSource, resetApp } from './helpers/api';
import { expect, test } from './helpers/fixtures';

// Screenshot tracing can dominate WebKit frame time; use the optional CPU/timeline profiles below.
test.use({ serviceWorkers: 'block', video: 'off', trace: 'off' });

async function openDenseGuide(page: Page, request: APIRequestContext, step = 15 * 60_000, at?: number, archive = false) {
  await resetApp(request);
  const source = await ensureSource(request, archive ? 'xtream' : 'm3u', 'Dense guide scroll');
  const count = 1200;
  let calls = 0;
  await page.route('**/api/rpc/catalog.channels', async (route) => {
    const { query } = route.request().postDataJSON();
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 200;
    await route.fulfill({ json: { offset, limit, total: count, items: Array.from({ length: Math.min(limit, count - offset) }, (_, n) => ({
      ref: { sourceId: source.id, contentType: 'live', itemId: String(offset + n) },
      name: `Channel ${offset + n + 1}`, number: offset + n + 1, isRadio: false,
      archive: { enabled: true, durationHours: 168 },
    })) } });
  });
  if (archive) {
    // A provider table spanning weeks reproduces the archive/XMLTV merge used by the desktop guide.
    const base = (at ?? Date.now()) - 7 * 24 * 60 * 60_000;
    await page.route('**/api/rpc/catchup.table', (route) => route.fulfill({ json: Array.from({ length: 14 * 24 * 60 * 60_000 / step }, (_, i) => ({
      channelId: 'dense', title: `Archive ${i}`, category: 'News',
      start: new Date(base + i * step).toISOString(), end: new Date(base + (i + 1) * step).toISOString(),
    })) }));
  }
  await page.route('**/api/rpc/epg.grid', async (route) => {
    calls++;
    const { refs, from, to } = route.request().postDataJSON();
    const start = Math.floor(Math.max(Date.parse(from), archive ? (at ?? Date.now()) - 2 * 60 * 60_000 : 0) / step) * step;
    const end = Date.parse(to);
    const programs = Array.from({ length: Math.max(0, Math.ceil((end - start) / step)) }, (_, i) => ({
      channelId: 'dense', title: `Programme ${Math.floor(start / step) + i}: a detailed title for the guide`, category: 'News',
      start: new Date(start + i * step).toISOString(), end: new Date(start + (i + 1) * step).toISOString(),
    }));
    await route.fulfill({ json: Object.fromEntries(refs.map((ref: { sourceId: string; contentType: string; itemId: string }) => [`${ref.sourceId}|${ref.contentType}|${ref.itemId}`, programs])) });
  });
  await page.goto(`/epg?source=${source.id}${at === undefined ? '' : `&at=${at}`}`);
  const grid = page.getByTestId('epg-grid');
  await expect(grid.locator('button[data-start]').first()).toBeVisible();
  return { grid, requests: () => calls };
}

test('dragging a guide cell pans both axes without opening it, while clicks still work', async ({ page, request }) => {
  const { grid } = await openDenseGuide(page, request);
  const cellPoint = () => grid.evaluate((el) => {
    const viewport = el.getBoundingClientRect();
    const cell = [...el.querySelectorAll<HTMLElement>('button[data-start]')].find((node) => {
      const box = node.getBoundingClientRect();
      return box.left > viewport.left + 150 && box.right < viewport.right - 150
        && box.top > viewport.top + 150 && box.bottom < viewport.bottom - 100;
    });
    if (!cell) return null;
    const box = cell.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  });
  for (const rtl of [false, true]) {
    await page.evaluate((value) => { document.documentElement.dir = value ? 'rtl' : 'ltr'; }, rtl);
    await grid.evaluate((el, value) => {
      el.scrollLeft = value ? -1000 : 1000;
      el.scrollTop = 400;
    }, rtl);
    await expect.poll(() => grid.evaluate((el) => el.scrollLeft)).toBe(rtl ? -1000 : 1000);
    await expect.poll(() => grid.evaluate((el) => el.scrollTop)).toBe(400);
    await expect.poll(cellPoint).not.toBeNull();
    const { x, y } = (await cellPoint())!;

    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 2, y - 2);
    expect(await grid.evaluate((el) => [el.scrollLeft, el.scrollTop])).toEqual([rtl ? -1000 : 1000, 400]);
    await page.mouse.move(x - 4, y - 2);
    await expect.poll(() => grid.evaluate((el) => [el.scrollLeft, el.scrollTop])).toEqual([(rtl ? -1000 : 1000) + 4, 402]);
    await page.mouse.move(x - 90, y - 85, { steps: 4 });
    await expect.poll(() => grid.evaluate((el) => [el.scrollLeft, el.scrollTop])).toEqual([(rtl ? -1000 : 1000) + 90, 485]);
    await page.mouse.up();
    await expect(page.getByTestId('program-popover')).toHaveCount(0);
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('');
  }

  // Moving away and returning to the same button still counts as a drag, so its click is ignored.
  await expect.poll(cellPoint).not.toBeNull();
  const { x, y } = (await cellPoint())!;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 15, y);
  await page.mouse.move(x, y);
  await page.mouse.up();
  await expect(page.getByTestId('program-popover')).toHaveCount(0);
  const click = (await cellPoint())!;
  await page.mouse.click(click.x, click.y);
  await expect(page.getByTestId('program-popover')).toBeVisible();
});

test('a densely populated guide keeps the mounted time range bounded before the first drag', async ({ page, request }) => {
  const { grid } = await openDenseGuide(page, request, 5 * 60_000);
  await page.waitForTimeout(3500);
  const report = await grid.evaluate(async (root) => {
    const cells = root.querySelectorAll('button[data-start]').length;
    const rows = root.querySelectorAll('[data-channel-row]').length;
    const first = root.querySelector<HTMLElement>('button[data-start]')!;
    const box = first.getBoundingClientRect();
    const down = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 8, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, clientX: box.left + 10, clientY: box.top + 10 });
    const move = new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 8, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, clientX: box.left - 30, clientY: box.top - 30 });
    const up = new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 8, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 0, clientX: box.left - 30, clientY: box.top - 30 });
    const start = performance.now();
    first.dispatchEvent(down);
    const downMs = performance.now() - start;
    window.dispatchEvent(move);
    const moveMs = performance.now() - start - downMs;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const firstFrameMs = performance.now() - start;
    window.dispatchEvent(up);
    const starts = [...root.querySelectorAll<HTMLElement>('button[data-start]')].map((cell) => Date.parse(cell.dataset.start!));
    return { cells, rows, downMs, moveMs, firstFrameMs, minStart: Math.min(...starts), maxStart: Math.max(...starts), viewAt: Number(root.dataset.viewAt), width: root.clientWidth };
  });
  console.log('GUIDE_FIRST_DRAG_METRICS', JSON.stringify(report));
  expect(report.cells).toBeLessThan(1200);
  expect(report.rows).toBeLessThan(40);
  expect(report.firstFrameMs).toBeLessThan(150);
});

test('a fast initial drag paints intermediate guide positions before reaching its destination', async ({ page, request }) => {
  const { grid } = await openDenseGuide(page, request, 5 * 60_000);
  await page.waitForTimeout(3500);
  for (const rtl of [false, true]) {
    await page.evaluate((value) => { document.documentElement.dir = value ? 'rtl' : 'ltr'; }, rtl);
    await grid.evaluate((root, rtl) => { root.scrollLeft = rtl ? -1000 : 1000; root.scrollTop = 400; }, rtl);
    await page.waitForTimeout(300);
    const positions = await grid.evaluate(async (root, rtl) => {
      const cell = root.querySelector('button[data-start]')!;
      const pointer = (type: string, x: number, y: number, buttons: number) =>
        new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'mouse', isPrimary: true, button: 0, buttons, clientX: x, clientY: y });
      // All three events arrive in one task: the old handler put the guide at its final position
      // before the first animation frame, so no transition could be painted.
      const start = performance.now();
      cell.dispatchEvent(pointer('pointerdown', 600, 400, 1));
      const downMs = performance.now() - start;
      window.dispatchEvent(pointer('pointermove', rtl ? 900 : 300, 160, 1));
      const moveMs = performance.now() - start - downMs;
      window.dispatchEvent(pointer('pointerup', rtl ? 900 : 300, 160, 0));
      const afterInput = { x: root.scrollLeft, y: root.scrollTop };
      const frames: { x: number; y: number; at: number }[] = [];
      for (let i = 0; i < 6; i++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        frames.push({ x: root.scrollLeft, y: root.scrollTop, at: performance.now() - start });
      }
      return { afterInput, frames, downMs, moveMs, cells: root.querySelectorAll('button[data-start]').length };
    }, rtl);
    console.log('GUIDE_FAST_DRAG_METRICS', JSON.stringify({ rtl, ...positions }));
    const progress = (x: number) => rtl ? -x : x;
    expect(progress(positions.afterInput.x)).toBeGreaterThan(1000);
    expect(progress(positions.afterInput.x)).toBeLessThan(1300);
    expect(positions.frames[0]).toMatchObject(positions.afterInput);
    expect(positions.frames[0]!.at).toBeLessThan(150);
    expect(progress(positions.frames[1]!.x)).toBeGreaterThan(progress(positions.afterInput.x));
    expect(progress(positions.frames[1]!.x)).toBeLessThan(1300);
    expect(positions.frames.at(-1)).toMatchObject({ x: rtl ? -1300 : 1300, y: 640 });

    await grid.evaluate((root) => { root.scrollLeft = 0; root.scrollTop = 400; });
    await page.waitForTimeout(300);
    const edge = await grid.evaluate(async (root, rtl) => {
      const channel = root.querySelector('[data-channel-row]')!;
      const pointer = (type: string, x: number, y: number, buttons: number) =>
        new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 9, pointerType: 'mouse', isPrimary: true, button: 0, buttons, clientX: x, clientY: y });
      channel.dispatchEvent(pointer('pointerdown', 400, 400, 1));
      window.dispatchEvent(pointer('pointermove', rtl ? 100 : 700, 160, 1));
      window.dispatchEvent(pointer('pointerup', rtl ? 100 : 700, 160, 0));
      for (let i = 0; i < 6; i++) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      return { x: root.scrollLeft, y: root.scrollTop };
    }, rtl);
    expect(edge).toEqual({ x: 0, y: 640 });
  }
});

test('time-navigation mounts target archive tiles while replenishing the offscreen buffer', async ({ page, request }, testInfo) => {
  test.setTimeout(60_000);
  const at = Date.UTC(2026, 9, 24, 10, 30);
  const { grid } = await openDenseGuide(page, request, 15 * 60_000, at, true);
  // Exclude startup work and warm the neighbouring slices, including the reverse journey.
  await page.waitForTimeout(6500);
  const reports = [];
  for (let i = 0; i < 8; i++) {
    const earlier = i < 4;
    const result = await page.getByRole('button', { name: earlier ? '3 hours earlier' : '3 hours later', exact: true }).evaluate(async (button, earlier) => {
      const root = document.querySelector<HTMLElement>('[data-testid="epg-grid"]')!;
      const before = root.scrollLeft;
      const previousAt = Number(root.dataset.viewAt);
      const target = previousAt + (earlier ? -3 : 3) * 60 * 60_000;
      const targetSelector = `button[data-cell-row="0"][data-start="${new Date(target).toISOString()}"]`;
      let added = 0;
      let maxBatch = 0;
      const frames: number[] = [];
      let previousFrame = performance.now();
      let measuring = true;
      const frame = (now: number) => {
        frames.push(now - previousFrame);
        previousFrame = now;
        if (measuring) requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
      const observer = new MutationObserver((records) => {
        let batch = 0;
        for (const record of records) for (const node of record.addedNodes) {
          if (node instanceof Element) batch += (node.matches('button[data-start]') ? 1 : 0) + node.querySelectorAll('button[data-start]').length;
        }
        added += batch;
        maxBatch = Math.max(maxBatch, batch);
      });
      observer.observe(root, { childList: true, subtree: true });
      const t = performance.now();
      // Calling click in this task lets us check native movement before React commits.
      (button as HTMLElement).click();
      const immediateDelta = root.scrollLeft - before;
      let firstFrameMs = 0;
      await new Promise<void>((resolve) => requestAnimationFrame(() => {
        firstFrameMs = performance.now() - t;
        requestAnimationFrame(() => resolve());
      }));
      const cell = root.querySelector<HTMLElement>(targetSelector);
      const box = cell?.getBoundingClientRect();
      const viewport = root.getBoundingClientRect();
      const targetVisible = !!box && box.right > viewport.left + 240 && box.left < viewport.right;
      const frameMs = performance.now() - t;
      // Include the old 180ms idle boundary and the subsequent offscreen population work.
      await new Promise((resolve) => setTimeout(resolve, 750));
      measuring = false;
      observer.disconnect();
      return {
        immediateDelta, firstFrameMs, frameMs, added, maxBatch, maxFrameMs: Math.max(...frames.slice(1)),
        kept: !!cell?.isConnected,
        targetVisible,
        actualAt: Number(root.dataset.viewAt), target,
      };
    }, earlier);
    expect(result.immediateDelta).toBe(earlier ? -900 : 900);
    expect(result.actualAt).toBe(result.target);
    expect(result.targetVisible).toBe(true);
    expect(result.kept).toBe(true);
    expect(result.maxBatch).toBeLessThanOrEqual(128);
    reports.push(result);
  }
  await expect(grid).toHaveAttribute('data-view-at', String(at));
  console.log('GUIDE_BUTTON_FRAMES', JSON.stringify(reports));
  await writeFile(testInfo.outputPath('button-navigation.json'), JSON.stringify(reports));
});

test('horizontal buffer population keeps visible tiles ready and bounds each DOM insertion', async ({ page, request, browserName }, testInfo) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  const at = Date.UTC(2026, 9, 24, 10, 30);
  const { grid } = await openDenseGuide(page, request, 15 * 60_000, at, true);
  await page.waitForTimeout(6500);
  const cdp = (process.env.EPG_PROFILE || process.env.EPG_TRACE) && browserName === 'chromium' ? await page.context().newCDPSession(page) : undefined;
  if (process.env.EPG_PROFILE && cdp) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.start');
  }
  if (process.env.EPG_TRACE && cdp) await cdp.send('Tracing.start', { categories: 'devtools.timeline,blink,cc', transferMode: 'ReturnAsStream' });
  const report = await grid.evaluate(async (root) => {
    const initial = root.scrollLeft;
    const initialAt = Number(root.dataset.viewAt);
    const frames: number[] = [];
    const activeFrames: number[] = [];
    const idleFrames: number[] = [];
    let moving = false;
    let previouslyMoving = false;
    let previous = performance.now();
    let measuring = true;
    let maxBatch = 0;
    let maxRemovedBatch = 0;
    let missingVisible = 0;
    const observer = new MutationObserver((records) => {
      let added = 0;
      let removed = 0;
      for (const record of records) for (const node of record.addedNodes) {
        if (node instanceof Element) added += Number(node.matches('button[data-start]')) + node.querySelectorAll('button[data-start]').length;
      }
      for (const record of records) for (const node of record.removedNodes) {
        if (node instanceof Element) removed += Number(node.matches('button[data-start]')) + node.querySelectorAll('button[data-start]').length;
      }
      maxBatch = Math.max(maxBatch, added);
      maxRemovedBatch = Math.max(maxRemovedBatch, removed);
    });
    observer.observe(root, { childList: true, subtree: true });
    const frame = (now: number) => {
      frames.push(now - previous);
      if (moving && previouslyMoving) activeFrames.push(now - previous);
      else if (!moving && !previouslyMoving) idleFrames.push(now - previous);
      previouslyMoving = moving;
      previous = now;
      if (measuring) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    // Thirty hours left and back, with pauses that include replenishment after wheel input.
    for (let leg = 0; leg < 4; leg++) {
      const base = root.scrollLeft;
      moving = true;
      await new Promise<void>((resolve) => {
        let i = 0;
        const move = () => {
          if (i % 5 === 0) {
            const time = initialAt + (root.scrollLeft - initial) / 5 * 60_000 + 60_000;
            const start = new Date(Math.floor(time / (15 * 60_000)) * 15 * 60_000).toISOString();
            if (!root.querySelector(`button[data-cell-row="0"][data-start="${start}"]`)) missingVisible++;
          }
          root.scrollLeft = base + (leg < 2 ? -1 : 1) * 50 * ++i;
          if (i < 90) requestAnimationFrame(move);
          else resolve();
        };
        requestAnimationFrame(move);
      });
      moving = false;
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
    measuring = false;
    observer.disconnect();
    const sorted = frames.slice(1).sort((a, b) => a - b);
    return { maxBatch, maxRemovedBatch, missingVisible,
      maxActiveFrameMs: Math.max(...activeFrames), maxIdleFrameMs: Math.max(...idleFrames),
      initial, final: root.scrollLeft, p95FrameMs: sorted[Math.floor(sorted.length * .95)],
      maxFrameMs: Math.max(...sorted), framesOver50ms: sorted.filter((ms) => ms > 50).length,
      rows: root.querySelectorAll('[data-channel-row]').length, cells: root.querySelectorAll('button[data-start]').length };
  });
  if (process.env.EPG_PROFILE && cdp) {
    const { profile } = await cdp.send('Profiler.stop');
    await writeFile(testInfo.outputPath('population.cpuprofile'), JSON.stringify(profile));
  }
  if (process.env.EPG_TRACE && cdp) {
    const done = new Promise<{ stream?: string }>((resolve) => cdp.once('Tracing.tracingComplete', resolve));
    await cdp.send('Tracing.end');
    const { stream } = await done;
    if (stream) {
      let contents = '';
      for (;;) {
        const chunk = await cdp.send('IO.read', { handle: stream });
        contents += chunk.data;
        if (chunk.eof) break;
      }
      await cdp.send('IO.close', { handle: stream });
      await writeFile(testInfo.outputPath('population-trace.json'), contents);
    }
  }
  expect(report.missingVisible).toBe(0);
  expect(report.maxBatch).toBeLessThanOrEqual(32);
  expect(report.final).toBe(report.initial);
  expect(report.rows).toBeLessThan(40);
  expect(report.cells).toBeLessThan(2400);
  console.log('GUIDE_POPULATION_METRICS', JSON.stringify(report));
  await writeFile(testInfo.outputPath('horizontal-population.json'), JSON.stringify(report));
});

// Dense schedules make render work measurable; channel count proves vertical DOM stays bounded.
test('dense guide keeps native scrolling and bounded rows across both axes', async ({ page, request, browserName }, testInfo) => {
  test.setTimeout(120_000);
  const { grid, requests } = await openDenseGuide(page, request);
  await page.waitForTimeout(1200);
  const cdp = browserName === 'chromium' ? await page.context().newCDPSession(page) : undefined;
  await cdp?.send('Performance.enable');
  if (process.env.EPG_PROFILE && cdp) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.start');
  }
  if (process.env.EPG_TRACE && cdp) await cdp.send('Tracing.start', { categories: 'devtools.timeline,blink,cc', transferMode: 'ReturnAsStream' });
  const reports = [];
  for (const axis of ['horizontal', 'vertical'] as const) {
    const before = await cdp?.send('Performance.getMetrics');
    const beforeCalls = requests();
    const result = await grid.evaluate(async (el, axis) => {
      const initialX = el.scrollLeft;
      const initialY = el.scrollTop;
      const frames: number[] = [];
      let previous = performance.now();
      let added = 0;
      const observer = new MutationObserver((records) => { for (const record of records) added += record.addedNodes.length; });
      observer.observe(el, { childList: true, subtree: true });
      // 180 animation frames, spanning several time/channel data chunks and returning.
      await new Promise<void>((resolve) => {
        let i = 0;
        const frame = (now: number) => {
          frames.push(now - previous);
          previous = now;
          const step = i < 90 ? i : 180 - i;
          if (axis === 'horizontal') el.scrollLeft = initialX + step * 45;
          else el.scrollTop = initialY + step * 40;
          if (++i <= 180) requestAnimationFrame(frame);
          else resolve();
        };
        requestAnimationFrame(frame);
      });
      observer.disconnect();
      const viewport = el.getBoundingClientRect();
      const visibleCells = [...el.querySelectorAll<HTMLElement>('button[data-start]')].filter((cell) => {
        const box = cell.getBoundingClientRect();
        return box.right > viewport.left + 250 && box.left < viewport.right && box.bottom > viewport.top + 40 && box.top < viewport.bottom;
      }).length;
      frames.shift();
      const sorted = [...frames].sort((a, b) => a - b);
      return { visibleCells, p95FrameMs: sorted[Math.floor(sorted.length * .95)], maxFrameMs: Math.max(...frames), framesOver32ms: frames.filter((n) => n > 32).length,
        stickyTitles: [...el.querySelectorAll<HTMLElement>('[data-testid=cell-text]')].filter((text) => getComputedStyle(text).position === 'sticky').length,
        addedNodes: added, cells: el.querySelectorAll('button[data-start]').length, rows: el.querySelectorAll('[data-channel-row]').length,
        initialX, finalX: el.scrollLeft };
    }, axis);
    const after = await cdp?.send('Performance.getMetrics');
    const metrics = Object.fromEntries((after?.metrics ?? []).filter(({ name }) => ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration'].includes(name)).map(({ name, value }) => [name, Math.round(1000 * (value - (before?.metrics.find((m) => m.name === name)?.value ?? 0)))]));
    reports.push({ axis, ...result, requests: requests() - beforeCalls, ...metrics });
    expect(result.rows).toBeLessThan(40);
    // Half-hour groups can prime neighbours on both sides of a group boundary.
    if (!process.env.EPG_BASELINE) expect(result.stickyTitles).toBeLessThanOrEqual(result.rows * 5);
    expect(result.visibleCells).toBeGreaterThan(0);
    expect(result.finalX).toBe(result.initialX);
    await page.waitForTimeout(500);
  }
  if (process.env.EPG_PROFILE && cdp) {
    const { profile } = await cdp.send('Profiler.stop');
    await writeFile(testInfo.outputPath('scroll.cpuprofile'), JSON.stringify(profile));
  }
  if (process.env.EPG_TRACE && cdp) {
    const done = new Promise<{ stream?: string }>((resolve) => cdp.once('Tracing.tracingComplete', resolve));
    await cdp.send('Tracing.end');
    const { stream } = await done;
    if (stream) {
      let contents = '';
      for (;;) {
        const chunk = await cdp.send('IO.read', { handle: stream });
        contents += chunk.data;
        if (chunk.eof) break;
      }
      await cdp.send('IO.close', { handle: stream });
      await writeFile(testInfo.outputPath('scroll-trace.json'), contents);
    }
  }
  console.log('GUIDE_SCROLL_METRICS', JSON.stringify(reports));
  await writeFile(testInfo.outputPath('scroll-metrics.json'), JSON.stringify(reports, null, 2));
});


test('clipped programme titles remain inside their cells in LTR and RTL', async ({ page, request }) => {
  const { grid } = await openDenseGuide(page, request, 2 * 60 * 60_000);
  for (const rtl of [false, true]) {
    await page.evaluate((rtl) => { document.documentElement.dir = rtl ? 'rtl' : 'ltr'; }, rtl);
    await expect.poll(() => grid.evaluate((el) => el.scrollLeft < 0)).toBe(rtl);
    // Put the viewport well inside a known two-hour slot, with enough remaining room for text.
    await grid.evaluate((el, rtl) => {
      const cell = [...el.querySelectorAll<HTMLElement>('button[data-start]')].find((cell) => {
        const box = cell.getBoundingClientRect();
        const viewport = el.getBoundingClientRect();
        return box.left > viewport.left + 250 && box.right < viewport.right - 250;
      }) ?? el.querySelector<HTMLElement>('button[data-start]')!;
      const text = cell.querySelector<HTMLElement>('[data-pad-left]')!;
      el.scrollLeft = (rtl ? -1 : 1) * (Number(text.dataset.padLeft) + 150);
    }, rtl);
    await expect.poll(() => grid.evaluate((el, rtl) => {
      const x = Math.abs(el.scrollLeft);
      const viewport = el.getBoundingClientRect();
      const row = el.querySelector<HTMLElement>('[aria-rowindex]')!;
      const col = row.querySelector<HTMLElement>('[role=rowheader]')!.getBoundingClientRect().width;
      const text = [...row.querySelectorAll<HTMLElement>('[data-pad-left]')].find((node) => Number(node.dataset.padLeft) < x && Number(node.dataset.padLeft) + Number(node.dataset.padWidth) > x);
      if (!text || getComputedStyle(text).position !== 'sticky') return false;
      const box = text.getBoundingClientRect();
      const cell = text.closest('button')!.getBoundingClientRect();
      const edge = rtl ? viewport.right - col : viewport.left + col;
      return rtl
        ? box.right <= edge && box.right >= edge - 15 && box.left >= cell.left
        : box.left >= edge && box.left <= edge + 15 && box.right <= cell.right;
    }, rtl)).toBe(true);
    // Native sticky positioning must hold on the same task as a wheel sized scroll. A
    // requestAnimationFrame based transform would still show the old position here.
    expect(await grid.evaluate((el, rtl) => {
      const x = Math.abs(el.scrollLeft);
      const text = [...el.querySelectorAll<HTMLElement>('[data-pad-left]')].find((node) =>
        Number(node.dataset.padLeft) < x && Number(node.dataset.padLeft) + Number(node.dataset.padWidth) > x);
      if (!text || getComputedStyle(text).position !== 'sticky') return false;
      const before = text.getBoundingClientRect();
      el.scrollLeft += rtl ? -30 : 30;
      const after = text.getBoundingClientRect();
      el.scrollLeft += rtl ? 30 : -30;
      const reversed = text.getBoundingClientRect();
      const edge = (box: DOMRect) => rtl ? box.right : box.left;
      return Math.abs(edge(before) - edge(after)) <= 1 && Math.abs(edge(before) - edge(reversed)) <= 1;
    }, rtl)).toBe(true);
    expect(await grid.evaluate((el, rtl) => {
      const x = Math.abs(el.scrollLeft);
      const text = [...el.querySelectorAll<HTMLElement>('[data-pad-left]')].find((node) =>
        Number(node.dataset.padLeft) < x && Number(node.dataset.padLeft) + Number(node.dataset.padWidth) > x);
      if (!text) return false;
      el.scrollLeft = (rtl ? -1 : 1) * (Number(text.dataset.padLeft) + Number(text.dataset.padWidth) - 30);
      const box = text.getBoundingClientRect();
      const cell = text.closest('button')!.getBoundingClientRect();
      return rtl ? box.left >= cell.left - 1 : box.right <= cell.right + 1;
    }, rtl)).toBe(true);
  }
});


// Exercise the Shift-wheel handler at a repeatable rate, including a six-hour data bucket
// crossing in each direction. Trusted mouse/trackpad inputs are covered in guide-left-scroll.
test('continuous Shift-wheel restores visible tiles while preparing the next time block', async ({ page, request }, testInfo) => {
  const { grid, requests } = await openDenseGuide(page, request, 15 * 60_000, Date.UTC(2026, 9, 23, 12, 30));
  await page.waitForTimeout(1000);
  await page.keyboard.down('Shift');
  const beforeCalls = requests();
  const report = await grid.evaluate(async (el) => {
    const initialX = el.scrollLeft;
    const initialWidth = el.scrollWidth;
    const initialAt = Number(el.dataset.viewAt);
    const originalCells = [...el.querySelectorAll<HTMLElement>('button[data-start]')].filter((cell) =>
      Math.abs(Date.parse(cell.dataset.start!) - initialAt) < 3 * 60 * 60_000);
    const frames: number[] = [];
    let previous = performance.now();
    let tileChanges = 0;
    let titleChanges = 0;
    let maxBatch = 0;
    const observer = new MutationObserver((records) => {
      let added = 0;
      for (const record of records) {
        if (record.type === 'attributes') {
          if ((record.target as Element).matches('[data-testid=cell-text]')) titleChanges++;
        } else {
          for (const node of record.addedNodes) {
            if (node instanceof Element) added += Number(node.matches('button[data-start]')) + node.querySelectorAll('button[data-start]').length;
          }
          for (const node of [...record.addedNodes, ...record.removedNodes]) {
            if (node instanceof Element) tileChanges += Number(node.matches('button[data-start]')) + node.querySelectorAll('button[data-start]').length;
          }
        }
      }
      maxBatch = Math.max(maxBatch, added);
    });
    observer.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
    await new Promise<void>((resolve) => {
      let i = 0;
      const frame = (now: number) => {
        frames.push(now - previous);
        previous = now;
        el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, shiftKey: true, deltaY: i < 90 ? -8 : 8 }));
        if (++i < 180) requestAnimationFrame(frame);
        else resolve();
      };
      requestAnimationFrame(frame);
    });
    observer.disconnect();
    frames.shift();
    frames.sort((a, b) => a - b);
    return {
      p95FrameMs: frames[Math.floor(frames.length * .95)], maxFrameMs: Math.max(...frames), framesOver32ms: frames.filter(n => n > 32).length,
      tileChanges, titleChanges, maxBatch, cells: originalCells.length,
      restoredVisible: !!el.querySelector(`button[data-cell-row="0"][data-start="${new Date(Math.floor(initialAt / (15 * 60_000)) * 15 * 60_000).toISOString()}"]`),
      initialX, finalX: el.scrollLeft, initialWidth, finalWidth: el.scrollWidth,
    };
  });
  await page.keyboard.up('Shift');
  const metrics = { ...report, requests: requests() - beforeCalls };
  console.log('SHIFT_WHEEL_METRICS', JSON.stringify(metrics));
  await writeFile(testInfo.outputPath('shift-wheel-metrics.json'), JSON.stringify(metrics, null, 2));
  expect(report.finalX).toBe(report.initialX);
  expect(report.finalWidth).toBe(report.initialWidth);
  if (!process.env.EPG_BASELINE) {
    expect(report.restoredVisible).toBe(true);
    expect(report.maxBatch).toBeLessThanOrEqual(32);
  }
});

// Unlike dispatchEvent, trusted wheel input exercises browser animation, hit testing and
// hover under the pointer. Sample movement too: quick frames with one jump per notch still judder.
test('wheel notches move through intermediate positions in both Shift-wheel event formats', async ({ page, request }, testInfo) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  const { grid } = await openDenseGuide(page, request, 15 * 60_000, Date.UTC(2026, 9, 23, 12, 30));
  // Exclude lazy player startup from this input/rendering measurement.
  await page.waitForTimeout(6500);
  const box = (await grid.boundingBox())!;
  await page.mouse.move(box.x + 500, box.y + 130);
  const initial = await grid.evaluate(el => el.scrollLeft);
  const reports = [];
  for (const axis of ['y', 'x'] as const) {
    await grid.evaluate(el => {
      const state = { stop: false, frames: [] as { t: number; x: number }[] };
      (window as unknown as { wheelAudit: typeof state }).wheelAudit = state;
      const frame = (t: number) => {
        state.frames.push({ t, x: el.scrollLeft });
        if (!state.stop) requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
    await page.keyboard.down('Shift');
    for (let i = 0; i < 12; i++) {
      await page.mouse.wheel(axis === 'x' ? 60 : 0, axis === 'y' ? -60 : 0);
      await page.waitForTimeout(70);
    }
    await page.keyboard.up('Shift');
    await expect.poll(() => grid.evaluate(el => el.scrollLeft)).toBe(axis === 'y' ? initial - 720 : initial);
    const report = await page.evaluate(() => {
      const state = (window as unknown as { wheelAudit: { stop: boolean; frames: { t: number; x: number }[] } }).wheelAudit;
      state.stop = true;
      const diffs = state.frames.slice(1).map((f, i) => ({ ms: f.t - state.frames[i]!.t, dx: f.x - state.frames[i]!.x }));
      const times = diffs.map(f => f.ms).sort((a, b) => a - b);
      return { movingFrames: diffs.filter(f => f.dx !== 0).length, intermediateFrames: diffs.filter(f => Math.abs(f.dx) > 0 && Math.abs(f.dx) < 60).length,
        p95FrameMs: times[Math.floor(times.length * .95)], maxFrameMs: Math.max(...times) };
    });
    reports.push({ axis, ...report });
    // Twelve instantaneous jumps fail this, even when their frame times are excellent.
    expect(report.movingFrames).toBeGreaterThan(24);
    expect(report.intermediateFrames).toBeGreaterThan(24);
    await expect(grid).not.toHaveAttribute('data-guide-scrolling');
  }
  console.log('TRUSTED_SHIFT_WHEEL_METRICS', JSON.stringify(reports));
  await writeFile(testInfo.outputPath('trusted-shift-wheel-metrics.json'), JSON.stringify(reports, null, 2));

  // The OS reduced-motion preference and the app's override both bypass wheel animation.
  for (const preference of ['system', 'app']) {
    await page.emulateMedia({ reducedMotion: preference === 'system' ? 'reduce' : 'no-preference' });
    await page.keyboard.down('Shift');
    const step = await grid.evaluate((el, preference) => {
      // Set the document override in the same task as input: ThemeSync responds asynchronously
      // to the media change and would otherwise replace it with the system preference.
      if (preference === 'app') document.documentElement.dataset.reducedMotion = 'true';
      const before = el.scrollLeft;
      el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, shiftKey: true, deltaY: -60 }));
      return el.scrollLeft - before;
    }, preference);
    expect(step).toBe(-60);
    await page.keyboard.up('Shift');
  }
});
