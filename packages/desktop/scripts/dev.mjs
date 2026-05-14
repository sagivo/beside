#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, '..');
const repoRoot = path.resolve(desktopRoot, '../..');
const isWindows = process.platform === 'win32';
const pnpmBin = isWindows ? 'pnpm.cmd' : 'pnpm';
const electronBin = path.join(desktopRoot, 'node_modules', '.bin', isWindows ? 'electron.cmd' : 'electron');
const rendererHost = process.env.BESIDE_RENDERER_HOST ?? '127.0.0.1';
const rendererPort = process.env.BESIDE_RENDERER_PORT ?? '5173';
const rendererUrl =
  process.env.BESIDE_RENDERER_URL ?? `http://${rendererHost}:${rendererPort}`;

const children = new Set();
let electron = null;
let stopping = false;
let restartingElectron = false;
let restartTimer = null;
let watchers = [];

function log(message) {
  console.log(`[desktop-dev] ${message}`);
}

function spawnChild(label, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...options.env },
    stdio: options.stdio ?? 'inherit',
    shell: isWindows,
  });

  children.add(child);
  child.on('exit', (code, signal) => {
    children.delete(child);
    if (label === 'electron') {
      electron = null;
      if (!stopping && !restartingElectron) {
        log(`Electron exited (code=${code}, signal=${signal}); stopping dev watchers.`);
        void shutdown(code ?? 0);
      }
    } else if (!stopping && code !== 0) {
      log(`${label} exited (code=${code}, signal=${signal})`);
    }
  });
  child.on('error', (err) => {
    children.delete(child);
    log(`${label} failed to start: ${err.message}`);
    if (!stopping) void shutdown(1);
  });
  return child;
}

function run(label, command, args, options = {}) {
  log(label);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: { ...process.env, ...options.env },
      stdio: options.stdio ?? 'inherit',
      shell: isWindows,
    });
    children.add(child);
    child.on('exit', (code) => {
      children.delete(child);
      if (code === 0) resolve();
      else reject(new Error(`${label} failed with exit code ${code}`));
    });
    child.on('error', (err) => {
      children.delete(child);
      reject(err);
    });
  });
}

function stopChild(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 5000);
    child.once('exit', () => {
      clearTimeout(killTimer);
      resolve();
    });
    child.kill(signal);
  });
}

async function shutdown(code) {
  if (stopping) return;
  stopping = true;
  if (restartTimer) clearTimeout(restartTimer);
  await Promise.all([...children].map((child) => stopChild(child)));
  process.exit(code);
}

async function waitForRenderer() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !stopping) {
    try {
      const response = await fetch(rendererUrl);
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for Vite at ${rendererUrl}`);
}

function startElectron() {
  log(`starting Electron with renderer ${rendererUrl}`);
  electron = spawnChild('electron', electronBin, ['dist/main.js'], {
    cwd: desktopRoot,
    env: {
      BESIDE_DEV: '1',
      BESIDE_RENDERER_URL: rendererUrl,
    },
  });
}

async function restartElectronNow(reason) {
  if (stopping) return;
  restartingElectron = true;
  log(`restarting Electron after ${reason}`);
  await stopChild(electron);
  restartingElectron = false;
  if (!stopping) startElectron();
}

function scheduleElectronRestart(reason) {
  if (!electron && !restartingElectron) return;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    void restartElectronNow(reason);
  }, 400);
}

function createDebouncedTask(label, task, delayMs = 500) {
  let timer = null;
  let running = false;
  let rerun = false;

  const execute = async () => {
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    try {
      await task();
    } catch (err) {
      log(`${label} failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      running = false;
      if (rerun && !stopping) {
        rerun = false;
        schedule();
      }
    }
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void execute();
    }, delayMs);
  };

  return schedule;
}

function shouldIgnorePath(relPath) {
  return (
    !relPath ||
    path.basename(relPath) === '.tsconfig.build.json' ||
    relPath.includes(`${path.sep}dist${path.sep}`) ||
    relPath.startsWith(`dist${path.sep}`) ||
    relPath.includes(`${path.sep}node_modules${path.sep}`) ||
    relPath.startsWith(`node_modules${path.sep}`) ||
    relPath.includes(`${path.sep}.git${path.sep}`) ||
    relPath.startsWith(`.git${path.sep}`) ||
    relPath.endsWith('.tsbuildinfo')
  );
}

function watchRecursive(label, dir, onChange) {
  if (!fs.existsSync(dir)) return [];
  try {
    const watcher = fs.watch(dir, { recursive: true }, (_event, filename) => {
      const relPath = filename ? path.normalize(String(filename)) : '';
      if (!shouldIgnorePath(relPath)) onChange(relPath);
    });
    log(`watching ${label}`);
    return [watcher];
  } catch (err) {
    log(`recursive watch unavailable for ${label}; falling back to directory walk`);
    return watchTree(label, dir, onChange);
  }
}

function watchTree(label, rootDir, onChange) {
  const watchers = [];
  const visit = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const watcher = fs.watch(dir, (_event, filename) => {
      const absPath = filename ? path.join(dir, String(filename)) : dir;
      const relPath = path.relative(rootDir, absPath);
      if (!shouldIgnorePath(relPath)) onChange(path.normalize(relPath));
    });
    watchers.push(watcher);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const relPath = path.relative(rootDir, path.join(dir, entry.name));
      if (!shouldIgnorePath(relPath)) visit(path.join(dir, entry.name));
    }
  };
  visit(rootDir);
  log(`watching ${label}`);
  return watchers;
}

function closeWatchers(watchers) {
  for (const watcher of watchers) watcher.close();
}

async function copyPreload() {
  await run('copying preload bridge', 'node', ['scripts/copy-preload.mjs'], {
    cwd: desktopRoot,
  });
  scheduleElectronRestart('preload bridge update');
}

async function buildDesktopNative() {
  if (isWindows) return;
  await run('building desktop native helper', 'bash', ['scripts/build-native.sh'], {
    cwd: desktopRoot,
  });
  scheduleElectronRestart('desktop native helper update');
}

async function buildPlugins() {
  await run('building plugins and native helpers', pnpmBin, ['build:plugins'], {
    cwd: repoRoot,
  });
  scheduleElectronRestart('plugin rebuild');
}

async function initialBuild() {
  await run('building runtime packages', pnpmBin, ['--filter', '@beside/runtime', 'run', 'build']);
  await run('building desktop main process', pnpmBin, ['exec', 'tsc', '-p', 'tsconfig.json'], {
    cwd: desktopRoot,
  });
  await copyPreload();
  await buildDesktopNative();
  await buildPlugins();
}

process.on('SIGINT', () => void shutdown(130));
process.on('SIGTERM', () => void shutdown(143));
process.on('exit', () => closeWatchers(watchers));

async function main() {
  await initialBuild();

  spawnChild('renderer vite', pnpmBin, [
    'exec',
    'vite',
    '--host',
    rendererHost,
    '--port',
    rendererPort,
    '--strictPort',
  ], {
    cwd: desktopRoot,
  });

  spawnChild('interfaces watcher', pnpmBin, ['--filter', '@beside/interfaces', 'run', 'dev']);
  spawnChild('core watcher', pnpmBin, ['--filter', '@beside/core', 'run', 'dev']);
  spawnChild('runtime watcher', pnpmBin, ['--filter', '@beside/runtime', 'run', 'dev']);
  spawnChild('desktop main watcher', pnpmBin, ['exec', 'tsc', '-p', 'tsconfig.json', '--watch', '--preserveWatchOutput'], {
    cwd: desktopRoot,
  });

  const schedulePreloadCopy = createDebouncedTask('preload copy', copyPreload);
  const scheduleDesktopNativeBuild = createDebouncedTask('desktop native build', buildDesktopNative);
  const schedulePluginBuild = createDebouncedTask('plugin build', buildPlugins, 800);
  watchers = [
    ...watchRecursive('desktop preload', path.join(desktopRoot, 'src'), (relPath) => {
      if (relPath === 'preload.ts') schedulePreloadCopy();
    }),
    ...watchRecursive('desktop native helper', path.join(desktopRoot, 'native'), () => {
      scheduleDesktopNativeBuild();
    }),
    ...watchRecursive('plugins', path.join(repoRoot, 'plugins'), (relPath) => {
      if (
        relPath.endsWith('.ts') ||
        relPath.endsWith('.json') ||
        relPath.endsWith('.swift') ||
        relPath.includes(`${path.sep}scripts${path.sep}`)
      ) {
        schedulePluginBuild();
      }
    }),
    ...watchRecursive('compiled Electron inputs', path.join(desktopRoot, 'dist'), (relPath) => {
      if (!relPath.startsWith(`renderer${path.sep}`)) scheduleElectronRestart('desktop compile');
    }),
    ...watchRecursive('compiled runtime', path.join(repoRoot, 'packages', 'runtime', 'dist'), () => {
      scheduleElectronRestart('runtime compile');
    }),
    ...watchRecursive('compiled core', path.join(repoRoot, 'packages', 'core', 'dist'), () => {
      scheduleElectronRestart('core compile');
    }),
    ...watchRecursive('compiled interfaces', path.join(repoRoot, 'packages', 'interfaces', 'dist'), () => {
      scheduleElectronRestart('interfaces compile');
    }),
  ];

  await waitForRenderer();
  startElectron();
}

main().catch((err) => {
  log(err instanceof Error ? err.message : String(err));
  void shutdown(1);
});
