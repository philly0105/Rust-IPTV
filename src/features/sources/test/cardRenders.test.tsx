/** VD-5: a source card follows its own import and guide progress; an event re-renders that card only. */

import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { Profiler } from 'react';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { queryClient } from '@/api/query';
import type { Source } from '@/api/types';
import i18n from '@/i18n';

import { SourceCard } from '../components/SourceCard';
import { handleGuideEvent, useGuideProgressStore } from '../lib/epgRefresh';
import { handleImportEvent, resetProgressForTests } from '../lib/progress';
import { installDomStubs, makeSource, rpcMock } from './harness';

vi.mock('@/api/transport', async (orig) => ({
  ...(await orig<typeof import('@/api/transport')>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  isDesktop: false,
}));

beforeAll(installDomStubs);
afterEach(() => {
  cleanup();
  resetProgressForTests();
  useGuideProgressStore.setState({ byUrl: {} });
});

const noop = () => undefined;

function renderCards(sources: Source[], renders: Map<string, number>) {
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter>
          <ul>
            {sources.map((s, i) => (
              <Profiler key={s.id} id={s.id} onRender={(id) => renders.set(id, (renders.get(id) ?? 0) + 1)}>
                <SourceCard
                  source={s}
                  index={i}
                  total={sources.length}
                  refreshing={false}
                  dragging={false}
                  dropTarget={null}
                  onRefresh={noop}
                  onEdit={noop}
                  onRemove={noop}
                  onMove={noop}
                  onDragStart={noop}
                  onDragOver={noop}
                  onDrop={noop}
                  onDragEnd={noop}
                />
              </Profiler>
            ))}
          </ul>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

describe('SourceCard progress subscriptions (VD-5)', () => {
  it('an import event re-renders only the card of its source', () => {
    const renders = new Map<string, number>();
    renderCards([makeSource('a'), makeSource('b')], renders);
    const before = new Map(renders);
    act(() => handleImportEvent({ sourceId: 'a', phase: 'parsing', done: 2000, total: 10000 }));
    expect(renders.get('a')).toBeGreaterThan(before.get('a')!);
    expect(renders.get('b')).toBe(before.get('b'));
    const [cardA, cardB] = screen.getAllByTestId('source-card');
    expect(within(cardA!).getByRole('progressbar')).toBeTruthy();
    expect(within(cardB!).queryByRole('progressbar')).toBeNull();
  });

  it('a guide event re-renders only the card whose guide it is', () => {
    const renders = new Map<string, number>();
    const epg = (url: string) => ({ detectedUrls: [url], manualUrls: [], disabledUrls: [] });
    renderCards([makeSource('a', { epg: epg('http://a/epg.xml') }), makeSource('b', { epg: epg('http://b/epg.xml') })], renders);
    const before = new Map(renders);
    act(() => handleGuideEvent({ url: 'http://a/epg.xml', phase: 'parsing', programs: 500 }));
    expect(renders.get('a')).toBeGreaterThan(before.get('a')!);
    expect(renders.get('b')).toBe(before.get('b'));
  });
});
