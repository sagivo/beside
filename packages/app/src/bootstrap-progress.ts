import type { ModelBootstrapHandler, ModelBootstrapProgress } from '@cofounderos/interfaces';

/**
 * Build a stderr renderer for ModelBootstrapProgress events. Draws a
 * progress bar for downloads, streams installer log lines, and prints
 * one-line milestones for everything else.
 *
 * Returns a tuple of [handler, finalize]. Call `finalize()` after
 * bootstrap completes (success or failure) to clean up the cursor and
 * print a trailing newline if needed.
 */
export function createBootstrapRenderer(): {
  handler: ModelBootstrapHandler;
  finalize: () => void;
} {
  // Honour NO_COLOR / FORCE_COLOR alongside TTY detection. NO_COLOR
  // also implies "no in-place rewriting" — fall back to a line-per-tick
  // log so non-interactive sinks (CI, files, Windows classic console)
  // get a clean, ANSI-free transcript.
  const env = process.env;
  const tty = (() => {
    if (env.NO_COLOR && env.NO_COLOR.length > 0) return false;
    if (env.FORCE_COLOR && env.FORCE_COLOR.length > 0) return true;
    return !!process.stderr.isTTY;
  })();
  let lastWasBar = false;
  let lastWasInstallProgress = false;

  const w = (text: string): void => {
    process.stderr.write(text);
  };

  const clearLine = (): void => {
    if (tty) w('\r\x1b[2K');
  };

  const flushBarLine = (): void => {
    if (lastWasBar) {
      w('\n');
      lastWasBar = false;
    }
    if (lastWasInstallProgress) {
      w('\n');
      lastWasInstallProgress = false;
    }
  };

  const handler: ModelBootstrapHandler = (event: ModelBootstrapProgress) => {
    switch (event.kind) {
      case 'check':
        flushBarLine();
        w(`  · ${event.message}\n`);
        break;

      case 'install_started':
        flushBarLine();
        w('\n');
        w(`────────────────────────────────────────────\n`);
        w(`Installing ${event.tool} (one-time, first run)\n`);
        if (event.message) w(`${event.message}\n`);
        w(`────────────────────────────────────────────\n`);
        break;

      case 'install_log':
        // Pass installer output through verbatim so the user can see what
        // the official script is doing (and answer prompts). Progress
        // updates (e.g. curl's download bar) are rewritten in place on a
        // TTY so they don't flood the terminal.
        if (event.progress) {
          if (tty) {
            clearLine();
            w(`  ${event.line}`);
            lastWasInstallProgress = true;
          } else if (!lastWasInstallProgress) {
            // Non-TTY: emit progress lines once per burst so logs stay sane.
            w(`  ${event.line}\n`);
            lastWasInstallProgress = true;
          }
        } else {
          flushBarLine();
          w(`  ${event.line}\n`);
        }
        break;

      case 'install_done':
        flushBarLine();
        w(`  ✓ ${event.tool} installed\n`);
        break;

      case 'install_failed':
        flushBarLine();
        w(`  ✗ ${event.tool} install failed: ${event.reason}\n`);
        break;

      case 'server_starting':
        flushBarLine();
        w(`  · Starting Ollama daemon at ${event.host}…\n`);
        break;

      case 'server_ready':
        flushBarLine();
        w(`  ✓ Ollama daemon ready at ${event.host}\n`);
        break;

      case 'server_failed':
        flushBarLine();
        w(`  ✗ Ollama daemon failed at ${event.host}: ${event.reason}\n`);
        break;

      case 'pull_started':
        flushBarLine();
        w('\n');
        w(`Downloading model ${event.model}`);
        if (event.sizeHint) w(` (${event.sizeHint})`);
        w(' …\n');
        break;

      case 'pull_progress':
        if (tty) {
          const bar = renderBar(event);
          w(`\r${bar}`);
          lastWasBar = true;
        } else {
          // Non-TTY: emit a single status line per phase change instead of
          // spamming, so log files stay readable.
          if (event.total > 0 && event.completed === event.total) {
            w(`  · ${event.status}: 100%\n`);
          }
        }
        break;

      case 'pull_done':
        flushBarLine();
        w(`  ✓ ${event.model} downloaded\n`);
        break;

      case 'pull_failed':
        flushBarLine();
        w(`  ✗ ${event.model} download failed: ${event.reason}\n`);
        break;

      case 'ready':
        flushBarLine();
        w(`  ✓ ${event.model} ready\n`);
        break;
    }
  };

  return {
    handler,
    finalize: () => flushBarLine(),
  };
}

function renderBar(event: { status: string; completed: number; total: number }): string {
  const status = event.status.padEnd(18).slice(0, 18);
  if (event.total <= 0) {
    return `  ${status}`;
  }
  const pct = Math.min(100, Math.max(0, Math.round((event.completed / event.total) * 100)));
  const width = 30;
  const filled = Math.round((pct / 100) * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  return `  ${status} [${bar}] ${pct.toString().padStart(3)}% (${formatBytes(event.completed)} / ${formatBytes(event.total)})`;
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)}${units[i]}`;
}
