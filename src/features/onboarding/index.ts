/**
 * Onboarding (contract C7): the first-run tour and What's new.
 *
 * - `OnboardingHost`: mounted once in the shell. Runs `onboardingAction` at
 *   startup and whenever its inputs change, and renders the open overlay.
 * - `openTour` / `openWhatsNew`: open by hand (command palette, About). The
 *   two never show together; a request made while the other is open waits.
 * - `RELEASE_NOTES`: newest first; strings in `onboarding.json`.
 *
 * Callers that only need an opener should import from `./store` to keep the
 * host and the release notes (with their icons) out of their chunk.
 */

export { compareVersions, onboardingAction, releasesToShow } from './decide';
export type { OnboardingAction, OnboardingInput } from './decide';
export { OnboardingHost } from './host';
export { RELEASE_NOTES } from './notes';
export type { ReleaseNoteItem, ReleaseNotes } from './notes';
export { openTour, openWhatsNew } from './store';
