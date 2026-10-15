/**
 * Which onboarding overlay is open: the tour, What's new, or neither. One
 * slot, so the two never show together; a request made while the other is
 * open waits in `pending` and opens when it closes (What's new waits for the
 * tour, and "Take the tour" from What's new opens once that dialog is gone).
 *
 * `openTour` and `openWhatsNew` are the public entry points (command
 * palette, About section). This module has no React or UI imports, so the
 * callers do not pull the overlays into their chunks.
 */

import { create } from 'zustand';

export type OnboardingOverlay =
  | {
      kind: 'tour';
      /** Started by the startup decision rather than by hand. */
      auto: boolean;
    }
  | {
      kind: 'whatsNew';
      /** null: opened by hand (every release so far). '': rule B (this version only). Else releases newer than it. */
      since: string | null;
      auto: boolean;
    };

interface OnboardingState {
  overlay: OnboardingOverlay | null;
  pending: OnboardingOverlay | null;
  /** Bumped on every open, so a reopened overlay remounts fresh. */
  seq: number;
}

export const useOnboardingStore = create<OnboardingState>(() => ({ overlay: null, pending: null, seq: 0 }));

/** Opens `o`, or queues it behind the overlay that is open (one of each kind at most). */
export function showOverlay(o: OnboardingOverlay): void {
  const { overlay, pending, seq } = useOnboardingStore.getState();
  if (!overlay) {
    useOnboardingStore.setState({ overlay: o, seq: seq + 1 });
    return;
  }
  if (overlay.kind === o.kind) return;
  // A queued request of the same kind is replaced; a hand-made one wins over an automatic one.
  if (!pending || pending.kind !== o.kind || pending.auto) useOnboardingStore.setState({ pending: o });
}

/** Closes the open overlay and opens the queued one, if any. */
export function closeOverlay(): void {
  const { pending, seq } = useOnboardingStore.getState();
  useOnboardingStore.setState({ overlay: pending, pending: null, seq: pending ? seq + 1 : seq });
}

/** Starts the 3-step tour (command palette entry). Waits if What's new is open. */
export function openTour(): void {
  showOverlay({ kind: 'tour', auto: false });
}

/** Opens What's new with every release so far (About section link). Waits if the tour is open. */
export function openWhatsNew(): void {
  showOverlay({ kind: 'whatsNew', since: null, auto: false });
}

/** Test helper: back to nothing open. */
export function resetOnboardingStore(): void {
  useOnboardingStore.setState({ overlay: null, pending: null, seq: 0 });
}
