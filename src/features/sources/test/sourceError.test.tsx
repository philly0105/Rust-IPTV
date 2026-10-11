/** R6-r3 F10: a source's core `lastError` shows as a translated message, the raw text behind a disclosure. */

import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { queryClient } from '@/api/query';
import i18n from '@/i18n';

import { SourceCard } from '../components/SourceCard';
import { classifySourceError, sourceErrorDetail } from '../lib/sourceError';
import { installDomStubs, makeSource, rpcMock } from './harness';

vi.mock('@/api/transport', async (orig) => ({
  ...(await orig<typeof import('@/api/transport')>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  isDesktop: false,
}));

beforeAll(installDomStubs);
afterEach(async () => {
  cleanup();
  await i18n.changeLanguage('en');
});

// Message shapes produced by crates/iptv-core (http.rs transport_error / send_within / status_error,
// the body idle timeout, m3u playlist_status_error, xtream and stalker auth checks).
const REFUSED =
  'Could not reach 127.0.0.1. Check the address and that the server is online, then try again. (No connection could be made because the target machine actively refused it. (os error 10061))';
const DNS = 'Could not reach tv.example.invalid. Check the address and that the server is online, then try again. (dns error: No such host is known. (os error 11001))';
const RESET = 'Could not reach 10.0.0.2:8080. Check the address and that the server is online, then try again. (connection reset by peer)';

describe('classifySourceError', () => {
  it.each([
    [REFUSED, 'refused', '127.0.0.1'],
    [DNS, 'dns', 'tv.example.invalid'],
    [RESET, 'network', '10.0.0.2:8080'],
    ['portal.example.com did not respond in time. Check the address and that the server is online, then try again.', 'timeout', 'portal.example.com'],
    ['portal.example.com accepted the connection but did not answer within 30 s. Check the address and that the server is online, then try again.', 'timeout', 'portal.example.com'],
    ['cdn.example.com stopped sending data in the middle of the download (nothing for 60 s). Check that the server is online, then try again.', 'timeout', 'cdn.example.com'],
    ['lists.example.com answered the playlist download: HTTP 403 Forbidden. Check the playlist URL and account details; some providers also require a specific User-Agent.', 'auth', 'lists.example.com'],
    ['lists.example.com answered the playlist download: HTTP 404 Not Found. Check the playlist URL; the provider may have changed it.', 'notFound', 'lists.example.com'],
    ['lists.example.com answered the playlist download: HTTP 503 Service Unavailable. The server is busy or down; try again later.', 'server', 'lists.example.com'],
    ['The server rejected the username or password. Check your credentials.', 'auth', undefined],
    ['The portal refused the handshake for this MAC address.', 'auth', undefined],
  ])('%s -> %s', (text, kind, host) => {
    expect(classifySourceError(text)).toEqual(host ? { kind, host } : { kind });
  });

  it('prefers a JSON error code and shows its message as the detail', () => {
    const json = JSON.stringify({ code: 'timeout', message: 'portal.example.com did not respond in time.' });
    expect(classifySourceError(json)).toEqual({ kind: 'timeout', host: 'portal.example.com' });
    expect(sourceErrorDetail(json)).toBe('portal.example.com did not respond in time.');
    expect(classifySourceError(JSON.stringify({ code: 'network', message: REFUSED })).kind).toBe('refused');
  });

  it('leaves unrecognised text unknown', () => {
    expect(classifySourceError('The playlist has no channels.')).toEqual({ kind: 'unknown' });
  });
});

function renderCard(lastError: string) {
  const source = makeSource('a', { lastError });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter>
          <ul>
            <SourceCard
              source={source}
              index={0}
              total={1}
              refreshing={false}
              dragging={false}
              dropTarget={null}
              onRefresh={() => undefined}
              onEdit={() => undefined}
              onRemove={() => undefined}
              onMove={() => undefined}
              onDragStart={() => undefined}
              onDragOver={() => undefined}
              onDrop={() => undefined}
              onDragEnd={() => undefined}
            />
          </ul>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

describe('SourceCard error line', () => {
  it('shows the translated refused message and keeps the OS text in the details disclosure', () => {
    renderCard(REFUSED);
    const msg = screen.getByTestId('source-error-message');
    expect(msg.dataset['kind']).toBe('refused');
    expect(msg.textContent).toBe('127.0.0.1 refused the connection. Check the address and port, and that the server is running.');
    const details = screen.getByTestId('source-error').querySelector('details')!;
    expect(details.querySelector('summary')!.textContent).toBe('Technical details');
    expect(details.textContent).toContain('os error 10061');
    expect(msg.textContent).not.toContain('os error');
  });

  it('falls back to the source host when the message names none', () => {
    renderCard('The server rejected the username or password. Check your credentials.');
    expect(screen.getByTestId('source-error-message').dataset['kind']).toBe('auth');
  });

  it('keeps unrecognised errors in view as they are', () => {
    renderCard('The playlist has no channels.');
    expect(screen.queryByTestId('source-error-message')).toBeNull();
    expect(screen.getByTestId('source-error').textContent).toContain('The playlist has no channels.');
    expect(screen.getByTestId('source-error').querySelector('details')).toBeNull();
  });
});
