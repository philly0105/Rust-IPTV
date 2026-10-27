/**
 * Review round 4, Live: calmer channel rows (no rule under each, a hairline track) and the
 * provider's country tag drawn after the name, quiet, with the raw name kept for assistive tech.
 */

import { cleanup, render, screen, within } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { ChannelName } from '../components/ChannelLogo';
import { ChannelRow } from '../components/ChannelRow';
import { StageIdle } from '../components/StageIdle';
import { MINUTE } from '../lib/epgTime';
import { i18n, installDomStubs, makeChannel, program } from './harness';

beforeAll(installDomStubs);
afterEach(cleanup);

function row(over: Partial<Parameters<typeof ChannelRow>[0]> = {}) {
  const now = Date.now();
  return render(
    <I18nextProvider i18n={i18n}>
      <ChannelRow
        index={0}
        channel={{ ...makeChannel(0), name: 'US| ESPN HD' }}
        nowNext={{ now: program('Morning Mix', now - 10 * MINUTE, now + 50 * MINUTE) }}
        favorite={false}
        playing={false}
        active={false}
        now={now}
        onActivate={() => undefined}
        onToggleFavorite={() => undefined}
        onContextMenu={() => undefined}
        {...over}
      />
    </I18nextProvider>,
  );
}

describe('channel rows without ruled lines (review round 4)', () => {
  it('draws no divider under a row and a hairline track with a neutral fill', () => {
    const { container } = row();
    expect((container.firstElementChild as HTMLElement).className).not.toMatch(/\bborder-b\b/);
    const track = screen.getByTestId('channel-progress-track');
    expect(track.className).toContain('h-0.5');
    expect(track.className).toContain('bg-fg/7');
    expect(screen.getByTestId('channel-progress').className).toContain('bg-fg-subtle/50');
  });

  it('keeps the firmer accent bar on the playing row', () => {
    row({ playing: true });
    const track = screen.getByTestId('channel-progress-track');
    expect(track.className).toContain('h-[3px]');
    expect(track.className).not.toContain('h-0.5');
    expect(screen.getByTestId('channel-progress').className).toContain('bg-accent-mark');
  });
});

describe('the country tag after the name (review round 4)', () => {
  it('draws the name first and the tag as a quiet suffix, and reads the provider name as it is', () => {
    row();
    const button = screen.getByRole('button', { name: /US\| ESPN HD/ });
    const tag = within(button).getByTestId('channel-name-tag');
    expect(tag.textContent).toBe('US');
    expect(tag.className).toContain('text-fg-subtle');
    expect(tag.className).toContain('text-caption');
    // The drawn name and tag are hidden from assistive tech; the raw name is there instead.
    const drawn = tag.parentElement!;
    expect(drawn.getAttribute('aria-hidden')).toBe('true');
    expect(drawn.textContent).toBe('ESPN HDUS');
    expect(drawn.firstChild?.textContent).toBe('ESPN HD');
    expect(within(button).getByText('US| ESPN HD').className).toContain('sr-only');
  });

  it('leaves the tag out with the strip setting on, and draws a name without a tag as plain text', () => {
    row({ stripPrefix: true });
    expect(screen.queryByTestId('channel-name-tag')).toBeNull();
    expect(screen.getByRole('button', { name: /^1, ESPN HD/ })).toBeTruthy();
    cleanup();
    render(<ChannelName name="NCIS: LA" testId="n" />);
    expect(screen.getByTestId('n').textContent).toBe('NCIS: LA');
    expect(screen.queryByTestId('channel-name-tag')).toBeNull();
  });

  it('drops the tag first, whole, so an ellipsis only shows when the name itself is cut', () => {
    render(<ChannelName name="US| MLB Network HD" className="truncate" />);
    const tag = screen.getByTestId('channel-name-tag');
    const name = tag.previousElementSibling as HTMLElement;
    // The name holds its own width up to the whole line.
    expect(name.className.split(' ')).toEqual(expect.arrayContaining(['shrink-0', 'max-w-full', 'truncate']));
    // A tag without room wraps to a second line that the one-line box hides; it never gets an ellipsis.
    expect(tag.parentElement!.className.split(' ')).toEqual(expect.arrayContaining(['flex', 'flex-wrap', 'h-[1lh]', 'overflow-hidden']));
    expect(tag.className).toContain('whitespace-nowrap');
    expect(tag.className).not.toMatch(/\btruncate\b|text-ellipsis/);
  });

  it('moves only a place code: event and content prefixes and names with a pipe stay as written', () => {
    for (const n of ['NBA: Lakers vs Celtics', 'PPV: UFC 300', 'Sky Sports | Main Event', 'beIN SPORTS 1 | HD', 'ESPN HD | Backup']) {
      render(<ChannelName name={n} testId="n" />);
      expect(screen.getByTestId('n').textContent).toBe(n);
      expect(screen.queryByTestId('channel-name-tag')).toBeNull();
      cleanup();
    }
  });

  it('takes a tone for the tag where the theme tone does not apply', () => {
    render(<ChannelName name="UK| BBC One" tagClassName="text-on-glass-muted" />);
    const tag = screen.getByTestId('channel-name-tag');
    expect(tag.className).toContain('text-on-glass-muted');
    expect(tag.className).not.toContain('text-fg-subtle');
  });
});

describe('channel rows on touch (review round 4)', () => {
  it('steps the name and the programme up a size under a coarse pointer and keeps the number quiet', () => {
    row();
    const button = screen.getByRole('button', { name: /US\| ESPN HD/ });
    const drawnName = within(button).getByTestId('channel-name-tag').parentElement!.parentElement!;
    expect(drawnName.className).toContain('text-body-sm');
    expect(drawnName.className).toContain('pointer-coarse:text-body');
    expect(screen.getByTestId('row-now').className).toContain('pointer-coarse:text-body-sm');
    expect(within(button).getByText('1').className).toContain('text-fg-subtle');
  });

  it('keeps the playing row number in the text colour', () => {
    row({ playing: true });
    const number = within(screen.getByRole('button', { name: /US\| ESPN HD/ })).getByText('1');
    expect(number.className).toMatch(/\btext-fg\b(?!-)/);
  });
});

describe('the idle stage names its channel in its own direction (review round 4)', () => {
  function idle(name: string) {
    const now = Date.now();
    return render(
      <I18nextProvider i18n={i18n}>
        <StageIdle kind="live" now={now} last={{ channel: { ...makeChannel(2), name }, nowNext: {} }} />
      </I18nextProvider>,
    );
  }

  it('truncates on the dir="auto" span, so an RTL name gets its ellipsis at its own end', () => {
    idle('قناة الرياضية');
    const name = screen.getByText('قناة الرياضية');
    expect(name.getAttribute('dir')).toBe('auto');
    expect(name.className).toContain('truncate');
    cleanup();
    idle('US| ESPN HD');
    const tag = screen.getByTestId('channel-name-tag');
    expect(tag.textContent).toBe('US');
    const outer = tag.parentElement!.parentElement!;
    expect(outer.getAttribute('dir')).toBe('auto');
    expect(outer.className).toContain('truncate');
  });
});
