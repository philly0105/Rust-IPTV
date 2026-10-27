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

function renderDialog(channel = makeChannel(1)) {
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <EpgMappingDialog channel={channel} onClose={() => undefined} />
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

  it('names the channel in its title with the country tag after the name, as the row reads', () => {
    rpcMock.handlers['epg.channelsSearch'] = () => [];
    rpcMock.handlers['epg.resolve'] = () => ({ via: 'name', epgChannelId: 'espn2.us' });
    renderDialog({ ...makeChannel(1), name: 'US| ESPN2 FHD' });
    expect(screen.getByRole('dialog', { name: 'Guide data for ESPN2 FHD (US)' })).toBeTruthy();
  });

  it('selects the suggested search, so typing replaces it', async () => {
    rpcMock.handlers['epg.channelsSearch'] = () => [];
    rpcMock.handlers['epg.resolve'] = () => ({ via: 'none' });
    renderDialog();
    const search = screen.getByRole<HTMLInputElement>('searchbox', { name: 'Search guide channels' });
    expect(search.value).toBe('Channel 1');
    expect(document.activeElement).toBe(search);
    expect([search.selectionStart, search.selectionEnd]).toEqual([0, search.value.length]);
    // What a keystroke does in a browser: the typed text takes the selection's place.
    const v = search.value;
    fireEvent.change(search, { target: { value: v.slice(0, search.selectionStart!) + 'fox' + v.slice(search.selectionEnd!) } });
    expect(search.value).toBe('fox');
    await waitFor(() => expect(rpcMock.calls).toContainEqual({ cmd: 'epg.channelsSearch', args: { query: 'fox', limit: 50 } }));
  });

  it('keeps one check on Match automatically when the automatic match is among the results', async () => {
    rpcMock.handlers['epg.channelsSearch'] = () => [{ channelId: 'one.uk', displayName: 'One UK', epgUrl: 'https://guide.example/epg.xml' }];
    rpcMock.handlers['epg.resolve'] = () => ({ via: 'name', epgChannelId: 'one.uk' });
    renderDialog();
    const auto = screen.getByRole('button', { name: /^Match automatically/ });
    await waitFor(() => expect(within(auto).queryByLabelText('Selected')).not.toBeNull());
    const row = await screen.findByRole('button', { name: /^One UK/ });
    expect(within(row).queryByLabelText('Selected')).toBeNull();
    expect(screen.getAllByLabelText('Selected')).toHaveLength(1);
  });

  it('checks the result row of a channel matched by hand, and nothing else', async () => {
    rpcMock.handlers['epg.channelsSearch'] = () => [{ channelId: 'one.uk', displayName: 'One UK', epgUrl: 'https://guide.example/epg.xml' }];
    rpcMock.handlers['epg.resolve'] = () => ({ via: 'manual', epgChannelId: 'one.uk' });
    renderDialog();
    const row = await screen.findByRole('button', { name: /^One UK/ });
    await waitFor(() => expect(within(row).queryByLabelText('Selected')).not.toBeNull());
    expect(screen.getAllByLabelText('Selected')).toHaveLength(1);
  });

  it('gives the results one fixed height, found or not, so the sheet keeps the search in place', async () => {
    rpcMock.handlers['epg.channelsSearch'] = () => [];
    rpcMock.handlers['epg.resolve'] = () => ({ via: 'none' });
    renderDialog();
    const box = screen.getByTestId('epg-mapping-results');
    expect(box.className).toContain('h-[min(320px,45vh)]');
    expect(box.className).not.toContain('max-h-');
    await waitFor(() => expect(within(box).getByText(/No guide channels match/)).toBeTruthy());
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
