/**
 * Continue watching's 16:9 art when the title has little or no artwork: the backdrop, else the
 * poster upright over its own colours, else the title's initials tile (a bare tint left a blank
 * frame that only the caption named).
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';

import '@/i18n';

import { installDomStubs, rpcMock } from '../../test/harness';

vi.mock('@/api/transport', async (orig) => ({
  ...(await orig<typeof import('@/api/transport')>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  isDesktop: false,
}));

const { ContinueCard } = await import('../cards');

beforeAll(installDomStubs);
afterEach(cleanup);

const rail = { tabIndex: 0, 'data-rail-card': '' as const };

function card(art: { posterUrl?: string; backdropUrl?: string }) {
  render(<ContinueCard rail={rail} title="Harbor Lights" left="60 minutes left" progress={0.3} sourceId="s1" ariaLabel="Resume Harbor Lights" onPlay={() => {}} menu={[]} {...art} />);
  return screen.getByRole('button', { name: 'Resume Harbor Lights' });
}

it('a title with no artwork shows its initials tile, as its poster card does, not a blank tint', () => {
  const el = card({});
  const tile = el.querySelector('[data-poster-fallback]');
  expect(tile?.textContent).toBe('HL');
  // The initials alone (the caption names the title), and the watched share still along the bottom edge.
  expect(tile?.querySelector('svg')).toBeNull();
  expect(el.querySelector('[role="progressbar"]')).toBeTruthy();
});

it('a poster-only title keeps its poster upright over its colours, and a backdrop fills the frame', () => {
  let el = card({ posterUrl: 'https://img.test/p.jpg' });
  expect(el.querySelector('[data-poster-fallback]')).toBeNull();
  expect(el.querySelector('[data-poster-placeholder]')).toBeTruthy();
  cleanup();
  el = card({ backdropUrl: 'https://img.test/b.jpg' });
  expect(el.querySelector('[data-poster-fallback]')).toBeNull();
  expect(el.querySelectorAll('[data-poster-placeholder]')).toHaveLength(1);
});
