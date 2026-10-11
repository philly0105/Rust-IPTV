import { expect, type Page } from '@playwright/test';

/**
 * Asserts the page has no horizontal scrollbar: neither the document nor the
 * shell's main scroller is wider than its box. On failure the message names the
 * widest elements that stick out past the viewport.
 */
export async function expectNoHorizontalScroll(page: Page, label: string): Promise<void> {
  const report = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const scrollers = [document.documentElement, document.body, document.querySelector<HTMLElement>('#main'), document.querySelector<HTMLElement>('main')].filter(
      (el): el is HTMLElement => !!el,
    );
    const overflow = scrollers
      .filter((el) => {
        const style = getComputedStyle(el);
        const clips = el !== document.documentElement && el !== document.body && (style.overflowX === 'hidden' || style.overflowX === 'clip');
        return !clips && el.scrollWidth > el.clientWidth + 1;
      })
      .map((el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''} scrollWidth=${el.scrollWidth} clientWidth=${el.clientWidth}`);
    const offenders: string[] = [];
    if (overflow.length) {
      for (const el of document.querySelectorAll<HTMLElement>('body *')) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.right > vw + 1) {
          offenders.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)} right=${Math.round(r.right)}`);
          if (offenders.length >= 5) break;
        }
      }
    }
    return { vw, overflow, offenders };
  });
  expect(report.overflow, `${label}: horizontal overflow (viewport ${report.vw}px). Sticking out: ${report.offenders.join(' | ')}`).toEqual([]);
}

/** Lets layout settle after navigation without depending on network idleness (live pages stream). */
export async function settle(page: Page, ms = 400): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.waitForTimeout(ms);
}
