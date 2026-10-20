#!/usr/bin/env node
// Writes THIRD_PARTY_NOTICES.md: the IPTVnator MIT notice, the licence texts of
// the npm packages in the web UI, and (when given) the Rust crates' licence
// texts rendered by cargo-about.
//
//   node tools/third-party-notices.mjs [--rust <file>] [--out <file>]
//
// --rust  Markdown that `cargo about generate` wrote with about.toml and
//         about.hbs. Without it the file says that the Rust section is missing.
// --out   Output path (default THIRD_PARTY_NOTICES.md at the repository root).
//
// Needs `pnpm install` first: pnpm reads the licences from node_modules. The
// release workflow (.github/workflows/release.yml) runs:
//
//   cargo about generate --locked --fail --output-file target/notices-rust.md about.hbs
//   node tools/third-party-notices.mjs --rust target/notices-rust.md
//
// The generated file is not committed. It goes into the GitHub release, the
// Docker image (/usr/share/doc/tsrust-iptv/) and the installer.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// IPTVnator's LICENSE.md as published at https://github.com/4gray/iptvnator
// (checked 2026-10-20).
const IPTVNATOR_LICENSE = `MIT License

Copyright (c) 2019-2026 4gray

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;

// LICENSE, LICENCE.md, LICENSE-MIT, COPYING, NOTICE and the like. SPDX
// documents (LICENSE.spdx) name a licence but do not carry its text.
const LICENCE_FILE = /^(licen[cs]e|copying|notice)([-._].*)?$/i;

function parseArgs(argv) {
  const opts = { out: join(root, 'THIRD_PARTY_NOTICES.md'), rust: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out' || arg === '--rust') {
      const value = argv[++i];
      if (!value) fail(`${arg} needs a path`);
      opts[arg.slice(2)] = resolve(value);
    } else {
      fail(`unknown argument ${arg}`);
    }
  }
  return opts;
}

function fail(message) {
  console.error(`third-party-notices: ${message}`);
  process.exit(1);
}

/** Runs pnpm from PATH, or through corepack when pnpm is not on PATH. */
function pnpm(args) {
  const opts = { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] };
  // pnpm is a .cmd shim on Windows, which needs a shell.
  const shell = process.platform === 'win32';
  try {
    return execFileSync('pnpm', args, { ...opts, shell });
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return execFileSync('corepack', ['pnpm', ...args], { ...opts, shell });
  }
}

function normalise(text) {
  return text.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '').trim();
}

/** The licence texts a package ships, or [] when it has none. */
function licenceTexts(dir, expression) {
  let files;
  try {
    files = readdirSync(dir).filter((f) => LICENCE_FILE.test(f) && !/\.spdx$/i.test(f));
  } catch {
    return [];
  }
  files.sort((a, b) => Number(/^notice/i.test(a)) - Number(/^notice/i.test(b)) || a.localeCompare(b));
  // "MIT OR Apache-2.0" with LICENSE-MIT and LICENSE-APACHE: pass on the MIT
  // text (the choice the package offers), plus any NOTICE file.
  if (/\bOR\b/.test(expression) && /\bMIT\b/.test(expression)) {
    const mit = files.find((f) => /mit/i.test(f));
    if (mit) files = files.filter((f) => f === mit || /^notice/i.test(f));
  }
  return files.map((f) => normalise(readFileSync(join(dir, f), 'utf8'))).filter(Boolean);
}

function npmSection() {
  let report;
  try {
    report = JSON.parse(pnpm(['licenses', 'list', '--prod', '--json']));
  } catch (err) {
    fail(`pnpm licenses list failed (run pnpm install first): ${err.message}`);
  }

  const packages = [];
  for (const [licence, entries] of Object.entries(report)) {
    for (const entry of entries) {
      entry.versions.forEach((version, i) => {
        const dir = entry.paths[i] ?? entry.paths[0];
        packages.push({
          name: entry.name,
          version,
          licence: entry.license ?? licence,
          author: entry.author,
          homepage: entry.homepage,
          texts: dir ? licenceTexts(dir, entry.license ?? licence) : [],
        });
      });
    }
  }
  packages.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

  // One block per distinct text, listing every package that ships it.
  const groups = new Map();
  const withoutText = [];
  for (const pkg of packages) {
    if (pkg.texts.length === 0) {
      withoutText.push(pkg);
      continue;
    }
    const text = pkg.texts.join('\n\n');
    const key = `${pkg.licence}\n${text}`;
    if (!groups.has(key)) groups.set(key, { licence: pkg.licence, text, users: [] });
    groups.get(key).users.push(`${pkg.name} ${pkg.version}`);
  }

  const counts = new Map();
  for (const pkg of packages) counts.set(pkg.licence, (counts.get(pkg.licence) ?? 0) + 1);

  const lines = [
    'The web UI bundles packages from npm. The list below is pnpm\'s production dependency tree',
    '(`pnpm licenses list --prod`), so it also names a few packages that only supply TypeScript',
    'types and do not end up in the bundle.',
    '',
    '| Licence | Packages |',
    '| --- | ---: |',
    ...[...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([l, n]) => `| ${l} | ${n} |`),
    '',
  ];
  const sorted = [...groups.values()].sort((a, b) => a.licence.localeCompare(b.licence) || a.users[0].localeCompare(b.users[0]));
  for (const group of sorted) {
    lines.push(`### ${group.licence}`, '', `Used by: ${group.users.join(', ')}`, '', '````text', group.text, '````', '');
  }
  if (withoutText.length > 0) {
    lines.push('### Packages that ship no licence text', '');
    lines.push('These packages declare a licence in package.json but include no licence file.', '');
    for (const pkg of withoutText) {
      const by = pkg.author ? `, by ${pkg.author}` : '';
      const home = pkg.homepage ? `, ${pkg.homepage}` : '';
      lines.push(`- ${pkg.name} ${pkg.version}: ${pkg.licence}${by}${home}`);
    }
    lines.push('');
  }
  return { markdown: lines.join('\n'), packages: packages.length, texts: groups.size };
}

function rustSection(file) {
  if (!file) {
    return [
      'Not included in this copy. Run `cargo about generate --locked --fail --output-file',
      'target/notices-rust.md about.hbs` (cargo-about 0.9) and pass the file with `--rust`. The',
      'release workflow does this for every published build.',
      '',
    ].join('\n');
  }
  if (!existsSync(file)) fail(`--rust file not found: ${file}`);
  return [
    'The desktop app and the server are compiled from the Rust crates below. The list covers the',
    'whole workspace for Windows and Linux, so the server image contains only part of it.',
    '',
    normalise(readFileSync(file, 'utf8')),
    '',
  ].join('\n');
}

const opts = parseArgs(process.argv.slice(2));
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const npm = npmSection();

const doc = [
  '# Third-party notices',
  '',
  `Tsrust IPTV ${version} contains software written by others. This file lists that software`,
  'with the licence texts and notices its licences ask to be passed on. It is generated by',
  '`tools/third-party-notices.mjs`; do not edit it by hand.',
  '',
  '- [IPTVnator](#iptvnator)',
  '- [JavaScript packages](#javascript-packages)',
  '- [Rust crates](#rust-crates)',
  '- [Programs outside this list](#programs-outside-this-list)',
  '',
  '## IPTVnator',
  '',
  'Tsrust IPTV was rebuilt from IPTVnator (https://github.com/4gray/iptvnator), which is',
  'distributed under the MIT licence:',
  '',
  '````text',
  IPTVNATOR_LICENSE,
  '````',
  '',
  '## JavaScript packages',
  '',
  npm.markdown,
  '## Rust crates',
  '',
  rustSection(opts.rust),
  '## Programs outside this list',
  '',
  '- mpv is not linked into Tsrust IPTV; the app starts it as a separate program. The installer',
  '  built with `pnpm tauri:build:mpv` ships an mpv build under GPL-2.0-or-later, with its licence,',
  '  source links and written offer in `vendor/mpv/LICENSE.txt` beside `mpv.exe`. The standard',
  '  installer contains no mpv.',
  '- The server image is based on Debian and installs Debian packages, mpv among them, for',
  '  recording. Their licences are in `/usr/share/doc/<package>/copyright` inside the image.',
  '- The Microsoft Edge WebView2 runtime that draws the desktop window is part of Windows and is not',
  '  shipped with the app.',
  '',
].join('\n');

writeFileSync(opts.out, doc, 'utf8');
const shown = relative(process.cwd(), opts.out);
console.error(
  `third-party-notices: wrote ${shown.startsWith('..') ? opts.out : shown} ` +
    `(${npm.packages} npm packages in ${npm.texts} licence texts, Rust section ${opts.rust ? 'included' : 'missing'})`,
);
