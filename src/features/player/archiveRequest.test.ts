import { describe, expect, it } from 'vitest';

import type { PlayerSource } from '@/api/types';

import { archiveRequest } from './archiveRequest';

const source: PlayerSource = {
  url: 'http://host/base/timeshift/user/password/180/2026-10-25:18-00/101.ts?token=x',
  kind: 'direct', title: 'Archive', isLive: false, isRadio: false,
  catchupProgramStart: '2026-10-25T18:00:00Z', durationSeconds: 10_800,
};

describe('Xtream archive requests', () => {
  it('opens the target minute with the provider duration intact and preserves query parameters', () => {
    expect(archiveRequest(source, 2 * 3600 + 19 * 60 + 35)).toEqual({
      url: 'http://host/base/timeshift/user/password/180/2026-10-25:20-19/101.ts?token=x',
      offset: 8340, duration: 2460,
    });
  });

  it('crosses midnight using the timestamp already generated for the provider', () => {
    expect(archiveRequest({ ...source, url: source.url.replace('2026-10-25:18-00', '2026-10-25:23-30') }, 3600)?.url)
      .toContain('/2026-10-26:00-30/');
  });

  it('leaves other archive formats to their existing seek path', () => {
    expect(archiveRequest({ ...source, url: 'http://host/recording.ts' }, 800)).toBeNull();
    expect(archiveRequest({ ...source, url: source.url.replace('2026-10-25:18-00', '2026-13-25:18-00') }, 800)).toBeNull();
  });
});
