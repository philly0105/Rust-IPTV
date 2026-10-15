// Settings section (C2): first PIN, mode and options behind the PIN, Lock
// now, the lock list by source with adult badges, removals behind the PIN,
// turning controls off, and its loading, error and unsupported states.
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { queryClient } from '@/api/query';
import type { Category, ContentType, ParentalLockTarget } from '@/api/types';
import type { SectionProps } from '@/features/settings/sections/types';
import { useToastStore } from '@/ui';

import { ParentalSection, useParentalEvents } from '..';
import { core, installDomStubs, makeSource, renderUi, type CoreState } from './harness';

vi.mock('@/api/transport', async (orig) => {
  const actual = await orig<typeof import('@/api/transport')>();
  const { core } = await import('./harness');
  const call = async (cmd: string, args?: unknown) => {
    try {
      return await core.call(cmd, args);
    } catch (e) {
      throw actual.RpcError.from(e);
    }
  };
  return { ...actual, rpc: call, rpcRaw: call };
});
vi.mock('@/api/events', async () => (await import('./harness')).eventsMock);

const PIN = '2580';
const props = {} as SectionProps;

const late: ParentalLockTarget = { sourceId: 'src1', contentType: 'live', kind: 'item', targetId: 'c1', name: 'Late Night' };
const xxx: ParentalLockTarget = { sourceId: 'src1', contentType: 'live', kind: 'category', targetId: 'xxx', name: 'XXX Live' };
const orphan: ParentalLockTarget = { sourceId: 'gone', contentType: 'movie', kind: 'item', targetId: 'm1', name: 'Old Film' };

const cat = (id: string, name: string, contentType: ContentType = 'live'): Category => ({
  id,
  sourceId: 'src1',
  contentType,
  name,
  hidden: false,
  itemCount: 12,
  position: 0,
});

function Section() {
  useParentalEvents();
  return <ParentalSection {...props} />;
}

const statusPanel = () => screen.getByTestId('parental-status');
const lastToast = () => useToastStore.getState().toasts.at(-1);

function enterPin(dialog: HTMLElement, pin: string, confirm: string) {
  fireEvent.change(within(dialog).getByLabelText('PIN'), { target: { value: pin } });
  fireEvent.click(within(dialog).getByRole('button', { name: confirm }));
}

/** A fresh core (with `patch`) that also answers the source and group lists. */
function given(patch: Partial<CoreState> = {}) {
  core.reset(patch);
  core.handle('sources.list', () => [makeSource('src1', 'Home IPTV', { movieCount: 0, seriesCount: 0 }), makeSource('src2', 'Backup')]);
  core.handle('catalog.categories', () => [cat('news', 'News'), cat('kids', 'Kids'), cat('xxx', 'XXX Live')]);
}

beforeAll(installDomStubs);
beforeEach(() => {
  given();
  queryClient.clear();
  useToastStore.setState({ toasts: [] });
});
afterEach(cleanup);

describe('ParentalSection', () => {
  it('shows a skeleton while the status loads', () => {
    core.override('parental.status', () => new Promise(() => undefined));
    renderUi(<Section />, queryClient);
    expect(screen.getByTestId('settings-loading')).toBeTruthy();
  });

  it('turns parental controls on with a first PIN', async () => {
    renderUi(<Section />, queryClient);
    expect(await screen.findByText('Parental controls are off')).toBeTruthy();
    expect(statusPanel().dataset.state).toBe('off');
    // Nothing to configure or list until there is a PIN.
    expect(screen.queryByText('How locks work')).toBeNull();
    expect(screen.queryByText('Locked content')).toBeNull();

    fireEvent.click(screen.getByTestId('parental-set-pin'));
    const dialog = await screen.findByRole('dialog', { name: 'Set a parental PIN' });
    fireEvent.change(within(dialog).getByLabelText('New PIN'), { target: { value: PIN } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next' }));
    fireEvent.change(await within(dialog).findByLabelText('New PIN again'), { target: { value: PIN } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set PIN' }));

    await waitFor(() => expect(statusPanel().dataset.state).toBe('locked'));
    expect(core.callsOf('parental.setPin')).toEqual([{ newPin: PIN }]);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(lastToast()?.title).toBe('Parental controls are on');
    expect(screen.getByText('How locks work')).toBeTruthy();
    expect(screen.getByTestId('parental-change-pin')).toBeTruthy();
  });

  it('asks for the PIN before changing a setting while locked', async () => {
    given({ pin: PIN });
    renderUi(<Section />, queryClient);
    const ask = await screen.findByRole('radio', { name: 'Ask for the PIN' });
    expect(screen.getByText('Changes here ask for the PIN.')).toBeTruthy();

    fireEvent.click(ask);
    const dialog = await screen.findByRole('dialog', { name: 'Enter the PIN to save' });
    expect(core.callsOf('parental.configure')).toEqual([]);

    enterPin(dialog, '1111', 'Save change');
    expect(await within(dialog).findByTestId('pin-error')).toBeTruthy();
    expect(core.state.mode).toBe('hide');

    enterPin(dialog, PIN, 'Save change');
    await waitFor(() => expect(core.state.mode).toBe('ask'));
    expect(core.callsOf('parental.configure').at(-1)).toEqual({ mode: 'ask', pin: PIN });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Ask for the PIN' }).getAttribute('aria-checked')).toBe('true'));
  });

  it('cancelling the PIN keeps the setting as it was', async () => {
    given({ pin: PIN });
    renderUi(<Section />, queryClient);
    fireEvent.click(await screen.findByTestId('parental-auto-adult'));
    const dialog = await screen.findByRole('dialog', { name: 'Enter the PIN to save' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(core.state.autoAdult).toBe(true);
    expect(core.callsOf('parental.configure')).toEqual([]);
  });

  it('saves settings without the PIN while unlocked, and Lock now locks again', async () => {
    given({ pin: PIN, unlockedUntil: Date.now() + 10 * 60_000 });
    renderUi(<Section />, queryClient);
    await waitFor(() => expect(statusPanel().dataset.state).toBe('unlocked'));
    expect(screen.getByTestId('parental-unlock-left').textContent).toMatch(/^(10:00|9:5\d)$/);
    expect(screen.queryByText('Changes here ask for the PIN.')).toBeNull();

    fireEvent.change(screen.getByTestId('parental-unlock-minutes'), { target: { value: '60' } });
    await waitFor(() => expect(core.state.unlockMinutes).toBe(60));
    expect(core.callsOf('parental.configure')).toEqual([{ unlockMinutes: 60 }]);
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByTestId('parental-lock-now'));
    await waitFor(() => expect(statusPanel().dataset.state).toBe('locked'));
    expect(core.callsOf('parental.lockNow')).toHaveLength(1);
    expect(lastToast()?.title).toBe('Parental controls locked');
  });

  it('unlocks from the status panel', async () => {
    given({ pin: PIN });
    renderUi(<Section />, queryClient);
    fireEvent.click(await screen.findByTestId('parental-unlock-button'));
    const dialog = await screen.findByRole('dialog', { name: 'Enter the parental PIN' });
    expect(within(dialog).getByText('Locked content stays open for 15 minutes, or until you lock it again.')).toBeTruthy();
    enterPin(dialog, PIN, 'Unlock');
    await waitFor(() => expect(statusPanel().dataset.state).toBe('unlocked'));
    expect(screen.getByTestId('parental-lock-now')).toBeTruthy();
  });

  it('lists locks by source, with adult badges and locks of removed sources', async () => {
    given({ pin: PIN, adult: { 'src1|live': ['xxx', 'yyy'] } });
    core.lock(late);
    core.lock(xxx);
    core.lock(orphan);
    renderUi(<Section />, queryClient);

    await waitFor(() => expect(screen.getAllByTestId('parental-source-locks')).toHaveLength(3));
    const [home, backup, removed] = screen.getAllByTestId('parental-source-locks') as [HTMLElement, HTMLElement, HTMLElement];

    expect(within(home).getByRole('heading', { name: 'Home IPTV' })).toBeTruthy();
    expect(within(home).getByText('2 locks')).toBeTruthy();
    const rows = within(home).getAllByTestId('parental-lock-row');
    // Groups first, then single items.
    expect(rows.map((r) => within(r).getByText(/XXX Live|Late Night/).textContent)).toEqual(['XXX Live', 'Late Night']);
    expect(within(rows[0]!).getByText('TV group')).toBeTruthy();
    expect(await within(rows[0]!).findByText('Adult')).toBeTruthy();
    expect(within(rows[1]!).getByText('Channel')).toBeTruthy();
    expect(within(rows[1]!).queryByText('Adult')).toBeNull();
    // "yyy" is locked by the automatic rule alone.
    expect(await within(home).findByText('1 adult group is also locked automatically.')).toBeTruthy();

    expect(within(backup).getByText('Nothing in this source is locked.')).toBeTruthy();
    expect(within(removed).getByRole('heading', { name: 'Removed source' })).toBeTruthy();
    expect(within(removed).getByText('Old Film')).toBeTruthy();
    expect(within(removed).queryByTestId('parental-choose-groups')).toBeNull();
  });

  it('asks for the PIN to remove a lock while locked', async () => {
    given({ pin: PIN });
    core.lock(late);
    renderUi(<Section />, queryClient);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove the lock on Late Night' }));
    const dialog = await screen.findByRole('dialog', { name: 'Enter the PIN to remove the lock' });
    expect(core.callsOf('parental.setLocked')).toEqual([]);

    enterPin(dialog, PIN, 'Remove lock');
    await waitFor(() => expect(core.state.locks).toEqual([]));
    expect(core.callsOf('parental.setLocked')).toEqual([{ target: late, locked: false, pin: PIN }]);
    await waitFor(() => expect(screen.queryByText('Late Night')).toBeNull());
    expect(lastToast()?.title).toBe('Lock removed from Late Night');
  });

  it('removes a lock at once while unlocked', async () => {
    given({ pin: PIN, unlockedUntil: Date.now() + 60_000 });
    core.lock(late);
    renderUi(<Section />, queryClient);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove the lock on Late Night' }));
    await waitFor(() => expect(core.state.locks).toEqual([]));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(core.callsOf('parental.setLocked')).toEqual([{ target: late, locked: false }]);
  });

  it('locks groups from "Choose groups" and asks for the PIN only to unlock some', async () => {
    given({ pin: PIN, adult: { 'src1|live': ['xxx'] } });
    core.lock({ ...xxx, targetId: 'news', name: 'News' });
    renderUi(<Section />, queryClient);
    await waitFor(() => expect(screen.getAllByTestId('parental-choose-groups')).toHaveLength(2));
    fireEvent.click(screen.getAllByTestId('parental-choose-groups')[0]!);

    const dialog = await screen.findByRole('dialog', { name: 'Lock groups in Home IPTV' });
    const row = (name: string) => within(dialog).getAllByTestId('lock-group-row').find((r) => r.textContent?.includes(name))!;
    const box = (name: string) => within(row(name)).getByRole('checkbox') as HTMLInputElement;
    await waitFor(() => expect(within(dialog).getAllByTestId('lock-group-row')).toHaveLength(3));
    expect(box('News').checked).toBe(true);
    // The adult rule locks XXX Live: checked, fixed, badged.
    expect(box('XXX Live').checked).toBe(true);
    expect(box('XXX Live').disabled).toBe(true);
    expect(within(row('XXX Live')).getByText('Adult')).toBeTruthy();

    fireEvent.click(box('Kids'));
    fireEvent.click(box('News'));
    expect(within(dialog).getByTestId('lock-groups-changes').textContent).toBe('2 unsaved changes');
    fireEvent.click(within(dialog).getByTestId('lock-groups-save'));

    const pin = await screen.findByRole('dialog', { name: 'Enter the PIN to remove locks' });
    expect(within(pin).getByText('1 group will open without the PIN.')).toBeTruthy();
    expect(core.callsOf('parental.setLocked')).toEqual([]);
    enterPin(pin, PIN, 'Save locks');

    await waitFor(() => expect(core.state.locks.map((l) => l.targetId)).toEqual(['kids']));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(lastToast()?.title).toBe('2 lock changes saved');
  });

  it('asks before dropping ticked groups, and closes at once with nothing changed', async () => {
    given({ pin: PIN });
    renderUi(<Section />, queryClient);
    await waitFor(() => expect(screen.getAllByTestId('parental-choose-groups')).toHaveLength(2));
    fireEvent.click(screen.getAllByTestId('parental-choose-groups')[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Lock groups in Home IPTV' });
    await waitFor(() => expect(within(dialog).getAllByTestId('lock-group-row')).toHaveLength(3));
    const kids = within(dialog).getAllByTestId('lock-group-row').find((r) => r.textContent?.includes('Kids'))!;
    fireEvent.click(within(kids).getByRole('checkbox'));

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    const ask = await screen.findByRole('dialog', { name: 'Discard your changes?' });
    fireEvent.click(within(ask).getByTestId('lock-groups-keep'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Discard your changes?' })).toBeNull());
    expect(screen.getByRole('dialog', { name: 'Lock groups in Home IPTV' })).toBeTruthy();
    expect(within(dialog).getByTestId('lock-groups-changes').textContent).toBe('1 unsaved change');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Discard your changes?' })).getByTestId('lock-groups-discard-confirm'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(core.callsOf('parental.setLocked')).toEqual([]);

    // Nothing ticked: Cancel closes without asking.
    fireEvent.click(screen.getAllByTestId('parental-choose-groups')[0]!);
    const again = await screen.findByRole('dialog', { name: 'Lock groups in Home IPTV' });
    fireEvent.click(within(again).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('turns parental controls off with the PIN and keeps the locks', async () => {
    given({ pin: PIN });
    core.lock(late);
    renderUi(<Section />, queryClient);
    fireEvent.click(await screen.findByTestId('parental-turn-off'));
    const dialog = await screen.findByRole('dialog', { name: 'Turn off parental controls?' });
    enterPin(dialog, '9999', 'Turn off');
    expect(await within(dialog).findByTestId('pin-error')).toBeTruthy();
    expect(core.state.pin).toBe(PIN);

    enterPin(dialog, PIN, 'Turn off');
    await waitFor(() => expect(statusPanel().dataset.state).toBe('off'));
    expect(lastToast()?.title).toBe('Parental controls are off');
    // The kept lock stays listed, with a note that it applies again with a PIN.
    expect(await screen.findByText('These locks are kept and apply again once you set a PIN.')).toBeTruthy();
    expect(screen.getByText('Late Night')).toBeTruthy();
  });

  it('changes the PIN', async () => {
    given({ pin: PIN });
    renderUi(<Section />, queryClient);
    fireEvent.click(await screen.findByTestId('parental-change-pin'));
    const dialog = await screen.findByRole('dialog', { name: 'Change the PIN' });
    fireEvent.change(within(dialog).getByLabelText('Current PIN'), { target: { value: PIN } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next' }));
    fireEvent.change(await within(dialog).findByLabelText('New PIN'), { target: { value: '7391' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next' }));
    fireEvent.change(await within(dialog).findByLabelText('New PIN again'), { target: { value: '7391' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Change PIN' }));
    await waitFor(() => expect(core.state.pin).toBe('7391'));
    expect(lastToast()?.title).toBe('PIN changed');
  });

  it('shows the lockout in the status panel', async () => {
    given({ pin: PIN, failedAttempts: 5, lockoutUntil: Date.now() + 75_000 });
    renderUi(<Section />, queryClient);
    expect((await screen.findByTestId('parental-status-lockout')).textContent).toMatch(/Too many wrong PINs\. The PIN can be tried again in 1:1\d\./);
  });

  it('says when this build has no parental controls', async () => {
    core.override('parental.status', () => {
      throw { code: 'unsupported', message: 'not built in' };
    });
    renderUi(<Section />, queryClient);
    expect(await screen.findByText('Parental controls are not available')).toBeTruthy();
  });

  it('shows an error with a retry when the status cannot load', async () => {
    let fail = true;
    core.override('parental.status', () => {
      if (fail) throw { code: 'db', message: 'database is locked' };
      return core.status();
    });
    renderUi(<Section />, queryClient);
    const error = await screen.findByTestId('settings-error', {}, { timeout: 5000 });
    fail = false;
    fireEvent.click(within(error).getByRole('button'));
    await waitFor(() => expect(statusPanel().dataset.state).toBe('off'));
  });

  it('shows the empty state when there are no sources', async () => {
    given({ pin: PIN });
    core.handle('sources.list', () => []);
    renderUi(<Section />, queryClient);
    expect(await screen.findByText('No sources yet')).toBeTruthy();
  });
});
