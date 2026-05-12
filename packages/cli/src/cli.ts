#!/usr/bin/env node
import process from 'node:process';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import {
  createLogger, writeDefaultConfigIfMissing, defaultDataDir, loadConfig, expandPath, findWorkspaceRoot,
} from '@cofounderos/core';
import {
  assertHeavyWorkAllowed, buildOrchestrator, bootstrapModel, createRuntime,
  runIncremental, runReorganisation, runFullReindex, startAll, stopAll, useOfflineModel,
} from '@cofounderos/runtime';
import type { OrchestratorHandles } from '@cofounderos/runtime';
import { createBootstrapRenderer } from './bootstrap-progress.js';

interface ParsedArgs { command: string; flags: Record<string, string | boolean>; positional: string[]; }

function parseArgs(argv: string[]): ParsedArgs {
  const [command = 'help', ...rest] = argv;
  const flags: Record<string, string | boolean> = {}, positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] ?? '';
    if (arg.startsWith('--')) {
      const key = arg.slice(2), next = rest[i + 1];
      if (next && !next.startsWith('--')) { flags[key] = next; i++; } else flags[key] = true;
    } else positional.push(arg);
  }
  return { command, flags, positional };
}

function help(): void {
  console.log(`cofounderos — AI-powered device capture, knowledge indexing, and agent memory
Usage: cofounderos <command> [options]
Commands:
  init                       Write config.yaml + auto-install Ollama + pull default model
  status                     Show capture state, storage stats, and index state.
  doctor                     Preflight check for platform, deps, permissions, etc.
  stats (alias: info)        Detailed snapshot of your data. Optional: --json
  start                      Start capture + scheduled indexing + MCP server.
  capture --once             Run a single capture cycle.
  index --once               Run an incremental indexing pass.
  index --reorganise         Run a reorganisation pass.
  index --full-reindex       Wipe the index and rebuild it from raw data.
  index --reindex-from <date> Shortcut for --full-reindex --from <date>.
  mcp [--stdio]              Run only the MCP server.
  model:update               Re-pull the configured local model.
  plugin list                List discovered plugins by layer.
  reset [--yes]              Wipe everything and start from scratch.
Options:
  --config <path>            Override config.yaml path.
  --log-level level          debug|info|warn|error
  --offline                  Skip Ollama install/pull and use offline indexer.
  --no-bootstrap             Skip model bootstrap for this command.`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const logger = createLogger({ level: (args.flags['log-level'] as any) ?? 'info' });

  switch (args.command) {
    case 'help': case '--help': case '-h': help(); return;
    case 'init': return await cmdInit(logger, args);
    case 'status': return await cmdStatus(logger, args);
    case 'doctor': return await cmdDoctor(args);
    case 'stats': case 'info': return await cmdStats(logger, args);
    case 'start': return await cmdStart(logger, args);
    case 'capture': if (args.flags.once) return await cmdCaptureOnce(logger, args); else help(); return;
    case 'index': return await cmdIndex(logger, args);
    case 'mcp': return await cmdMcp(logger, args);
    case 'model:update': return await cmdModelUpdate(logger, args);
    case 'plugin': return await cmdPlugin(logger, args);
    case 'reset': return await cmdReset(logger, args);
    default: console.error(`Unknown command: ${args.command}\n`); help(); process.exitCode = 1;
  }
}

async function cmdInit(logger: ReturnType<typeof createLogger>, args: ParsedArgs): Promise<void> {
  const r = await writeDefaultConfigIfMissing(defaultDataDir());
  console.log(r.created ? `✓ Created ${r.path}` : `• Already exists: ${r.path}`);
  if (args.flags.offline || args.flags['no-bootstrap']) return console.log(`• Skipping model bootstrap.`);
  console.log('\nPreparing local AI model (Ollama + Gemma)…');
  const handles = await buildOrchestrator(logger, configFromArgs(args));
  try { await ensureModelOrFallback(handles, args); } finally { await stopAll(handles); }
  console.log('\n✓ CofounderOS is ready. Next: `cofounderos start`');
}

async function cmdStatus(logger: ReturnType<typeof createLogger>, args: ParsedArgs): Promise<void> {
  const overview = await createRuntime({ ...configFromArgs(args), logger }).getOverview();
  console.log(`# CofounderOS — status
## Capture\nrunning: ${overview.capture.running}\npaused: ${overview.capture.paused}\nevents today: ${overview.capture.eventsToday}\nstorage: ${formatBytes(overview.capture.storageBytesToday)}\nmemory: ${overview.capture.memoryMB} MB
## Storage\nroot: ${overview.storageRoot}\nevents: ${overview.storage.totalEvents}\nassets: ${formatBytes(overview.storage.totalAssetBytes)}\noldest: ${overview.storage.oldestEvent ?? '-'}\nnewest: ${overview.storage.newestEvent ?? '-'}
## Index (${overview.index.strategy})\nroot: ${overview.index.rootPath}\npages: ${overview.index.pageCount}\nevents: ${overview.index.eventsCovered}
## System\nload: ${formatLoad(overview.system.load)}\npower: ${formatPower(overview.system.power)}\nexports:\n${overview.exports.map((e) => `- ${e.name}`).join('\n')}`);
}

type DoctorStatus = 'ok' | 'warn' | 'fail' | 'info';
interface DoctorCheck { area: string; status: DoctorStatus; message: string; detail?: string; }

async function cmdDoctor(args: ParsedArgs): Promise<void> {
  const runtime = createRuntime(configFromArgs(args)), checks: DoctorCheck[] = await runtime.runDoctor();
  const n = Number(process.versions.node.split('.')[0] ?? 0);
  checks.unshift({ area: 'runtime', status: n >= 20 ? 'ok' : 'fail', message: `Node ${process.versions.node}`, detail: n >= 20 ? 'meets >=20' : 'install Node >=20' }, { area: 'runtime', status: 'info', message: `${process.platform} ${os.release()} (${process.arch})` });
  checks.push(...await Promise.all([checkImport('native', 'sharp', 'image encoding', 'fail'), checkImport('native', 'better-sqlite3', 'local SQLite storage', 'fail'), checkImport('capture', 'active-win', 'active window metadata', 'warn'), checkImport('capture', 'screenshot-desktop', 'screen capture', 'warn')]));

  if (process.platform === 'darwin') {
    checks.push(await checkCommand('capture', 'screencapture', 'macOS screen capture CLI'), await checkCommand('capture', 'osascript', 'macOS browser fallback'), { area: 'permissions', status: 'info', message: 'macOS requires permissions' });
  } else if (process.platform === 'linux') {
    checks.push({ area: 'capture', status: process.env.DISPLAY ? 'ok' : 'warn', message: process.env.DISPLAY ? 'X11 detected' : 'Wayland/headless partial capture' }, await checkCommand('capture', 'xprop', 'Linux active-window helper'));
  } else if (process.platform === 'win32') {
    checks.push(await checkCommand('bootstrap', 'winget', 'Windows Ollama auto-install'));
  }
  checks.push(...await checkNativeCaptureHelper((await runtime.readConfig()).config));

  const fails = checks.filter(c => c.status === 'fail').length, warns = checks.filter(c => c.status === 'warn').length;
  console.log(`# CofounderOS — doctor\n\n${checks.map(c => `- [${c.status}] ${c.area}: ${c.message}${c.detail ? `\n    ${c.detail}` : ''}`).join('\n')}\n\nsummary: ${fails} fail, ${warns} warn, ${checks.length - fails - warns} ok/info`);
  if (fails > 0) process.exitCode = 1;
}

async function checkImport(area: string, spec: string, purpose: string, failStatus: Extract<DoctorStatus, 'warn' | 'fail'>): Promise<DoctorCheck> {
  try { await import(spec); return { area, status: 'ok', message: `${spec} importable`, detail: purpose }; }
  catch (e) { return { area, status: failStatus, message: `${spec} failed`, detail: `${purpose}; ${e}` }; }
}

async function checkCommand(area: string, cmd: string, purpose: string): Promise<DoctorCheck> {
  const avail = await new Promise<boolean>((resolve) => { const c = spawn(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore', windowsHide: true }); c.on('exit', code => resolve(code === 0)); c.on('error', () => resolve(false)); });
  return { area, status: avail ? 'ok' : 'warn', message: avail ? `${cmd} found` : `${cmd} not found`, detail: purpose };
}

async function checkNativeCaptureHelper(config: any): Promise<DoctorCheck[]> {
  const p = config.capture.helper_path ? expandPath(config.capture.helper_path) : path.join(findWorkspaceRoot(process.cwd()), 'plugins', 'capture', 'native', 'dist', 'native', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'cofounderos-capture.exe' : 'cofounderos-capture');
  try { await fsp.access(p); return [{ area: 'native-capture', status: config.capture.plugin === 'native' ? 'ok' : 'info', message: 'native helper present', detail: p }]; }
  catch { return [{ area: 'native-capture', status: config.capture.plugin === 'native' ? 'fail' : 'info', message: 'native helper not built', detail: 'Run pnpm build:plugins' }]; }
}

async function cmdStats(logger: ReturnType<typeof createLogger>, args: ParsedArgs): Promise<void> {
  const h = await buildOrchestrator(logger, configFromArgs(args));
  try {
    const sr = h.storage.getRoot(), dd = h.loaded.dataDir, is = await h.strategy.getState(), ss = await h.storage.getStats(), cs = h.capture.getStatus(), days = await h.storage.listDays(), mi = h.model.getModelInfo(), mr = await h.model.isAvailable().catch(() => false), fb = await measureFreeBytes(dd);
    const l1h = await h.storage.readEvents({ from: new Date(Date.now() - 3600000).toISOString(), limit: 50000 }), dk = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const bl = await h.storage.readEvents({ unindexed_for_strategy: is.strategy, limit: 5000 }).catch(() => []);
    const [po, pr, pe] = await Promise.all([h.storage.listFramesNeedingOcr(1000).catch(() => []), h.storage.listFramesNeedingResolution(1000).catch(() => []), h.storage.listFramesNeedingEmbedding(mi.name, 1000).catch(() => [])]);
    const mcpRef = h.config.export.plugins.find((p: any) => p.name === 'mcp') as any, mcp = mcpRef?.enabled !== false ? `http://${mcpRef?.host ?? '127.0.0.1'}:${mcpRef?.port ?? 3456}` : null, mcpOk = mcp ? await fetch(`${mcp}/health`).then(r => r.ok).catch(() => false) : false;
    
    const dr = await Promise.all([{ label: 'raw', path: path.join(sr, 'raw') }, { label: 'checkpoints', path: path.join(sr, 'checkpoints') }, { label: 'db', path: path.join(sr, 'cofounderOS.db') }, { label: 'wal', path: path.join(sr, 'cofounderOS.db-wal') }, { label: 'index', path: is.rootPath }, { label: 'exports', path: path.join(dd, 'export') }].map(async t => ({ ...t, ...(await measurePathDetailed(t.path, Date.now())) })));
    const tb = dr.reduce((a, r) => a + r.totalBytes, 0), dbh = new Array(24).fill(0); dr.forEach(r => r.recentByHour.forEach((v, i) => dbh[i] += v));
    const ft = (await h.storage.countFramesByTier().catch(() => {})) as Record<string, number> ?? {}, tf = Object.values(ft).reduce((a, b) => a + b, 0), ents = await h.storage.listEntities({}).catch(() => []);
    const rec = await h.storage.readEvents({ from: new Date(Date.now() - 7 * 86400000).toISOString(), limit: 50000 }), bd: Record<string, number> = {}; rec.forEach(e => { const d = e.timestamp.slice(0, 10); bd[d] = (bd[d] ?? 0) + 1; });
    const et = bd[dk(new Date())] ?? 0, ey = bd[dk(new Date(Date.now() - 86400000))] ?? 0;

    if (args.flags.json) return console.log(JSON.stringify({ dataDir: dd, storageRoot: sr, disk: { total: tb, free: fb, breakdown: dr.map(r => ({ label: r.label, bytes: r.totalBytes })), last24Hours: dbh }, events: { total: ss.totalEvents, today: et, yesterday: ey, lastHour: l1h.length }, frames: { total: tf, byTier: ft, pending: { ocr: po.length, resolve: pr.length, embed: pe.length } }, entities: { total: ents.length }, index: { strategy: is.strategy, pages: is.pageCount, coverage: is.eventsCovered, backlog: bl.length }, model: { name: mi.name, local: mi.isLocal, ready: mr }, mcp: mcp ? { enabled: true, url: mcp, ready: mcpOk } : { enabled: false } }, null, 2));

    const ipct = ss.totalEvents > 0 ? Math.round((is.eventsCovered / ss.totalEvents) * 100) : 0, r24 = dbh.reduce((a, b) => a + b, 0), sd = [...dr].sort((a, b) => b.totalBytes - a.totalBytes);
    console.log(`${color.bold(color.cyan('CofounderOS'))} stats\n\nCapture: ${cs.running ? (cs.paused ? 'paused' : 'running') : 'stopped'}, ${et} today (${formatBytes(cs.storageBytesToday)})\nIndex: ${ipct}% coverage (${is.pageCount} pages, ${is.eventsCovered}/${ss.totalEvents} events, backlog: ${bl.length})\nModel: ${mi.name} (${mr ? 'ready' : 'offline'})\nMCP: ${mcp ? (mcpOk ? 'listening' : 'offline') : 'disabled'}\nStorage: ${formatBytes(tb)} total${fb ? ` (${formatBytes(fb)} free)` : ''}\n  24h writes: ${formatBytes(r24)}\n  ${sd.slice(0, 3).map(r => `${r.label}: ${formatBytes(r.totalBytes)}`).join(' | ')}\nActivity: ${et} today, ${ey} yesterday\nFrames: ${tf} total\nEntities: ${ents.length} total`);
  } finally { await stopAll(h); }
}

async function measurePathDetailed(p: string, now: number): Promise<{ totalBytes: number; recentByHour: number[] }> {
  const rbh = new Array(24).fill(0); let tb = 0, hMs = 86400000;
  async function walk(fp: string) {
    try {
      const s = await fsp.stat(fp);
      if (s.isFile()) { tb += s.size; const age = now - s.mtimeMs; if (age >= 0 && age < hMs) { const b = 23 - Math.floor(age / 3600000); if (b >= 0 && b < 24) rbh[b] += s.size; } }
      else if (s.isDirectory()) for (const e of await fsp.readdir(fp, { withFileTypes: true })) await walk(path.join(fp, e.name));
    } catch {}
  }
  await walk(p); return { totalBytes: tb, recentByHour: rbh };
}

const color = { bold: (s: string) => `\x1b[1m${s}\x1b[0m`, dim: (s: string) => `\x1b[2m${s}\x1b[0m`, cyan: (s: string) => `\x1b[36m${s}\x1b[0m`, green: (s: string) => `\x1b[32m${s}\x1b[0m`, yellow: (s: string) => `\x1b[33m${s}\x1b[0m`, red: (s: string) => `\x1b[31m${s}\x1b[0m` };

function formatBytes(n: number) { const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0, v = n; while (v >= 1024 && i < 4) { v /= 1024; i++; } return `${v.toFixed(1)} ${u[i]}`; }
function formatLoad(n: number | null) { return n == null ? 'n/a' : `${(n * 100).toFixed(0)}%`; }
function formatPower(p: any) { return `${p.source}${p.batteryPercent != null ? ` (${p.batteryPercent}%)` : ''}`; }
async function measureFreeBytes(p: string) { try { const s = await (fsp as any).statfs?.(p); return s ? s.bsize * s.bavail : null; } catch { return null; } }

async function ensureModelOrFallback(h: OrchestratorHandles, a: ParsedArgs) {
  if (a.flags.offline || a.flags['no-bootstrap']) return a.flags.offline ? useOfflineModel(h) : undefined;
  const { handler, finalize } = createBootstrapRenderer();
  try { await bootstrapModel(h, handler); finalize(); } catch (err) { finalize(); console.error(`✗ Model bootstrap failed: ${err}\nFalling back to offline mode.`); useOfflineModel(h); }
}

async function cmdStart(logger: ReturnType<typeof createLogger>, args: ParsedArgs) {
  const handles = await buildOrchestrator(logger, configFromArgs(args));
  await ensureModelOrFallback(handles, args);
  await startAll(handles);
  logger.info(`CofounderOS running. MCP: ${handles.exports.find(e => e.name === 'mcp')?.getStatus()}`);
  if (process.env.COFOUNDEROS_DEV === '1') setTimeout(() => runFullReindex(handles).catch(() => {}), 60000).unref();
  await waitForShutdown(handles);
}

async function cmdCaptureOnce(logger: ReturnType<typeof createLogger>, args: ParsedArgs) {
  const handles = await buildOrchestrator(logger, configFromArgs(args));
  try { if (typeof (handles.capture as any).tickOnce === 'function') await (handles.capture as any).tickOnce(); else { await handles.capture.start(); await new Promise(r => setTimeout(r, 5000)); await handles.capture.stop(); } } finally { await stopAll(handles); }
}

async function cmdIndex(logger: ReturnType<typeof createLogger>, args: ParsedArgs) {
  const full = Boolean(args.flags['full-reindex'] || args.flags['reindex-from'] || args.flags.since);
  const from = args.flags['reindex-from'] || args.flags.since || args.flags.from;
  const handles = await buildOrchestrator(logger, configFromArgs(args));
  try {
    await ensureModelOrFallback(handles, args);
    if (full) await runFullReindex(handles, { from: from as string });
    else if (args.flags.reorganise || args.flags.reorg) await runReorganisation(handles);
    else console.log(`Indexed ${(await runIncremental(handles)).eventsProcessed} events`);
  } finally { await stopAll(handles); }
}

async function cmdMcp(logger: ReturnType<typeof createLogger>, args: ParsedArgs) {
  const handles = await buildOrchestrator(logger, configFromArgs(args));
  await ensureModelOrFallback(handles, args);
  const stdio = Boolean(args.flags.stdio), mcp = handles.exports.find(e => e.name === 'mcp');
  if (!mcp) return logger.error('MCP export not configured.');
  if (stdio) {
    const sm = await handles.registry.loadExport('mcp', { dataDir: handles.loaded.dataDir, logger: handles.logger.child('mcp'), config: { ...(handles.config.export.plugins.find(p => p.name === 'mcp') as any), transport: 'stdio' } });
    sm.bindServices?.({ storage: handles.storage, strategy: handles.strategy, model: handles.model, embeddingModelName: handles.embeddingWorker.getModelName(), embeddingSearchWeight: handles.config.index.embeddings.search_weight, dataDir: handles.loaded.dataDir, triggerReindex: async (f) => { if (f) await runFullReindex(handles); else await runIncremental(handles); } });
    await sm.start();
  } else { await mcp.start(); logger.info('MCP running. Ctrl+C to stop.'); }
  await waitForShutdown(handles);
}

async function cmdPlugin(logger: ReturnType<typeof createLogger>, args: ParsedArgs) {
  if (args.positional[0] !== 'list') return help();
  const handles = await buildOrchestrator(logger, configFromArgs(args));
  try {
    console.log('# Plugins\n');
    for (const l of ['capture', 'storage', 'model', 'index', 'export']) {
      console.log(`## ${l}\n` + handles.registry.list().filter(p => p.manifest.layer === l).map(p => `  - ${p.manifest.name} (${p.packageName} v${p.manifest.version})`).join('\n'));
    }
  } finally { await stopAll(handles); }
}

async function cmdModelUpdate(logger: ReturnType<typeof createLogger>, args: ParsedArgs) {
  if (args.flags.offline) return console.log('Skipping model:update (offline).');
  const handles = await buildOrchestrator(logger, configFromArgs(args));
  try {
    if (typeof handles.model.ensureReady !== 'function') return console.log(`Plugin ${handles.model.getModelInfo().name} does not manage local weights.`);
    console.log(`Refreshing local model weights for ${handles.model.getModelInfo().name}…`);
    const { handler, finalize } = createBootstrapRenderer();
    await bootstrapModel(handles, handler, { force: true }); finalize();
    console.log(`✓ Up to date.`);
  } catch (err) { console.error(`✗ Update failed: ${err}`); process.exitCode = 1; } finally { await stopAll(handles); }
}

async function cmdReset(logger: ReturnType<typeof createLogger>, args: ParsedArgs) {
  const loaded = await loadConfig((configFromArgs(args) as any).configPath);
  const sr = expandPath(loaded.config.storage.local.path), ir = expandPath(loaded.config.index.index_path);
  const targets = [{ label: 'raw', path: path.join(sr, 'raw') }, { label: 'db', path: path.join(sr, 'cofounderOS.db') }, { label: 'index', path: ir }];
  if (args.flags['keep-config'] === false) targets.push({ label: 'config.yaml', path: loaded.sourcePath });

  console.log('cofounderos reset — the following will be deleted:\n' + targets.map(t => `  · ${t.label}: ${t.path}`).join('\n') + '\n');
  if (!args.flags.yes && !args.flags.y) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ok = await new Promise(r => rl.question('Type "wipe" to confirm: ', a => { rl.close(); r(a.trim() === 'wipe'); }));
    if (!ok) return console.log('Aborted.');
  }
  for (const t of targets) await fsp.rm(t.path, { recursive: true, force: true }).catch(() => {});
  console.log('✓ Reset complete.');
}

function configFromArgs(args: ParsedArgs) { return typeof args.flags.config === 'string' ? { configPath: args.flags.config } : {}; }

async function waitForShutdown(handles: OrchestratorHandles) {
  await new Promise<void>((resolve) => {
    let shuttingDown = false;
    const onSig = (s: string) => {
      if (shuttingDown) process.exit(1); shuttingDown = true;
      handles.logger.info(`received ${s}, shutting down…`);
      const t = setTimeout(() => process.exit(1), 3000); t.unref();
      stopAll(handles).finally(() => { clearTimeout(t); resolve(); });
    };
    ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'].forEach(s => process.once(s, () => onSig(s)));
  });
  process.exit(0);
}

main().catch((err) => { console.error('fatal:', err); process.exit(1); });
