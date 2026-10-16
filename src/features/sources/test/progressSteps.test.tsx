/**
 * The core's fixed progress messages show in the user's language (follow-up to L2-sources-home-7),
 * and a Stalker "Could not reach the portal at <host>" names the host, not "the".
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import '@/i18n';

import { ImportProgressView } from '../components/ImportProgressView';
import { classifySourceError } from '../lib/sourceError';
import { installDomStubs } from './harness';

beforeAll(installDomStubs);
afterEach(cleanup);

const detail = () => screen.queryByTestId('import-progress-detail')?.textContent ?? null;
const show = (phase: 'fetching' | 'parsing' | 'saving' | 'done', message: string) =>
  render(<ImportProgressView entry={{ sourceId: 's', phase, done: 10, total: 20, at: 0, message }} kind="xtream" />);

describe('progress steps', () => {
  it.each([
    ['fetching', 'account', 'Checking the account'],
    ['fetching', 'live', 'Live channels'],
    ['parsing', 'movies', 'Movies'],
    ['parsing', 'series', 'Series'],
    ['fetching', 'Connecting to the portal', 'Connecting to the portal'],
    ['fetching', 'Loading channel categories', 'Loading channel groups'],
    ['fetching', 'Loading channels', 'Loading channels'],
    ['fetching', 'Loading radio', 'Loading radio'],
    ['fetching', 'Loading movie and series categories', 'Loading movie and series groups'],
    ['done', 'unchanged', 'Nothing changed since the last refresh'],
  ] as const)('%s "%s" reads "%s"', (phase, message, text) => {
    show(phase, message);
    expect(detail()).toBe(text);
  });

  it('hides the Stalker saving message the phase label already says', () => {
    show('saving', 'Saving the catalog');
    expect(screen.getByTestId('import-progress-phase').textContent).toBe('Saving');
    expect(detail()).toBeNull();
  });

  it('keeps a warning as the core sent it', () => {
    show('parsing', 'movies skipped: the panel answered HTTP 500');
    expect(detail()).toBe('movies skipped: the panel answered HTTP 500');
  });
});

describe('Stalker unreachable portal', () => {
  it('names the host after "the portal at"', () => {
    const text = 'Could not reach the portal at 127.0.0.1:9. The server refused the connection. Check the address and port, and that the server is running, then try again.';
    // The core's new refused wording (L1-sources-home-7) counts as refused too.
    expect(classifySourceError(text, 'network')).toMatchObject({ kind: 'refused', host: '127.0.0.1:9' });
  });
});
