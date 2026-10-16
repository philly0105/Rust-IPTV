import type { Channel, Page as RpcPage } from '../src/api/types';
import { ensureSource, resetApp, rpc } from './helpers/api';
import { expect, test } from './helpers/fixtures';

// Catch-up archive browser: an Xtream channel with tv_archive (mock streams
// 101..105) opens /live/archive/<source>/<channel> with a day picker and either a
// programme list or the designed empty state for the selected day.

const NAME = 'Archive Xtream';

let sourceId = '';
let channel: Channel;

test.beforeAll(async ({ request }) => {
  await resetApp(request);
  sourceId = (await ensureSource(request, 'xtream', NAME)).id;
  const page = await rpc<RpcPage<Channel>>(request, 'catalog.channels', { sourceId, query: { offset: 0, limit: 200, sort: 'number', dir: 'asc' } });
  const withArchive = page.items.find((c) => !c.isRadio && c.archive);
  if (!withArchive) throw new Error('mock portal has no live channel with an archive');
  channel = withArchive;
});

test('archive view shows the day picker and the selected day', async ({ page }) => {
  await page.goto(`/live/archive/${encodeURIComponent(sourceId)}/${encodeURIComponent(channel.ref.itemId)}`);
  const archive = page.getByTestId('archive-page');
  await expect(archive).toBeVisible();

  const days = archive.getByRole('tablist', { name: 'Archive day' });
  await expect(days).toBeVisible();
  const tabs = days.getByRole('tab');
  expect(await tabs.count()).toBeGreaterThan(1);
  await expect(tabs.first()).toHaveText(/Today/);
  await expect(days.getByRole('tab', { selected: true })).toHaveCount(1);

  // The day settles into a programme list or the designed empty state, never a spinner or an error.
  const programs = archive.getByTestId('archive-programs');
  const empty = archive.getByText('Nothing listed for this day');
  await expect(programs.or(empty).first()).toBeVisible();
  if (await programs.isVisible()) expect(await programs.getByRole('listitem').count()).toBeGreaterThan(0);

  // Another day keeps the picker and settles the same way.
  await tabs.nth(1).click();
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(programs.or(empty).first()).toBeVisible();
});
