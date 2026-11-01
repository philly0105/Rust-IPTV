// Entry-chunk budget (C4, SC10): `pnpm build && pnpm size:check`.
//
// Prints every JavaScript chunk in dist/assets, largest first, and exits 1 when the entry chunk
// (`dist/assets/index-*.js`, the module script index.html loads) is over BUDGET bytes, when the
// boot chunks hold code only lazy pages use (NOT_AT_BOOT), when a lazy route chunk statically loads
// player code it must not wait for (see ROUTES: none for Home, Settings and the VOD browsing pages,
// performance audit SH-2; no dock or controls for the pages that draw the stage) or TanStack
// Virtual without drawing a virtual list, when a guarded route goes over its byte budget, or when
// there is no build to check. Plain Node, no dependencies.
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
 * Player chunks, named after their first module: the player store, `playback`, `mpvExtras`, the
 * `@/features/player` barrel (`player-index`), the stage, the dock (`dock`, the module the shell
 * loads it from), the controls and the engines. A lazy route renders only after its static imports
 * have run, so one of these in Home's static closure made a cold Home wait for about 97 kB of
 * player code it needs only after a click. Home loads the player behind import().
 */
const PLAYER = /^(?:store|playback|mpvExtras|player-index|PlayerStage|PlayerDock|dock|Controls|engines|hls|mpegts|shaka-player\.compiled)-[\w-]+\.js$/;
/**
 * The player's UI: the barrel and the stage, the dock, the controls (with the player's stores and
 * subscriptions around them: reconnect, failover, sleep timer) and the engines. A static import of
 * `@/features/player` for `playItem` put the controls chunk, 69 kB, in front of Search's and the
 * category grids' first render; the duration helper merged into the player's subtitle chunk did the
 * same to Settings.
 */
const PLAYER_UI = /^(?:player-index|PlayerStage|PlayerDock|dock|Controls|engines|hls|mpegts|shaka-player\.compiled)-[\w-]+\.js$/;
/** The dock and the controls, which only the shell loads (`@/features/player/dock`). */
const DOCK = /^(?:PlayerDock|dock|Controls)-[\w-]+\.js$/;
/**
 * Modules found by a string only they hold (a storage key, a test id), whatever chunk the
 * experimentalMinChunkSize merge put them in: it names a merged chunk after its first module, and
 * the player store has sat in `store-*.js` and in `format-*.js`. The check fails when a marker is
 * in no chunk, so renaming one cannot switch a guard off.
 */
const MODULES = {
  store: { marker: 'player.volume', what: 'the player store (features/player/store.ts)' },
  engines: { marker: 'player.liveFormats', what: "the player's engines (features/player/engines.ts)" },
  dock: { marker: 'player.mini.pos', what: 'the dock (features/player/components/PlayerDock.tsx)' },
  controls: { marker: 'controls-pane', what: "the player's controls (features/player/components/Controls.tsx)" },
  cards: { marker: 'source-card-progress', what: "Home's cards (shell/dashboard/cards.tsx)" },
  virtual: { marker: 'measureElement', what: 'TanStack Virtual (the `virtual` chunk)' },
  channelRows: { marker: 'row-guide-unavailable', what: "Live's channel list and rows (features/live/components/ChannelRow.tsx)" },
};
/**
 * Code only lazy pages (or only the desktop app) use, found by a string only it holds, which must
 * not be in the boot: the entry and the chunks it loads statically, index.html's preloads. A manual
 * vendor chunk loads whole, so one misplaced package rides along on every launch. `web` markers
 * apply to the web build only (vite.config.ts keeps the whole Tauri API in vendor-tauri for the
 * desktop app, which syncs its window at boot). A marker that is in no chunk fails the check.
 */
const NOT_AT_BOOT = [
  { marker: 'plugin:dialog|', what: 'the Tauri dialog plugin' },
  { marker: 'plugin:opener|', what: 'the Tauri opener plugin' },
  { marker: 'plugin:updater|', what: 'the Tauri updater plugin' },
  { marker: 'plugin:window|', what: "the Tauri window API (the web build's boot needs only invoke and listen)", web: true },
  { marker: 'measureElement', what: 'TanStack Virtual (only the virtualized pages use it)' },
  { marker: 'role:"switch"', what: "the form fields (ui/Field.tsx; the header's search box is ui/SearchInput.tsx)" },
  { marker: '"tab-bar"', what: 'the phone tab bar (shell/TabBar.tsx), which only phones draw' },
];
/** What a route must not load: chunks by name, and modules by marker. */
const NO_PLAYER = { what: 'player code', names: PLAYER, modules: ['store', 'engines', 'dock', 'controls'] };
const NO_PLAYER_UI = { what: "the player's UI", names: PLAYER_UI, modules: ['engines', 'dock', 'controls'] };
const NO_DOCK = { what: "the dock or the player's controls", names: DOCK, modules: ['dock', 'controls'] };
/**
 * Live and the guide draw the stage without the engines, and their EPG mapping dialog and the guide
 * join facts with `joinList` from `@/lib/intl`, not from Home's cards.
 */
const NO_DOCK_OR_CARDS = {
  what: "the dock, the player's controls, its engines or Home's cards",
  names: DOCK,
  modules: ['dock', 'controls', 'engines', 'cards'],
};
/** The guide also draws no channel list: its Stalker notice has a module of its own. */
const GUIDE = {
  what: "the dock, the player's controls, its engines, Home's cards or Live's channel list",
  names: DOCK,
  modules: ['dock', 'controls', 'engines', 'cards', 'channelRows'],
};
/**
 * Lazy route chunks, named after their page module, and what each must not reach through static
 * imports. Home plays only through import() (SH-2); Search plays a channel, a category grid's
 * poster menu plays a movie, Sports plays a game's channel and the VOD pages resume titles the same
 * way, and the resume rules they label titles with live apart from the store
 * (`features/player/resumeRules.ts`). The library's pages load the player when a row plays
 * (`features/library/lib/open.ts`, `playDownload.ts`); Recently watched reads the store to mark
 * what is playing, so it may load the store, but not the player's UI.
 *
 * The pages that draw the stage (`PlayerStage` from the `@/features/player` barrel) load the store
 * and the stage, but the dock and the controls come from the shell, which loads them after the
 * first route (`@/features/player/dock`). The barrel must not export anything that reaches them:
 * when it exported `PlayerDock`, Live and the guide waited for the controls chunk, about 25 kB
 * gzipped, before their first render.
 *
 * `lists: false`: the page draws no virtual list before its first render, so it must not load
 * TanStack Virtual (vite.config.ts virtualListBoundary keeps the small-chunk merge from adding it).
 *
 * `budget`: the most bytes beyond the boot chunks the page may load before its first render. It is
 * what the page loaded before the 2026-10-31 performance audit, plus the code the boot carried then
 * and the page still draws (the form fields, ui/Field.tsx, 7.4 kB; TanStack Virtual, 27 kB). The
 * experimentalMinChunkSize merge once added 23 to 56 kB to these pages by placing small shared
 * modules differently, which no other check here sees.
 */
const ROUTES = [
  { name: 'Home', chunk: /^DashboardPage-[\w-]+\.js$/, page: 'src/shell/dashboard/DashboardPage.tsx', forbid: NO_PLAYER, lists: false },
  { name: 'Search', chunk: /^SearchPage-[\w-]+\.js$/, page: 'src/features/vod/pages/SearchPage.tsx', forbid: NO_PLAYER },
  { name: 'Settings', chunk: /^SettingsPage-[\w-]+\.js$/, page: 'src/features/settings/SettingsPage.tsx', forbid: NO_PLAYER, lists: false, budget: 224_510 },
  { name: 'Category grid', chunk: /^CategoryGridPage-[\w-]+\.js$/, page: 'src/features/vod/pages/CategoryGridPage.tsx', forbid: NO_PLAYER },
  { name: 'VOD landing', chunk: /^VodLandingPage-[\w-]+\.js$/, page: 'src/features/vod/pages/VodLandingPage.tsx', forbid: NO_PLAYER },
  { name: 'Actor', chunk: /^ActorPage-[\w-]+\.js$/, page: 'src/features/vod/pages/ActorPage.tsx', forbid: NO_PLAYER, lists: false },
  { name: 'Sports', chunk: /^SportsPage-[\w-]+\.js$/, page: 'src/features/sports/pages/SportsPage.tsx', forbid: NO_PLAYER, lists: false, budget: 159_224 },
  { name: 'Live', chunk: /^LivePage-[\w-]+\.js$/, page: 'src/features/live/components/LivePage.tsx', forbid: NO_DOCK_OR_CARDS },
  { name: 'Guide', chunk: /^EpgGridPage-[\w-]+\.js$/, page: 'src/features/live/components/EpgGridPage.tsx', forbid: GUIDE },
  { name: 'Archive', chunk: /^ArchivePage-[\w-]+\.js$/, page: 'src/features/live/components/ArchivePage.tsx', forbid: NO_DOCK, lists: false },
  { name: 'Multi-view', chunk: /^MultiviewPage-[\w-]+\.js$/, page: 'src/features/multiview/components/MultiviewPage.tsx', forbid: NO_DOCK },
  { name: 'List', chunk: /^ListPage-[\w-]+\.js$/, page: 'src/features/lists/pages/ListPage.tsx', forbid: NO_DOCK },
  { name: 'Movie', chunk: /^MovieDetailPage-[\w-]+\.js$/, page: 'src/features/vod/pages/MovieDetailPage.tsx', forbid: NO_DOCK, lists: false },
  { name: 'Series', chunk: /^SeriesDetailPage-[\w-]+\.js$/, page: 'src/features/vod/pages/SeriesDetailPage.tsx', forbid: NO_DOCK },
  { name: 'Favorites', chunk: /^FavoritesPage-[\w-]+\.js$/, page: 'src/features/library/pages/FavoritesPage.tsx', forbid: NO_PLAYER },
  { name: 'Recent', chunk: /^RecentPage-[\w-]+\.js$/, page: 'src/features/library/pages/RecentPage.tsx', forbid: NO_PLAYER_UI },
  { name: 'Downloads', chunk: /^DownloadsPage-[\w-]+\.js$/, page: 'src/features/library/pages/DownloadsPage.tsx', forbid: NO_PLAYER },
  { name: 'Scheduled', chunk: /^ScheduledPage-[\w-]+\.js$/, page: 'src/features/library/pages/ScheduledPage.tsx', forbid: NO_PLAYER, lists: false },
  { name: 'My videos', chunk: /^MyVideosPage-[\w-]+\.js$/, page: 'src/features/library/pages/MyVideosPage.tsx', forbid: NO_PLAYER },
  { name: 'My video', chunk: /^MyVideoDetailPage-[\w-]+\.js$/, page: 'src/features/library/pages/MyVideoDetailPage.tsx', forbid: NO_DOCK },
  { name: 'My List', chunk: /^MyListPage-[\w-]+\.js$/, page: 'src/features/mylist/pages/MyListPage.tsx', forbid: NO_PLAYER, budget: 148_909 },
  { name: 'Sources', chunk: /^SourcesPage-[\w-]+\.js$/, page: 'src/features/sources/SourcesPage.tsx', forbid: NO_PLAYER, lists: false, budget: 157_989 },
  { name: 'Stats', chunk: /^StatsPage-[\w-]+\.js$/, page: 'src/features/stats/pages/StatsPage.tsx', forbid: NO_PLAYER_UI, lists: false, budget: 188_351 },
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
const entryFile = htmlEntry ?? entries[0].file;
const bootChunks = staticClosure(entryFile);
// Only a web build writes precompressed copies (vite.config.ts `precompress`); `tauri build` does not.
const webBuild = existsSync(join(assets, `${entryFile}.br`));
const source = new Map();
const text = (file) => {
  if (!source.has(file)) source.set(file, readFileSync(join(assets, file), 'utf8'));
  return source.get(file);
};
for (const [key, m] of Object.entries(MODULES)) {
  m.chunks = chunks.filter((c) => text(c.file).includes(m.marker)).map((c) => c.file);
  if (m.chunks.length === 0) {
    fail(`no chunk holds ${m.what} (marker "${m.marker}") in ${shown}; update MODULES.${key} in tools/check-bundle.mjs if the module changed.`);
  }
}
const atBoot = [];
for (const { marker, what, web } of NOT_AT_BOOT) {
  const holders = chunks.filter((c) => text(c.file).includes(marker)).map((c) => c.file);
  if (holders.length === 0) fail(`no chunk holds ${what} (marker "${marker}") in ${shown}; update NOT_AT_BOOT in tools/check-bundle.mjs if the module changed.`);
  if (web && !webBuild) continue;
  const held = holders.filter((f) => bootChunks.has(f));
  if (held.length > 0) atBoot.push(`${what} is in ${held.join(', ')}`);
}
const bootSize = [...bootChunks].reduce((sum, f) => sum + (chunks.find((c) => c.file === f)?.size ?? 0), 0);
console.log(`Boot (the entry and its static imports): ${bootChunks.size} chunks, ${bytes(bootSize)} bytes, ${webBuild ? 'web' : 'desktop'} build.`);
if (atBoot.length > 0) {
  fail(`every launch loads code only lazy pages use: ${atBoot.join('; ')}. Give the package a chunk of its own rather than a vendor-* one (VENDOR_CHUNKS in vite.config.ts), or load the module behind import(); see docs/architecture/performance.md.`);
}
console.log(`size:check: the boot chunks hold none of the ${NOT_AT_BOOT.length} lazy-only modules checked.`);
console.log('');

const leaks = [];
const lists = [];
const overBudget = [];
for (const route of ROUTES) {
  const page = chunks.find((c) => route.chunk.test(c.file));
  if (!page) fail(`no ${route.name} route chunk (${route.page}) in ${shown}; update ROUTES in tools/check-bundle.mjs if the page moved.`);
  const closure = staticClosure(page.file);
  const beyondBoot = chunks.filter((c) => closure.has(c.file) && !boot(c.file));
  const routeBytes = beyondBoot.reduce((sum, c) => sum + c.size, 0);
  const routeGzip = beyondBoot.reduce((sum, c) => sum + c.gzip, 0);
  const budget = route.budget ? ` (budget ${bytes(route.budget)})` : '';
  console.log(`${route.name} ${page.file}: ${beyondBoot.length} chunks, ${bytes(routeBytes)} bytes (${kb(routeGzip)} gz) beyond the boot chunks before its first render${budget}.`);
  if (route.budget && routeBytes > route.budget) overBudget.push(`${route.name} loads ${count(routeBytes - route.budget)} over its ${bytes(route.budget)}-byte budget`);
  if (route.lists === false) {
    const held = MODULES.virtual.chunks.filter((f) => closure.has(f));
    if (held.length > 0) lists.push(`${route.name} (${held.join(', ')})`);
  }
  const named = [...closure].filter((f) => route.forbid.names.test(f)).sort();
  const held = route.forbid.modules.filter((key) => MODULES[key].chunks.some((f) => closure.has(f))).map((key) => MODULES[key].what);
  if (named.length > 0 || held.length > 0) {
    leaks.push(`The ${route.name} route chunk statically loads ${route.forbid.what} (${[...named, ...held].join(', ')}).`);
  }
}
if (leaks.length > 0) {
  fail(`${leaks.join(' ')} Load the player inside the click handler with import('@/features/player'), import the store from '@/features/player/store' where a page reads it, and leave the dock to the shell ('@/features/player/dock'); see docs/architecture/performance.md.`);
}
if (lists.length > 0) {
  fail(`pages that draw no virtual list load TanStack Virtual before their first render: ${lists.join('; ')}. A small module merged with the virtualizer, or one of its importers, brings it; see virtualListBoundary in vite.config.ts and docs/architecture/performance.md.`);
}
if (overBudget.length > 0) {
  fail(`${overBudget.join('; ')}. Find what the page now loads before its first render (a new static import, or small modules the experimentalMinChunkSize merge placed differently) before raising a budget; see docs/architecture/performance.md.`);
}
const budgets = ROUTES.filter((r) => r.budget).length;
console.log(`size:check: no route chunk statically loads player code it must not wait for, ${ROUTES.filter((r) => r.lists === false).length} pages without a virtual list load no TanStack Virtual, and ${budgets} pages are within their budgets (${ROUTES.length} routes checked).`);
