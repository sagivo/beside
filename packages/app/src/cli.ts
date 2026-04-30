#!/usr/bin/env node
import process from 'node:process';
import path from 'node:path';
import { createLogger, writeDefaultConfigIfMissing, defaultDataDir } from '@cofounderos/core';
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
  start                      Start everything: capture + scheduled indexing + MCP server.
                             Bootstraps the model on first run.
  capture --once             Run a single capture cycle (sanity check, no scheduling).
  index --once               Run an incremental indexing pass against unindexed events.
  index --reorganise         Run a reorganisation pass (merges, splits, archives, summaries).
  index --full-reindex       Wipe the index and rebuild it from raw data.
                             Optional: --strategy <name>  --from <iso>  --to <iso>
  mcp [--stdio]              Run only the MCP server (HTTP by default; stdio for AI clients).
  plugin list                List discovered plugins by layer.

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
last incr run:  ${indexState.lastIncrementalRun ?? 'never'}
last reorg run: ${indexState.lastReorganisationRun ?? 'never'}

## Model
ready:          ${modelReady ? 'yes' : 'no — run `cofounderos init` to install/pull'}
${JSON.stringify(modelInfo, null, 2)}

## Exports
${handles.exports.map((e) => `- ${e.name}: ${JSON.stringify(e.getStatus())}`).join('\n')}
`);
  } finally {
    await stopAll(handles);
  }
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

  await waitForShutdown(handles);
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
    // Re-create with stdio transport.
    const McpExportCtor = (await import('@cofounderos/export-mcp')).McpExport;
    const stdioMcp = new McpExportCtor(
      { transport: 'stdio' },
      handles.logger.child('mcp-stdio-cli'),
    );
    stdioMcp.bindServices({
      storage: handles.storage,
      strategy: handles.strategy,
      triggerReindex: async () => {
        await runIncremental(handles);
      },
    });
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

function formatRecord(r: Record<string, number>): string {
  const entries = Object.entries(r).sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (entries.length === 0) return '(none)';
  return entries.map(([k, v]) => `${k}=${v}`).join(', ');
}

async function waitForShutdown(handles: OrchestratorHandles): Promise<void> {
  await new Promise<void>((resolve) => {
    const onSignal = (sig: string) => {
      handles.logger.info(`received ${sig}, shutting down…`);
      void stopAll(handles).then(() => resolve());
    };
    process.once('SIGINT', () => onSignal('SIGINT'));
    process.once('SIGTERM', () => onSignal('SIGTERM'));
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('fatal:', err);
  process.exit(1);
});

// Silence "unused import" if path tree-shakes it out of the bundle.
void path;
