/**
 * A Home rail's "See all" is the kit's link (SEE_ALL_LINK) whichever way the rail draws its
 * heading: through SectionHeader, or by hand when a meta line sits beside the title (My List's
 * "6 titles"). The hand-built copy had the look but not the invisible touch band, so on a phone
 * one rail's See all was a 44 px target and the next a 59 x 19 tap.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import '@/i18n';

import { installDomStubs } from '../../test/harness';
import { DashboardRail } from '../DashboardRail';

beforeAll(installDomStubs);
afterEach(cleanup);

function rail(id: string, meta?: string) {
  return (
    <DashboardRail<string>
      id={id}
      title={`Rail ${id}`}
      items={['a', 'b']}
      getKey={(s) => s}
      cardWidth={168}
      skeletonAspect={2 / 3}
      seeAll={{ to: `/${id}` }}
      meta={meta ? <span>{meta}</span> : undefined}
      renderCard={(s, p) => (
        <a href={`#${s}`} {...p}>
          {s}
        </a>
      )}
    />
  );
}

describe('a rail’s See all link', () => {
  it('carries the 44 px touch band with and without a meta line beside the title', () => {
    render(
      <MemoryRouter>
        {rail('plain')}
        {rail('with-meta', '6 titles')}
      </MemoryRouter>,
    );
    for (const id of ['plain', 'with-meta']) {
      const region = screen.getByRole('region', { name: `Rail ${id}` });
      const seeAll = within(region).getByRole('link', { name: 'See all' });
      expect(seeAll.getAttribute('href')).toBe(`/${id}`);
      expect(seeAll.className).toContain('relative');
      expect(seeAll.className).toContain('pointer-coarse:after:absolute');
      expect(seeAll.className).toContain('pointer-coarse:after:-inset-y-[calc(12.5rem/15)]');
    }
    // The meta line stays beside the title, and its link does not shrink.
    const withMeta = screen.getByRole('region', { name: 'Rail with-meta' });
    expect(within(withMeta).getByText('6 titles')).toBeTruthy();
    expect(within(withMeta).getByRole('link', { name: 'See all' }).className).toContain('shrink-0');
  });
});
