/**
 * `OnboardingHost`: runs the startup decision (`onboardingAction`) and shows
 * the open overlay. Mounted once in the shell.
 *
 * This module, the store and the decision are all the shell pays for up
 * front; the tour and What's new (with the release notes, their icons and
 * the English strings) are lazy chunks fetched when one opens.
 *
 * The decision runs whenever its inputs change: `settings.get`, `app.info`
 * and `sources.list` (so adding the first source starts the tour; one whose
 * imports all failed does not, see `countUsableSources`). Each
 * automatic overlay opens at most once per session, even when storing its
 * marker fails, and only while the app is idle: no modal dialog open (the
 * add-source dialog, a PIN prompt), no fullscreen video, the window visible.
 */

import { lazy, Suspense, useEffect, useMemo, type JSX } from 'react';

import { useRpcQuery } from '@/api/query';

import { countUsableSources, onboardingAction } from './decide';
import { saveOnboarding } from './persist';
import { closeOverlay, showOverlay, useOnboardingStore } from './store';

const Tour = lazy(async () => ({ default: (await import('./tour/Tour')).Tour }));
const WhatsNewDialog = lazy(async () => ({ default: (await import('./WhatsNewDialog')).WhatsNewDialog }));

/** Wait after the shell mounts before an automatic overlay, so the rail and header have painted their anchors. */
export const START_DELAY_MS = 600;
/** How often a waiting overlay checks whether the app became idle. */
export const IDLE_POLL_MS = 400;

/** Automatic overlays already shown (or written) this session, so a failed write never reopens one in a loop. */
const handled = new Set<string>();

/** Test helper: forget what this session already showed. */
export function resetOnboardingSession(): void {
  handled.clear();
}

/** True when an overlay may open now: nothing modal on screen, no fullscreen video, the window visible. */
export function appIsIdle(): boolean {
  if (typeof document === 'undefined') return false;
  if (document.querySelector('[aria-modal="true"]')) return false;
  if (document.fullscreenElement) return false;
  return document.visibilityState !== 'hidden';
}

/** Runs `fn` once the app is idle (checked after `START_DELAY_MS`, then every `IDLE_POLL_MS`). Returns a cancel function. */
function whenIdle(fn: () => void): () => void {
  let timer: number | undefined;
  const check = () => {
    if (appIsIdle()) fn();
    else timer = window.setTimeout(check, IDLE_POLL_MS);
  };
  timer = window.setTimeout(check, START_DELAY_MS);
  return () => window.clearTimeout(timer);
}

function useStartupDecision(): void {
  const settings = useRpcQuery('settings.get', undefined, { staleTime: Infinity });
  const info = useRpcQuery('app.info', undefined, { staleTime: Infinity });
  const sources = useRpcQuery('sources.list', undefined);
  const busy = useOnboardingStore((s) => s.overlay !== null);

  const version = info.data?.version;
  const lastSeenVersion = settings.data?.lastSeenVersion;
  const tourCompleted = settings.data?.tourCompleted;
  const sourceCount = sources.data ? countUsableSources(sources.data) : undefined;

  const action = useMemo(
    () =>
      version !== undefined && lastSeenVersion !== undefined && tourCompleted !== undefined && sourceCount !== undefined
        ? onboardingAction({ version, lastSeenVersion, tourCompleted, sourceCount })
        : null,
    [version, lastSeenVersion, tourCompleted, sourceCount],
  );

  useEffect(() => {
    if (!action || busy || version === undefined) return;
    switch (action.kind) {
      case 'none':
        return;
      case 'silent': {
        const key = `silent:${JSON.stringify(action.patch)}`;
        if (handled.has(key)) return;
        handled.add(key);
        void saveOnboarding(action.patch);
        return;
      }
      case 'tour': {
        if (handled.has('tour')) return;
        return whenIdle(() => {
          handled.add('tour');
          showOverlay({ kind: 'tour', auto: true });
        });
      }
      case 'whatsNew': {
        const key = `whatsNew:${version}`;
        if (handled.has(key)) return;
        // Rule B: an upgrade from a build without onboarding knows the app; the tour is done.
        if (action.since === '' && tourCompleted === false && !handled.has('tour')) {
          handled.add('tour');
          void saveOnboarding({ tourCompleted: true });
        }
        return whenIdle(() => {
          handled.add(key);
          showOverlay({ kind: 'whatsNew', since: action.since, auto: true });
        });
      }
    }
  }, [action, busy, version, tourCompleted]);
}

export function OnboardingHost(): JSX.Element | null {
  useStartupDecision();
  const overlay = useOnboardingStore((s) => s.overlay);
  const seq = useOnboardingStore((s) => s.seq);
  if (!overlay) return null;
  return (
    <Suspense fallback={null}>
      {overlay.kind === 'tour' ? (
        <Tour
          key={seq}
          onClose={() => {
            closeOverlay();
            // Finishing and skipping both count: the tour does not come back on its own.
            void saveOnboarding({ tourCompleted: true });
          }}
        />
      ) : (
        <WhatsNewDialog key={seq} since={overlay.since} auto={overlay.auto} onClose={closeOverlay} />
      )}
    </Suspense>
  );
}
