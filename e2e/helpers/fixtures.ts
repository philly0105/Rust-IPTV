import { test as base, expect, type ConsoleMessage } from '@playwright/test';

/**
 * Console noise that is not an app defect: media requests aborted when a test
 * navigates away mid-stream.
 */
const IGNORED_CONSOLE = [/net::ERR_ABORTED/, /The play\(\) request was interrupted/, /AbortError/];

export interface ConsoleLog {
  /** Console errors and uncaught page errors since the test started. */
  errors: string[];
  /** Clears what was collected so far (e.g. after a deliberate failure). */
  clear(): void;
}

export const test = base.extend<{ consoleLog: ConsoleLog }>({
  consoleLog: async ({ page }, use) => {
    const errors: string[] = [];
    const onConsole = (m: ConsoleMessage) => {
      if (m.type() !== 'error') return;
      const text = m.text();
      if (IGNORED_CONSOLE.some((re) => re.test(text))) return;
      errors.push(`console.error: ${text}`);
    };
    page.on('console', onConsole);
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    await use({ errors, clear: () => errors.splice(0, errors.length) });
    page.off('console', onConsole);
  },
});

export { expect };
