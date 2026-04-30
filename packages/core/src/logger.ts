import type { Logger } from '@cofounderos/interfaces';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const COLOURS: Record<LogLevel, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};
const RESET = '\x1b[0m';

export interface LoggerOptions {
  level?: LogLevel;
  scope?: string;
  /** Disable ANSI colours (e.g. for logfiles). */
  plain?: boolean;
}

/**
 * Decide whether ANSI colour codes should be emitted, honouring the
 * `NO_COLOR` / `FORCE_COLOR` conventions. Order of precedence:
 *   1. Explicit `opts.plain` always wins.
 *   2. `NO_COLOR` (any non-empty value) → strip colour, regardless of TTY.
 *   3. `FORCE_COLOR` (any non-empty value) → keep colour, regardless of TTY.
 *      Useful for CI logs that get rendered with ANSI support.
 *   4. Fall back to TTY detection (the historical default).
 */
function resolvePlain(explicit: boolean | undefined): boolean {
  if (typeof explicit === 'boolean') return explicit;
  const env = process.env;
  if (env.NO_COLOR && env.NO_COLOR.length > 0) return true;
  if (env.FORCE_COLOR && env.FORCE_COLOR.length > 0) return false;
  return !process.stdout.isTTY;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const level: LogLevel = opts.level ?? 'info';
  const scope = opts.scope ?? 'cofounderos';
  const plain = resolvePlain(opts.plain);

  const emit = (lvl: LogLevel, msg: string, rest: unknown[]): void => {
    if (LEVEL_RANK[lvl] < LEVEL_RANK[level]) return;
    const ts = new Date().toISOString();
    const colour = plain ? '' : COLOURS[lvl];
    const reset = plain ? '' : RESET;
    const prefix = `${colour}[${ts}] ${lvl.toUpperCase().padEnd(5)} ${scope}${reset}`;
    if (rest.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`${prefix} | ${msg}`, ...rest);
    } else {
      // eslint-disable-next-line no-console
      console.log(`${prefix} | ${msg}`);
    }
  };

  return {
    debug: (msg, ...rest) => emit('debug', msg, rest),
    info: (msg, ...rest) => emit('info', msg, rest),
    warn: (msg, ...rest) => emit('warn', msg, rest),
    error: (msg, ...rest) => emit('error', msg, rest),
    child: (child) => createLogger({ ...opts, scope: `${scope}:${child}` }),
  };
}
