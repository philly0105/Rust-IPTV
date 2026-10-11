import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { RpcError } from '@/api/transport';

import { Button, Dialog, ErrorState, SearchInput, Tabs, Toggle } from '..';

afterEach(cleanup);

describe('Toggle in RTL (R6-r2 F1)', () => {
  it('mirrors the thumb translate so it stays inside the track', () => {
    const { container, rerender } = render(
      <div dir="rtl">
        <Toggle label="Autoplay" checked onChange={() => {}} />
      </div>,
    );
    const thumb = () => container.querySelector('[role="switch"] > span')!;
    expect(thumb().className).toContain('translate-x-5.5');
    expect(thumb().className).toContain('rtl:-translate-x-5.5');
    rerender(
      <div dir="rtl">
        <Toggle label="Autoplay" checked={false} onChange={() => {}} />
      </div>,
    );
    expect(thumb().className).toContain('rtl:-translate-x-0.75');
  });
});

describe('SearchInput uses logical positions (R6-r2 F8)', () => {
  it('places the icon at the inline start and the clear button at the inline end', () => {
    const { container } = render(
      <div dir="rtl">
        <SearchInput value="news" onChange={() => {}} label="Search" />
      </div>,
    );
    const icon = container.querySelector('svg')!;
    expect(icon.getAttribute('class')).toContain('start-3');
    expect(icon.getAttribute('class')).not.toMatch(/\bleft-3\b/);
    const clear = screen.getByRole('button', { name: /clear/i });
    expect(clear.className).toContain('end-1');
    expect(clear.className).not.toMatch(/\bright-1\b/);
    expect(screen.getByRole('searchbox').className).toMatch(/\bps-9\b.*\bpe-9\b/);
  });
});

describe('Tabs arrow keys follow the screen in RTL', () => {
  it('ArrowLeft moves forward when the tab row is mirrored', () => {
    const onChange = vi.fn();
    render(
      <div dir="rtl">
        <Tabs
          label="Kind"
          value="a"
          onChange={onChange}
          items={[
            { id: 'a', label: 'Live' },
            { id: 'b', label: 'Movies' },
          ]}
        />
      </div>,
    );
    // jsdom does not derive `direction` from `dir`; set it the way the browser computes it.
    screen.getByRole('tablist').style.direction = 'rtl';
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Live' }), { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith('b');
  });
});

describe('Dialog unmounted while open (R6-r2 F5)', () => {
  function Harness() {
    const [shown, setShown] = useState(false);
    return (
      <>
        <button onClick={() => setShown(true)}>Edit source</button>
        {/* Like EditSourceDialog: the Dialog is always `open` and the parent unmounts it. */}
        {shown && (
          <Dialog open onClose={() => setShown(false)} title="Edit">
            <input aria-label="Name" data-autofocus="" />
          </Dialog>
        )}
      </>
    );
  }
  it('returns focus to the opener instead of BODY', () => {
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Edit source' });
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement).toBe(screen.getByLabelText('Name'));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

describe('Button loading keeps focus (R6-r2 F6)', () => {
  function Harness({ onRun }: { onRun: () => void }) {
    const [loading, setLoading] = useState(false);
    return (
      <Button
        loading={loading}
        onClick={() => {
          onRun();
          setLoading(true);
        }}
      >
        Refresh all
      </Button>
    );
  }
  it('uses aria-disabled while loading, keeps focus, and ignores further activation', () => {
    const onRun = vi.fn();
    render(<Harness onRun={onRun} />);
    const btn = screen.getByRole('button', { name: 'Refresh all' });
    btn.focus();
    fireEvent.click(btn);
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(btn.hasAttribute('disabled')).toBe(false);
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(btn.getAttribute('aria-busy')).toBe('true');
    expect(document.activeElement).toBe(btn);
    fireEvent.click(btn);
    expect(onRun).toHaveBeenCalledTimes(1);
  });
  it('blocks form submission while loading', () => {
    const onSubmit = vi.fn((e: { preventDefault: () => void }) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <Button type="submit" loading>
          Save
        </Button>
      </form>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSubmit).not.toHaveBeenCalled();
  });
  it('keeps native disabled for the disabled prop', () => {
    render(<Button disabled>Save</Button>);
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true);
  });
});

describe('ErrorState for an unreachable app server (R6-r2 F4)', () => {
  it('shows a translated body and a local-server hint, with the raw text behind a disclosure', () => {
    const err = new RpcError('network', 'Cannot reach the server: Failed to fetch', true, { transport: 'unreachable' });
    render(<ErrorState error={err} />);
    expect(screen.getByText("The app's own server isn't answering, so nothing could load.")).toBeTruthy();
    expect(screen.getByText(/Check that the Tsrust IPTV server is still running/)).toBeTruthy();
    expect(screen.queryByText(/provider URL/)).toBeNull();
    const raw = screen.getByText('Cannot reach the server: Failed to fetch');
    expect(raw.closest('details')).not.toBeNull();
  });
  it('keeps the provider hint and message for provider network errors', () => {
    render(<ErrorState error={new RpcError('network', 'error sending request for url (http://p.example/x)')} />);
    expect(screen.getByText('error sending request for url (http://p.example/x)').closest('details')).toBeNull();
    expect(screen.getByText(/provider URL/)).toBeTruthy();
  });
});
