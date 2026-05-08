/**
 * First-run bootstrap helpers for the Ollama model adapter.
 *
 * Responsible for:
 *   1. Detecting whether the `ollama` binary is installed.
 *   2. Auto-installing it on macOS / Linux / Windows.
 *   3. Starting the local daemon when it isn't already serving.
 *   4. Polling until the HTTP API is reachable.
 *
 * All routines emit structured progress events through the supplied
 * handler so the CLI can render a progress bar instead of a wall of logs.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ModelBootstrapHandler } from '@cofounderos/interfaces';

const OLLAMA_INSTALL_SCRIPT_URL = 'https://ollama.com/install.sh';
const OLLAMA_MAC_ZIP_URL = 'https://ollama.com/download/Ollama-darwin.zip';
const OLLAMA_DOWNLOAD_PAGE = 'https://ollama.com/download';

export async function commandExists(cmd: string): Promise<boolean> {
  const tool = process.platform === 'win32' ? 'where' : 'which';
  return await new Promise<boolean>((resolve) => {
    // windowsHide suppresses the brief console window flash on Windows.
    // Harmless no-op on POSIX.
    const child = spawn(tool, [cmd], { stdio: 'ignore', windowsHide: true });
    child.on('exit', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

export async function isOllamaReachable(host: string, timeoutMs = 1500): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${host}/api/tags`, { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function waitForOllama(host: string, totalMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < totalMs) {
    if (await isOllamaReachable(host)) return true;
    await delay(750);
  }
  return false;
}

export async function ollamaCommandExists(): Promise<boolean> {
  const resolved = resolveOllamaCommand();
  if (resolved.command !== 'ollama') return true;
  return await commandExists('ollama');
}

function attachInstallOutput(
  child: ChildProcess,
  onProgress: ModelBootstrapHandler,
): void {
  // Installers mix plain \n-terminated lines with \r-overwritten progress
  // bars. Treat \r as an in-place update marker so renderers can rewrite a
  // single line instead of receiving every percentage tick as a log entry.
  let buf = '';
  const flushSegment = (segment: string, progress: boolean): void => {
    const trimmed = segment.replace(/\s+$/u, '');
    if (trimmed.length === 0) return;
    onProgress({ kind: 'install_log', line: trimmed, progress });
  };
  const stream = (chunk: Buffer | string): void => {
    buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let start = 0;
    for (let i = 0; i < buf.length; i++) {
      const ch = buf[i];
      if (ch === '\n') {
        flushSegment(buf.slice(start, i), false);
        start = i + 1;
      } else if (ch === '\r') {
        if (buf[i + 1] === '\n') continue;
        flushSegment(buf.slice(start, i), true);
        start = i + 1;
      }
    }
    buf = buf.slice(start);
  };
  const flushTail = (): void => {
    if (buf.length > 0) {
      flushSegment(buf, false);
      buf = '';
    }
  };

  child.stdout?.on('data', stream);
  child.stderr?.on('data', stream);
  child.stdout?.on('end', flushTail);
  child.stderr?.on('end', flushTail);
}

async function runInstallerCommand(
  command: string,
  args: string[],
  onProgress: ModelBootstrapHandler,
  options: { cwd?: string; shell?: boolean } = {},
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: options.shell,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    attachInstallOutput(child, onProgress);
    child.on('error', (err) => reject(err));
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

async function pathWritable(dir: string): Promise<boolean> {
  try {
    await fs.access(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function macApplicationsInstallDir(): Promise<string> {
  if (await pathWritable('/Applications')) return '/Applications';

  const userApplications = path.join(os.homedir(), 'Applications');
  await fs.mkdir(userApplications, { recursive: true });
  return userApplications;
}

function macOllamaCommandCandidates(): string[] {
  return [
    '/opt/homebrew/bin/ollama',
    '/usr/local/bin/ollama',
    path.join('/Applications', 'Ollama.app', 'Contents', 'Resources', 'ollama'),
    path.join(os.homedir(), 'Applications', 'Ollama.app', 'Contents', 'Resources', 'ollama'),
  ];
}

export async function installOllamaMacOS(
  onProgress: ModelBootstrapHandler,
): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error(
      `installOllamaMacOS called on ${process.platform}. ` +
        `Use installOllamaUnixLike on linux or installOllamaWindows on win32.`,
    );
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cofounderos-ollama-'));
  try {
    const zipPath = path.join(tmpDir, 'Ollama-darwin.zip');
    const extractDir = path.join(tmpDir, 'extract');
    await fs.mkdir(extractDir, { recursive: true });

    onProgress({ kind: 'install_log', line: 'Downloading Ollama for macOS…' });
    await runInstallerCommand(
      'curl',
      ['-fL', '--progress-bar', OLLAMA_MAC_ZIP_URL, '-o', zipPath],
      onProgress,
    );

    onProgress({ kind: 'install_log', line: 'Extracting Ollama.app…' });
    await runInstallerCommand('ditto', ['-x', '-k', zipPath, extractDir], onProgress);

    const sourceApp = path.join(extractDir, 'Ollama.app');
    if (!existsSync(sourceApp)) {
      throw new Error('download did not contain Ollama.app');
    }

    const applicationsDir = await macApplicationsInstallDir();
    const targetApp = path.join(applicationsDir, 'Ollama.app');
    onProgress({ kind: 'install_log', line: `Installing Ollama.app to ${targetApp}…` });
    await fs.rm(targetApp, { recursive: true, force: true });
    await fs.cp(sourceApp, targetApp, { recursive: true });

    const commandPath = path.join(targetApp, 'Contents', 'Resources', 'ollama');
    if (!existsSync(commandPath)) {
      throw new Error('installed Ollama.app did not contain the ollama command');
    }
    await fs.chmod(commandPath, 0o755).catch(() => {});
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Install Ollama on Linux by piping the official install script through
 * `sh`. The subprocess's stdout/stderr is mirrored to onProgress as
 * `install_log` events.
 *
 * Returns when the script exits 0; rejects otherwise.
 */
export async function installOllamaUnixLike(
  onProgress: ModelBootstrapHandler,
): Promise<void> {
  if (process.platform !== 'linux') {
    throw new Error(
      `installOllamaUnixLike called on ${process.platform}. ` +
        `Use installOllamaMacOS on darwin or installOllamaWindows on win32.`,
    );
  }

  // Equivalent to `curl -fsSL https://ollama.com/install.sh | sh`.
  // We use `bash -c` with a here-string so we can stream output.
  const script = `set -e; curl -fsSL ${OLLAMA_INSTALL_SCRIPT_URL} | sh`;
  return await new Promise<void>((resolve, reject) => {
    const child = spawn('bash', ['-c', script], {
      // Inherit stdin for CLI users so sudo can prompt; desktop callers
      // inherit the runtime-service pipe, which is still non-interactive.
      stdio: ['inherit', 'pipe', 'pipe'],
    });

    attachInstallOutput(child, onProgress);
    child.on('error', (err) => reject(err));
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`installer exited with code ${code}`));
    });
  });
}

/**
 * Install Ollama on Windows via winget. winget ships with Windows 10
 * 1809+ and Windows 11 by default, so the vast majority of users have
 * it. We invoke it via the Windows shell so the `winget.exe` /
 * `winget.cmd` resolution Just Works regardless of how it was put on
 * PATH.
 *
 * Note: this asks winget to also accept the source + package agreements
 * non-interactively. We still inherit stdio so any UAC prompt — which
 * winget displays in a separate dialog — surfaces to the user, and the
 * progress lines stream through to `install_log` events.
 *
 * Throws if winget isn't installed or the install fails. Callers should
 * surface `manualInstallHint()` so the user has a documented fallback.
 */
export async function installOllamaWindows(
  onProgress: ModelBootstrapHandler,
): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error(
      `installOllamaWindows called on ${process.platform}. ` +
        `Use installOllamaMacOS on darwin or installOllamaUnixLike on linux.`,
    );
  }

  if (!(await commandExists('winget'))) {
    throw new Error(
      `winget not found on PATH. Install Ollama manually from ${OLLAMA_DOWNLOAD_PAGE}.`,
    );
  }

  return await new Promise<void>((resolve, reject) => {
    const child = spawn(
      'winget',
      [
        'install',
        '--id',
        'Ollama.Ollama',
        '--silent',
        '--accept-source-agreements',
        '--accept-package-agreements',
      ],
      {
        // `shell: true` so Node resolves winget.cmd / winget.exe via
        // %PATHEXT% the way the user's interactive shell would. Without
        // it, spawning a `.cmd` shim throws ENOENT on stock Node for
        // Windows.
        shell: true,
        stdio: ['inherit', 'pipe', 'pipe'],
        // Hide the cmd.exe wrapper window. UAC + winget's own UI still
        // surface to the user; we just don't want an extra empty
        // console flashing for the duration of the install.
        windowsHide: true,
      },
    );

    attachInstallOutput(child, onProgress);
    child.on('error', (err) => reject(err));
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`winget install exited with code ${code}`));
    });
  });
}

function resolveOllamaCommand(): { command: string; shell: boolean } {
  if (process.platform === 'darwin') {
    const installed = macOllamaCommandCandidates().find((p) => existsSync(p));
    if (installed) {
      return { command: installed, shell: false };
    }
    return { command: 'ollama', shell: false };
  }

  if (process.platform !== 'win32') {
    return { command: 'ollama', shell: false };
  }

  // winget can update PATH for *future* shells while the current Node
  // process keeps its old environment. Try the common install locations
  // before falling back to PATHEXT / shell resolution.
  const candidates = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Ollama', 'ollama.exe'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Ollama', 'ollama.exe'),
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);

  const installed = candidates.find((p) => existsSync(p));
  if (installed) {
    return { command: installed, shell: false };
  }

  return { command: 'ollama', shell: true };
}

/**
 * Spawn `ollama serve` in the background, detached from this process. On
 * macOS the .app already auto-starts the daemon via launchd, on Windows
 * the installer registers a service, so this is mostly a Linux fallback
 * for when no system service exists.
 *
 * The child is unrefed so this process can exit cleanly without leaving
 * the daemon hanging — but the daemon itself keeps running because its
 * stdio is detached.
 */
export async function startOllamaDaemon(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    try {
      const resolved = resolveOllamaCommand();
      const child = spawn(resolved.command, ['serve'], {
        detached: true,
        stdio: 'ignore',
        // On Windows `ollama` is `ollama.exe`, but other potential
        // wrappers may be `.cmd`. shell:true keeps PATHEXT resolution
        // identical to the user's shell. Harmless on POSIX.
        shell: resolved.shell,
        // Critical on Windows: without windowsHide, a detached `ollama
        // serve` would leave a permanent console window on the user's
        // desktop until the daemon exits.
        windowsHide: true,
        // Bump parallelism + memory tuning on the spawned daemon. Only
        // applies when *we* start the daemon (not when the user already
        // has `ollama serve` running). The indexer fans out 4 entity
        // renders per batch (KarpathyStrategy.renderConcurrency), so
        // NUM_PARALLEL=4 keeps all four slots busy. FLASH_ATTENTION
        // halves the KV-cache memory cost on Apple Silicon and is a
        // pure speedup; KV_CACHE_TYPE=q8_0 trims another ~2x of KV
        // memory at near-imperceptible quality cost. Users who want
        // different tradeoffs can override via launchd/systemd or by
        // pre-starting `ollama serve` with their own env.
        env: {
          ...process.env,
          OLLAMA_NUM_PARALLEL: process.env.OLLAMA_NUM_PARALLEL ?? '4',
          OLLAMA_FLASH_ATTENTION:
            process.env.OLLAMA_FLASH_ATTENTION ?? '1',
          OLLAMA_KV_CACHE_TYPE:
            process.env.OLLAMA_KV_CACHE_TYPE ?? 'q8_0',
        },
      });
      child.on('error', (err) => reject(err));
      child.unref();
      resolve();
    } catch (err) {
      reject(err);
    }
  });
}

/** Friendly hint about how to install when auto-install isn't available. */
export function manualInstallHint(): string {
  if (process.platform === 'win32') {
    return (
      `Install Ollama for Windows from ${OLLAMA_DOWNLOAD_PAGE} ` +
      `(or run: winget install --id Ollama.Ollama) and then re-run.`
    );
  }
  if (process.platform === 'darwin') {
    return (
      `Install Ollama for macOS from ${OLLAMA_DOWNLOAD_PAGE} ` +
      `and then re-run.`
    );
  }
  return `If auto-install fails, install manually from ${OLLAMA_DOWNLOAD_PAGE}.`;
}
