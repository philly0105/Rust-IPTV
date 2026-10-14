import AxeBuilder from '@axe-core/playwright';
import type { APIRequestContext, Page } from '@playwright/test';

import type { Channel, CustomList, CustomListEntry, Page as RpcPage } from '../src/api/types';
import { ensureSource, resetApp, rpc } from './helpers/api';
import { expect, test } from './helpers/fixtures';
import { expectNoHorizontalScroll, settle } from './helpers/layout';

// Custom channel lists (contract C3) end to end against the real core: add a
// channel from Live with the L key and from the context menu, open the list
// page with channels from two sources, manage lists (rename, reorder by
// keyboard, delete with Undo), find the list on Home, and check axe and
// layout from phone to wide desktop. Needs the integration wiring: the
// /lists routes, ListsDialogHost, the Live sidebar section, the Live context
// menu item, the L shortcut on LivePage and the dashboard rails.

let xtreamId = '';
let m3uId = '';
let xtream: Channel[] = [];
let m3u: Channel[] = [];

async function liveChannels(request: APIRequestContext, sourceId: string): Promise<Channel[]> {
  const res = await rpc<RpcPage<Channel>>(request, 'catalog.channels', { sourceId, query: { offset: 0, limit: 20, sort: 'number', dir: 'asc' } });
  return res.items.filter((c) => !c.isRadio);
}

const allLists = (request: APIRequestContext) => rpc<CustomList[]>(request, 'lists.list');
const itemsOf = (request: APIRequestContext, id: string) => rpc<CustomListEntry[]>(request, 'lists.items', { id });
const snap = (c: Channel) => ({ ref: c.ref, snapshot: { title: c.name, contentType: c.ref.contentType } });

async function clearLists(request: APIRequestContext): Promise<void> {
  for (const l of await allLists(request)) await rpc(request, 'lists.remove', { id: l.id });
}

async function makeList(request: APIRequestContext, name: string, channels: Channel[], onDashboard = false): Promise<CustomList> {
  const list = await rpc<CustomList>(request, 'lists.create', { name, items: channels.map(snap) });
  // A new list shows on Home by default (C3: on_dashboard DEFAULT 1).
  if (list.onDashboard !== onDashboard) return rpc<CustomList>(request, 'lists.update', { id: list.id, onDashboard });
  return list;
}

/** The visible toast with this text (the sr-only live region repeats it outside the list). */
function toastWith(page: Page, text: string) {
  return page.getByRole('region', { name: 'Notifications' }).getByRole('listitem').filter({ hasText: text });
}

/** The Manage dialog's list names in the order on screen. */
async function manageNames(page: Page): Promise<string[]> {
  return page
    .getByTestId('manage-lists')
    .locator('[data-sort-key] [data-sort-part="name"] > span:first-child')
    .allInnerTexts();
}

async function seriousViolations(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']).analyze();
  return result.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.impact} ${v.id}: ${v.help} -> ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
}

test.describe('Custom lists', () => {
  test.beforeAll(async ({ request }) => {
    await resetApp(request);
    xtreamId = (await ensureSource(request, 'xtream', 'Lists Xtream')).id;
    m3uId = (await ensureSource(request, 'm3u', 'Lists Playlist')).id;
    xtream = await liveChannels(request, xtreamId);
    m3u = await liveChannels(request, m3uId);
    expect(xtream.length).toBeGreaterThanOrEqual(3);
    expect(m3u.length).toBeGreaterThanOrEqual(2);
  });

  test.beforeEach(async ({ request }) => {
    await clearLists(request);
  });

  test('add from Live with L and the context menu; the list mixes sources', async ({ page, request }) => {
    const [a] = xtream as [Channel];
    const [b] = m3u as [Channel];

    // L on a focused channel row opens the picker; New list starts with that channel.
    await page.goto(`/s/${xtreamId}/live`);
    const rows = page.getByTestId('channel-list').locator('button[data-row-index]');
    await expect(rows.first()).toBeVisible();
    await rows.first().focus();
    await page.keyboard.press('l');
    const picker = page.getByTestId('list-picker');
    await expect(picker).toBeVisible();
    await expect(picker.getByText(a.name)).toBeVisible();
    await expect(picker.getByText('No lists yet. Name one below.')).toBeVisible();
    await picker.getByLabel('New list name').fill('Evening');
    await picker.getByRole('button', { name: 'Create' }).click();
    await expect(picker.getByRole('checkbox', { checked: true })).toHaveCount(1);
    await picker.getByRole('button', { name: 'Done' }).click();
    await expect(picker).toBeHidden();
    // Focus goes back to the row, and L was not taken as a seek.
    await expect(rows.first()).toBeFocused();

    const [evening] = await allLists(request);
    expect(evening?.name).toBe('Evening');
    expect((await itemsOf(request, evening!.id)).map((e) => e.ref.itemId)).toEqual([a.ref.itemId]);

    // The context menu of a channel from the other source adds it to the same list.
    await page.goto(`/s/${m3uId}/live`);
    await rows.first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Add to list…' }).click();
    // The check box is visually hidden under its drawn box, so click the row's label as a user would.
    const option = picker.getByTestId('list-picker-options').locator('label').first();
    await option.click();
    await expect(option.getByRole('checkbox')).toBeChecked();
    await expect(toastWith(page, 'Added to Evening').or(picker.getByText('Added to Evening'))).toBeAttached();
    await picker.getByRole('button', { name: 'Done' }).click();
    await expect.poll(async () => (await itemsOf(request, evening!.id)).map((e) => e.ref.sourceId)).toEqual([xtreamId, m3uId]);

    // The sidebar section leads to the list page with both channels.
    await page.getByTestId('lists-section').getByRole('link', { name: /Evening/ }).click();
    await expect(page).toHaveURL(new RegExp(`/lists/${evening!.id}$`));
    const listPage = page.getByTestId('list-page');
    await expect(listPage.getByTestId('channel-list').locator('button[data-row-index]')).toHaveCount(2);
    await expect(listPage.getByTestId('list-sources')).toContainText('Lists Xtream');
    await expect(listPage.getByTestId('list-sources')).toContainText('Lists Playlist');
    await expect(listPage.getByText(b.name).first()).toBeVisible();
  });

  test('manage: rename, reorder by keyboard, delete with Undo; the order survives a reload', async ({ page, request }) => {
    const [a, b, c] = xtream as [Channel, Channel, Channel];
    await makeList(request, 'Sports', [a, b]);
    const kids = await makeList(request, 'Kids', [c], true);
    await makeList(request, 'News', [a]);

    await page.goto('/lists');
    await expect(page).toHaveURL(/\/lists\/[^/]+$/);
    await page.getByRole('button', { name: 'Manage lists' }).first().click();
    const dialog = page.getByTestId('manage-lists-dialog');
    await expect(dialog).toBeVisible();
    expect(await manageNames(page)).toEqual(['Sports', 'Kids', 'News']);

    // Rename inline.
    await dialog.getByRole('button', { name: 'Rename Sports' }).click();
    const input = dialog.getByRole('textbox', { name: 'Rename Sports' });
    await expect(input).toBeFocused();
    await input.fill('Football');
    await input.press('Enter');
    await expect(toastWith(page, 'Renamed to Football')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Rename Football' })).toBeFocused();

    // Alt+ArrowDown on the grip moves the list; focus stays on it.
    await dialog.getByRole('button', { name: 'Move Football', exact: true }).focus();
    await page.keyboard.press('Alt+ArrowDown');
    await expect.poll(() => manageNames(page)).toEqual(['Kids', 'Football', 'News']);
    await expect(dialog.getByRole('button', { name: 'Move Football', exact: true })).toBeFocused();
    await expect.poll(async () => (await allLists(request)).map((l) => l.name)).toEqual(['Kids', 'Football', 'News']);

    // Delete, then Undo: same name, channels, Home rail and place.
    await dialog.getByRole('button', { name: 'Delete Kids' }).click();
    await expect.poll(() => manageNames(page)).toEqual(['Football', 'News']);
    await toastWith(page, 'Deleted Kids').getByRole('button', { name: 'Undo' }).click();
    await expect.poll(() => manageNames(page)).toEqual(['Kids', 'Football', 'News']);
    const restored = (await allLists(request))[0]!;
    expect(restored.id).not.toBe(kids.id);
    expect(restored.onDashboard).toBe(true);
    expect((await itemsOf(request, restored.id)).map((e) => e.ref.itemId)).toEqual([c.ref.itemId]);

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await page.reload();
    await page.getByRole('button', { name: 'Manage lists' }).first().click();
    await expect.poll(() => manageNames(page)).toEqual(['Kids', 'Football', 'News']);
  });

  test('edit channels: reorder by keyboard and remove with Undo', async ({ page, request }) => {
    const [a, b, c] = xtream as [Channel, Channel, Channel];
    const list = await makeList(request, 'Morning', [a, b, c]);
    await page.goto(`/lists/${list.id}`);
    await page.getByRole('button', { name: 'Edit channels' }).first().click();
    const dialog = page.getByTestId('edit-list-dialog');
    await expect(dialog.getByTestId('edit-list-items').getByRole('listitem')).toHaveCount(3);

    await dialog.getByRole('button', { name: `Move ${c.name}`, exact: true }).focus();
    await page.keyboard.press('Alt+ArrowUp');
    await expect(dialog.getByRole('button', { name: `Move ${c.name}`, exact: true })).toBeFocused();
    await expect.poll(async () => (await itemsOf(request, list.id)).map((e) => e.ref.itemId)).toEqual([a, c, b].map((x) => x.ref.itemId));

    await dialog.getByRole('button', { name: `Remove ${a.name}` }).click();
    await expect(dialog.getByTestId('edit-list-items').getByRole('listitem')).toHaveCount(2);
    await toastWith(page, `Removed ${a.name} from Morning`).getByRole('button', { name: 'Undo' }).click();
    await expect.poll(async () => (await itemsOf(request, list.id)).map((e) => e.ref.itemId)).toEqual([a, c, b].map((x) => x.ref.itemId));
  });

  test('a list shown on Home gets a rail that plays from the list', async ({ page, request }) => {
    const [a, b] = xtream as [Channel, Channel];
    const list = await makeList(request, 'Favourites rail', [a, b], true);
    await makeList(request, 'Not on Home', [a]);
    await page.goto('/dashboard');
    const rail = page.getByTestId(`dashboard-rail-list-${list.id}`);
    await expect(rail).toBeVisible();
    await expect(rail).toContainText('2 channels');
    await expect(page.getByText('Not on Home')).toHaveCount(0);
    await rail.getByRole('link', { name: 'See all' }).click();
    await expect(page).toHaveURL(new RegExp(`/lists/${list.id}$`));
  });

  test('designed empty states, then axe and layout from phone to wide desktop', async ({ page, request }) => {
    await page.goto('/lists');
    await expect(page.getByTestId('lists-index')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create list' })).toBeVisible();

    const [a, b] = xtream as [Channel, Channel];
    const [c] = m3u as [Channel];
    const list = await makeList(request, 'A list with a fairly long name for layout checks', [a, b, c]);
    const empty = await makeList(request, 'Empty one', []);

    const failures: string[] = [];
    for (const vp of [
      { width: 390, height: 844 },
      { width: 800, height: 600 },
      { width: 1920, height: 1080 },
    ]) {
      await page.setViewportSize(vp);
      for (const path of [`/lists/${list.id}`, `/lists/${empty.id}`]) {
        await page.goto(path);
        await expect(page.getByTestId('list-page')).toBeVisible();
        await settle(page, 500);
        await expectNoHorizontalScroll(page, `${path} @ ${vp.width}x${vp.height}`);
        for (const v of await seriousViolations(page)) failures.push(`${path} @ ${vp.width}: ${v}`);
      }
      await page.goto(`/lists/${list.id}`);
      await page.getByRole('button', { name: 'Manage lists' }).first().click();
      await expect(page.getByTestId('manage-lists-dialog')).toBeVisible();
      await settle(page, 300);
      await expectNoHorizontalScroll(page, `manage @ ${vp.width}x${vp.height}`);
      for (const v of await seriousViolations(page)) failures.push(`manage @ ${vp.width}: ${v}`);
      await page.keyboard.press('Escape');
    }
    expect(failures, 'axe serious/critical violations').toEqual([]);
  });
});
