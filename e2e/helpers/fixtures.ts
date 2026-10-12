import { test as base, expect, type ConsoleMessage } from '@playwright/test';

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
  // Specs that test failure states deliberately hit the mock's 401/404/500 routes;
  // the browser logs the failed resource load itself (the app shows its own error UI).
  /Failed to load resource: the server responded with a status of (401|403|404|500|502|503)/,
];

export interface ConsoleLog {
  /** Console errors, React warnings and uncaught page errors since the test started. */
  errors: string[];
  /** Clears what was collected so far (e.g. after a deliberate failure). */
  clear(): void;
}

/**
 * SC9: every test fails on console errors, React key/act warnings and
 * unhandled page errors (uncaught exceptions and unhandled promise
 * rejections both surface as `pageerror`). The fixture is automatic, so
 * specs do not need to opt in; a spec that provokes an error on purpose calls
 * `consoleLog.clear()` afterwards.
 */
export const test = base.extend<{ consoleLog: ConsoleLog }>({
  consoleLog: [
    async ({ page }, use, testInfo) => {
      const errors: string[] = [];
      const onConsole = (m: ConsoleMessage) => {
        const text = m.text();
        const isReactWarning = m.type() === 'warning' && /^Warning: |Each child in a list should have a unique "key"/.test(text);
        if (m.type() !== 'error' && !isReactWarning) return;
        if (IGNORED_CONSOLE.some((re) => re.test(text))) return;
        errors.push(`console.${m.type()}: ${text}`);
      };
      const onPageError = (e: Error) => errors.push(`pageerror: ${e.message}`);
      page.on('console', onConsole);
      page.on('pageerror', onPageError);
      await use({ errors, clear: () => errors.splice(0, errors.length) });
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
