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

// The upstream source repository does not track its generated dist bundle. Build once so the
// package patch's bundle hunk has the exact upstream file it was generated against.
const applied = spawnSync('git', ['apply', '--reverse', '--check', patch], { cwd: checkout, stdio: 'ignore' }).status === 0;
if (!applied) {
  run('npm', ['run', 'build']);
  run('git', ['apply', '--check', patch]);
  run('git', ['apply', patch]);
}

run('npm', ['run', 'build']);
console.log(`mpegts.js ${tag} is ready at ${checkout}`);
