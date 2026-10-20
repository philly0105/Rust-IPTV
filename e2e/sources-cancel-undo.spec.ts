import type { Page } from '@playwright/test';

import type { Source } from '../src/api/types';
import { listSources, resetApp, rpc } from './helpers/api';
import { M3U_URL, MOCK, MOCK_FACTS } from './helpers/env';
import { expect, test } from './helpers/fixtures';
import { blurFocus, openAddSourceDialog } from './helpers/ui';

// C8 and C9: a running import or refresh can be cancelled and leaves no
// half-written catalog; "Refresh all" can be stopped; removing a source can be
// undone, and once the undo window passes the removal is real (reload confirms).

/** A playlist that streams slowly enough to cancel mid-import (iptv-mock `/fail/slow-large.m3u`). */
const SLOW_URL = `${MOCK}/fail/slow-large.m3u?channels=50000&ms=400`;

/** The browser's own log line for the rejected request of a cancelled run. */
const CANCELLED_LOAD = /Failed to load resource: the server responded with a status of 409 .*\/api\/rpc\/sources\.(add|refresh)\b/;

function m3uArgs(name: string, url: string): Record<string, unknown> {
  return { kind: 'm3u', name, m3u: { origin: 'url', url, headers: {} } };
}

/** Adds a fast M3U source over rpc, then points it at the slow playlist so the next refresh can be cancelled. */
async function slowRefreshSource(page: Page, name: string): Promise<Source> {
  const added = await rpc<Source>(page.request, 'sources.add', m3uArgs(name, M3U_URL));
  expect(added.channelCount).toBe(MOCK_FACTS.m3uChannels);
  return rpc<Source>(page.request, 'sources.update', { id: added.id, patch: { m3u: { origin: 'url', url: SLOW_URL, headers: {} } } });
}

function card(page: Page, name: string) {
  return page.getByTestId('source-card').filter({ has: page.getByTestId('source-name').filter({ hasText: name }) });
}

/** Remove, from the card's More actions menu. */
async function removeFromCard(page: Page, name: string): Promise<void> {
  await card(page, name).getByRole('button', { name: `More actions for ${name}` }).click();
  await page.getByRole('menu', { name: `More actions for ${name}` }).getByRole('menuitem', { name: 'Remove', exact: true }).click();
}

/** One visible toast (not the screen-reader live region that repeats its text). */
function toastItem(page: Page, text: string) {
  return page.getByRole('region', { name: 'Notifications' }).getByRole('listitem').filter({ hasText: text });
}

/** The catalog of the source is the one from before the cancelled run. */
async function expectCatalogKept(page: Page, id: string): Promise<void> {
  const after = await rpc<Source>(page.request, 'sources.get', { id });
  expect(after.lastError ?? null, 'a cancel is not an error').toBeNull();
  expect(after.channelCount).toBe(MOCK_FACTS.m3uChannels);
  const counts = await rpc<{ channelCount: number }>(page.request, 'sources.counts', { id });
  expect(counts.channelCount).toBe(MOCK_FACTS.m3uChannels);
}

test.describe('sources: cancel and undo', () => {
  test.beforeEach(async ({ request }) => {
    await resetApp(request);
  });

  test('cancelling an add stops the import and leaves no source behind', async ({ page, consoleLog }) => {
    // The cancelled run's own request answers 409 (conflict, details.cancelled); the browser logs that load.
    consoleLog.allow(CANCELLED_LOAD);
    const name = 'Cancel Add';
    const dialog = await openAddSourceDialog(page);
    await dialog.getByRole('tab', { name: 'M3U playlist' }).click();
    await dialog.getByRole('textbox', { name: /^Name/ }).fill(name);
    await dialog.getByRole('tab', { name: 'URL' }).click();
    await dialog.getByRole('textbox', { name: 'Playlist URL' }).fill(SLOW_URL);
    await page.getByTestId('add-source-submit').click();

    const cancel = dialog.getByTestId('import-cancel');
    await expect(cancel).toBeVisible({ timeout: 20_000 });
    await cancel.click();

    const cancelled = dialog.getByTestId('add-source-cancelled');
    await expect(cancelled).toBeVisible({ timeout: 20_000 });
    await expect(cancelled.getByTestId('import-progress-phase')).toHaveText('Import cancelled');
    await expect(cancelled.getByTestId('import-cancelled-note')).toHaveText(/Nothing was added/);
    // The form keeps the details for another try.
    await expect(dialog.getByRole('textbox', { name: 'Playlist URL' })).toHaveValue(SLOW_URL);
    await expect(page.getByTestId('add-source-error')).toHaveCount(0);

    // No half-written source: the row the add inserted is gone, and no channels were kept.
    await expect.poll(async () => (await listSources(page.request)).filter((s) => s.name === name).length, { timeout: 20_000 }).toBe(0);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(card(page, name)).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('sources-page')).toBeVisible();
    await expect(card(page, name)).toHaveCount(0);
  });

  test('a refresh cancelled away from Sources shows the cancelled toast and keeps the catalog', async ({ page }) => {
    const name = 'Cancel Refresh';
    const source = await slowRefreshSource(page, name);
    await page.goto('/dashboard');
    await expect(page.getByTestId('dashboard')).toBeVisible();

    // The refresh blocks until it ends. The server broadcasts its import.progress events to this tab.
    const refresh = page.request
      .post('/api/rpc/sources.refresh', { data: JSON.stringify({ id: source.id }), headers: { 'content-type': 'application/json' }, timeout: 90_000 })
      .then((r) => r.status());
    // The run is registered once the import starts; cancelImport answers true from then on.
    await expect.poll(() => rpc<boolean>(page.request, 'sources.cancelImport', { id: source.id }), { timeout: 20_000 }).toBe(true);
    expect(await refresh, 'the cancelled refresh rejects').toBeGreaterThanOrEqual(400);

    await expect(toastItem(page, `Import of ${name} cancelled`)).toBeVisible();
    await expectCatalogKept(page, source.id);
  });

  test('"Refresh all" can be stopped and the catalog stays as it was', async ({ page, consoleLog }) => {
    // The cancelled run's own request answers 409 (conflict, details.cancelled); the browser logs that load.
    consoleLog.allow(CANCELLED_LOAD);
    const name = 'Stop All';
    const source = await slowRefreshSource(page, name);
    await page.goto('/sources');
    await expect(card(page, name)).toBeVisible();

    await page.getByTestId('sources-refresh-all').click();
    const stop = page.getByTestId('sources-refresh-all-stop');
    await expect(stop).toBeVisible();
    await expect(card(page, name).getByTestId('import-progress')).toBeVisible({ timeout: 20_000 });
    await stop.click();

    await expect(toastItem(page, 'Refresh stopped: 0 of 1 done')).toBeVisible({ timeout: 20_000 });
    await expect(stop).toBeHidden();
    await expect(page.getByTestId('sources-refresh-all')).toBeEnabled();
    // The card says the run was cancelled, not that it failed.
    await expect(card(page, name).getByTestId('source-error')).toHaveCount(0);
    await expectCatalogKept(page, source.id);
  });

  test('removing a source offers Undo; Undo restores it', async ({ page }) => {
    const name = 'Undo Me';
    const source = await rpc<Source>(page.request, 'sources.add', m3uArgs(name, M3U_URL));
    await page.goto('/sources');
    await expect(card(page, name)).toBeVisible();

    await removeFromCard(page, name);
    await expect(card(page, name)).toHaveCount(0);
    const toast = toastItem(page, `Removed ${name}`);
    await expect(toast).toBeVisible();
    await toast.getByRole('button', { name: 'Undo' }).click();

    await expect(card(page, name)).toBeVisible();
    await expect(toast).toBeHidden();
    // Nothing was sent: the source and its catalog are untouched, also after the undo window.
    await page.waitForTimeout(9_000);
    const kept = await rpc<Source>(page.request, 'sources.get', { id: source.id });
    expect(kept.channelCount).toBe(MOCK_FACTS.m3uChannels);
    await page.reload();
    await expect(card(page, name)).toBeVisible();
  });

  test('a removal without Undo goes through when the toast expires', async ({ page }) => {
    const name = 'Remove Me';
    const keep = 'Keep Me';
    const source = await rpc<Source>(page.request, 'sources.add', m3uArgs(name, M3U_URL));
    // sources.add refuses a second source on one address; the mock serves the same playlist
    // whatever the query, and the query makes it a different address.
    await rpc<Source>(page.request, 'sources.add', m3uArgs(keep, `${M3U_URL}?copy=keep`));
    await page.goto('/sources');
    await expect(card(page, name)).toBeVisible();

    await removeFromCard(page, name);
    await expect(card(page, name)).toHaveCount(0);
    await expect(toastItem(page, `Removed ${name}`)).toBeVisible();
    // Still there while Undo is offered.
    expect((await listSources(page.request)).some((s) => s.id === source.id)).toBe(true);

    // The removal commits on its own 8 s timer (UNDO_MS), whatever the toast does. Hover or focus
    // only pauses the toast's own timer, so move the mouse and focus away to let the toast close too.
    await page.mouse.move(1, 1);
    await blurFocus(page);
    await expect.poll(async () => (await listSources(page.request)).some((s) => s.id === source.id), { timeout: 20_000 }).toBe(false);
    await expect(toastItem(page, `Removed ${name}`)).toBeHidden();

    await page.reload();
    await expect(card(page, keep)).toBeVisible();
    await expect(card(page, name)).toHaveCount(0);
  });
});
