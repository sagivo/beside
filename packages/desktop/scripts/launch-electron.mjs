#!/usr/bin/env node
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const desktopRoot = path.resolve(import.meta.dirname, '..');
const appName = 'Beside';
const macBundleIdentifier = 'so.beside.desktop.dev';

function execFileAsync(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

function findMacAppBundle(executablePath) {
  const marker = '.app/Contents/MacOS/';
  const markerIndex = executablePath.indexOf(marker);
  if (markerIndex === -1) return null;
  return executablePath.slice(0, markerIndex + '.app'.length);
}

async function setPlistString(plistPath, key, value) {
  try {
    await execFileAsync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plistPath]);
  } catch {
    await execFileAsync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} string ${value}`, plistPath]);
  }
}

async function prepareMacDevApp(electronExecutable) {
  const sourceApp = findMacAppBundle(electronExecutable);
  if (!sourceApp) return electronExecutable;

  const electronVersion = require('electron/package.json').version;
  const targetRoot = path.join(desktopRoot, 'build', 'dev-app');
  const targetApp = path.join(targetRoot, `${appName}.app`);
  const markerPath = path.join(targetRoot, '.electron-source.json');
  const targetExecutable = path.join(targetApp, 'Contents', 'MacOS', path.basename(electronExecutable));
  const expectedMarker = {
    electronVersion,
    sourceApp,
    appName,
    bundleIdentifier: macBundleIdentifier,
    copyMode: 'verbatim-symlinks-v1',
  };

  try {
    const existingMarker = JSON.parse(await fs.readFile(markerPath, 'utf8'));
    await fs.access(targetExecutable);
    if (JSON.stringify(existingMarker) === JSON.stringify(expectedMarker)) return targetExecutable;
  } catch {
    // Rebuild the wrapper below.
  }

  await fs.rm(targetApp, { recursive: true, force: true });
  await fs.mkdir(targetRoot, { recursive: true });
  await fs.cp(sourceApp, targetApp, { recursive: true, verbatimSymlinks: true });

  const plistPath = path.join(targetApp, 'Contents', 'Info.plist');
  await setPlistString(plistPath, 'CFBundleName', appName);
  await setPlistString(plistPath, 'CFBundleDisplayName', appName);
  await setPlistString(plistPath, 'CFBundleIdentifier', macBundleIdentifier);

  await fs.writeFile(markerPath, `${JSON.stringify(expectedMarker, null, 2)}\n`, 'utf8');
  return targetExecutable;
}

async function resolveElectronExecutable() {
  const electronExecutable = require('electron');
  if (process.platform !== 'darwin') return electronExecutable;
  return prepareMacDevApp(electronExecutable);
}

async function main() {
  const electronExecutable = await resolveElectronExecutable();
  const child = spawn(electronExecutable, process.argv.slice(2), {
    cwd: desktopRoot,
    env: {
      ...process.env,
      BESIDE_DEV_APP_NAME: appName,
    },
    stdio: 'inherit',
  });

  const forwardSignal = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  process.on('SIGINT', forwardSignal);
  process.on('SIGTERM', forwardSignal);

  child.on('error', (error) => {
    console.error(`[desktop-launch] failed to start Electron: ${error.message}`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
}

main().catch((error) => {
  console.error(`[desktop-launch] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
