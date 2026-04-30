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

export function createLogger(opts: LoggerOptions = {}): Logger {
  const level: LogLevel = opts.level ?? 'info';
  const scope = opts.scope ?? 'cofounderos';
  const plain = opts.plain ?? !process.stdout.isTTY;

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
