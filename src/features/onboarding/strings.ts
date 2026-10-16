/**
 * The English `onboarding` strings, loaded on demand.
 *
 * Every other locale's onboarding.json is already a lazy chunk
 * (`i18n/lazyLocales.ts`). English is the fallback and is normally bundled
 * eagerly with the other namespaces; this namespace is read only when an
 * overlay opens (the release notes alone are about 1.5 kB), so the overlays
 * call `useOnboardingStrings` before rendering. When the English bundle is
 * already registered (eager glob, tests) it resolves at once; when the shell
 * leaves it out of the entry chunk, the first overlay fetches it here.
 */

import type { i18n as I18n } from 'i18next';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

export const NS = 'onboarding';
const FALLBACK = 'en';

function loaded(i18n: I18n): boolean {
  const bundle = i18n.getResourceBundle?.(FALLBACK, NS) as Record<string, unknown> | undefined;
  return !!bundle && Object.keys(bundle).length > 0;
}

const jobs = new WeakMap<I18n, Promise<void>>();

/** Adds the English onboarding strings to `i18n` once; a failed load is retried on the next call. */
export function ensureOnboardingStrings(i18n: I18n): Promise<void> {
  if (loaded(i18n)) return Promise.resolve();
  const running = jobs.get(i18n);
  if (running) return running;
  const job = import('@/i18n/en/onboarding.json')
    .then((mod) => {
      const data = ((mod as { default?: unknown }).default ?? mod) as Record<string, string>;
      i18n.addResourceBundle(FALLBACK, NS, data, true, false);
    })
    .finally(() => jobs.delete(i18n));
  jobs.set(i18n, job);
  return job;
}

/**
 * `useTranslation('onboarding')` plus a readiness flag: false only while the
 * English strings are still on their way (then the overlay renders nothing
 * rather than raw keys). A failed load still flips it to true, so the overlay
 * shows its keys instead of never opening.
 */
export function useOnboardingStrings() {
  const result = useTranslation(NS);
  const { i18n } = result;
  const [ready, setReady] = useState(() => loaded(i18n));
  useEffect(() => {
    if (ready) return;
    let live = true;
    ensureOnboardingStrings(i18n)
      .catch((err: unknown) => console.warn('[onboarding] could not load strings', err))
      .finally(() => live && setReady(true));
    return () => {
      live = false;
    };
  }, [i18n, ready]);
  return { ...result, ready };
}
