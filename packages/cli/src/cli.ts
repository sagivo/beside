#!/usr/bin/env node
import process from 'node:process';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import {
  createLogger,
  writeDefaultConfigIfMissing,
  defaultDataDir,
  loadConfig,
  expandPath,
  findWorkspaceRoot,
} from '@cofounderos/core';
import {
  assertHeavyWorkAllowed,
  buildOrchestrator,
  bootstrapModel,
  createRuntime,
  runIncremental,
  runReorganisation,
  runFullReindex,
  startAll,
  stopAll,
  useOfflineModel,
} from '@cofounderos/runtime';
import type { OrchestratorHandles } from '@cofounderos/runtime';
import { createBootstrapRenderer } from './bootstrap-progress.js';

interface ParsedArgs {
  command: string;
  flags: Record<string, string | boolean>;
  positional: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = 'help', ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] ?? '';
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = rest[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { command, flags, positional };
}

function help(): void {
  // eslint-disable-next-line no-console
  console.log(`cofounderos — AI-powered device capture, knowledge indexing, and agent memory

Usage: cofounderos <command> [options]

Commands:
  init                       Write config.yaml + auto-install Ollama + pull default
                             model (Gemma) so the agent is ready to index.
  status                     Show capture state, storage stats, and index state.
                             (Read-only — never triggers an install or download.)
  doctor                     Preflight check for platform, deps, permissions hints,
                             data dir, Ollama, and MCP config.
  stats (alias: info)        Detailed snapshot of your data: disk usage breakdown,
                             event/frame counts, recent activity, last operations.
                             Optional: --json (machine-readable output)
  start                      Start everything: capture + scheduled indexing + MCP server.
                             Bootstraps the model on first run.
  capture --once             Run a single capture cycle (sanity check, no scheduling).
  index --once               Run an incremental indexing pass against unindexed events.
  index --reorganise         Run a reorganisation pass (merges, splits, archives, summaries).
  index --full-reindex       Wipe the index and rebuild it from raw data.
                             Optional: --strategy <name>  --from <date|iso>  --to <date|iso>
  index --reindex-from <date>
                             Shortcut for --full-reindex --from <date>. Date-only
                             values use the local day's start; --to uses day end.
  mcp [--stdio]              Run only the MCP server (HTTP by default; stdio for AI clients).
  model:update               Re-pull the configured local model (and embedding model)
                             to refresh weights under a floating Ollama tag (e.g. when
                             gemma4:e2b gets new weights published under the same name).
                             No-op for remote model plugins.
  plugin list                List discovered plugins by layer.
  reset [--yes] [--keep-config]
                             Wipe everything and start from scratch: raw capture
                             (raw/, checkpoints/, cofounderOS.db), the index, and
                             configured exports (e.g. markdown mirror).
                             Prompts for confirmation unless --yes is passed.
                             Pass --keep-config to preserve config.yaml (default).

Options:
  --config <path>            Override config.yaml path.
  --log-level debug|info|warn|error
  --offline                  Skip the Ollama install/pull and use the deterministic
                             offline indexer. Useful in CI or air-gapped setups.
  --no-bootstrap             Skip the model bootstrap for this command (fail later
                             if the model is needed but not ready).

See README.md and ~/.cofounderOS/config.yaml for full configuration.`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  const level = (args.flags['log-level'] as 'debug' | 'info' | 'warn' | 'error' | undefined) ?? 'info';
  const logger = createLogger({ level });

  switch (args.command) {
    case 'help':
    case '--help':
    case '-h':
      help();
      return;

    case 'init':
      await cmdInit(logger, args);
      return;

    case 'status':
      await cmdStatus(logger, args);
      return;

    case 'doctor':
      await cmdDoctor(args);
      return;

    case 'stats':
    case 'info':
      await cmdStats(logger, args);
      return;

    case 'start':
      await cmdStart(logger, args);
      return;

    case 'capture':
      if (args.flags.once) await cmdCaptureOnce(logger, args);
      else help();
      return;

    case 'index':
      await cmdIndex(logger, args);
      return;

    case 'mcp':
      await cmdMcp(logger, args);
      return;

    case 'model:update':
      await cmdModelUpdate(logger, args);
      return;

    case 'plugin':
      await cmdPlugin(logger, args);
      return;

    case 'reset':
      await cmdReset(logger, args);
      return;

    default:
      // eslint-disable-next-line no-console
      console.error(`Unknown command: ${args.command}\n`);
      help();
      process.exitCode = 1;
  }
}

async function cmdInit(logger: ReturnType<typeof createLogger>, args: ParsedArgs): Promise<void> {
  const dir = defaultDataDir();
  const result = await writeDefaultConfigIfMissing(dir);
  if (result.created) {
    // eslint-disable-next-line no-console
    console.log(`✓ Created ${result.path}`);
  } else {
    // eslint-disable-next-line no-console
    console.log(`• Already exists: ${result.path}`);
  }

  if (args.flags.offline) {
    // eslint-disable-next-line no-console
    console.log('• --offline set: skipping model bootstrap.');
    return;
  }
  if (args.flags['no-bootstrap']) {
    // eslint-disable-next-line no-console
    console.log('• --no-bootstrap set: skipping model bootstrap.');
    return;
  }

  // eslint-disable-next-line no-console
  console.log('\nPreparing local AI model (Ollama + Gemma)…');
  const handles = await buildOrchestrator(logger, configFromArgs(args));
  try {
    await ensureModelOrFallback(handles, args);
  } finally {
    await stopAll(handles);
  }
  // eslint-disable-next-line no-console
  console.log('\n✓ CofounderOS is ready. Next: `cofounderos start`');
}

async function cmdStatus(logger: ReturnType<typeof createLogger>, args: ParsedArgs): Promise<void> {
  const runtime = createRuntime({ ...configFromArgs(args), logger });
  const overview = await runtime.getOverview();

  // eslint-disable-next-line no-console
  console.log(`# CofounderOS — status

## Capture
running:        ${overview.capture.running}
paused:         ${overview.capture.paused}
events today:   ${overview.capture.eventsToday}
storage today:  ${formatBytes(overview.capture.storageBytesToday)}
process memory: ${overview.capture.memoryMB} MB

## Storage
root:           ${overview.storageRoot}
total events:   ${overview.storage.totalEvents}
total assets:   ${formatBytes(overview.storage.totalAssetBytes)}
oldest:         ${overview.storage.oldestEvent ?? '-'}
newest:         ${overview.storage.newestEvent ?? '-'}
events by type: ${formatRecord(overview.storage.eventsByType)}
top apps:       ${formatRecord(overview.storage.eventsByApp)}

## Index (${overview.index.strategy})
root:           ${overview.index.rootPath}
pages:          ${overview.index.pageCount}
events covered: ${overview.index.eventsCovered}
last incr run:  ${overview.index.lastIncrementalRun ?? 'never'}
last reorg run: ${overview.index.lastReorganisationRun ?? 'never'}

## Model
ready:          ${overview.model.ready ? 'yes' : 'no — run `cofounderos init` to install/pull'}
${JSON.stringify({ name: overview.model.name, isLocal: overview.model.isLocal }, null, 2)}

## System
load (1m):      ${formatLoad(overview.system.load)}
memory:         ${formatMemoryPressure(overview.system.memory)}
power:          ${formatPower(overview.system.power)}
load_guard:     ${overview.system.loadGuardEnabled ? 'enabled' : 'disabled'}
model jobs:     ${overview.system.backgroundModelJobs}

## Exports
${overview.exports.map((e) => `- ${e.name}: ${JSON.stringify(e)}`).join('\n')}
`);
}

type DoctorStatus = 'ok' | 'warn' | 'fail' | 'info';

interface DoctorCheck {
  area: string;
  status: DoctorStatus;
  message: string;
  detail?: string;
}

async function cmdDoctor(args: ParsedArgs): Promise<void> {
  const runtime = createRuntime(configFromArgs(args));
  const checks: DoctorCheck[] = await runtime.runDoctor();

  const nodeMajor = Number(process.versions.node.split('.')[0] ?? 0);
  checks.unshift({
    area: 'runtime',
    status: nodeMajor >= 20 ? 'ok' : 'fail',
    message: `Node ${process.versions.node}`,
    detail: nodeMajor >= 20 ? 'meets >=20 requirement' : 'install Node 20 LTS or newer',
  });
  checks.splice(1, 0, {
    area: 'runtime',
    status: 'info',
    message: `${platformName()} ${os.release()} (${process.arch})`,
  });

  const importChecks = await Promise.all([
    checkImport('native', 'sharp', 'image encoding', 'fail'),
    checkImport('native', 'better-sqlite3', 'local SQLite storage', 'fail'),
    checkImport('capture', 'active-win', 'active window metadata', 'warn'),
    checkImport('capture', 'screenshot-desktop', 'screen capture', 'warn'),
  ]);
  checks.push(...importChecks);

  if (process.platform === 'darwin') {
    checks.push(await checkCommand('capture', 'screencapture', 'macOS screen capture CLI'));
    checks.push(await checkCommand('capture', 'osascript', 'macOS browser URL / window fallback'));
    checks.push({
      area: 'permissions',
      status: 'info',
      message: 'macOS requires Screen Recording, Accessibility, and Automation permissions',
      detail: 'Run `cofounderos capture --once`; if capture is blank or URL is null, grant access in System Settings.',
    });
  } else if (process.platform === 'linux') {
    const wayland = Boolean(process.env.WAYLAND_DISPLAY);
    const x11 = Boolean(process.env.DISPLAY);
    checks.push({
      area: 'capture',
      status: x11 ? 'ok' : wayland ? 'warn' : 'warn',
      message: x11
        ? `X11 display detected (${process.env.DISPLAY})`
        : wayland
          ? `Wayland session detected (${process.env.WAYLAND_DISPLAY})`
          : 'no DISPLAY / WAYLAND_DISPLAY detected',
      detail: x11
        ? 'active-win and screenshot-desktop are expected to work.'
        : 'Wayland/headless capture is partial; use an X11 session for full capture.',
    });
    checks.push(await checkCommand('capture', 'xprop', 'Linux active-window metadata helper'));
  } else if (process.platform === 'win32') {
    checks.push(await checkCommand('bootstrap', 'winget', 'Windows Ollama auto-install'));
    checks.push({
      area: 'native',
      status: 'info',
      message: 'If native prebuilds are unavailable, install Visual Studio Build Tools + Python 3',
    });
  }

  const loaded = await runtime.readConfig();
  checks.push(...await checkNativeCaptureHelper(loaded.config));

  const failCount = checks.filter((c) => c.status === 'fail').length;
  const warnCount = checks.filter((c) => c.status === 'warn').length;

  // eslint-disable-next-line no-console
  console.log(`# CofounderOS — doctor

${checks.map(formatDoctorCheck).join('\n')}

summary: ${failCount} fail, ${warnCount} warn, ${checks.length - failCount - warnCount} ok/info
`);

  if (failCount > 0) process.exitCode = 1;
}

function platformName(): string {
  if (process.platform === 'darwin') return 'macOS';
  if (process.platform === 'win32') return 'Windows';
  if (process.platform === 'linux') return 'Linux';
  return process.platform;
}

function formatDoctorCheck(c: DoctorCheck): string {
  const icon = c.status === 'ok' ? 'ok' : c.status === 'warn' ? 'warn' : c.status === 'fail' ? 'fail' : 'info';
  const detail = c.detail ? `\n    ${c.detail}` : '';
  return `- [${icon}] ${c.area}: ${c.message}${detail}`;
}

async function checkImport(
  area: string,
  specifier: string,
  purpose: string,
  failureStatus: Extract<DoctorStatus, 'warn' | 'fail'>,
): Promise<DoctorCheck> {
  try {
    await import(specifier);
    return { area, status: 'ok', message: `${specifier} importable`, detail: purpose };
  } catch (err) {
    return {
      area,
      status: failureStatus,
      message: `${specifier} failed to import`,
      detail: `${purpose}; ${String(err)}`,
    };
  }
}

async function checkCommand(area: string, command: string, purpose: string): Promise<DoctorCheck> {
  const available = await canRunCommand(command);
  return {
    area,
    status: available ? 'ok' : 'warn',
    message: available ? `${command} found` : `${command} not found on PATH`,
    detail: purpose,
  };
}

async function checkNativeCaptureHelper(config: {
  capture: { plugin: string; helper_path?: string };
}): Promise<DoctorCheck[]> {
  const platformArch = `${process.platform}-${process.arch}`;
  const helperPath = nativeHelperPath(config);
  try {
    await fsp.access(helperPath);
    const checks: DoctorCheck[] = [{
      area: 'native-capture',
      status: config.capture.plugin === 'native' ? 'ok' : 'info',
      message: `native helper present for ${platformArch}`,
      detail: config.capture.plugin === 'native'
        ? helperPath
        : `${helperPath} (set capture.plugin: native to use it)`,
    }];
    checks.push(...await runNativeHelperDoctor(helperPath));
    return checks;
  } catch {
    return [{
      area: 'native-capture',
      status: config.capture.plugin === 'native' ? 'fail' : 'info',
      message: `native helper not built for ${platformArch}`,
      detail: config.capture.plugin === 'native'
        ? `Run pnpm build:plugins or set capture.plugin: node. Expected: ${helperPath}`
        : 'native capture is optional; current capture.plugin is not native',
    }];
  }
}

function nativeHelperPath(config: { capture: { helper_path?: string } }): string {
  const platformArch = `${process.platform}-${process.arch}`;
  const exe = process.platform === 'win32' ? 'cofounderos-capture.exe' : 'cofounderos-capture';
  return config.capture.helper_path
    ? expandPath(config.capture.helper_path)
    : path.join(
      findWorkspaceRoot(process.cwd()),
      'plugins',
      'capture',
      'native',
      'dist',
      'native',
      platformArch,
      exe,
    );
}

async function runNativeHelperDoctor(helperPath: string): Promise<DoctorCheck[]> {
  if (process.platform !== 'darwin') return [];
  try {
    const { stdout } = await runCommandCapture(helperPath, ['--doctor']);
    const lines = stdout.split(/\r?\n/).filter(Boolean);
    const doctorLine = lines.find((line) => line.includes('"kind":"doctor"'));
    if (!doctorLine) {
      return [{
        area: 'native-permissions',
        status: 'warn',
        message: 'native helper did not return doctor output',
      }];
    }
    const parsed = JSON.parse(doctorLine) as {
      checks?: Array<{ id?: string; status?: DoctorStatus; message?: string; detail?: string }>;
    };
    return (parsed.checks ?? []).map((check) => ({
      area: `native-${check.id ?? 'check'}`,
      status: normaliseDoctorStatus(check.status),
      message: check.message ?? 'native helper check',
      detail: check.detail,
    }));
  } catch (err) {
    return [{
      area: 'native-permissions',
      status: 'warn',
      message: 'native helper doctor failed',
      detail: String(err),
    }];
  }
}

function normaliseDoctorStatus(status: unknown): DoctorStatus {
  return status === 'ok' || status === 'warn' || status === 'fail' || status === 'info'
    ? status
    : 'warn';
}

async function canRunCommand(command: string): Promise<boolean> {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  return await new Promise<boolean>((resolve) => {
    const child = spawn(probe, [command], {
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('exit', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

async function runCommandCapture(
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited ${code}: ${stderr || stdout}`));
    });
  });
}

async function checkHttp(area: string, url: string, purpose: string): Promise<DoctorCheck> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1200);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return {
      area,
      status: res.ok ? 'ok' : 'warn',
      message: `${purpose}: HTTP ${res.status}`,
      detail: url,
    };
  } catch {
    return {
      area,
      status: 'warn',
      message: `${purpose}: no response`,
      detail: `${url} (run \`cofounderos init\` or use --offline)`,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function cmdStats(logger: ReturnType<typeof createLogger>, args: ParsedArgs): Promise<void> {
  const handles = await buildOrchestrator(logger, configFromArgs(args));
  try {
    const storageRoot = handles.storage.getRoot();
    const dataDir = handles.loaded.dataDir;
    const indexState = await handles.strategy.getState();
    const storageStats = await handles.storage.getStats();
    const captureStatus = handles.capture.getStatus();
    const days = await handles.storage.listDays();
    const modelInfo = handles.model.getModelInfo();
    // Probe the model adapter without bootstrapping. `isAvailable` is
    // a fast HTTP check for adapters that own a daemon (Ollama); in-
    // process adapters typically return `true` immediately.
    const modelReady = await handles.model.isAvailable().catch(() => false);

    // Free disk on the data volume — single most actionable "you're
    // about to run out" signal.
    const freeBytes = await measureFreeBytes(dataDir);

    // Capture rate + lag: latest-event timestamp tells us if capture
    // is alive; events in the last hour give us a current cadence even
    // when "events today" is misleading (e.g. fresh process restart).
    const oneHourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
    const lastHourEvents = await handles.storage.readEvents({
      from: oneHourAgo,
      limit: 50_000,
    });
    const eventsLastHour = lastHourEvents.length;
    const lastEventTs = storageStats.newestEvent;

    // Today vs. yesterday delta. Local-day boundaries so the comparison
    // matches the user's calendar, not UTC.
    const dayKey = (d: Date): string => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    };
    const todayKey = dayKey(new Date());
    const yesterdayKey = dayKey(new Date(Date.now() - 24 * 60 * 60_000));

    // Backlog for the active index strategy. Capped scan so massive
    // unindexed queues don't make `stats` slow; we report ">= cap" if
    // we hit the lid.
    const BACKLOG_CAP = 5000;
    const backlogEvents = await handles.storage
      .readEvents({
        unindexed_for_strategy: indexState.strategy,
        limit: BACKLOG_CAP,
      })
      .catch(() => []);
    const backlogCount = backlogEvents.length;
    const backlogIsLowerBound = backlogCount >= BACKLOG_CAP;

    // Pipeline queues. Same capped-scan trick — we only need a rough
    // "is there work waiting?" number for the dashboard.
    const PIPELINE_CAP = 1000;
    const [pendingOcrTasks, pendingResolveTasks, pendingEmbedTasks] =
      await Promise.all([
        handles.storage.listFramesNeedingOcr(PIPELINE_CAP).catch(() => []),
        handles.storage.listFramesNeedingResolution(PIPELINE_CAP).catch(() => []),
        handles.storage
          .listFramesNeedingEmbedding(modelInfo.name, PIPELINE_CAP)
          .catch(() => []),
      ]);
    const pipeline = {
      ocr: pendingOcrTasks.length,
      resolve: pendingResolveTasks.length,
      embed: pendingEmbedTasks.length,
      cap: PIPELINE_CAP,
    };

    // MCP: configured host:port + a connect probe. We never start the
    // server inside `stats`, so this just tells the user whether the
    // MCP they configured is currently reachable (e.g. another
    // `cofounderos start` is running).
    const mcpRef = handles.config.export.plugins.find(
      (p) => p.name === 'mcp',
    ) as { name: string; enabled?: boolean; host?: string; port?: number } | undefined;
    const mcpEnabled = !!mcpRef && mcpRef.enabled !== false;
    const mcpHost = mcpRef?.host ?? '127.0.0.1';
    const mcpPort = mcpRef?.port ?? 3456;
    const mcpUrl = mcpEnabled ? `http://${mcpHost}:${mcpPort}` : null;
    const mcpReady = mcpUrl ? await probeHttp(`${mcpUrl}/health`, 600) : false;

    // Disk usage broken down by component.
    const diskTargets: Array<{ label: string; path: string }> = [
      { label: 'raw events + assets', path: path.join(storageRoot, 'raw') },
      { label: 'checkpoints',         path: path.join(storageRoot, 'checkpoints') },
      { label: 'sqlite database',     path: path.join(storageRoot, 'cofounderOS.db') },
      { label: 'sqlite WAL',          path: path.join(storageRoot, 'cofounderOS.db-wal') },
      { label: 'sqlite SHM',          path: path.join(storageRoot, 'cofounderOS.db-shm') },
      { label: 'index',               path: indexState.rootPath },
      { label: 'exports',             path: path.join(dataDir, 'export') },
    ];
    // Bucket file sizes by mtime hour for the last-24h sparkline at the
    // same time we compute totals — saves a second pass over the trees.
    const measuredAt = Date.now();
    const diskRows = await Promise.all(
      diskTargets.map(async (t) => {
        const { totalBytes: bytes, recentByHour } = await measurePathDetailed(t.path, measuredAt);
        return { ...t, bytes, recentByHour };
      }),
    );
    const totalBytes = diskRows.reduce((acc, r) => acc + r.bytes, 0);
    // Aggregate per-hour bytes across every target. recentByHour[0] is the
    // oldest hour shown (23-24h ago); recentByHour[23] is the most recent
    // (within the last hour).
    const diskByHour = new Array<number>(24).fill(0);
    for (const r of diskRows) {
      for (let i = 0; i < 24; i++) diskByHour[i] += r.recentByHour[i] ?? 0;
    }

    // Frame stats.
    let frameTiers: Record<string, number> = {};
    try {
      frameTiers = (await handles.storage.countFramesByTier()) as Record<string, number>;
    } catch {
      // Storage backend may not implement frames; fall through.
    }
    const totalFrames = Object.values(frameTiers).reduce((a, b) => a + b, 0);

    // Entities — total count + top 5 by recent activity.
    let entityCount = 0;
    let topEntities: Array<{ title: string; kind: string; frames: number; lastSeen: string }> = [];
    try {
      const all = await handles.storage.listEntities({});
      entityCount = all.length;
      topEntities = all.slice(0, 5).map((e) => ({
        title: e.title,
        kind: e.kind,
        frames: e.frameCount,
        lastSeen: e.lastSeen,
      }));
    } catch {
      // ignore — backend may not implement entities
    }

    // Recent activity: events in the last 7 days, grouped by day.
    const now = Date.now();
    const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
    const recent = await handles.storage.readEvents({ from: sevenDaysAgo, limit: 50_000 });
    const byDay: Record<string, number> = {};
    for (const e of recent) {
      const d = e.timestamp.slice(0, 10);
      byDay[d] = (byDay[d] ?? 0) + 1;
    }
    const eventsToday = byDay[todayKey] ?? 0;
    const eventsYesterday = byDay[yesterdayKey] ?? 0;

    // SQLite WAL: bytes (already collected via diskRows) + age of the
    // last checkpoint (≈ mtime of the .db file, since checkpoints
    // rewrite the main DB pages).
    const walRow = diskRows.find((r) => r.label === 'sqlite WAL');
    const walBytes = walRow?.bytes ?? 0;
    const dbMtimeMs = await safeMtimeMs(path.join(storageRoot, 'cofounderOS.db'));
    const lastCheckpointAgoMs =
      walBytes > 0 && dbMtimeMs ? Math.max(0, Date.now() - dbMtimeMs) : null;

    if (args.flags.json) {
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify(
          {
            dataDir,
            storageRoot,
            disk: {
              total: totalBytes,
              free: freeBytes,
              breakdown: diskRows.map((r) => ({ label: r.label, path: r.path, bytes: r.bytes })),
              // 24 entries, oldest first. Each value is bytes whose file
              // mtime falls within that hour (counted across all targets).
              last24Hours: diskByHour,
              lastHourBytes: diskByHour[diskByHour.length - 1] ?? 0,
              walBytes,
              lastCheckpointAgoMs,
            },
            events: {
              total: storageStats.totalEvents,
              oldest: storageStats.oldestEvent,
              newest: storageStats.newestEvent,
              byType: storageStats.eventsByType,
              topApps: storageStats.eventsByApp,
              activeDays: days.length,
              last7Days: byDay,
              today: eventsToday,
              yesterday: eventsYesterday,
              lastHour: eventsLastHour,
              lastEventAt: lastEventTs,
            },
            frames: {
              total: totalFrames,
              byTier: frameTiers,
              pendingOcr: pipeline.ocr,
              pendingResolution: pipeline.resolve,
              pendingEmbedding: pipeline.embed,
              pendingCap: pipeline.cap,
            },
            entities: { total: entityCount, recent: topEntities },
            index: {
              strategy: indexState.strategy,
              rootPath: indexState.rootPath,
              pageCount: indexState.pageCount,
              eventsCovered: indexState.eventsCovered,
              eventsBacklog: backlogCount,
              eventsBacklogIsLowerBound: backlogIsLowerBound,
              lastIncrementalRun: indexState.lastIncrementalRun,
              lastReorganisationRun: indexState.lastReorganisationRun,
            },
            model: {
              name: modelInfo.name,
              isLocal: modelInfo.isLocal,
              ready: modelReady,
            },
            mcp: mcpUrl
              ? { enabled: true, url: mcpUrl, ready: mcpReady }
              : { enabled: false },
            capture: {
              running: captureStatus.running,
              paused: captureStatus.paused,
              eventsToday: eventsToday,
              eventsYesterday: eventsYesterday,
              eventsLastHour,
              storageBytesToday: captureStatus.storageBytesToday,
              lastEventAt: lastEventTs,
            },
          },
          null,
          2,
        ),
      );
      return;
    }

    const indexedPct =
      storageStats.totalEvents > 0
        ? Math.round((indexState.eventsCovered / storageStats.totalEvents) * 100)
        : 0;

    const lastIncremental = indexState.lastIncrementalRun
      ? `${formatRelativeTime(indexState.lastIncrementalRun)}${formatNextIncremental(indexState.lastIncrementalRun, handles.config.index.incremental_interval_min)}`
      : color.dim('never');
    const lastReorg = indexState.lastReorganisationRun
      ? formatRelativeTime(indexState.lastReorganisationRun)
      : color.dim('never');

    const out: string[] = [];
    const captureDot = captureStatus.running
      ? captureStatus.paused
        ? color.yellow('●') + ' paused'
        : color.green('●') + ' running'
      : color.red('●') + ' stopped';
    const idxBarColor: ColorName = indexedPct >= 95 ? 'green' : indexedPct >= 60 ? 'yellow' : 'red';
    const recent24Total = diskByHour.reduce((a, b) => a + b, 0);
    const recent24Peak = Math.max(0, ...diskByHour);
    const sortedDisk = [...diskRows].sort((a, b) => b.bytes - a.bytes);
    const diskTop = sortedDisk.slice(0, 3);
    const diskOtherBytes = sortedDisk.slice(3).reduce((acc, r) => acc + r.bytes, 0);
    const tierOrder = ['original', 'compressed', 'thumbnail', 'deleted'] as const;
    const frameParts = tierOrder.map((t) => `${t} ${(frameTiers[t] ?? 0).toLocaleString()}`);

    const lastEventAgo = lastEventTs
      ? color.dim(`last event ${formatRelativeTime(lastEventTs)}`)
      : color.dim('no events yet');
    const captureRate = `${eventsLastHour.toLocaleString()}/h`;
    const backlogText = backlogCount === 0
      ? color.dim('backlog 0')
      : `backlog ${color.bold(`${backlogIsLowerBound ? '≥' : ''}${backlogCount.toLocaleString()}`)} events`;
    const lastHourBytes = diskByHour[diskByHour.length - 1] ?? 0;
    const freeFragment = freeBytes != null ? `  ·  ${formatBytes(freeBytes)} free` : '';
    const deltaText = renderDayDelta(eventsToday, eventsYesterday);
    const pipelineText = formatPipeline(pipeline);
    const modelLine = formatModelLine(modelInfo.name, modelReady, modelInfo.isLocal);
    const mcpLine = formatMcpLine(mcpEnabled, mcpUrl, mcpReady);
    out.push(color.bold(color.cyan('CofounderOS')) + color.dim('  stats'));
    out.push(color.dim(dataDir));
    out.push('');
    out.push(
      `${sectionLabel('Capture')} ${captureDot}` +
        `   ${sectionLabel('today')} ${color.bold(eventsToday.toLocaleString())} events ${color.dim(`(${formatBytes(captureStatus.storageBytesToday)})`)}` +
        `   ${sectionLabel('rate')} ${color.bold(captureRate)}` +
        `   ${lastEventAgo}`,
    );
    out.push(
      `${sectionLabel('Index')}   ${miniBar(indexedPct / 100, 16, idxBarColor)} ` +
        `${color.bold(formatPct(indexedPct / 100))} covered` +
        `   ${color.dim(`${indexState.eventsCovered.toLocaleString()} / ${storageStats.totalEvents.toLocaleString()} events`)}` +
        `   ${backlogText}`,
    );
    out.push(`${sectionLabel('Model')}   ${modelLine}`);
    if (mcpEnabled) out.push(`${sectionLabel('MCP')}     ${mcpLine}`);
    out.push('');

    out.push(
      sectionTitle(
        'Storage',
        `${formatBytes(totalBytes)} total${freeFragment}`,
      ),
    );
    out.push(
      `  ${color.dim('writes')}  ${color.bold(`${formatBytesCompact(recent24Total)}/24h`)}  |  ` +
        `${formatBytesCompact(lastHourBytes)}/h  ${color.dim(`(peak ${formatBytes(recent24Peak)}/h)`)}`,
    );
    for (const r of diskTop) out.push(formatDiskLine(r.label, r.bytes, totalBytes));
    if (diskOtherBytes > 0) out.push(formatDiskLine('other', diskOtherBytes, totalBytes));
    if (walBytes > 0) {
      const checkpointPart = lastCheckpointAgoMs != null
        ? `  ${color.dim(`(checkpoint ${formatDurationShort(lastCheckpointAgoMs)} ago)`)}`
        : '';
      out.push(`  ${color.dim('wal')}     ${formatBytes(walBytes)}${checkpointPart}`);
    }
    out.push(`  ${color.dim('24h')}     ${color.dim('-24h')} ${sparkline(diskByHour, 'cyan')} ${color.dim('now')}`);
    out.push('');

    out.push(sectionTitle('Activity'));
    out.push(
      `  events  ${color.bold(storageStats.totalEvents.toLocaleString())} total  ·  ${days.length.toLocaleString()} active days  ·  ` +
        `${storageStats.oldestEvent ? formatTs(storageStats.oldestEvent) : '-'} ${color.dim('→')} ` +
        `${storageStats.newestEvent ? formatTs(storageStats.newestEvent) : '-'}`,
    );
    out.push(
      `  today   ${color.bold(eventsToday.toLocaleString())}  ${color.dim('vs yesterday')} ${eventsYesterday.toLocaleString()}  ${deltaText}`,
    );
    out.push(`  7 days  ${formatLast7DaysCompact(byDay)}`);
    out.push(`  types   ${formatInlineBreakdown(storageStats.eventsByType, 'magenta', 3)}`);
    out.push(`  apps    ${formatInlineBreakdown(storageStats.eventsByApp, 'blue', 3)}`);
    out.push('');

    out.push(sectionTitle('Memory'));
    out.push(`  frames    ${color.bold(totalFrames.toLocaleString())} total  ·  ${frameParts.join(color.dim(' · '))}`);
    out.push(
      `  entities  ${color.bold(entityCount.toLocaleString())} total  ·  ` +
        `${topEntities.length > 0 ? formatInlineEntities(topEntities, 2) : color.dim('none resolved yet')}`,
    );
    out.push(`  pipeline  ${pipelineText}`);
    out.push('');

    out.push(sectionTitle('Index', indexState.strategy));
    out.push(
      `  pages     ${color.bold(String(indexState.pageCount))}  ·  coverage ${miniBar(indexedPct / 100, 18, idxBarColor)} ` +
        `${color.bold(formatPct(indexedPct / 100))}  ·  ${backlogText}`,
    );
    out.push(`  runs      incremental ${lastIncremental}  ·  reorg ${lastReorg}`);

    // eslint-disable-next-line no-console
    console.log(out.join('\n'));
  } finally {
    await stopAll(handles);
  }
}

/**
 * Best-effort recursive disk usage. Returns 0 for missing paths.
 *
 * In addition to the running total, buckets each file's size by mtime
 * into one of 24 one-hour windows ending at `now`. Bucket index 0 is
 * the *oldest* hour shown (23-24h ago); bucket index 23 is the most
 * recent (within the last hour). Files outside the 24h window
 * contribute to `totalBytes` only.
 *
 * Used only by `stats` — small enough not to need streaming.
 */
async function measurePathDetailed(
  p: string,
  now: number,
): Promise<{ totalBytes: number; recentByHour: number[] }> {
  const recentByHour = new Array<number>(24).fill(0);
  let totalBytes = 0;
  const horizonMs = 24 * 60 * 60 * 1000;

  async function walk(filePath: string): Promise<void> {
    let stat: import('node:fs').Stats;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      return;
    }
    if (stat.isFile()) {
      totalBytes += stat.size;
      const ageMs = now - stat.mtimeMs;
      if (ageMs >= 0 && ageMs < horizonMs) {
        const hoursAgo = Math.floor(ageMs / (60 * 60 * 1000));
        const bucket = 23 - hoursAgo;
        if (bucket >= 0 && bucket < 24) {
          recentByHour[bucket] = (recentByHour[bucket] ?? 0) + stat.size;
        }
      }
      return;
    }
    if (!stat.isDirectory()) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fsp.readdir(filePath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      await walk(path.join(filePath, e.name));
    }
  }

  await walk(p);
  return { totalBytes, recentByHour };
}

/**
 * Render an ASCII bar chart of the last 7 calendar days, oldest first.
 * Days with zero events are still shown so the user can see gaps.
 */
function formatLast7Days(byDay: Record<string, number>): string {
  const days: string[] = [];
  const today = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const max = Math.max(1, ...days.map((d) => byDay[d] ?? 0));
  const blocks = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
  return days
    .map((d, idx) => {
      const n = byDay[d] ?? 0;
      const isToday = idx === days.length - 1;
      const wd = weekday[new Date(d + 'T00:00:00Z').getUTCDay()] ?? '???';
      const barWidth = 28;
      const filled = n > 0 ? Math.max(1, Math.round((n / max) * barWidth)) : 0;
      const remainder = n > 0 ? Math.min(7, Math.round(((n / max) * barWidth - Math.floor((n / max) * barWidth)) * 7)) : 0;
      let bar = '█'.repeat(filled);
      if (filled < barWidth && remainder > 0) bar += blocks[remainder] ?? '';
      const colored = color.cyan(bar);
      const dateLabel = isToday ? color.bold(d) : d;
      const wdLabel = isToday ? color.bold(wd) : color.dim(wd);
      const count = isToday ? color.bold(String(n).padStart(5)) : String(n).padStart(5);
      return `  ${wdLabel} ${dateLabel}  ${count}  ${colored}`;
    })
    .join('\n');
}

// ── Pretty-print helpers (colors, bars, sections) ────────────────────────────

type ColorName = 'cyan' | 'green' | 'yellow' | 'red' | 'blue' | 'magenta';

// NO_COLOR (https://no-color.org) wins outright. Otherwise FORCE_COLOR
// can opt back in for non-TTY contexts (CI logs that render ANSI). Last
// resort: standard TTY detection. Matches the rules in core/logger.ts.
const COLORS_ENABLED = ((): boolean => {
  if (process.env.NO_COLOR && process.env.NO_COLOR.length > 0) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR.length > 0) return true;
  return !!process.stdout.isTTY;
})();
const ANSI: Record<string, string> = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
};

function wrap(code: string, s: string): string {
  if (!COLORS_ENABLED) return s;
  return `${code}${s}${ANSI.reset}`;
}

const color = {
  bold: (s: string) => wrap(ANSI.bold!, s),
  dim: (s: string) => wrap(ANSI.dim!, s),
  cyan: (s: string) => wrap(ANSI.cyan!, s),
  green: (s: string) => wrap(ANSI.green!, s),
  yellow: (s: string) => wrap(ANSI.yellow!, s),
  red: (s: string) => wrap(ANSI.red!, s),
  blue: (s: string) => wrap(ANSI.blue!, s),
  magenta: (s: string) => wrap(ANSI.magenta!, s),
  by: (name: ColorName, s: string) => wrap(ANSI[name]!, s),
};

/** Strip ANSI codes when measuring visible length. */
function visibleLen(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

function miniBar(fraction: number, width: number, c: ColorName): string {
  const f = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(f * width);
  const empty = width - filled;
  return color.by(c, '█'.repeat(filled)) + color.dim('░'.repeat(empty));
}

function formatPct(fraction: number): string {
  if (!Number.isFinite(fraction)) return '0%';
  const p = Math.max(0, Math.min(1, fraction)) * 100;
  return p >= 10 ? `${Math.round(p)}%` : `${p.toFixed(1)}%`;
}

function sectionLabel(s: string): string {
  return color.bold(s) + color.dim(':');
}

function sectionTitle(title: string, detail?: string): string {
  return detail ? `${color.bold(title)}  ${color.dim(detail)}` : color.bold(title);
}

function formatDiskLine(label: string, bytes: number, totalBytes: number): string {
  const pct = totalBytes > 0 ? bytes / totalBytes : 0;
  return `  ${label.padEnd(22)} ${formatBytes(bytes).padStart(8)}  ${color.dim(formatPct(pct))}`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 1) return s.slice(0, max);
  return `${s.slice(0, max - 1)}…`;
}

function sparkline(values: number[], c: ColorName): string {
  const max = Math.max(0, ...values);
  const blocks = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
  if (max === 0) return color.dim('·'.repeat(values.length));
  return values
    .map((n) => {
      if (n <= 0) return color.dim('·');
      const idx = Math.max(0, Math.min(blocks.length - 1, Math.ceil((n / max) * blocks.length) - 1));
      return color.by(c, blocks[idx] ?? '▁');
    })
    .join('');
}

function formatLast7DaysCompact(byDay: Record<string, number>): string {
  const days: string[] = [];
  const today = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const values = days.map((d) => byDay[d] ?? 0);
  const labels = days.map((d) => (weekday[new Date(d + 'T00:00:00Z').getUTCDay()] ?? '???').slice(0, 2)).join(' ');
  const todayCount = values[values.length - 1] ?? 0;
  const peak = Math.max(0, ...values);
  return (
    `${color.dim(labels)}  ${sparkline(values, 'cyan')}  ` +
    `today ${color.bold(todayCount.toLocaleString())}  peak ${peak.toLocaleString()}`
  );
}

function formatInlineBreakdown(record: Record<string, number>, c: ColorName, limit: number): string {
  const entries = Object.entries(record)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
  if (entries.length === 0) return color.dim('none');
  const total = Object.values(record).reduce((acc, v) => acc + v, 0);
  return entries
    .map(([key, v]) => {
      const pct = total > 0 ? v / total : 0;
      return `${color.by(c, key)} ${v.toLocaleString()} ${color.dim(formatPct(pct))}`;
    })
    .join(color.dim(' · '));
}

function formatInlineEntities(
  entities: Array<{ title: string; kind: string; frames: number; lastSeen: string }>,
  limit: number,
): string {
  return entities
    .slice(0, limit)
    .map(
      (e) =>
        `${truncate(e.title, 24)} ${color.dim(`[${e.kind}]`)} ` +
        `${e.frames.toLocaleString()}f ${color.dim(formatRelativeTime(e.lastSeen))}`,
    )
    .join(color.dim(' · '));
}

function formatTs(iso: string): string {
  // Trim to "YYYY-MM-DD HH:MM" for readability.
  const t = iso.slice(0, 16).replace('T', ' ');
  return t || iso;
}

/**
 * Free bytes on the filesystem hosting `p`. Returns `null` if the
 * platform doesn't support `fs.statfs` (older Node) or the call fails.
 */
async function measureFreeBytes(p: string): Promise<number | null> {
  const statfs = (fsp as unknown as {
    statfs?: (path: string) => Promise<{ bsize: number; bavail: number }>;
  }).statfs;
  if (!statfs) return null;
  try {
    const s = await statfs(p);
    return s.bsize * s.bavail;
  } catch {
    return null;
  }
}

async function safeMtimeMs(p: string): Promise<number | null> {
  try {
    const s = await fsp.stat(p);
    return s.mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Cheap one-shot HTTP HEAD-like probe. We use GET because some servers
 * reject HEAD; the body is discarded. Any response (even 404) means
 * "something is listening", which is what `stats` cares about.
 */
async function probeHttp(url: string, timeoutMs: number): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    await fetch(url, { signal: ctrl.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function renderDayDelta(today: number, yesterday: number): string {
  if (yesterday === 0 && today === 0) return color.dim('—');
  if (yesterday === 0) return color.green(`+${today.toLocaleString()} new`);
  const diff = today - yesterday;
  const pct = Math.round((diff / yesterday) * 100);
  if (diff === 0) return color.dim('0%');
  const sign = diff > 0 ? '+' : '';
  const text = `${sign}${pct}%`;
  return diff > 0 ? color.green(text) : color.yellow(text);
}

function formatPipeline(p: { ocr: number; resolve: number; embed: number; cap: number }): string {
  const fmt = (label: string, n: number): string => {
    const display = n >= p.cap ? `≥${n.toLocaleString()}` : n.toLocaleString();
    const body = `${label} ${display}`;
    return n > 0 ? color.bold(body) : color.dim(body);
  };
  return `${fmt('ocr', p.ocr)} ${color.dim('·')} ${fmt('resolve', p.resolve)} ${color.dim('·')} ${fmt('embed', p.embed)}`;
}

function formatModelLine(name: string, ready: boolean, isLocal: boolean): string {
  const dot = ready ? color.green('●') + ' ready' : color.red('●') + ' unreachable';
  const tag = color.dim(isLocal ? '[local]' : '[remote]');
  return `${dot}  ${color.bold(name)}  ${tag}`;
}

function formatMcpLine(enabled: boolean, url: string | null, ready: boolean): string {
  if (!enabled || !url) return color.dim('disabled');
  const dot = ready ? color.green('●') + ' listening' : color.dim('○') + ' offline';
  return `${dot}  ${color.bold(url)}`;
}

/**
 * Compact relative-duration formatter for "X ago"-style suffixes.
 * Picks the largest unit that yields a value ≥ 1.
 *   42_000     → "42s"
 *   3_600_000  → "1h"
 */
function formatDurationShort(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86_400) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86_400)}d`;
}

function formatRelativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const diffSec = Math.round((Date.now() - t) / 1000);
  const abs = Math.abs(diffSec);
  const future = diffSec < 0;
  let val: string;
  if (abs < 60) val = `${abs}s`;
  else if (abs < 3600) val = `${Math.round(abs / 60)}m`;
  else if (abs < 86400) val = `${Math.round(abs / 3600)}h`;
  else if (abs < 86400 * 30) val = `${Math.round(abs / 86400)}d`;
  else if (abs < 86400 * 365) val = `${Math.round(abs / (86400 * 30))}mo`;
  else val = `${Math.round(abs / (86400 * 365))}y`;
  return future ? `in ${val}` : `${val} ago`;
}

/**
 * Run the model adapter's first-run bootstrap with a CLI progress bar.
 * Honours `--offline` (force fallback) and `--no-bootstrap` (skip entirely).
 *
 * On bootstrap failure, prints clear next-step guidance and falls back
 * to the offline adapter so the rest of the command can still run.
 */
async function ensureModelOrFallback(
  handles: OrchestratorHandles,
  args: ParsedArgs,
): Promise<void> {
  if (args.flags.offline) {
    useOfflineModel(handles);
    return;
  }
  if (args.flags['no-bootstrap']) {
    return;
  }
  const { handler, finalize } = createBootstrapRenderer();
  try {
    await bootstrapModel(handles, handler);
    finalize();
  } catch (err) {
    finalize();
    // eslint-disable-next-line no-console
    console.error(`\n✗ Model bootstrap failed: ${(err as Error).message}`);
    // eslint-disable-next-line no-console
    console.error(
      `\nFalling back to the offline deterministic indexer so this command can still run.\n` +
        `To retry the install, run: cofounderos init\n` +
        `To skip in future runs, pass --offline.`,
    );
    useOfflineModel(handles);
  }
}

async function cmdStart(logger: ReturnType<typeof createLogger>, args: ParsedArgs): Promise<void> {
  const handles = await buildOrchestrator(logger, configFromArgs(args));
  await ensureModelOrFallback(handles, args);
  await startAll(handles);

  const url = handles.exports.find((e) => e.name === 'mcp')?.getStatus();
  logger.info(
    `CofounderOS running. Capture, indexing scheduler, and MCP server are live. Press Ctrl+C to stop.`,
    { mcp: url },
  );

  scheduleDevFullReindex(handles, logger);

  await waitForShutdown(handles);
}

/**
 * In dev mode (`pnpm dev`, which sets COFOUNDEROS_DEV=1 and runs under
 * `tsx watch`), kick off a full re-index ~1 minute after start so the
 * index reflects the latest code/strategy changes. The 1-minute delay is
 * a debounce: tsx restarts the process on every file edit, which cancels
 * the pending timer, so the re-index only fires after the dev session
 * has been stable for a minute.
 *
 * A marker file (last successful dev re-index timestamp) prevents this
 * from running on every restart once it has succeeded recently — without
 * it, simply leaving `pnpm dev` running and idle would trigger a heavy
 * full re-index every minute.
 */
function scheduleDevFullReindex(
  handles: OrchestratorHandles,
  logger: ReturnType<typeof createLogger>,
): void {
  if (process.env.COFOUNDEROS_DEV !== '1') return;

  const log = logger.child('dev-reindex');
  const markerPath = path.join(handles.loaded.dataDir, '.dev-reindex-marker');
  const cooldownMs = 24 * 60 * 60 * 1000;
  const delayMs = 60_000;

  void (async () => {
    try {
      const stat = await fsp.stat(markerPath);
      const age = Date.now() - stat.mtimeMs;
      if (age < cooldownMs) {
        log.debug(
          `skipping — last dev re-index was ${Math.round(age / 60_000)}m ago (cooldown ${Math.round(cooldownMs / 60_000)}m)`,
        );
        return;
      }
    } catch {
      // No marker yet — fall through and schedule.
    }

    log.info(`dev mode detected — scheduling full re-index in ${delayMs / 1000}s (debounced across file edits)`);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          assertHeavyWorkAllowed(handles, 'index-full-reindex');
          await runFullReindex(handles);
          await fsp.writeFile(markerPath, new Date().toISOString());
          log.info('dev full re-index complete');
        } catch (err) {
          log.warn('dev full re-index failed', { err: String(err) });
        }
      })();
    }, delayMs);
    // Don't keep the event loop alive just for this — Ctrl+C should still
    // shut down promptly even before the delay elapses.
    timer.unref();
  })();
}

async function cmdCaptureOnce(
  logger: ReturnType<typeof createLogger>,
  args: ParsedArgs,
): Promise<void> {
  const handles = await buildOrchestrator(logger, configFromArgs(args));
  try {
    // The Node capture has a non-interface tickOnce method we can use to
    // perform a single cycle without scheduling.
    const cap = handles.capture as unknown as { tickOnce?: () => Promise<void> };
    if (typeof cap.tickOnce === 'function') {
      await cap.tickOnce();
      logger.info('single capture cycle complete');
    } else {
      logger.warn('capture plugin does not support --once; doing a 5-second sample');
      await handles.capture.start();
      await new Promise((r) => setTimeout(r, 5000));
      await handles.capture.stop();
    }
  } finally {
    await stopAll(handles);
  }
}

async function cmdIndex(logger: ReturnType<typeof createLogger>, args: ParsedArgs): Promise<void> {
  let reindex: ParsedReindexArgs;
  try {
    reindex = parseReindexArgs(args);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error((err as Error).message);
    process.exitCode = 1;
    return;
  }

  const handles = await buildOrchestrator(logger, configFromArgs(args));
  try {
    await ensureModelOrFallback(handles, args);
    if (reindex.full) {
      assertHeavyWorkAllowed(handles, 'index-full-reindex');
      await runFullReindex(handles, reindex.range);
    } else if (args.flags.reorganise || args.flags.reorg) {
      assertHeavyWorkAllowed(handles, 'index-reorganise');
      await runReorganisation(handles);
    } else {
      assertHeavyWorkAllowed(handles, 'index-incremental');
      const result = await runIncremental(handles);
      // eslint-disable-next-line no-console
      console.log(`indexed ${result.eventsProcessed} events (${result.pagesCreated} created, ${result.pagesUpdated} updated)`);
    }
  } finally {
    await stopAll(handles);
  }
}

interface ParsedReindexArgs {
  full: boolean;
  range: { from?: string; to?: string };
}

function parseReindexArgs(args: ParsedArgs): ParsedReindexArgs {
  const full = Boolean(args.flags['full-reindex']);
  const reindexFrom = dateFlag(args, 'reindex-from');
  const since = dateFlag(args, 'since');
  const from = dateFlag(args, 'from');
  const to = dateFlag(args, 'to');
  const until = dateFlag(args, 'until');

  const fromValues = [
    ['--reindex-from', reindexFrom],
    ['--since', since],
    ['--from', from],
  ].filter(([, value]) => typeof value === 'string') as Array<[string, string]>;
  if (fromValues.length > 1) {
    throw new Error(
      `Use only one lower-bound flag, got ${fromValues.map(([name]) => name).join(', ')}.`,
    );
  }

  const toValues = [
    ['--to', to],
    ['--until', until],
  ].filter(([, value]) => typeof value === 'string') as Array<[string, string]>;
  if (toValues.length > 1) {
    throw new Error('Use only one upper-bound flag, got --to and --until.');
  }

  const hasShortcut = Boolean(reindexFrom || since);
  const hasRange = fromValues.length > 0 || toValues.length > 0;
  if (hasRange && !full && !hasShortcut) {
    throw new Error(
      'Date bounds only apply to full re-indexing. Use `index --reindex-from <date>` ' +
        'or `index --full-reindex --from <date>`.',
    );
  }

  const fromValue = fromValues[0]?.[1];
  const toValue = toValues[0]?.[1];
  return {
    full: full || hasShortcut,
    range: {
      from: normaliseDateBound(fromValue, 'from'),
      to: normaliseDateBound(toValue, 'to'),
    },
  };
}

function dateFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name];
  if (value === undefined || value === false) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Missing value for --${name}. Expected YYYY-MM-DD or an ISO timestamp.`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Missing value for --${name}. Expected YYYY-MM-DD or an ISO timestamp.`);
  }
  return trimmed;
}

function normaliseDateBound(value: string | undefined, side: 'from' | 'to'): string | undefined {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return side === 'from' ? `${value}T00:00:00.000` : `${value}T23:59:59.999`;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid --${side} value "${value}". Expected YYYY-MM-DD or an ISO timestamp.`);
  }
  return value;
}

async function cmdMcp(logger: ReturnType<typeof createLogger>, args: ParsedArgs): Promise<void> {
  const handles = await buildOrchestrator(logger, configFromArgs(args));
  await ensureModelOrFallback(handles, args);

  const stdio = Boolean(args.flags.stdio);
  // Filter to the mcp export only and (optionally) flip its transport.
  const mcp = handles.exports.find((e) => e.name === 'mcp');
  if (!mcp) {
    logger.error('mcp export not configured. Add it to config.yaml under export.plugins.');
    process.exitCode = 1;
    return;
  }
  if (stdio) {
    const mcpRef =
      (handles.config.export.plugins.find((p) => p.name === 'mcp') as
        | Record<string, unknown>
        | undefined) ?? {};
    // Re-instantiate the mcp export via the registry with stdio transport
    // — no static import of the plugin class, just config override.
    const stdioMcp = await handles.registry.loadExport('mcp', {
      dataDir: handles.loaded.dataDir,
      logger: handles.logger.child('mcp-stdio-cli'),
      config: { ...mcpRef, transport: 'stdio' },
    });
    if (typeof stdioMcp.bindServices === 'function') {
      stdioMcp.bindServices({
        storage: handles.storage,
        strategy: handles.strategy,
        model: handles.model,
        embeddingModelName: handles.embeddingWorker.getModelName(),
        embeddingSearchWeight: handles.config.index.embeddings.search_weight,
        dataDir: handles.loaded.dataDir,
        triggerReindex: async (full = false) => {
          assertHeavyWorkAllowed(handles, full ? 'full-reindex' : 'index-incremental');
          if (full) {
            await runFullReindex(handles);
            return;
          }
          await runIncremental(handles);
        },
      });
    }
    await stdioMcp.start();
    await waitForShutdown(handles);
  } else {
    await mcp.start();
    logger.info('MCP server running. Ctrl+C to stop.');
    await waitForShutdown(handles);
  }
}

async function cmdPlugin(logger: ReturnType<typeof createLogger>, args: ParsedArgs): Promise<void> {
  const sub = args.positional[0];
  if (sub !== 'list') {
    help();
    return;
  }
  const handles = await buildOrchestrator(logger, configFromArgs(args));
  try {
    const all = handles.registry.list();
    // eslint-disable-next-line no-console
    console.log('# CofounderOS plugins\n');
    const layers = ['capture', 'storage', 'model', 'index', 'export'] as const;
    for (const layer of layers) {
      const list = all.filter((p) => p.manifest.layer === layer);
      // eslint-disable-next-line no-console
      console.log(`## ${layer}`);
      for (const p of list) {
        // eslint-disable-next-line no-console
        console.log(`  - ${p.manifest.name}  (${p.packageName} v${p.manifest.version})`);
        if (p.manifest.description) {
          // eslint-disable-next-line no-console
          console.log(`      ${p.manifest.description}`);
        }
      }
      // eslint-disable-next-line no-console
      console.log();
    }
  } finally {
    await stopAll(handles);
  }
}

/**
 * Force-refresh the configured local model (and embedding model). Picks
 * up newer weights published under the same Ollama tag — the typical
 * case is a floating tag like `gemma4:e2b` getting an updated manifest
 * a few weeks after release. Idempotent: if the registry has nothing
 * new, Ollama re-uses the cached blobs by content hash and the pull
 * finishes near-instantly.
 *
 * Honours `--offline` (no-op + warning) so scripts can call it
 * unconditionally in any environment.
 */
async function cmdModelUpdate(
  logger: ReturnType<typeof createLogger>,
  args: ParsedArgs,
): Promise<void> {
  if (args.flags.offline) {
    // eslint-disable-next-line no-console
    console.log('• --offline set: skipping model:update.');
    return;
  }

  const handles = await buildOrchestrator(logger, configFromArgs(args));
  const modelInfo = handles.model.getModelInfo();
  if (typeof handles.model.ensureReady !== 'function') {
    // eslint-disable-next-line no-console
    console.log(
      `• Active model plugin (${modelInfo.name}) does not manage local weights — nothing to refresh.`,
    );
    await stopAll(handles);
    return;
  }

  // eslint-disable-next-line no-console
  console.log(`Refreshing local model weights for ${modelInfo.name}…`);
  const { handler, finalize } = createBootstrapRenderer();
  try {
    await bootstrapModel(handles, handler, { force: true });
    finalize();
    // eslint-disable-next-line no-console
    console.log(`\n✓ ${modelInfo.name} up to date.`);
  } catch (err) {
    finalize();
    // eslint-disable-next-line no-console
    console.error(`\n✗ Model update failed: ${(err as Error).message}`);
    process.exitCode = 1;
  } finally {
    await stopAll(handles);
  }
}

/**
 * Wipe all derived state — raw capture, SQLite database, the index, and any
 * configured export mirror — so the next `start` / `index` run begins from a
 * clean slate. Intentionally avoids the orchestrator: we don't want to open
 * the database (we'd just have to close it again to delete it) or trigger a
 * model bootstrap for what is fundamentally a destructive filesystem op.
 *
 * Preserves `config.yaml` so the user doesn't have to re-run `init` after
 * a reset. Pass `--keep-config=false` to wipe that too.
 */
async function cmdReset(
  logger: ReturnType<typeof createLogger>,
  args: ParsedArgs,
): Promise<void> {
  const cfgArgs = configFromArgs(args);
  const loaded = await loadConfig(cfgArgs.configPath);
  const { config, dataDir, sourcePath } = loaded;

  const storageRoot = expandPath(config.storage.local.path);
  const indexPath = expandPath(config.index.index_path);

  const exportPaths: string[] = [];
  for (const exp of config.export.plugins) {
    if ((exp as { enabled?: boolean }).enabled === false) continue;
    const p = (exp as { path?: string }).path;
    if (typeof p === 'string' && p.length > 0) {
      exportPaths.push(expandPath(p));
    } else if (exp.name === 'markdown') {
      exportPaths.push(path.join(dataDir, 'export', 'markdown'));
    }
  }

  const targets: Array<{ label: string; path: string }> = [
    { label: 'raw events',     path: path.join(storageRoot, 'raw') },
    { label: 'checkpoints',    path: path.join(storageRoot, 'checkpoints') },
    { label: 'sqlite database', path: path.join(storageRoot, 'cofounderOS.db') },
    { label: 'sqlite WAL',     path: path.join(storageRoot, 'cofounderOS.db-wal') },
    { label: 'sqlite SHM',     path: path.join(storageRoot, 'cofounderOS.db-shm') },
    { label: 'index',          path: indexPath },
    ...exportPaths.map((p, i) => ({ label: `export[${i}]`, path: p })),
  ];

  const keepConfig =
    args.flags['no-keep-config'] !== true &&
    args.flags['keep-config'] !== false &&
    args.flags['keep-config'] !== 'false';
  if (!keepConfig) {
    targets.push({ label: 'config.yaml', path: sourcePath });
  }

  // eslint-disable-next-line no-console
  console.log('cofounderos reset — the following will be permanently deleted:\n');
  for (const t of targets) {
    const exists = await pathExists(t.path);
    // eslint-disable-next-line no-console
    console.log(`  ${exists ? '✗' : '·'} ${t.label.padEnd(16)} ${t.path}${exists ? '' : '  (not present)'}`);
  }
  // eslint-disable-next-line no-console
  console.log(
    `\n${keepConfig ? '✓ Preserving config.yaml' : '✗ Also deleting config.yaml'}` +
      ` (${sourcePath})\n`,
  );

  if (!args.flags.yes && !args.flags.y) {
    const ok = await confirm('Type "wipe" to confirm: ', 'wipe');
    if (!ok) {
      // eslint-disable-next-line no-console
      console.log('Aborted. Nothing was deleted.');
      return;
    }
  }

  let deleted = 0;
  for (const t of targets) {
    try {
      await fsp.rm(t.path, { recursive: true, force: true });
      deleted++;
    } catch (err) {
      logger.warn(`failed to remove ${t.path}`, { err: String(err) });
    }
  }

  // eslint-disable-next-line no-console
  console.log(`\n✓ Reset complete (${deleted}/${targets.length} targets removed).`);
  // eslint-disable-next-line no-console
  console.log(
    keepConfig
      ? 'Next: `cofounderos start` to begin capturing from scratch.'
      : 'Next: `cofounderos init` to recreate config.yaml, then `cofounderos start`.',
  );
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.stat(p);
    return true;
  } catch {
    return false;
  }
}

function confirm(prompt: string, expected: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    // eslint-disable-next-line no-console
    console.error('reset requires confirmation but stdin is not a TTY. Pass --yes to skip.');
    return Promise.resolve(false);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === expected.toLowerCase());
    });
  });
}

function configFromArgs(args: ParsedArgs): { configPath?: string } {
  const cfg = typeof args.flags.config === 'string' ? args.flags.config : undefined;
  return cfg ? { configPath: cfg } : {};
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
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

function formatBytesCompact(n: number): string {
  return formatBytes(n).replace(' ', '');
}

/**
 * Render "  (next in 2m43s)" appended to the last-run line when we can
 * compute it. Returns empty string if the index has never run (no anchor)
 * or if the next run is already overdue (the scheduler will pick it up
 * on its next tick anyway, so the noise isn't useful).
 */
function formatNextIncremental(lastRunIso: string | null | undefined, intervalMin: number): string {
  if (!lastRunIso) return '';
  const last = Date.parse(lastRunIso);
  if (!Number.isFinite(last)) return '';
  const nextMs = last + intervalMin * 60_000 - Date.now();
  if (nextMs <= 0) return '  (due now)';
  const totalSec = Math.round(nextMs / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `  (next in ${m}m${s.toString().padStart(2, '0')}s)`;
}

function formatLoad(normalised: number | null): string {
  if (normalised == null) return 'n/a (unsupported on this platform)';
  return `${(normalised * 100).toFixed(0)}%`;
}

function formatMemoryPressure(memory: {
  usedRatio: number;
  freeMB: number;
  totalMB: number;
}): string {
  return `${(memory.usedRatio * 100).toFixed(0)}% used (${memory.freeMB} MB free / ${memory.totalMB} MB)`;
}

function formatPower(power: {
  source: 'ac' | 'battery' | 'unknown';
  batteryPercent: number | null;
}): string {
  const pct = power.batteryPercent == null ? '' : ` (${power.batteryPercent}%)`;
  return `${power.source}${pct}`;
}

function formatRecord(r: Record<string, number>): string {
  const entries = Object.entries(r).sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (entries.length === 0) return '(none)';
  return entries.map(([k, v]) => `${k}=${v}`).join(', ');
}

async function waitForShutdown(handles: OrchestratorHandles): Promise<void> {
  await new Promise<void>((resolve) => {
    let shuttingDown = false;
    const onSignal = (sig: string) => {
      if (shuttingDown) {
        // Second signal: bail out immediately so a stuck shutdown can't
        // leave the process holding onto sockets (e.g. port 3456 under
        // tsx watch).
        handles.logger.warn(`received ${sig} during shutdown, forcing exit`);
        process.exit(1);
      }
      shuttingDown = true;
      handles.logger.info(`received ${sig}, shutting down…`);
      // Hard ceiling: if stopAll hangs (open keep-alive sockets, slow
      // plugin teardown), don't let the process hold listening sockets
      // forever. tsx watch in particular sends SIGTERM and immediately
      // respawns — any leak here turns into EADDRINUSE on restart.
      const forceExitMs = 3000;
      const forceTimer = setTimeout(() => {
        handles.logger.warn(`shutdown still pending after ${forceExitMs}ms, forcing exit`);
        process.exit(1);
      }, forceExitMs);
      forceTimer.unref();
      void stopAll(handles)
        .catch((err) => handles.logger.error('stopAll failed', { err: String(err) }))
        .finally(() => {
          clearTimeout(forceTimer);
          resolve();
        });
    };
    process.once('SIGINT', () => onSignal('SIGINT'));
    process.once('SIGTERM', () => onSignal('SIGTERM'));
    // Windows: Ctrl+Break produces SIGBREAK and closing the console
    // window produces SIGHUP. Both should drain cleanly the same way
    // SIGINT does on POSIX so the MCP port is released and any flushes
    // run before the daemon goes away.
    process.once('SIGBREAK', () => onSignal('SIGBREAK'));
    process.once('SIGHUP', () => onSignal('SIGHUP'));
  });
  // Ensure the process actually exits even if some plugin left a timer
  // or socket dangling — `cofounderos start` is a foreground command and
  // returning from main() is the explicit signal that we're done.
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('fatal:', err);
  process.exit(1);
});

// Silence "unused import" if path tree-shakes it out of the bundle.
void path;
