#!/usr/bin/env node

import { existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const checkout = join(root, 'vendor', 'mpegts.js');
const patch = join(root, 'patches', 'mpegts.js@1.8.2.patch');
const tag = 'v1.8.2';

function run(command, args) {
  const result = spawnSync(command, args, { cwd: checkout, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (!existsSync(join(checkout, '.git'))) {
  mkdirSync(join(root, 'vendor'), { recursive: true });
  const result = spawnSync('git', ['clone', '--depth', '1', '--branch', tag, 'https://github.com/xqq/mpegts.js.git', checkout], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run('npm', ['install', '--ignore-scripts']);

// The patch's dist bundle hunk targets the published npm package, which differs from a fresh
// build of the upstream tag. Apply the source and type changes here, then generate the bundle.
const sourcePatch = ['--exclude=dist/mpegts.js', patch];
const applied = spawnSync('git', ['apply', '--reverse', '--check', ...sourcePatch], { cwd: checkout, stdio: 'ignore' }).status === 0;
if (!applied) {
  run('npm', ['run', 'build']);
  run('git', ['apply', '--check', ...sourcePatch]);
  run('git', ['apply', ...sourcePatch]);
}

run('npm', ['run', 'build']);
console.log(`mpegts.js ${tag} is ready at ${checkout}`);
