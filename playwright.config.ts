import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

import { defineConfig, devices } from '@playwright/test';

// e2e runs the UI in server (PWA) mode against the mock portals.
// `pnpm build` must have produced ./dist first.
//
// Env overrides:
//   PW_CHANNEL      browser channel (default msedge; the bundled Chromium lacks H.264). Use "chromium" for the bundled build.
//   E2E_PORT        iptv-server port (default 7180)
//   E2E_MOCK_PORT   iptv-mock port (default 7290; the mock URLs in specs assume 7290)
//   E2E_KEEP_DATA=1 keep ./.e2e-data from the previous run

const port = Number(process.env['E2E_PORT'] ?? 7180);
const mockPort = Number(process.env['E2E_MOCK_PORT'] ?? 7290);
const channel = process.env['PW_CHANNEL'] ?? 'msedge';
const dataDir = './.e2e-data';

// Fresh data dir per run. This runs at config load, before Playwright starts the
// web servers (globalSetup would run after them, too late on Windows where the
// server holds the SQLite files open). Worker processes load this config again,
// so the env flag makes the reset happen once, in the main process.
if (!process.env['TSRUST_E2E_DATA_RESET'] && process.env['E2E_KEEP_DATA'] !== '1') {
  process.env['TSRUST_E2E_DATA_RESET'] = '1';
  try {
    rmSync(resolve(import.meta.dirname, dataDir), { recursive: true, force: true });
  } catch (err) {
    console.warn(`[e2e] could not reset ${dataDir} (is an old iptv-server still running?):`, err);
  }
}

// Video capture needs Playwright's ffmpeg build for this playwright-core revision.
// When it is not in the browser cache, record no video instead of failing every test
// (`pnpm exec playwright install ffmpeg` turns it back on).
function ffmpegInstalled(): boolean {
  try {
    const req = createRequire(import.meta.url);
    const corePkg = req.resolve('playwright-core/package.json', { paths: [dirname(req.resolve('@playwright/test/package.json'))] });
    const browsers = JSON.parse(readFileSync(join(dirname(corePkg), 'browsers.json'), 'utf8')) as { browsers: { name: string; revision: string }[] };
    const rev = browsers.browsers.find((b) => b.name === 'ffmpeg')?.revision;
    const root = process.env['PLAYWRIGHT_BROWSERS_PATH'] ?? (process.platform === 'win32' ? join(process.env['LOCALAPPDATA'] ?? '', 'ms-playwright') : '');
    if (!rev || !root) return true;
    return existsSync(join(root, `ffmpeg-${rev}`));
  } catch {
    return true;
  }
}

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    channel: channel === 'chromium' ? undefined : channel,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: ffmpegInstalled() ? 'retain-on-failure' : 'off',
  },
  projects: [
    {
      name: channel,
      use: {
        ...devices['Desktop Chrome'],
        channel: channel === 'chromium' ? undefined : channel,
        viewport: { width: 1280, height: 800 },
      },
    },
  ],
  webServer: [
    {
      command: `cargo run -p iptv-mock -- --port ${mockPort}`,
      url: `http://127.0.0.1:${mockPort}/health`,
      reuseExistingServer: !process.env['CI'],
      timeout: 300_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: `cargo run -p iptv-server -- --port ${port} --data-dir ${dataDir} --static ./dist`,
      url: `http://127.0.0.1:${port}/api/health`,
      // Never reuse: a running server would keep its own (stale) data dir.
      reuseExistingServer: false,
      timeout: 300_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
