import type { APIRequestContext, Locator, Page } from '@playwright/test';

import type { Category, Channel, Page as RpcPage, ParentalLock, ParentalLockTarget, ParentalStatus, Source } from '../src/api/types';
import { ensureSource, resetApp, rpc } from './helpers/api';
import { MOCK } from './helpers/env';
import { expect, test } from './helpers/fixtures';
import { expectPlaying } from './helpers/media';
import { channelButton, gotoLive, playerRegion } from './helpers/ui';

// Parental controls (C2): the first PIN from Settings, Hide mode dropping a
// locked group from the live list, Ask mode asking for the PIN before a
// locked channel plays, Lock now, removing a lock with the PIN, adult groups
// locked automatically, and turning the controls off with the locks kept.
// One wrong PIN in total, so the wrong-PIN lockout never starts.

const PIN = '2580';
const WRONG_PIN = '9135';
const XTREAM_NAME = 'Parental Xtream';
const M3U_NAME = 'Parental M3U';

/** A pasted playlist with one adult group, pointing at the mock's live HLS streams. */
const ADULT_PLAYLIST = [
  '#EXTM3U',
  `#EXTINF:-1 tvg-id="pc.news" tvg-chno="1" group-title="Pasted News",Pasted News One`,
  `${MOCK}/xtream/live/demo/secret/101.m3u8`,
  `#EXTINF:-1 tvg-id="pc.late" tvg-chno="2" group-title="XXX Live",Late Night`,
  `${MOCK}/xtream/live/demo/secret/102.m3u8`,
  '',
].join('\n');

const status = (request: APIRequestContext) => rpc<ParentalStatus>(request, 'parental.status');
const locks = (request: APIRequestContext) => rpc<ParentalLock[]>(request, 'parental.locks', {});

/**
 * Controls off, no locks, default behaviour. Runs before and after the spec so
 * a failed run does not leave other specs behind a PIN.
 */
async function resetParental(request: APIRequestContext): Promise<void> {
  if ((await status(request)).enabled) await rpc(request, 'parental.disable', { pin: PIN });
  for (const l of await locks(request)) {
    const target: ParentalLockTarget = { sourceId: l.sourceId, contentType: l.contentType, kind: l.kind, targetId: l.targetId, name: l.name };
    await rpc(request, 'parental.setLocked', { target, locked: false });
  }
  await rpc(request, 'parental.configure', { mode: 'hide', autoAdult: true, unlockMinutes: 15 });
}

async function liveCategory(request: APIRequestContext, sourceId: string, name: string): Promise<Category> {
  const categories = await rpc<Category[]>(request, 'catalog.categories', { sourceId, contentType: 'live' });
  const found = categories.find((c) => c.name === name);
  if (!found) throw new Error(`no live group "${name}" in ${sourceId}`);
  return found;
}

async function liveChannel(request: APIRequestContext, sourceId: string, name: string): Promise<Channel> {
  const page = await rpc<RpcPage<Channel>>(request, 'catalog.channels', { sourceId, query: { offset: 0, limit: 200, sort: 'number', dir: 'asc' } });
  const found = page.items.find((c) => c.name === name);
  if (!found) throw new Error(`no channel "${name}" in ${sourceId}`);
  return found;
}

function lock(request: APIRequestContext, target: ParentalLockTarget): Promise<void> {
  return rpc(request, 'parental.setLocked', { target, locked: true });
}

/** A group link in the live view's Groups navigation ("News 3"). */
function groupLink(page: Page, name: string): Locator {
  return page.getByRole('navigation', { name: 'Groups' }).getByRole('link', { name: new RegExp(`^${name} \\d+$`) });
}

function toast(page: Page, text: string): Locator {
  return page.locator('[data-toast-id]').filter({ hasText: text });
}

/** Types the PIN into the dialog with this test id and presses its confirm button. */
async function enterPin(page: Page, testId: string, pin: string): Promise<void> {
  const dialog = page.getByTestId(testId);
  await expect(dialog).toBeVisible();
  await dialog.getByTestId(`${testId}-field-input`).fill(pin);
  await page.getByTestId(`${testId}-submit`).click();
}

async function openSettings(page: Page): Promise<Locator> {
  await page.goto('/settings/parental');
  const section = page.getByTestId('settings-parental');
  await expect(section).toBeVisible();
  return section;
}

test.describe.serial('parental controls', () => {
  let xtream: Source;
  let m3u: Source;

  test.beforeAll(async ({ request }) => {
    await resetParental(request);
    await resetApp(request);
    xtream = await ensureSource(request, 'xtream', XTREAM_NAME);
    m3u = await rpc<Source>(request, 'sources.add', { kind: 'm3u', name: M3U_NAME, m3u: { origin: 'text', text: ADULT_PLAYLIST, headers: {} } });
    expect(m3u.lastError, 'pasted playlist imports').toBeFalsy();
  });

  test.afterAll(async ({ request }) => {
    await resetParental(request);
  });

  test('set the first PIN from Settings', async ({ page }) => {
    const section = await openSettings(page);
    await expect(section.getByTestId('parental-status')).toHaveAttribute('data-state', 'off');
    // Nothing is locked yet, so the panel's button is the only next step.
    await expect(section.getByText('Locked content', { exact: true })).toHaveCount(0);

    await section.getByTestId('parental-set-pin').click();
    const dialog = page.getByTestId('set-pin-dialog');
    await expect(dialog.getByTestId('set-pin-dialog-step')).toHaveText('Step 1 of 2');
    await dialog.getByTestId('set-pin-dialog-field-input').fill(PIN);
    await page.getByTestId('set-pin-dialog-submit').click();

    // The confirmation step, typed on the on-screen keypad this time.
    await expect(dialog.getByTestId('set-pin-dialog-step')).toHaveText('Step 2 of 2');
    const keypad = dialog.getByRole('group', { name: 'Number pad' });
    for (const digit of PIN) await keypad.getByRole('button', { name: digit, exact: true }).click();
    await expect(page.getByTestId('set-pin-dialog-submit')).toHaveText('Set PIN');
    await page.getByTestId('set-pin-dialog-submit').click();

    await expect(dialog).toBeHidden();
    await expect(toast(page, 'Parental controls are on')).toBeVisible();
    await expect(section.getByTestId('parental-status')).toHaveAttribute('data-state', 'locked');
    const st = await status(page.request);
    expect(st).toMatchObject({ enabled: true, unlocked: false, failedAttempts: 0 });
  });

  test('Hide mode drops locked and adult groups from the live list', async ({ page }) => {
    expect((await status(page.request)).mode).toBe('hide');
    const sports = await liveCategory(page.request, xtream.id, 'Sports');
    await lock(page.request, { sourceId: xtream.id, contentType: 'live', kind: 'category', targetId: sports.id, name: sports.name });

    await gotoLive(page, xtream.id);
    await expect(groupLink(page, 'News')).toBeVisible();
    await expect(groupLink(page, 'Sports')).toHaveCount(0);

    // autoAdult (on by default) hides the adult group with no lock of its own.
    await gotoLive(page, m3u.id);
    await expect(groupLink(page, 'Pasted News')).toBeVisible();
    await expect(groupLink(page, 'XXX Live')).toHaveCount(0);

    const section = await openSettings(page);
    const row = section.getByTestId('parental-lock-row').filter({ hasText: 'Sports' });
    await expect(row).toContainText('TV group');
  });

  test('Ask mode asks for the PIN before a locked channel plays', async ({ page, consoleLog }) => {
    // Switching the mode while locked asks for the PIN.
    const section = await openSettings(page);
    const ask = section.getByRole('radio', { name: 'Ask for the PIN' });
    await ask.click();
    await enterPin(page, 'parental-configure', PIN);
    await expect(page.getByTestId('parental-configure')).toBeHidden();
    await expect(ask).toHaveAttribute('aria-checked', 'true');
    await expect(section.getByTestId('parental-status')).toContainText('Locked content stays visible and asks for the PIN before it opens.');

    const bbc = await liveChannel(page.request, xtream.id, 'BBC One');
    await lock(page.request, { sourceId: xtream.id, contentType: 'live', kind: 'item', targetId: bbc.ref.itemId, name: bbc.name });

    // Locked groups stay in the list in Ask mode.
    await gotoLive(page, xtream.id);
    await expect(groupLink(page, 'Sports')).toBeVisible();

    const heading = playerRegion(page).getByRole('heading', { level: 2, name: 'BBC One', exact: true });
    const gate = page.getByTestId('parental-unlock');

    // Cancel leaves the player alone.
    await channelButton(page, 'BBC One').click();
    await expect(gate).toBeVisible();
    await expect(gate.getByRole('heading', { name: 'Enter the parental PIN' })).toBeVisible();
    await gate.getByRole('button', { name: 'Cancel' }).click();
    await expect(gate).toBeHidden();
    await expect(heading).toHaveCount(0);

    // A wrong PIN says so and keeps the dialog; the right one plays the channel.
    consoleLog.allow(/parental\.unlock/);
    await channelButton(page, 'BBC One').click();
    await enterPin(page, 'parental-unlock', WRONG_PIN);
    const error = gate.getByTestId('pin-error');
    await expect(error).toHaveAttribute('data-kind', 'wrong');
    await expect(error).toContainText('Wrong PIN.');
    await expect(heading).toHaveCount(0);

    await enterPin(page, 'parental-unlock', PIN);
    await expect(gate).toBeHidden();
    await expect(heading).toBeVisible();
    await expectPlaying(page, { advance: 1 });
    expect(await status(page.request)).toMatchObject({ unlocked: true, failedAttempts: 0 });
  });

  test('Lock now ends the unlock', async ({ page }) => {
    const section = await openSettings(page);
    const panel = section.getByTestId('parental-status');
    await expect(panel).toHaveAttribute('data-state', 'unlocked');
    await expect(panel.getByTestId('parental-unlock-left')).toBeVisible();

    await panel.getByTestId('parental-lock-now').click();
    await expect(panel).toHaveAttribute('data-state', 'locked');
    await expect(toast(page, 'Parental controls locked')).toBeVisible();
    expect((await status(page.request)).unlocked).toBe(false);
  });

  test('removing a lock asks for the PIN', async ({ page }) => {
    const section = await openSettings(page);
    await expect(section.getByTestId('parental-lock-row').filter({ hasText: 'BBC One' })).toBeVisible();

    await section.getByRole('button', { name: 'Remove the lock on BBC One' }).click();
    await expect(page.getByTestId('parental-remove')).toContainText('BBC One will open without the PIN.');
    await enterPin(page, 'parental-remove', PIN);

    await expect(page.getByTestId('parental-remove')).toBeHidden();
    await expect(toast(page, 'Lock removed from BBC One')).toBeVisible();
    await expect(section.getByTestId('parental-lock-row').filter({ hasText: 'BBC One' })).toHaveCount(0);
    expect((await locks(page.request)).some((l) => l.name === 'BBC One')).toBe(false);
  });

  test('adult groups are badged and locked automatically', async ({ page }) => {
    const section = await openSettings(page);
    const block = section.getByTestId('parental-source-locks').filter({ hasText: M3U_NAME });
    await expect(block.getByTestId('parental-auto-adult-count')).toHaveText('1 adult group is also locked automatically.');

    await block.getByTestId('parental-choose-groups').click();
    const dialog = page.getByTestId('lock-groups-dialog');
    await expect(dialog).toBeVisible();

    // The adult group is ticked by the automatic rule and cannot be unticked here.
    const adult = dialog.getByTestId('lock-group-row').filter({ hasText: 'XXX Live' });
    await expect(adult).toContainText('Adult');
    await expect(adult.getByRole('checkbox')).toBeChecked();
    await expect(adult.getByRole('checkbox')).toBeDisabled();

    // Adding a lock needs no PIN.
    await dialog.getByTestId('lock-group-row').filter({ hasText: 'Pasted News' }).getByRole('checkbox').check();
    await expect(dialog.getByTestId('lock-groups-changes')).toHaveText('1 unsaved change');
    await dialog.getByTestId('lock-groups-save').click();
    await expect(dialog).toBeHidden();
    await expect(toast(page, '1 lock change saved')).toBeVisible();
    await expect(block.getByTestId('parental-lock-row').filter({ hasText: 'Pasted News' })).toContainText('TV group');
  });

  test('turning the controls off keeps the locks', async ({ page }) => {
    const section = await openSettings(page);
    await section.getByTestId('parental-turn-off').click();
    await expect(page.getByTestId('parental-disable')).toBeVisible();
    await enterPin(page, 'parental-disable', PIN);

    await expect(page.getByTestId('parental-disable')).toBeHidden();
    await expect(toast(page, 'Parental controls are off')).toBeVisible();
    await expect(section.getByTestId('parental-status')).toHaveAttribute('data-state', 'off');
    await expect(section.getByText('These locks are kept and apply again once you set a PIN.')).toBeVisible();
    await expect(section.getByTestId('parental-lock-row').filter({ hasText: 'Sports' })).toBeVisible();

    expect((await status(page.request)).enabled).toBe(false);
    expect((await locks(page.request)).map((l) => l.name).sort()).toEqual(['Pasted News', 'Sports']);

    // With controls off, the once-hidden group is back in the list.
    await gotoLive(page, xtream.id);
    await expect(groupLink(page, 'Sports')).toBeVisible();
  });
});
