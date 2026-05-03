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

function sendEvent(event: string, payload: unknown): void {
  // `id: 0` because heartbeat events aren't tied to a specific request.
  // The client (main.ts) ignores `id` for events anyway.
  process.stdout.write(`${JSON.stringify({ id: 0, event, payload })}\n`);
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

// ---------------------------------------------------------------------
// Push-based overview broadcasting.
//
// The renderer used to poll `getOverview()` on a setInterval. That meant
// every UI surface paid a polling cost and lag was capped by the
// interval (2-5s). Now the runtime-service is the single source of truth
// and pushes overview snapshots:
//
//   - on a 2s heartbeat while running
//   - immediately after any state-mutating call (start/stop/pause/
//     resume/triggerIndex/triggerReorganise/saveConfigPatch)
//
// `pushOverview` is fire-and-forget; if `getOverview` rejects we just
// skip that tick rather than crashing the service.
// ---------------------------------------------------------------------

let heartbeat: ReturnType<typeof setInterval> | null = null;

async function pushOverview(): Promise<void> {
  try {
    const overview = await runtime.getOverview();
    sendEvent('overview', overview);
  } catch {
    // Runtime is mid-restart or not yet started; let the next mutation
    // or heartbeat retry. Errors here are very noisy in the desktop log.
  }
}

function startHeartbeat(): void {
  if (heartbeat) return;
  heartbeat = setInterval(() => {
    void pushOverview();
  }, 2000);
}

function stopHeartbeat(): void {
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
}

startHeartbeat();

async function handle(req: Request): Promise<unknown> {
  switch (req.method) {
    case 'start': {
      await runtime.start({ bootstrap: false });
      const ov = await runtime.getOverview();
      sendEvent('overview', ov);
      return ov;
    }
    case 'bootstrapModel':
      await runtime.bootstrapModel((event) => {
        process.stdout.write(`${JSON.stringify({ id: req.id, event: 'bootstrap-progress', payload: event })}\n`);
      });
      void pushOverview();
      return { ready: true };
    case 'stop':
      await runtime.stop();
      void pushOverview();
      return { stopped: true };
    case 'pauseCapture': {
      const ov = await runtime.pauseCapture();
      sendEvent('overview', ov);
      return ov;
    }
    case 'resumeCapture': {
      const ov = await runtime.resumeCapture();
      sendEvent('overview', ov);
      return ov;
    }
    case 'triggerIndex': {
      await runtime.triggerIndex();
      const ov = await runtime.getOverview();
      sendEvent('overview', ov);
      return ov;
    }
    case 'triggerReorganise': {
      await runtime.triggerReorganise();
      const ov = await runtime.getOverview();
      sendEvent('overview', ov);
      return ov;
    }
    case 'overview':
      return await runtime.getOverview();
    case 'doctor':
      return await runtime.runDoctor();
    case 'readConfig':
      return await runtime.readConfig();
    case 'validateConfig':
      return runtime.validateConfig(req.params);
    case 'saveConfigPatch': {
      const result = await runtime.saveConfigPatch(req.params as Record<string, unknown>);
      void pushOverview();
      return result;
    }
    case 'listJournalDays':
      return await runtime.listJournalDays();
    case 'getJournalDay':
      return await runtime.getJournalDay(String(req.params));
    case 'searchFrames':
      return await runtime.searchFrames(req.params as never);
    case 'explainSearchResults':
      return await runtime.explainSearchResults(req.params as never);
    case 'readAsset': {
      const buf = await runtime.readAsset(String(req.params));
      return { base64: buf.toString('base64') };
    }
    case 'deleteFrame': {
      const result = await runtime.deleteFrame(String(req.params));
      // Re-emit overview so KPIs / live strip update without waiting for
      // the 2s heartbeat after a destructive action.
      void pushOverview();
      return result;
    }
    case 'deleteFramesByDay': {
      const result = await runtime.deleteFramesByDay(String(req.params));
      void pushOverview();
      return result;
    }
    case 'deleteAllMemory': {
      const result = await runtime.deleteAllMemory();
      void pushOverview();
      return result;
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

function shutdown(): void {
  stopHeartbeat();
  void runtime.stop().finally(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
