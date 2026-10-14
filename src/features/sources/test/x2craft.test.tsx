/** X2-craft: preview retry, disclosure states, and the divider-vs-border contract across the feature pages. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const parsePreview = vi.fn<(args: unknown) => Promise<unknown>>();

vi.mock('@/api/transport', async (orig) => ({
  ...(await orig<typeof import('@/api/transport')>()),
  rpc: (cmd: string, args?: unknown) => (cmd === 'm3u.parsePreview' ? parsePreview(args) : Promise.reject(new Error(`unexpected ${cmd}`))),
}));

const { PreviewPanel } = await import('../components/PreviewPanel');
const { usePlaylistPreview } = await import('../lib/usePreview');

function Harness({ text }: { text: string }) {
  return <PreviewPanel state={usePlaylistPreview(text, 0)} />;
}

beforeEach(() => parsePreview.mockReset());
afterEach(cleanup);

describe('playlist preview', () => {
  it('a failed preview offers Try again, which re-runs the same parse', async () => {
    parsePreview.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ channelCount: 3, groups: ['News'], epgUrls: [] });
    render(<Harness text="#EXTM3U" />);
    const alert = await screen.findByTestId('preview-error');
    fireEvent.click(alert.querySelector('button') as HTMLButtonElement);
    expect(await screen.findByTestId('preview-channel-count')).toBeTruthy();
    expect(parsePreview).toHaveBeenCalledTimes(2);
    expect(parsePreview.mock.calls[1]?.[0]).toEqual({ text: '#EXTM3U' });
  });
});

const FEATURES = join(__dirname, '..', '..');
const DIRS = ['live', 'vod', 'sources', 'library', 'settings'];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'test' ? [] : sourceFiles(p);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}

describe('border contract (D23)', () => {
  it('decorative separators use the divider token, not the 3:1 component border', () => {
    // Single-sided edges, divide-* lists and 1px rules are separators. Three kept on purpose:
    // the modal category drawer's edge (a dialog surface), the EPG midnight marker and the
    // interface-size scale's ticks in Appearance (both carry meaning). Run 2: the track of the
    // decade chips' count meter in the movie filters (a bar, not a rule between regions).
    const allowed = [
      /fixed inset-y-0 start-0 z-50 .*border-e border-border/,
      /midnight \? 'bg-border'/,
      /on \? 'bg-accent' : 'bg-border'/,
      /on \? 'bg-accent-fg\/25' : 'bg-border'/,
    ];
    const offenders: string[] = [];
    for (const d of DIRS) {
      for (const file of sourceFiles(join(FEATURES, d))) {
        readFileSync(file, 'utf8')
          .split('\n')
          .forEach((line, i) => {
            const tokens = line.split(/[\s'"`{}()]+/);
            const has = (re: RegExp) => tokens.some((t) => re.test(t));
            // A one-sided edge with no full outline is a rule between regions, not a component edge.
            const oneSided = has(/^border-[tbsexy](-\d+)?$/) && !has(/^border(-\d+)?$/);
            const separator = has(/^divide-border(\/\d+)?$/) || has(/^bg-border(\/\d+)?$/) || (oneSided && has(/^border-border(\/\d+)?$/));
            if (separator && !allowed.some((re) => re.test(line))) offenders.push(`${relative(FEATURES, file)}:${i + 1}`);
          });
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('disclosures', () => {
  it('source form disclosures show hover and pressed states and mirror their chevron in RTL', () => {
    for (const f of ['HeadersFields.tsx', 'StalkerForm.tsx']) {
      const src = readFileSync(join(__dirname, '..', 'components', f), 'utf8');
      const summary = /<summary className="([^"]+)"/.exec(src)?.[1] ?? '';
      expect(summary, f).toMatch(/hover:bg-surface-2/);
      expect(summary, f).toMatch(/active:bg-surface-3/);
      const chevron = /<ChevronRight[^>]*className="([^"]+)"/.exec(src)?.[1] ?? '';
      expect(chevron, f).toContain('rtl:-scale-x-100');
      expect(chevron, f).toContain('rtl:group-open:-rotate-90');
      expect(chevron, f).toContain('ltr:group-open:rotate-90');
    }
  });
});
