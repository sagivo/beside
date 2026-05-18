#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repoRoot, 'packages', 'cli', 'dist', 'cli.js');
const args = process.argv.slice(2);

function sqliteOpensInCurrentRuntime() {
  try {
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    db.prepare('SELECT 1 AS ok').get();
    db.close();
    return true;
  } catch {
    return false;
  }
}

function resolveElectronExecutable() {
  const candidates = [
    createRequire(path.join(repoRoot, 'packages', 'desktop', 'package.json')),
    require,
  ];
  for (const scopedRequire of candidates) {
    try {
      return scopedRequire('electron');
    } catch {
      // Try the next resolution root.
    }
  }
  const pnpmBin = path.join(repoRoot, 'node_modules', '.pnpm', 'node_modules', '.bin', 'electron');
  try {
    require('node:fs').accessSync(pnpmBin);
    return pnpmBin;
  } catch {
    return null;
  }
}

function run(command, commandArgs, env = process.env) {
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  });
  if (result.signal) {
    process.kill(process.pid, result.signal);
    return;
  }
  process.exit(result.status ?? 1);
}

const forcedRuntime = process.env.BESIDE_CLI_RUNTIME;

if (forcedRuntime === 'node' || sqliteOpensInCurrentRuntime()) {
  run(process.execPath, [cliPath, ...args]);
}

const electronExecutable = resolveElectronExecutable();
if (forcedRuntime !== 'node' && electronExecutable) {
  console.warn(
    `[beside-cli] using Electron Node for native SQLite compatibility ` +
      `(node ABI ${process.versions.modules} could not open better-sqlite3)`,
  );
  run(electronExecutable, [cliPath, ...args], {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
  });
}

console.error(
  'beside cli could not open better-sqlite3 with the current Node runtime, ' +
    'and Electron was not available as a fallback.',
);
console.error(
  `Node ${process.version} ABI ${process.versions.modules}. ` +
    'Try `pnpm rebuild better-sqlite3` for this Node runtime, or install Electron dependencies.',
);
process.exit(1);
