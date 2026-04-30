#!/usr/bin/env node
import process from 'node:process';
import path from 'node:path';
import fsp from 'node:fs/promises';
import readline from 'node:readline';
import {
  createLogger,
  writeDefaultConfigIfMissing,
  defaultDataDir,
  loadConfig,
  expandPath,
} from '@cofounderos/core';
import {
  buildOrchestrator,
  bootstrapModel,
  runIncremental,
  runReorganisation,
  runFullReindex,
  startAll,
  stopAll,
  useOfflineModel,
} from './orchestrator.js';
import type { OrchestratorHandles } from './orchestrator.js';
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
  stats (alias: info)        Detailed snapshot of your data: disk usage breakdown,
                             event/frame counts, recent activity, last operations.
                             Optional: --json (machine-readable output)
  start                      Start everything: capture + scheduled indexing + MCP server.
                             Bootstraps the model on first run.
  capture --once             Run a single capture cycle (sanity check, no scheduling).
  index --once               Run an incremental indexing pass against unindexed events.
  index --reorganise         Run a reorganisation pass (merges, splits, archives, summaries).
  index --full-reindex       Wipe the index and rebuild it from raw data.
                             Optional: --strategy <name>  --from <iso>  --to <iso>
  mcp [--stdio]              Run only the MCP server (HTTP by default; stdio for AI clients).
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
  const handles = await buildOrchestrator(logger, configFromArgs(args));
  try {
    const captureStatus = handles.capture.getStatus();
    const storageStats = await handles.storage.getStats();
    const indexState = await handles.strategy.getState();
    const modelInfo = handles.model.getModelInfo();
    // Probe but never bootstrap — `status` should be a snapshot.
    const modelReady = await handles.model.isAvailable();
    const loadSnap = handles.loadGuard.snapshot();
    const loadCfg = handles.config.system.load_guard;

    // eslint-disable-next-line no-console
    console.log(`# CofounderOS — status

## Capture (${handles.config.capture.plugin})
running:        ${captureStatus.running}
paused:         ${captureStatus.paused}
events today:   ${captureStatus.eventsToday}
storage today:  ${formatBytes(captureStatus.storageBytesToday)}
process memory: ${captureStatus.memoryMB} MB

## Storage (${handles.config.storage.plugin})
root:           ${handles.storage.getRoot()}
total events:   ${storageStats.totalEvents}
total assets:   ${formatBytes(storageStats.totalAssetBytes)}
oldest:         ${storageStats.oldestEvent ?? '-'}
newest:         ${storageStats.newestEvent ?? '-'}
events by type: ${formatRecord(storageStats.eventsByType)}
top apps:       ${formatRecord(storageStats.eventsByApp)}

## Index (${indexState.strategy})
root:           ${indexState.rootPath}
pages:          ${indexState.pageCount}
events covered: ${indexState.eventsCovered}
last incr run:  ${indexState.lastIncrementalRun ?? 'never'}${formatNextIncremental(indexState.lastIncrementalRun, handles.config.index.incremental_interval_min)}
last reorg run: ${indexState.lastReorganisationRun ?? 'never'}
incr cadence:   every ${handles.config.index.incremental_interval_min} min (idle ceiling)
reorg cadence:  ${handles.config.index.reorganise_schedule}

## Model
ready:          ${modelReady ? 'yes' : 'no — run `cofounderos init` to install/pull'}
${JSON.stringify(modelInfo, null, 2)}

## System
load (1m):      ${formatLoad(loadSnap.normalised)} (${loadSnap.loadavg1?.toFixed(2) ?? 'n/a'} / ${loadSnap.cpuCount} CPUs)
load_guard:     ${loadCfg.enabled ? `enabled (skip heavy jobs at ≥ ${loadCfg.threshold})` : 'disabled'}

## Exports
${handles.exports.map((e) => `- ${e.name}: ${JSON.stringify(e.getStatus())}`).join('\n')}
`);
  } finally {
    await stopAll(handles);
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
    const diskRows = await Promise.all(
      diskTargets.map(async (t) => ({ ...t, bytes: await measurePath(t.path) })),
    );
    const totalBytes = diskRows.reduce((acc, r) => acc + r.bytes, 0);

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

    if (args.flags.json) {
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify(
          {
            dataDir,
            storageRoot,
            disk: {
              total: totalBytes,
              breakdown: diskRows.map((r) => ({ label: r.label, path: r.path, bytes: r.bytes })),
            },
            events: {
              total: storageStats.totalEvents,
              oldest: storageStats.oldestEvent,
              newest: storageStats.newestEvent,
              byType: storageStats.eventsByType,
              topApps: storageStats.eventsByApp,
              activeDays: days.length,
              last7Days: byDay,
              today: captureStatus.eventsToday,
            },
            frames: { total: totalFrames, byTier: frameTiers },
            entities: { total: entityCount, recent: topEntities },
            index: {
              strategy: indexState.strategy,
              rootPath: indexState.rootPath,
              pageCount: indexState.pageCount,
              eventsCovered: indexState.eventsCovered,
              lastIncrementalRun: indexState.lastIncrementalRun,
              lastReorganisationRun: indexState.lastReorganisationRun,
            },
            capture: {
              running: captureStatus.running,
              paused: captureStatus.paused,
              eventsToday: captureStatus.eventsToday,
              storageBytesToday: captureStatus.storageBytesToday,
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
    const W = 64;

    out.push(color.bold(color.cyan('CofounderOS')) + color.dim('  •  stats')); 
    out.push(color.dim(`data dir: ${dataDir}`));
    out.push('');

    // ── Capture ────────────────────────────────────────────
    out.push(sectionHeader('Capture', W));
    const captureDot = captureStatus.running
      ? captureStatus.paused
        ? color.yellow('●') + ' paused'
        : color.green('●') + ' running'
      : color.red('●') + ' stopped';
    out.push(`  status     ${captureDot}`);
    out.push(
      `  today      ${color.bold(String(captureStatus.eventsToday))} events  ` +
        color.dim(`(${formatBytes(captureStatus.storageBytesToday)})`),
    );
    out.push('');

    // ── Disk usage ─────────────────────────────────────────
    out.push(sectionHeader(`Disk usage  ${color.dim('total')} ${color.bold(formatBytes(totalBytes))}`, W));
    const sortedDisk = [...diskRows].sort((a, b) => b.bytes - a.bytes);
    const labelW = Math.max(...sortedDisk.map((r) => r.label.length));
    for (const r of sortedDisk) {
      const pct = totalBytes > 0 ? r.bytes / totalBytes : 0;
      out.push(
        `  ${r.label.padEnd(labelW)}  ${formatBytes(r.bytes).padStart(9)}  ` +
          `${miniBar(pct, 16, 'cyan')} ${color.dim(formatPct(pct).padStart(4))}`,
      );
    }
    out.push('');

    // ── Events ─────────────────────────────────────────────
    out.push(sectionHeader('Events', W));
    out.push(`  total      ${color.bold(storageStats.totalEvents.toLocaleString())}`);
    out.push(
      `  range      ${storageStats.oldestEvent ? formatTs(storageStats.oldestEvent) : '-'} ${color.dim('→')} ` +
        `${storageStats.newestEvent ? formatTs(storageStats.newestEvent) : '-'}`,
    );
    if (days.length > 0) {
      out.push(`  active     ${days.length} days  ${color.dim(`(${days[0]} … ${days[days.length - 1]})`)}`);
    } else {
      out.push(`  active     ${days.length} days`);
    }
    out.push('');
    out.push(`  ${color.dim('last 7 days')}`);
    out.push(formatLast7Days(byDay));
    out.push('');
    out.push(`  ${color.dim('by type')}`);
    out.push(formatBreakdown(storageStats.eventsByType, 'magenta'));
    out.push('');
    out.push(`  ${color.dim('top apps')}`);
    out.push(formatBreakdown(storageStats.eventsByApp, 'blue'));
    out.push('');

    // ── Frames ─────────────────────────────────────────────
    out.push(sectionHeader(`Frames  ${color.dim('total')} ${color.bold(totalFrames.toLocaleString())}`, W));
    if (Object.keys(frameTiers).length === 0) {
      out.push(color.dim('  (none)'));
    } else {
      const tierOrder = ['original', 'compressed', 'thumbnail', 'deleted'] as const;
      const tierColors: Record<string, ColorName> = {
        original: 'green',
        compressed: 'cyan',
        thumbnail: 'blue',
        deleted: 'red',
      };
      for (const t of tierOrder) {
        const n = frameTiers[t] ?? 0;
        const pct = totalFrames > 0 ? n / totalFrames : 0;
        out.push(
          `  ${t.padEnd(11)}${String(n).padStart(7)}  ` +
            `${miniBar(pct, 16, tierColors[t] ?? 'cyan')} ${color.dim(formatPct(pct).padStart(4))}`,
        );
      }
    }
    out.push('');

    // ── Entities ───────────────────────────────────────────
    out.push(sectionHeader(`Entities  ${color.dim('total')} ${color.bold(entityCount.toLocaleString())}`, W));
    if (topEntities.length === 0) {
      out.push(color.dim('  (no entities resolved yet)'));
    } else {
      const titleW = Math.min(40, Math.max(...topEntities.map((e) => e.title.length)));
      const kindW = Math.max(...topEntities.map((e) => e.kind.length));
      for (const e of topEntities) {
        out.push(
          `  ${e.title.slice(0, titleW).padEnd(titleW)}  ` +
            `${color.dim(`[${e.kind.padEnd(kindW)}]`)}  ` +
            `${color.bold(String(e.frames).padStart(5))} ${color.dim('frames')}  ` +
            `${color.dim(formatRelativeTime(e.lastSeen))}`,
        );
      }
    }
    out.push('');

    // ── Index ──────────────────────────────────────────────
    out.push(sectionHeader(`Index  ${color.dim(indexState.strategy)}`, W));
    const idxBarColor: ColorName = indexedPct >= 95 ? 'green' : indexedPct >= 60 ? 'yellow' : 'red';
    out.push(
      `  coverage   ${miniBar(indexedPct / 100, 24, idxBarColor)} ` +
        `${color.bold(formatPct(indexedPct / 100).padStart(4))}  ` +
        `${color.dim(`${indexState.eventsCovered.toLocaleString()} / ${storageStats.totalEvents.toLocaleString()}`)}`,
    );
    out.push(`  pages      ${color.bold(String(indexState.pageCount))}`);
    out.push(`  last incr  ${lastIncremental}`);
    out.push(`  last reorg ${lastReorg}`);

    // eslint-disable-next-line no-console
    console.log(out.join('\n'));
  } finally {
    await stopAll(handles);
  }
}

/**
 * Best-effort recursive disk usage. Returns 0 for missing paths.
 * Used only by `stats` — small enough not to need streaming.
 */
async function measurePath(p: string): Promise<number> {
  let stat: import('node:fs').Stats;
  try {
    stat = await fsp.stat(p);
  } catch {
    return 0;
  }
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  let total = 0;
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fsp.readdir(p, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    total += await measurePath(path.join(p, e.name));
  }
  return total;
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

const COLORS_ENABLED = !!process.stdout.isTTY && !process.env.NO_COLOR;
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

function sectionHeader(title: string, width: number): string {
  const visible = visibleLen(title);
  const dashes = Math.max(2, width - visible - 4);
  return `${color.dim('──')} ${color.bold(title)} ${color.dim('─'.repeat(dashes))}`;
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

function formatBreakdown(record: Record<string, number>, c: ColorName): string {
  const entries = Object.entries(record)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
  if (entries.length === 0) return color.dim('    (none)');
  const total = entries.reduce((acc, [, v]) => acc + v, 0);
  const max = Math.max(...entries.map(([, v]) => v));
  const keyW = Math.min(20, Math.max(...entries.map(([k]) => k.length)));
  return entries
    .map(([k, v]) => {
      const pct = total > 0 ? v / total : 0;
      const barFrac = max > 0 ? v / max : 0;
      return (
        `    ${k.slice(0, keyW).padEnd(keyW)}  ${String(v).padStart(7)}  ` +
        `${miniBar(barFrac, 14, c)} ${color.dim(formatPct(pct).padStart(4))}`
      );
    })
    .join('\n');
}

function formatTs(iso: string): string {
  // Trim to "YYYY-MM-DD HH:MM" for readability.
  const t = iso.slice(0, 16).replace('T', ' ');
  return t || iso;
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
  const handles = await buildOrchestrator(logger, configFromArgs(args));
  try {
    await ensureModelOrFallback(handles, args);
    if (args.flags['full-reindex']) {
      await runFullReindex(handles, {
        from: typeof args.flags.from === 'string' ? args.flags.from : undefined,
        to: typeof args.flags.to === 'string' ? args.flags.to : undefined,
      });
    } else if (args.flags.reorganise || args.flags.reorg) {
      await runReorganisation(handles);
    } else {
      const result = await runIncremental(handles);
      // eslint-disable-next-line no-console
      console.log(`indexed ${result.eventsProcessed} events (${result.pagesCreated} created, ${result.pagesUpdated} updated)`);
    }
  } finally {
    await stopAll(handles);
  }
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
    // Re-instantiate the mcp export via the registry with stdio transport
    // — no static import of the plugin class, just config override.
    const stdioMcp = await handles.registry.loadExport('mcp', {
      dataDir: handles.loaded.dataDir,
      logger: handles.logger.child('mcp-stdio-cli'),
      config: { transport: 'stdio' },
    });
    if (typeof stdioMcp.bindServices === 'function') {
      stdioMcp.bindServices({
        storage: handles.storage,
        strategy: handles.strategy,
        dataDir: handles.loaded.dataDir,
        triggerReindex: async () => {
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
