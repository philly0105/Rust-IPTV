// The overlay slot: one overlay at a time, the other waits; openTour and
// openWhatsNew are the hand-made entry points.
import { beforeEach, describe, expect, it } from 'vitest';

import { closeOverlay, openTour, openWhatsNew, resetOnboardingStore, showOverlay, useOnboardingStore } from '../store';

const state = () => useOnboardingStore.getState();

beforeEach(() => resetOnboardingStore());

describe('onboarding overlay store', () => {
  it('opens the tour by hand', () => {
    openTour();
    expect(state().overlay).toEqual({ kind: 'tour', auto: false });
    expect(state().seq).toBe(1);
  });

  it("opens What's new by hand with every release (since null)", () => {
    openWhatsNew();
    expect(state().overlay).toEqual({ kind: 'whatsNew', since: null, auto: false });
  });

  it("queues What's new behind the tour and opens it when the tour closes", () => {
    showOverlay({ kind: 'tour', auto: true });
    showOverlay({ kind: 'whatsNew', since: '0.0.1', auto: true });
    expect(state().overlay?.kind).toBe('tour');
    expect(state().pending).toEqual({ kind: 'whatsNew', since: '0.0.1', auto: true });
    closeOverlay();
    expect(state().overlay).toEqual({ kind: 'whatsNew', since: '0.0.1', auto: true });
    expect(state().pending).toBeNull();
    expect(state().seq).toBe(2);
  });

  it("queues the tour behind What's new (Take the tour)", () => {
    openWhatsNew();
    openTour();
    expect(state().overlay?.kind).toBe('whatsNew');
    closeOverlay();
    expect(state().overlay).toEqual({ kind: 'tour', auto: false });
  });

  it('ignores a second request for the overlay that is already open', () => {
    openTour();
    openTour();
    expect(state().seq).toBe(1);
    expect(state().pending).toBeNull();
  });

  it('lets a hand-made request replace a queued automatic one, not the other way round', () => {
    openTour();
    showOverlay({ kind: 'whatsNew', since: '0.0.1', auto: true });
    openWhatsNew();
    expect(state().pending).toEqual({ kind: 'whatsNew', since: null, auto: false });
    showOverlay({ kind: 'whatsNew', since: '0.0.2', auto: true });
    expect(state().pending).toEqual({ kind: 'whatsNew', since: null, auto: false });
  });

  it('closes to nothing when nothing waits', () => {
    openTour();
    closeOverlay();
    expect(state().overlay).toBeNull();
    expect(state().seq).toBe(1);
  });
});
