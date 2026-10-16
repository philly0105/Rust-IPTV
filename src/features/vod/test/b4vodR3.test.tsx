/**
 * B4-vod review round 3.
 * D18: a rejected TMDB key on a TMDB-backed section ("More like this", the
 * actor page) says so, points to Metadata settings, and drops the generic
 * hint about the source's username, password or MAC address.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { RpcError } from '@/api/transport';
import common from '@/i18n/en/common.json';
import vod from '@/i18n/en/vod.json';

import { SimilarSection } from '../components/SimilarSection';
import { TmdbErrorState } from '../components/TmdbErrorState';
import { installDomStubs } from './harness';

beforeAll(installDomStubs);
afterEach(cleanup);

const rejected = new RpcError('auth', 'TMDB rejected the API key (401)');
const similar = (error: unknown) => (
  <MemoryRouter>
    <SimilarSection items={[]} loading={false} sourceId="src1" error={error} onRetry={() => undefined} keyMissing={false} enriched={false} />
  </MemoryRouter>
);

describe('B4-vod-D18: TMDB key rejected', () => {
  it('"More like this" names the key, links to Metadata settings, and drops the source-credentials hint', () => {
    render(similar(rejected));
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain(vod.tmdbKeyRejectedTitle);
    expect(alert.textContent).toContain(vod.tmdbKeyRejectedHint);
    expect(alert.textContent).not.toContain(vod.tmdbUnavailable);
    expect(alert.textContent).not.toContain(common.errorHintAuth);
    expect(screen.getByRole('link', { name: vod.openMetadataSettings }).getAttribute('href')).toBe('/settings/metadata');
    expect(screen.getByRole('button', { name: common.retry })).toBeTruthy();
  });

  it('other TMDB failures keep "TMDB could not be reached" and no settings link', () => {
    render(similar(new RpcError('network', 'connection refused')));
    expect(screen.getByRole('alert').textContent).toContain(vod.tmdbUnavailable);
    expect(screen.queryByRole('link', { name: vod.openMetadataSettings })).toBeNull();
  });

  it('the page-size state (actor page) gets the same treatment', () => {
    render(
      <MemoryRouter>
        <TmdbErrorState error={rejected} onRetry={() => undefined} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: vod.tmdbKeyRejectedTitle })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).not.toContain(common.errorHintAuth);
    expect(screen.getByTestId('vod-tmdb-key-settings').getAttribute('href')).toBe('/settings/metadata');
  });
});
