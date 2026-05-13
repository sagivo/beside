#!/usr/bin/env node
import readline from 'node:readline';
import type { Logger } from '@beside/interfaces';
import { createRuntime } from '@beside/runtime';

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

function sendOverview(overview: unknown): void {
  lastOverviewFingerprint = fingerprintOverview(overview);
  sendEvent('overview', overview);
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
  workspaceRoot: process.env.BESIDE_RESOURCE_ROOT,
});

const getRuntimeOverview = runtime.getOverview.bind(runtime) as (
  options?: { forceRefresh?: boolean; mode?: 'full' | 'fast' },
) => Promise<unknown>;

// ---------------------------------------------------------------------
// Push-based overview broadcasting.
//
// The renderer used to poll `getOverview()` on a setInterval. That meant
// every UI surface paid a polling cost and lag was capped by the
// interval (2-5s). Now the runtime-service is the single source of truth
// and pushes overview snapshots:
//
//   - on a 5s lightweight heartbeat while the desktop window is visible
//   - on a 60s heartbeat while the window is hidden / minimised / closed
//   - immediately after any state-mutating call (start/stop/pause/
//     resume/triggerIndex/triggerReorganise/saveConfigPatch)
//
// `pushOverview` is fire-and-forget; if `getOverview` rejects we just
// skip that tick rather than crashing the service.
// ---------------------------------------------------------------------

const ACTIVE_HEARTBEAT_MS = 5000;
const IDLE_HEARTBEAT_MS = 60_000;

let heartbeat: ReturnType<typeof setInterval> | null = null;
let heartbeatMs = ACTIVE_HEARTBEAT_MS;

// Lightweight dirty-flag: track a JSON fingerprint of the last pushed
// overview so heartbeat ticks are no-ops when nothing has changed.
let lastOverviewFingerprint: string | null = null;

// Fields that change on every overview build but don't carry information
// the renderer actually cares about between heartbeats (timestamps of when
// the overview was generated, transient load samples, runtime durations).
// Stripping them lets the fingerprint dedupe actually fire — otherwise the
// heartbeat pushes a new payload every 5s purely because `overviewGeneratedAt`
// just ticked, even on a completely idle machine.
const VOLATILE_OVERVIEW_KEYS = new Set([
  'overviewGeneratedAt',
  'overviewDurationMs',
  'overviewTimings',
  'load',
  'memory',
]);

function fingerprintOverview(overview: unknown): string {
  return JSON.stringify(overview, (key, value) => {
    if (VOLATILE_OVERVIEW_KEYS.has(key)) return undefined;
    return value;
  });
}

async function pushOverview(mode: 'full' | 'fast' = 'full', force = false): Promise<void> {
  try {
    const overview = await getRuntimeOverview({ mode });
    const fp = fingerprintOverview(overview);
    if (!force && fp === lastOverviewFingerprint) return;
    lastOverviewFingerprint = fp;
    sendEvent('overview', overview);
  } catch {
    // Runtime is mid-restart or not yet started; let the next mutation
    // or heartbeat retry. Errors here are very noisy in the desktop log.
  }
}

function startHeartbeat(): void {
  if (heartbeat || heartbeatMs <= 0) return;
  heartbeat = setInterval(() => {
    void pushOverview('fast');
  }, heartbeatMs);
}

function stopHeartbeat(): void {
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
}

function setHeartbeatInterval(intervalMs: number): void {
  const next = Number.isFinite(intervalMs) ? Math.max(0, Math.floor(intervalMs)) : ACTIVE_HEARTBEAT_MS;
  if (next === heartbeatMs && (heartbeat != null || next <= 0)) return;
  heartbeatMs = next;
  stopHeartbeat();
  startHeartbeat();
}

startHeartbeat();

async function handle(req: Request): Promise<unknown> {
  switch (req.method) {
    case 'start': {
      await runtime.start({ bootstrap: false });
      try {
        runtime.onCaptureHookUpdate((hookId) => {
          sendEvent('capture-hook-update', { hookId });
        });
      } catch {
        // Hook engine may not be available in all configurations.
      }
      const ov = await runtime.getOverview();
      sendOverview(ov);
      return ov;
    }
    case 'bootstrapModel':
      await runtime.bootstrapModel((event) => {
        process.stdout.write(`${JSON.stringify({ id: req.id, event: 'bootstrap-progress', payload: event })}\n`);
      });
      void pushOverview('full');
      return { ready: true };
    case 'updateModel':
      // Force-pull the configured local model regardless of whether
      // it's already cached. Reuses the same progress channel as
      // bootstrapModel so the renderer can render a single bar.
      await runtime.bootstrapModel(
        (event) => {
          process.stdout.write(`${JSON.stringify({ id: req.id, event: 'bootstrap-progress', payload: event })}\n`);
        },
        { force: true },
      );
      void pushOverview('full');
      return { ready: true };
    case 'stop':
      await runtime.stop();
      void pushOverview('full');
      return { stopped: true };
    case 'pauseCapture': {
      const ov = await runtime.pauseCapture();
      sendOverview(ov);
      return ov;
    }
    case 'resumeCapture': {
      const ov = await runtime.resumeCapture();
      sendOverview(ov);
      return ov;
    }
    case 'triggerIndex': {
      await runtime.triggerIndex();
      const ov = await runtime.getOverview();
      sendOverview(ov);
      return ov;
    }
    case 'triggerReorganise': {
      await runtime.triggerReorganise();
      const ov = await runtime.getOverview();
      sendOverview(ov);
      return ov;
    }
    case 'triggerFullReindex': {
      const params = (req.params ?? {}) as { from?: string; to?: string };
      await runtime.triggerFullReindex({
        from: typeof params.from === 'string' ? params.from : undefined,
        to: typeof params.to === 'string' ? params.to : undefined,
      });
      const ov = await runtime.getOverview();
      sendOverview(ov);
      return ov;
    }
    case 'overview':
      return await runtime.getOverview();
    case 'setHeartbeat': {
      // Main process tells us whether the desktop window is visible;
      // we slow the broadcast cadence to 60s when no UI is consuming the
      // stream. `intervalMs: 0` pauses heartbeat entirely — explicit
      // mutations still push.
      const params = (req.params ?? {}) as {
        intervalMs?: number;
        mode?: 'active' | 'idle' | 'paused';
      };
      let target: number;
      if (typeof params.intervalMs === 'number') {
        target = params.intervalMs;
      } else if (params.mode === 'idle') {
        target = IDLE_HEARTBEAT_MS;
      } else if (params.mode === 'paused') {
        target = 0;
      } else {
        target = ACTIVE_HEARTBEAT_MS;
      }
      setHeartbeatInterval(target);
      return { intervalMs: heartbeatMs };
    }
    case 'doctor':
      return await runtime.runDoctor();
    case 'readConfig':
      return await runtime.readConfig();
    case 'validateConfig':
      return runtime.validateConfig(req.params);
    case 'saveConfigPatch': {
      const result = await runtime.saveConfigPatch(req.params as Record<string, unknown>);
      void pushOverview('full');
      return result;
    }
    case 'listJournalDays':
      return await runtime.listJournalDays();
    case 'getJournalDay':
      return await runtime.getJournalDay(String(req.params));
    case 'listMeetings':
      return await runtime.listMeetings(
        req.params && typeof req.params === 'object' ? (req.params as Record<string, unknown>) : {},
      );
    case 'listDayEvents':
      return await runtime.listDayEvents(
        req.params && typeof req.params === 'object' ? (req.params as Record<string, unknown>) : {},
      );
    case 'triggerEventExtractor':
      return await runtime.triggerEventExtractor();
    case 'listCaptureHookDefinitions':
      return await runtime.listCaptureHookDefinitions();
    case 'listCaptureHookWidgetManifests':
      return await runtime.listCaptureHookWidgetManifests();
    case 'getCaptureHookDiagnostics':
      return await runtime.getCaptureHookDiagnostics();
    case 'queryCaptureHookStorage': {
      const params = (req.params ?? {}) as { hookId?: string; query?: unknown };
      if (!params.hookId) throw new Error('hookId required');
      return await runtime.queryCaptureHookStorage(
        params.hookId,
        (params.query as Record<string, unknown>) ?? {},
      );
    }
    case 'mutateCaptureHookStorage': {
      const params = (req.params ?? {}) as {
        hookId?: string;
        mutation?: {
          collection?: string;
          id?: string;
          data?: unknown;
          evidenceEventIds?: string[];
          contentHash?: string | null;
        };
      };
      const mutation = params.mutation;
      if (!params.hookId || !mutation?.collection || !mutation.id) {
        throw new Error('hookId, mutation.collection, mutation.id required');
      }
      const result = await runtime.mutateCaptureHookStorage(params.hookId, {
        collection: mutation.collection,
        id: mutation.id,
        data: mutation.data ?? null,
        evidenceEventIds: mutation.evidenceEventIds,
        contentHash: mutation.contentHash ?? null,
      });
      sendEvent('capture-hook-update', { hookId: params.hookId });
      return result;
    }
    case 'searchFrames':
      return await runtime.searchFrames(req.params as never);
    case 'explainSearchResults':
      return await runtime.explainSearchResults(req.params as never);
    case 'getFrameIndexDetails':
      return await runtime.getFrameIndexDetails(String(req.params));
    case 'readAsset': {
      const buf = await runtime.readAsset(String(req.params));
      return { base64: buf.toString('base64') };
    }
    case 'deleteFrame': {
      const result = await runtime.deleteFrame(String(req.params));
      // Re-emit overview so KPIs / live strip update without waiting for
      // the next heartbeat after a destructive action.
      void pushOverview('full');
      return result;
    }
    case 'deleteFrames': {
      const params =
        req.params && typeof req.params === 'object'
          ? (req.params as { app?: unknown; urlDomain?: unknown })
          : {};
      const result = await runtime.deleteFrames({
        app: typeof params.app === 'string' ? params.app : undefined,
        urlDomain: typeof params.urlDomain === 'string' ? params.urlDomain : undefined,
      });
      void pushOverview('full');
      return result;
    }
    case 'deleteAllMemory': {
      const result = await runtime.deleteAllMemory();
      void pushOverview('full');
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
