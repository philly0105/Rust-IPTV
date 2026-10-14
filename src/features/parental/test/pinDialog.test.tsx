// PIN entry (C2): digits from typing, paste and the keypad; show/hide; the
// wrong-PIN and lockout states; first PIN and PIN change steps.
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { queryClient } from '@/api/query';
import { rpc } from '@/api/transport';

import { PinDialog, SetPinDialog } from '..';
import { core, installDomStubs, renderUi } from './harness';

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

beforeAll(installDomStubs);
beforeEach(() => {
  core.reset({ pin: PIN, mode: 'ask' });
  queryClient.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderUnlock(onDone = vi.fn(), onCancel = vi.fn()) {
  renderUi(
    <PinDialog
      open
      title="Enter the parental PIN"
      confirmLabel="Unlock"
      onSubmit={async (pin) => {
        await rpc('parental.unlock', { pin });
        onDone(pin);
      }}
      onCancel={onCancel}
    />,
    queryClient,
  );
  const dialog = screen.getByRole('dialog', { name: 'Enter the parental PIN' });
  const input = within(dialog).getByLabelText('PIN') as HTMLInputElement;
  const submit = within(dialog).getByRole('button', { name: 'Unlock' }) as HTMLButtonElement;
  return { dialog, input, submit, onDone, onCancel };
}

describe('PinDialog', () => {
  it('focuses the PIN field and keeps only digits from typing', () => {
    const { input } = renderUnlock();
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: '1a2 b3-4' } });
    expect(input.value).toBe('1234');
    fireEvent.change(input, { target: { value: '123456789' } });
    expect(input.value).toBe('12345678');
  });

  it('takes a pasted PIN, in any script of digits', () => {
    const { input } = renderUnlock();
    fireEvent.change(input, { target: { value: '9' } });
    // A whole PIN replaces what is there.
    fireEvent.paste(input, { clipboardData: { getData: () => ' 25 80\n' } });
    expect(input.value).toBe('2580');
    // Arabic-Indic and full-width digits count.
    fireEvent.paste(input, { clipboardData: { getData: () => '٢٥٨٠' } });
    expect(input.value).toBe('2580');
    fireEvent.paste(input, { clipboardData: { getData: () => '１２３４５' } });
    expect(input.value).toBe('12345');
    // A few digits continue what is there.
    fireEvent.paste(input, { clipboardData: { getData: () => '67' } });
    expect(input.value).toBe('1234567');
    // Text with no digits changes nothing.
    fireEvent.paste(input, { clipboardData: { getData: () => 'hello' } });
    expect(input.value).toBe('1234567');
  });

  it('enters digits from the keypad without taking focus from the field', () => {
    const { dialog, input } = renderUnlock();
    const keypad = within(dialog).getByRole('group', { name: 'Number pad' });
    for (const d of ['2', '5', '8', '0']) fireEvent.click(within(keypad).getByRole('button', { name: d }));
    expect(input.value).toBe('2580');
    fireEvent.click(within(keypad).getByRole('button', { name: 'Delete last digit' }));
    expect(input.value).toBe('258');
    fireEvent.click(within(keypad).getByRole('button', { name: 'Clear PIN' }));
    expect(input.value).toBe('');
    expect(within(keypad).getByRole('button', { name: 'Clear PIN' })).toHaveProperty('disabled', true);
    // Keypad keys stay out of the Tab order; the field takes the same digits.
    for (const key of within(keypad).getAllByRole('button')) expect(key.tabIndex).toBe(-1);
  });

  it('shows and hides the PIN', () => {
    const { dialog, input } = renderUnlock();
    expect(input.type).toBe('password');
    const show = within(dialog).getByRole('button', { name: 'Show PIN' });
    expect(show.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(show);
    expect(input.type).toBe('text');
    const hide = within(dialog).getByRole('button', { name: 'Hide PIN' });
    expect(hide.getAttribute('aria-pressed')).toBe('true');
    fireEvent.change(input, { target: { value: '25' } });
    const slots = () => [...dialog.querySelectorAll('[data-filled]')].map((s) => s.textContent).join('');
    expect(slots()).toBe('25');
    fireEvent.click(hide);
    expect(slots()).toBe('');
    expect(input.type).toBe('password');
  });

  it('explains a PIN that is too short without asking the core', async () => {
    const { dialog, input, submit } = renderUnlock();
    fireEvent.change(input, { target: { value: '12' } });
    fireEvent.click(submit);
    expect(await within(dialog).findByText('Enter 4 to 8 digits.')).toBeTruthy();
    expect(core.callsOf('parental.unlock')).toEqual([]);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    // Typing again clears the message.
    fireEvent.change(input, { target: { value: '123' } });
    expect(within(dialog).queryByText('Enter 4 to 8 digits.')).toBeNull();
  });

  it('says how many tries are left after a wrong PIN', async () => {
    const { dialog, input, submit, onDone } = renderUnlock();
    fireEvent.change(input, { target: { value: '1111' } });
    fireEvent.click(submit);
    const error = await within(dialog).findByText('Wrong PIN. 4 tries left before a short wait.');
    expect(error.getAttribute('role')).toBe('alert');
    expect(input.value).toBe('');
    expect(input.getAttribute('aria-describedby')).toBe(error.parentElement?.id);
    expect(onDone).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: PIN } });
    fireEvent.click(submit);
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(PIN));
  });

  it('counts down the wrong-PIN lockout with the field locked, then lets the PIN be tried again', async () => {
    core.reset({ pin: PIN, mode: 'ask', failedAttempts: 4 });
    const { dialog, input, submit, onDone } = renderUnlock();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });

    fireEvent.change(input, { target: { value: '1111' } });
    await act(async () => {
      fireEvent.click(submit);
    });
    const lockout = within(dialog).getByTestId('pin-lockout');
    expect(within(lockout).getByText('Too many wrong PINs.')).toBeTruthy();
    expect(within(lockout).getByText('Try again in 0:30')).toBeTruthy();
    expect(input.readOnly).toBe(true);
    expect(submit.disabled).toBe(true);
    // Typing and the keypad do nothing while it runs.
    fireEvent.change(input, { target: { value: '25' } });
    expect(input.value).toBe('');

    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(within(lockout).getByText('Try again in 0:20')).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(20_500);
    });
    expect(within(dialog).queryByTestId('pin-lockout')).toBeNull();
    expect(input.readOnly).toBe(false);
    expect(submit.disabled).toBe(false);
    expect(document.activeElement).toBe(input);

    // Still on the core's (fake) clock, where the lockout is over too.
    fireEvent.change(input, { target: { value: PIN } });
    await act(async () => {
      fireEvent.click(submit);
    });
    expect(onDone).toHaveBeenCalledWith(PIN);
  });

  it('shows a lockout the core already reports when it opens', () => {
    core.reset({ pin: PIN, mode: 'ask', failedAttempts: 5, lockoutUntil: Date.now() + 75_000 });
    queryClient.setQueryData(['parental.status', null], core.status());
    const { dialog, input } = renderUnlock();
    expect(within(dialog).getByText('Try again in 1:15')).toBeTruthy();
    expect(input.readOnly).toBe(true);
  });

  it('cancels from Escape and from Cancel', () => {
    const { dialog, onCancel } = renderUnlock();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it('moves focus that lands on the dialog panel back into the field', () => {
    const { dialog, input } = renderUnlock();
    act(() => dialog.focus());
    expect(document.activeElement).toBe(input);
  });
});

describe('SetPinDialog', () => {
  function step(dialog: HTMLElement, label: string, pin: string, button: string) {
    fireEvent.change(within(dialog).getByLabelText(label), { target: { value: pin } });
    fireEvent.click(within(dialog).getByRole('button', { name: button }));
  }

  it('sets the first PIN in two steps and warns about an easy one', async () => {
    core.reset();
    const onDone = vi.fn();
    renderUi(<SetPinDialog open mode="first" onDone={onDone} onCancel={vi.fn()} />, queryClient);
    const dialog = screen.getByRole('dialog', { name: 'Set a parental PIN' });
    expect(within(dialog).getByText('Step 1 of 2')).toBeTruthy();

    fireEvent.change(within(dialog).getByLabelText('New PIN'), { target: { value: '1234' } });
    expect(within(dialog).getByText(/Easy to guess/)).toBeTruthy();
    step(dialog, 'New PIN', PIN, 'Next');
    expect(await within(dialog).findByText('Step 2 of 2')).toBeTruthy();
    step(dialog, 'New PIN again', PIN, 'Set PIN');

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(core.callsOf('parental.setPin')).toEqual([{ newPin: PIN }]);
    expect(onDone.mock.calls[0]![0]).toMatchObject({ enabled: true });
    expect(queryClient.getQueryData(['parental.status', null])).toMatchObject({ enabled: true });
  });

  it('starts over when the two PINs differ', async () => {
    core.reset();
    renderUi(<SetPinDialog open mode="first" onDone={vi.fn()} onCancel={vi.fn()} />, queryClient);
    const dialog = screen.getByRole('dialog', { name: 'Set a parental PIN' });
    step(dialog, 'New PIN', PIN, 'Next');
    await within(dialog).findByText('Step 2 of 2');
    step(dialog, 'New PIN again', '2581', 'Set PIN');
    expect(await within(dialog).findByText('The PINs did not match. Choose the new PIN again.')).toBeTruthy();
    expect(within(dialog).getByText('Step 1 of 2')).toBeTruthy();
    expect(core.callsOf('parental.setPin')).toEqual([]);
  });

  it('goes back a step and keeps what was entered', async () => {
    renderUi(<SetPinDialog open mode="change" onDone={vi.fn()} onCancel={vi.fn()} />, queryClient);
    const dialog = screen.getByRole('dialog', { name: 'Change the PIN' });
    step(dialog, 'Current PIN', PIN, 'Next');
    await within(dialog).findByText('Step 2 of 3');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Back' }));
    expect(((await within(dialog).findByLabelText('Current PIN')) as HTMLInputElement).value).toBe(PIN);
  });

  it('asks for the current PIN again after a wrong one, keeping the new PIN', async () => {
    const onDone = vi.fn();
    renderUi(<SetPinDialog open mode="change" onDone={onDone} onCancel={vi.fn()} />, queryClient);
    const dialog = screen.getByRole('dialog', { name: 'Change the PIN' });
    step(dialog, 'Current PIN', '0000', 'Next');
    await within(dialog).findByText('Step 2 of 3');
    step(dialog, 'New PIN', '9137', 'Next');
    await within(dialog).findByText('Step 3 of 3');
    step(dialog, 'New PIN again', '9137', 'Change PIN');

    expect(await within(dialog).findByText('Wrong PIN. 4 tries left before a short wait.')).toBeTruthy();
    expect(within(dialog).getByText('Step 1 of 3')).toBeTruthy();
    expect(within(dialog).getByText('Your new PIN is kept. Enter the current PIN to finish.')).toBeTruthy();
    // No way back to the other steps: the new PIN is already confirmed.
    expect(within(dialog).queryByRole('button', { name: 'Back' })).toBeNull();

    step(dialog, 'Current PIN', PIN, 'Change PIN');
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(core.callsOf('parental.setPin')).toEqual([
      { currentPin: '0000', newPin: '9137' },
      { currentPin: PIN, newPin: '9137' },
    ]);
    expect(core.state.pin).toBe('9137');
  });
});
