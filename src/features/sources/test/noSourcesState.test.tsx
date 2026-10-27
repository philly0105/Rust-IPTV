/**
 * The one "no source yet" state every page shows: Add a source opens the add dialog where the
 * user is, cancelling leaves them there, and Import a backup sits beside it.
 */

import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import type { Source } from '@/api/types';

import { makeSource, renderAt, rpcMock } from './harness';

vi.mock('@/api/transport', async (orig) => ({
  ...(await orig<typeof import('@/api/transport')>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  isDesktop: false,
}));
// The dialog's forms and import are tested on their own; a stand-in that can cancel or add.
const added = vi.hoisted(() => ({ source: null as Source | null }));
vi.mock('../components/AddSourceDialog', () => ({
  AddSourceDialog: ({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded?: (s: Source, first: boolean) => void }) =>
    open ? (
      <div role="dialog" aria-label="Add a source" data-testid="add-source-dialog">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          onClick={() => {
            onAdded?.(added.source!, true);
            onClose();
          }}
        >
          Add source
        </button>
      </div>
    ) : null,
}));

const { NoSourcesState, useNoSourcesAdding } = await import('../components/NoSourcesState');

/** What a host page reads to keep its no-source state up while the dialog is open. */
function AddingProbe() {
  return <output data-testid="adding">{String(useNoSourcesAdding())}</output>;
}

beforeEach(() => {
  rpcMock.reset();
  added.source = makeSource('s1', { channelCount: 12 });
});
afterEach(cleanup);

const page = (stay?: boolean) => [
  { path: '/favorites', element: <NoSourcesState icon={<span />} title="No favorites yet" description="Add a source first." testId="fav-add" stay={stay} /> },
  { path: '/s/:id/live', element: <p>channels</p> },
];

describe('NoSourcesState', () => {
  it("shows the page's title and line, then Add a source and Import a backup", async () => {
    renderAt(page(), '/favorites');
    expect(screen.getByRole('heading', { name: 'No favorites yet' })).toBeTruthy();
    expect(screen.getByText('Add a source first.')).toBeTruthy();
    const add = screen.getByTestId('fav-add');
    expect(add.tagName).toBe('BUTTON');
    expect(add.textContent).toBe('Add a source');
    const backup = screen.getByRole('link', { name: 'Import a backup' });
    expect(backup.getAttribute('href')).toBe('/settings/backup');
  });

  it('opens the add dialog in place, and cancelling leaves the user on the page', async () => {
    const { router } = renderAt(page(), '/favorites');
    fireEvent.click(screen.getByTestId('fav-add'));
    await screen.findByTestId('add-source-dialog');
    expect(router.state.location.pathname).toBe('/favorites');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByTestId('add-source-dialog')).toBeNull());
    expect(router.state.location.pathname).toBe('/favorites');
  });

  it('opens the first source on its channels, or stays on a page that fills in with it', async () => {
    const { router } = renderAt(page(), '/favorites');
    fireEvent.click(screen.getByTestId('fav-add'));
    fireEvent.click(await screen.findByRole('button', { name: 'Add source' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/s/s1/live'));
    cleanup();

    const stay = renderAt(page(true), '/favorites');
    fireEvent.click(screen.getByTestId('fav-add'));
    fireEvent.click(await screen.findByRole('button', { name: 'Add source' }));
    await waitFor(() => expect(screen.queryByTestId('add-source-dialog')).toBeNull());
    expect(stay.router.state.location.pathname).toBe('/favorites');
  });

  it('tells the page it is adding while the dialog is open, until it closes or the state goes', async () => {
    const adding = () => screen.getByTestId('adding').textContent;
    const routes = [
      {
        path: '/favorites',
        element: (
          <>
            <AddingProbe />
            <NoSourcesState icon={<span />} title="No favorites yet" description="Add a source first." testId="fav-add" />
          </>
        ),
      },
      { path: '/elsewhere', element: <AddingProbe /> },
    ];
    const { router } = renderAt(routes, '/favorites');
    expect(adding()).toBe('false');
    fireEvent.click(screen.getByTestId('fav-add'));
    await screen.findByTestId('add-source-dialog');
    expect(adding()).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(adding()).toBe('false'));

    // Leaving the page with the dialog open does not leave the flag behind.
    fireEvent.click(screen.getByTestId('fav-add'));
    await waitFor(() => expect(adding()).toBe('true'));
    await act(async () => {
      await router.navigate('/elsewhere');
    });
    expect(screen.queryByTestId('fav-add')).toBeNull();
    expect(adding()).toBe('false');
  });

  it('draws one short row in the banner layout, with the same actions', () => {
    renderAt([{ path: '/sports', element: <NoSourcesState layout="banner" icon={<span />} title="No sources yet" description="Add a source to watch these games." stateTestId="banner" /> }], '/sports');
    const banner = screen.getByTestId('banner');
    expect(banner.className).toContain('border-dashed');
    expect(screen.getByRole('heading', { name: 'No sources yet' })).toBeTruthy();
    expect(screen.getByTestId('no-sources-add').textContent).toBe('Add a source');
    expect(screen.getByRole('link', { name: 'Import a backup' })).toBeTruthy();
  });
});
