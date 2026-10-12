import { test as base, expect, type ConsoleMessage } from '@playwright/test';
import { MOCK } from './env';

/**
 * Console noise that is not an app defect. Keep this list short and say why
 * each entry is benign; anything else on the console fails the test.
 */
const IGNORED_CONSOLE: readonly RegExp[] = [
  // A test navigates away (or switches channel) while a media request is in flight.
  /net::ERR_ABORTED/,
  // HTMLMediaElement.play() promise rejected because a new src/pause interrupted it.
  /The play\(\) request was interrupted/,
  // fetch/XHR aborted through an AbortController on unmount or channel switch.
  /AbortError/,
];

const FAILED_LOAD = /Failed to load resource: the server responded with a status of (401|403|404|500|502|503)/;

/**
 * Specs that test failure states deliberately hit the mock portal's 401/404/500
 * routes (directly or through `/api/proxy`); the browser logs the failed load
 * itself and the app shows its own error UI. Only mock-portal URLs qualify: an
 * app RPC (`/api/rpc/*`) that fails is a defect unless the spec allows it with
 * `consoleLog.allow()`.
 */
function isMockLoadFailure(text: string, url: string): boolean {
  if (!FAILED_LOAD.test(text) || !url) return false;
  let target = url;
  try {
    target = decodeURIComponent(url);
  } catch {
    // Keep the raw URL.
  }
  return url.startsWith(MOCK) || (url.includes('/api/proxy') && target.includes(MOCK));
}

export interface ConsoleLog {
  /** Console errors, React warnings and uncaught page errors since the test started. */
  errors: string[];
  /** Clears what was collected so far (e.g. after a deliberate failure). */
  clear(): void;
  /**
   * Accepts console errors matching `pattern` for the rest of this test only, for a
   * failure the spec provokes on purpose (a cancelled import answers HTTP 409).
   * Prefer this over `clear()`: anything else still fails the test.
   */
  allow(pattern: RegExp): void;
}

/**
 * SC9: every test fails on console errors, React key/act warnings and
 * unhandled page errors (uncaught exceptions and unhandled promise
 * rejections both surface as `pageerror`). The fixture is automatic, so
 * specs do not need to opt in; a spec that provokes an error on purpose calls
 * `consoleLog.allow(pattern)` before it (or `consoleLog.clear()` afterwards).
 */
export const test = base.extend<{ consoleLog: ConsoleLog }>({
  consoleLog: [
    async ({ page }, use, testInfo) => {
      const errors: string[] = [];
      const allowed: RegExp[] = [];
      const onConsole = (m: ConsoleMessage) => {
        const text = m.text();
        const isReactWarning = m.type() === 'warning' && /^Warning: |Each child in a list should have a unique "key"/.test(text);
        if (m.type() !== 'error' && !isReactWarning) return;
        const at = m.location();
        const line = `console.${m.type()}: ${text}${at.url ? ` (${at.url}:${at.lineNumber})` : ''}`;
        if (IGNORED_CONSOLE.some((re) => re.test(text)) || isMockLoadFailure(text, at.url)) return;
        // Allow patterns see the URL too, so a spec can allow one failing RPC by name.
        if (allowed.some((re) => re.test(line))) return;
        errors.push(line);
      };
      // Uncaught exceptions and unhandled promise rejections both arrive here.
      const onPageError = (e: Error) => {
        const frames = e.stack ? e.stack.split('\n').slice(1, 4).join(' | ') : '';
        errors.push(`pageerror: ${e.message}${frames ? ` @ ${frames.trim()}` : ''}`);
      };
      page.on('console', onConsole);
      page.on('pageerror', onPageError);
      await use({ errors, clear: () => errors.splice(0, errors.length), allow: (re) => allowed.push(re) });
      page.off('console', onConsole);
      page.off('pageerror', onPageError);
      // Only judge tests that otherwise passed, so the real failure stays the headline.
      if (testInfo.status === testInfo.expectedStatus) {
        expect(errors, 'no console errors, React warnings or uncaught page errors').toEqual([]);
      }
    },
    { auto: true },
  ],
});

export { expect };
