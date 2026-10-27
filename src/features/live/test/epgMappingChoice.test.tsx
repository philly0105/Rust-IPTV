/** Match guide channel: opens in the search, with Match automatically and No guide as choice rows. */
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { queryClient } from '@/api/query';

import { EpgMappingDialog } from '../components/EpgMappingDialog';
import { i18n, makeChannel } from './harness';

const rpcMock = vi.hoisted(() => {
  const handlers: Record<string, (args: unknown) => unknown> = {};
  const calls: { cmd: string; args: unknown }[] = [];
  const call = async (cmd: string, args?: unknown) => {
    calls.push({ cmd, args });
    const h = handlers[cmd];
    if (!h) throw new Error(`unmocked rpc ${cmd}`);
    return h(args);
  };
  return { handlers, calls, call };
});

vi.mock('@/api/transport', () => ({
  rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  isDesktop: false,
  RpcError: class RpcError extends Error {
    static from(e: unknown) {
      return e instanceof Error ? e : new Error(String(e));
    }
  },
  proxiedUrl: (s: { url: string }) => s.url,
}));
vi.mock('@/api/events', () => ({
  onAppEvent: () => () => undefined,
  onAnyAppEvent: () => () => undefined,
}));

afterEach(() => {
  cleanup();
  queryClient.clear();
  rpcMock.calls.length = 0;
});

function renderDialog() {
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <EpgMappingDialog channel={makeChannel(1)} onClose={() => undefined} />
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

describe('epg mapping dialog: the choice first', () => {
  it('opens in the search, says the current match under the title, and keeps the time shift last', async () => {
    rpcMock.handlers['epg.channelsSearch'] = () => [];
    rpcMock.handlers['epg.resolve'] = () => ({ via: 'item', epgChannelId: 'one.uk' });
    renderDialog();
    const dialog = screen.getByRole('dialog');
    const search = within(dialog).getByRole('searchbox', { name: 'Search guide channels' });
    // Typing a channel name goes into the search, not the time shift field.
    expect(document.activeElement).toBe(search);
    await waitFor(() => expect(document.getElementById(dialog.getAttribute('aria-describedby')!)?.textContent).toBe('Currently one.uk (from the playlist)'));
    const shift = within(dialog).getByTestId('epg-mapping-shift');
    expect(search.compareDocumentPosition(shift) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Every choice applies at once: no footer with a Cancel beside the close button.
    expect(within(dialog).queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(dialog.querySelector('[data-dialog-close]')).not.toBeNull();
  });

  it('checks the choice in force, and a tap on another applies it', async () => {
    rpcMock.handlers['epg.channelsSearch'] = () => [];
    rpcMock.handlers['epg.resolve'] = () => ({ via: 'name', epgChannelId: 'one.uk' });
    rpcMock.handlers['epg.setMapping'] = () => null;
    renderDialog();
    const auto = screen.getByRole('button', { name: /^Match automatically/ });
    await waitFor(() => expect(within(auto).queryByLabelText('Selected')).not.toBeNull());
    const none = screen.getByRole('button', { name: /^No guide/ });
    expect(within(none).queryByLabelText('Selected')).toBeNull();
    fireEvent.click(none);
    await waitFor(() => expect(rpcMock.calls).toContainEqual({ cmd: 'epg.setMapping', args: { ref: makeChannel(1).ref, epgChannelId: null } }));
  });

  it('checks No guide when the guide was turned off by hand, and Match automatically puts it back', async () => {
    rpcMock.handlers['epg.channelsSearch'] = () => [];
    rpcMock.handlers['epg.resolve'] = () => ({ via: 'manual', epgChannelId: null });
    rpcMock.handlers['epg.clearMapping'] = () => null;
    renderDialog();
    const none = screen.getByRole('button', { name: /^No guide/ });
    await waitFor(() => expect(within(none).queryByLabelText('Selected')).not.toBeNull());
    const auto = screen.getByRole('button', { name: /^Match automatically/ });
    expect(within(auto).queryByLabelText('Selected')).toBeNull();
    fireEvent.click(auto);
    await waitFor(() => expect(rpcMock.calls).toContainEqual({ cmd: 'epg.clearMapping', args: { ref: makeChannel(1).ref } }));
  });
});
