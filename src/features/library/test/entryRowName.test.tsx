/** R6-r3 F4: every control in a favorites/recent row has an accessible name (axe button-name). */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ItemRef } from '@/api/types';

import { EntryRow } from '../components/EntryRow';
import { i18n, installDomStubs } from './harness';

vi.mock('@/api/transport', () => ({
  rpc: async () => undefined,
  rpcRaw: async () => undefined,
  isDesktop: false,
  RpcError: class RpcError extends Error {},
  proxiedUrl: (s: { url: string }) => s.url,
}));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));
vi.mock('@/shell', async () => (await import('./harness')).shellModule);
vi.mock('@/features/player', async () => (await import('./harness')).playerModule);

beforeAll(installDomStubs);
afterEach(cleanup);

function renderRow(contentType: ItemRef['contentType'], onOpen = vi.fn()) {
  render(
    <I18nextProvider i18n={i18n}>
      <EntryRow
        entryRef={{ sourceId: 's1', contentType, itemId: 'i1' }}
        snapshot={{ title: 'BBC One', subtitle: 'News', contentType }}
        showSource={false}
        time="Today"
        removeLabel="Remove BBC One"
        menuRemoveLabel="Remove from favorites"
        onOpen={onOpen}
        onRemove={() => undefined}
      />
    </I18nextProvider>,
  );
  return onOpen;
}

describe('EntryRow accessible names', () => {
  for (const type of ['live', 'movie'] as const) {
    it(`${type}: no button without a name; the artwork is decorative`, () => {
      renderRow(type);
      const buttons = screen.getAllByRole('button');
      for (const b of buttons) {
        const name = b.getAttribute('aria-label') ?? b.textContent ?? '';
        expect(name.trim(), b.outerHTML).not.toBe('');
      }
      const art = screen.getByTestId('entry-artwork');
      expect(art.getAttribute('aria-hidden')).toBe('true');
      expect(art.tagName).not.toBe('BUTTON');
      expect(art.querySelector('button, [tabindex]')).toBeNull();
    });
  }

  it('the artwork still opens the item with the mouse', () => {
    const onOpen = renderRow('live');
    fireEvent.click(screen.getByTestId('entry-artwork'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
