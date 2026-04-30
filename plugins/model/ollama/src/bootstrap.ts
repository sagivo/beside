/**
 * First-run bootstrap helpers for the Ollama model adapter.
 *
 * Responsible for:
 *   1. Detecting whether the `ollama` binary is installed.
 *   2. Auto-installing it on macOS / Linux via the official one-liner.
 *   3. Starting the local daemon when it isn't already serving.
 *   4. Polling until the HTTP API is reachable.
 *
 * All routines emit structured progress events through the supplied
 * handler so the CLI can render a progress bar instead of a wall of logs.
 */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import type { ModelBootstrapHandler } from '@cofounderos/interfaces';

const OLLAMA_INSTALL_SCRIPT_URL = 'https://ollama.com/install.sh';
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

/**
 * Install Ollama by piping the official install script through `sh`.
 * Inherits the user's TTY so any sudo prompt surfaces directly. The
 * subprocess's stdout/stderr is mirrored to onProgress as `install_log`
 * events.
 *
 * Returns when the script exits 0; rejects otherwise.
 */
export async function installOllamaUnixLike(
  onProgress: ModelBootstrapHandler,
): Promise<void> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new Error(
      `installOllamaUnixLike called on ${process.platform}. ` +
        `Use installOllamaWindows for win32 hosts.`,
    );
  }

  // Equivalent to `curl -fsSL https://ollama.com/install.sh | sh`.
  // We use `bash -c` with a here-string so we can stream output.
  const script = `set -e; curl -fsSL ${OLLAMA_INSTALL_SCRIPT_URL} | sh`;
  return await new Promise<void>((resolve, reject) => {
    const child = spawn('bash', ['-c', script], {
      // Inherit stdin so sudo can prompt; pipe stdout/stderr so we can
      // surface progress lines to the host.
      stdio: ['inherit', 'pipe', 'pipe'],
    });

    // The installer mixes plain \n-terminated lines with \r-overwritten
    // progress lines (curl's download bar). We treat \r as an in-place
    // update marker so the renderer can rewrite a single bar line instead
    // of spamming the terminal with every percentage tick.
    let buf = '';
    const flushSegment = (segment: string, progress: boolean): void => {
      const trimmed = segment.replace(/\s+$/u, '');
      if (trimmed.length === 0) return;
      onProgress({ kind: 'install_log', line: trimmed, progress });
    };
    const stream = (chunk: Buffer | string): void => {
      buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      // Walk the buffer, emitting on each \r or \n boundary so we don't
      // hold a 2MB curl bar line forever.
      let start = 0;
      for (let i = 0; i < buf.length; i++) {
        const ch = buf[i];
        if (ch === '\n') {
          flushSegment(buf.slice(start, i), false);
          start = i + 1;
        } else if (ch === '\r') {
          // \r without a following \n is curl rewriting the same line.
          if (buf[i + 1] === '\n') continue;
          flushSegment(buf.slice(start, i), true);
          start = i + 1;
        }
      }
      buf = buf.slice(start);
    };
    child.stdout?.on('data', stream);
    child.stderr?.on('data', stream);
    const flushTail = (): void => {
      if (buf.length > 0) {
        flushSegment(buf, false);
        buf = '';
      }
    };
    child.stdout?.on('end', flushTail);
    child.stderr?.on('end', flushTail);

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
        `Use installOllamaUnixLike on darwin/linux.`,
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

    let buf = '';
    const flush = (segment: string, progress: boolean): void => {
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
          flush(buf.slice(start, i), false);
          start = i + 1;
        } else if (ch === '\r') {
          if (buf[i + 1] === '\n') continue;
          flush(buf.slice(start, i), true);
          start = i + 1;
        }
      }
      buf = buf.slice(start);
    };
    child.stdout?.on('data', stream);
    child.stderr?.on('data', stream);
    const flushTail = (): void => {
      if (buf.length > 0) {
        flush(buf, false);
        buf = '';
      }
    };
    child.stdout?.on('end', flushTail);
    child.stderr?.on('end', flushTail);

    child.on('error', (err) => reject(err));
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`winget install exited with code ${code}`));
    });
  });
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
      const child = spawn('ollama', ['serve'], {
        detached: true,
        stdio: 'ignore',
        // On Windows `ollama` is `ollama.exe`, but other potential
        // wrappers may be `.cmd`. shell:true keeps PATHEXT resolution
        // identical to the user's shell. Harmless on POSIX.
        shell: process.platform === 'win32',
        // Critical on Windows: without windowsHide, a detached `ollama
        // serve` would leave a permanent console window on the user's
        // desktop until the daemon exits.
        windowsHide: true,
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
  return `If auto-install fails, install manually from ${OLLAMA_DOWNLOAD_PAGE}.`;
}
