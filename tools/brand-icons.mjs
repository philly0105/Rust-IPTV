// Renders every app, installer and web icon from the SVG masters in docs/brand (see the README
// there). Run it after changing a master, then commit the masters and the PNG/ICO/ICNS output:
//
//   node tools/brand-icons.mjs
//
// It rasterizes with Playwright's Chromium (`pnpm exec playwright install chromium`, or set
// PW_CHANNEL=msedge to use the installed Edge). The desktop set goes through `tauri icon`, which
// also writes Android and iOS folders; only its top-level files, the set the Windows bundle uses,
// are copied into crates/iptv-tauri/icons.

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from '@playwright/test';

const root = join(import.meta.dirname, '..');
const brand = join(root, 'docs', 'brand');
const web = join(root, 'public', 'icons');
const desktop = join(root, 'crates', 'iptv-tauri', 'icons');

/** [master in docs/brand, file in public/icons, size in px] */
const WEB_PNGS = [
  ['mark.svg', 'icon-192.png', 192],
  ['mark.svg', 'icon-512.png', 512],
  ['mark.svg', 'favicon-32.png', 32],
  ['mark-maskable.svg', 'icon-maskable-512.png', 512],
  ['mark-maskable.svg', 'apple-touch-icon.png', 180],
  ['shortcut-guide.svg', 'shortcut-guide.png', 96],
  ['shortcut-search.svg', 'shortcut-search.png', 96],
  ['shortcut-favorites.svg', 'shortcut-favorites.png', 96],
];

const channel = process.env['PW_CHANNEL'];
const browser = await chromium.launch(channel ? { channel } : {});
const page = await browser.newPage();

/** Rasterizes `master` at `size` px straight from the vector (no downscaling) to a PNG file. */
async function render(master, size, out) {
  const svg = readFileSync(join(brand, master)).toString('base64');
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<body style="margin:0"><img src="data:image/svg+xml;base64,${svg}" width="${size}" height="${size}" style="display:block"></body>`,
  );
  await page.locator('img').evaluate((img) => img.decode());
  await page.screenshot({ path: out, omitBackground: true });
}

const tmp = mkdtempSync(join(tmpdir(), 'tsrust-icons-'));
try {
  for (const [master, file, size] of WEB_PNGS) await render(master, size, join(web, file));
  copyFileSync(join(brand, 'mark.svg'), join(web, 'favicon.svg'));

  const source = join(tmp, 'mark-1024.png');
  await render('mark.svg', 1024, source);
  const out = join(tmp, 'tauri');
  const cli = join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
  execFileSync(process.execPath, [cli, 'icon', source, '-o', out], { stdio: 'pipe' });
  for (const name of readdirSync(out)) {
    if (statSync(join(out, name)).isFile()) copyFileSync(join(out, name), join(desktop, name));
  }
} finally {
  await browser.close();
  rmSync(tmp, { recursive: true, force: true });
}
console.log('Icons written to public/icons and crates/iptv-tauri/icons.');
