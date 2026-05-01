#!/usr/bin/env node
import readline from 'node:readline';
import type { Logger } from '@cofounderos/interfaces';
import { createRuntime } from '@cofounderos/runtime';

type Request = {
  id: number;
  method: string;
  params?: unknown;
};

type Response =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

function send(response: Response): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

const logger: Logger = {
  debug: (msg, ...rest) => emitLog('debug', msg, rest),
  info: (msg, ...rest) => emitLog('info', msg, rest),
  warn: (msg, ...rest) => emitLog('warn', msg, rest),
  error: (msg, ...rest) => emitLog('error', msg, rest),
  child: (scope) => childLogger(scope),
};

function childLogger(scope: string): Logger {
  return {
    debug: (msg, ...rest) => emitLog('debug', `${scope}: ${msg}`, rest),
    info: (msg, ...rest) => emitLog('info', `${scope}: ${msg}`, rest),
    warn: (msg, ...rest) => emitLog('warn', `${scope}: ${msg}`, rest),
    error: (msg, ...rest) => emitLog('error', `${scope}: ${msg}`, rest),
    child: (child) => childLogger(`${scope}:${child}`),
  };
}

function emitLog(level: string, msg: string, rest: unknown[]): void {
  const suffix = rest.length > 0 ? ` ${JSON.stringify(rest)}` : '';
  process.stderr.write(`[${new Date().toISOString()}] ${level.toUpperCase()} ${msg}${suffix}\n`);
}

const runtime = createRuntime({
  logger,
  workspaceRoot: process.env.COFOUNDEROS_RESOURCE_ROOT,
});

async function handle(req: Request): Promise<unknown> {
  switch (req.method) {
    case 'start':
      await runtime.start({ bootstrap: false });
      return await runtime.getOverview();
    case 'bootstrapModel':
      await runtime.bootstrapModel((event) => {
        process.stdout.write(`${JSON.stringify({ id: req.id, event: 'bootstrap-progress', payload: event })}\n`);
      });
      return { ready: true };
    case 'stop':
      await runtime.stop();
      return { stopped: true };
    case 'pauseCapture':
      return await runtime.pauseCapture();
    case 'resumeCapture':
      return await runtime.resumeCapture();
    case 'triggerIndex':
      await runtime.triggerIndex();
      return await runtime.getOverview();
    case 'triggerReorganise':
      await runtime.triggerReorganise();
      return await runtime.getOverview();
    case 'overview':
      return await runtime.getOverview();
    case 'doctor':
      return await runtime.runDoctor();
    case 'readConfig':
      return await runtime.readConfig();
    case 'validateConfig':
      return runtime.validateConfig(req.params);
    case 'saveConfigPatch':
      return await runtime.saveConfigPatch(req.params as Record<string, unknown>);
    case 'listJournalDays':
      return await runtime.listJournalDays();
    case 'getJournalDay':
      return await runtime.getJournalDay(String(req.params));
    case 'searchFrames':
      return await runtime.searchFrames(req.params as never);
    case 'readAsset': {
      const buf = await runtime.readAsset(String(req.params));
      return { base64: buf.toString('base64') };
    }
    default:
      throw new Error(`Unknown runtime method: ${req.method}`);
  }
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on('line', (line) => {
  void (async () => {
    let req: Request;
    try {
      req = JSON.parse(line) as Request;
    } catch (err) {
      process.stderr.write(`Invalid request: ${String(err)}\n`);
      return;
    }
    try {
      send({ id: req.id, ok: true, result: await handle(req) });
    } catch (err) {
      send({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  })();
});

process.on('SIGTERM', () => {
  void runtime.stop().finally(() => process.exit(0));
});

process.on('SIGINT', () => {
  void runtime.stop().finally(() => process.exit(0));
});
