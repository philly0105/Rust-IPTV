// Entry-chunk budget (C4, SC10): `pnpm build && pnpm size:check`.
//
// Prints every JavaScript chunk in dist/assets, largest first, and exits 1 when the entry chunk
// (`dist/assets/index-*.js`, the module script index.html loads) is over BUDGET bytes, when
// Home's route chunk statically loads player code (performance audit SH-2), when the Search,
// Settings or category-grid route chunks statically load the player's UI, or when there is no
// build to check. Plain Node, no dependencies.
//
//   node tools/check-bundle.mjs [distDir]    (default: dist)
//
// See docs/architecture/performance.md for what lives in the entry and how to keep it small.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

/** About 10 % over the 243,927-byte entry measured before Run 1 (run.md SC10). */
const BUDGET = 268_000;
const ENTRY = /^index-[\w-]+\.js$/;
/**
 * Player chunks (named after their first module: the player store, `playback`, `mpvExtras`, the
 * `@/features/player` barrel, the stage and the engines). A lazy route renders only after its
 * static imports have run, so one of these in Home's static closure made a cold Home wait for
 * about 97 kB of player code it needs only after a click. Home loads the player behind import().
 */
const PLAYER = /^(?:store|playback|mpvExtras|player-index|PlayerStage|PlayerDock|Controls|hls|mpegts|shaka-player\.compiled)-[\w-]+\.js$/;
/**
 * The player's UI: the barrel, the dock, the stage, the controls (whose chunk also holds the
 * player's stores and subscriptions: reconnect, failover, sleep timer, zap banner) and the engines.
 * A page that only formats or resumes titles may load the player store (`vod/lib/format.ts` reads
 * its resume rules), not these. A static import of `@/features/player` for `playItem` put the
 * controls chunk, 69 kB, in front of Search's and the category grids' first render; the duration
 * helper merged into the player's subtitle chunk did the same to Settings.
 */
const PLAYER_UI = /^(?:player-index|PlayerStage|PlayerDock|Controls|hls|mpegts|shaka-player\.compiled)-[\w-]+\.js$/;
/** The chunk Controls.tsx starts; the route checks fail when it is gone, so a rename cannot switch them off. */
const CONTROLS = /^Controls-[\w-]+\.js$/;
/**
 * Lazy route chunks, named after their page module, and the player chunks each must not reach
 * through static imports. Home plays only through import() (SH-2); Search plays a channel and a
 * category grid's poster menu plays a movie the same way.
 */
const ROUTES = [
  { name: 'Home', chunk: /^DashboardPage-[\w-]+\.js$/, page: 'src/shell/dashboard/DashboardPage.tsx', forbid: PLAYER, what: 'player code' },
  { name: 'Search', chunk: /^SearchPage-[\w-]+\.js$/, page: 'src/features/vod/pages/SearchPage.tsx', forbid: PLAYER_UI, what: "the player's UI" },
  { name: 'Settings', chunk: /^SettingsPage-[\w-]+\.js$/, page: 'src/features/settings/SettingsPage.tsx', forbid: PLAYER, what: 'player code' },
  { name: 'Category grid', chunk: /^CategoryGridPage-[\w-]+\.js$/, page: 'src/features/vod/pages/CategoryGridPage.tsx', forbid: PLAYER_UI, what: "the player's UI" },
];
/** A static `import`/`export ... from "./chunk.js"` in Rollup's output; `import("./x.js")` is not one. */
const STATIC_IMPORT = /\b(?:import|export)\s*(?:\{[^}]*\}\s*from\s*|\*\s*as\s*[\w$]+\s*from\s*|[\w$]+\s*from\s*)?["']\.\/([\w.-]+\.js)["']/g;

const dist = resolve(process.argv[2] ?? 'dist');
const assets = join(dist, 'assets');
const shown = relative(process.cwd(), assets) || assets;

function fail(message) {
  console.error(`size:check: ${message}`);
  process.exit(1);
}

if (!existsSync(assets)) fail(`${shown} not found; run pnpm build first.`);

const bytes = (n) => n.toLocaleString('en-US');
const count = (n) => `${bytes(n)} byte${n === 1 ? '' : 's'}`;
const kb = (n) => `${(n / 1000).toFixed(2)} kB`;

const chunks = readdirSync(assets)
  .filter((file) => file.endsWith('.js'))
  .map((file) => {
    const data = readFileSync(join(assets, file));
    return { file, size: statSync(join(assets, file)).size, gzip: gzipSync(data).length };
  })
  .sort((a, b) => b.size - a.size || a.file.localeCompare(b.file));

if (chunks.length === 0) fail(`no .js files in ${shown}; run pnpm build first.`);

// The script index.html loads is the real entry; it should be the only index-*.js
// (vite.config.ts names lazy feature barrels after their folder).
let htmlEntry = null;
try {
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  htmlEntry = /<script\b[^>]*\bsrc="(?:[^"]*\/)?assets\/([^"/]+\.js)"/.exec(html)?.[1] ?? null;
} catch {
  // No index.html: fall back to the file name alone.
}

const entries = chunks.filter((c) => ENTRY.test(c.file));
const sizeWidth = bytes(chunks[0].size).length;
const gzipWidth = kb(Math.max(...chunks.map((c) => c.gzip))).length;

console.log(`JavaScript chunks in ${shown}, largest first (bytes, gzip):`);
for (const c of chunks) {
  const mark = ENTRY.test(c.file) ? (c.file === htmlEntry || !htmlEntry ? '  <- entry' : '  <- index-*.js') : '';
  console.log(`  ${bytes(c.size).padStart(sizeWidth)}  ${kb(c.gzip).padStart(gzipWidth)} gz  ${c.file}${mark}`);
}
const total = chunks.reduce((sum, c) => sum + c.size, 0);
console.log(`  ${chunks.length} chunks, ${bytes(total)} bytes in all.`);
console.log('');

if (entries.length === 0) fail(`no entry chunk (index-*.js) in ${shown}.`);
if (htmlEntry && !ENTRY.test(htmlEntry)) fail(`index.html loads ${htmlEntry}, which is not an index-*.js chunk.`);

let over = false;
for (const c of entries) {
  const left = BUDGET - c.size;
  const verdict = left >= 0 ? `${count(left)} left` : `${count(-left)} OVER`;
  console.log(`Entry ${c.file}: ${bytes(c.size)} bytes of ${bytes(BUDGET)} (${verdict}).`);
  if (left < 0) over = true;
}
if (over) {
  fail(`entry chunk over the ${bytes(BUDGET)}-byte budget. Load the new code lazily (route chunks, dialogs behind import()); see docs/architecture/performance.md.`);
}
console.log('size:check: entry chunk within budget.');
console.log('');

/** Every chunk `file` loads through static imports, itself included (each chunk read once). */
function staticClosure(file) {
  const seen = new Set();
  const stack = [file];
  while (stack.length > 0) {
    const next = stack.pop();
    if (seen.has(next) || !existsSync(join(assets, next))) continue;
    seen.add(next);
    for (const m of readFileSync(join(assets, next), 'utf8').matchAll(STATIC_IMPORT)) stack.push(m[1]);
  }
  return seen;
}

const boot = (f) => ENTRY.test(f) || /^(?:vendor|locale)-/.test(f);
if (!chunks.some((c) => CONTROLS.test(c.file))) {
  fail(`no player controls chunk (Controls-*.js) in ${shown}; update CONTROLS and PLAYER_UI in tools/check-bundle.mjs if the module moved.`);
}
const leaks = [];
for (const route of ROUTES) {
  const page = chunks.find((c) => route.chunk.test(c.file));
  if (!page) fail(`no ${route.name} route chunk (${route.page}) in ${shown}; update ROUTES in tools/check-bundle.mjs if the page moved.`);
  const closure = staticClosure(page.file);
  const beyondBoot = chunks.filter((c) => closure.has(c.file) && !boot(c.file));
  const routeBytes = beyondBoot.reduce((sum, c) => sum + c.size, 0);
  const routeGzip = beyondBoot.reduce((sum, c) => sum + c.gzip, 0);
  console.log(`${route.name} ${page.file}: ${beyondBoot.length} chunks, ${bytes(routeBytes)} bytes (${kb(routeGzip)} gz) beyond the boot chunks before its first render.`);
  const player = [...closure].filter((f) => route.forbid.test(f)).sort();
  if (player.length > 0) leaks.push(`The ${route.name} route chunk statically loads ${route.what} (${player.join(', ')}).`);
}
if (leaks.length > 0) {
  fail(`${leaks.join(' ')} Load the player inside the click handler with import('@/features/player'), and import the store from '@/features/player/store' where a page reads it; see docs/architecture/performance.md.`);
}
console.log("size:check: no player code in the Home or Settings route chunks' static imports, and none of the player's UI in Search's or the category grid's.");
