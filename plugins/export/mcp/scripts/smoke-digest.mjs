#!/usr/bin/env node
// End-to-end smoke test: build a daily digest and an entity summary
// against the live local storage. Read-only — does not write to disk.
//
// Usage: node plugins/export/mcp/scripts/smoke-digest.mjs [YYYY-MM-DD]

import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const dataDir = process.env.COFOUNDEROS_DATA_DIR || path.join(os.homedir(), '.cofounderOS');
const day = process.argv[2] || new Date().toISOString().slice(0, 10);

const repoRoot = path.resolve(new URL('../../../..', import.meta.url).pathname);

// Use the dist outputs so we don't need a TS runtime.
const storageMod = await import(
  pathToFileURL(path.join(repoRoot, 'plugins/storage/local/dist/index.js')).href
);
const digestMod = await import(
  pathToFileURL(path.join(repoRoot, 'plugins/export/mcp/dist/digest.js')).href
);

const StorageFactory = storageMod.default;
const logger = {
  debug: () => {},
  info: () => {},
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  child: () => logger,
};

const storage = await StorageFactory({
  dataDir,
  logger,
  config: { path: dataDir },
});
await storage.init();

const summary = await digestMod.buildDailySummary(storage, day);
const trim = (obj, keys) => {
  const out = {};
  for (const k of keys) out[k] = obj[k];
  return out;
};

console.log('--- get_daily_summary —', day, '---');
console.log(
  JSON.stringify(
    {
      day: summary.day,
      totals: summary.totals,
      top_apps: summary.top_apps.slice(0, 5),
      top_entities: summary.top_entities.slice(0, 5),
      top_url_hosts: summary.top_url_hosts.slice(0, 5),
      session_count: summary.sessions.length,
      first_session: summary.sessions[0] ?? null,
      calendar_events: summary.calendar_events.slice(0, 5),
      open_loops: summary.open_loops.slice(0, 5),
      slack_threads: summary.slack_threads.slice(0, 3).map((t) =>
        trim(t, ['channel', 'observation_count', 'last_seen', 'looks_unanswered']),
      ),
      review_queue: summary.review_queue.slice(0, 5).map((r) =>
        trim(r, ['ref', 'status', 'observation_count', 'last_seen']),
      ),
      notes: summary.notes,
    },
    null,
    2,
  ),
);

if (summary.top_entities.length > 0) {
  const top = summary.top_entities[0];
  const entitySummary = await digestMod.buildEntitySummary(storage, top.path, {
    detail_limit: 5,
  });
  console.log(`\n--- get_entity_summary — ${top.path} (top entity of day) ---`);
  if (entitySummary) {
    console.log(
      JSON.stringify(
        {
          path: entitySummary.path,
          kind: entitySummary.kind,
          totals: entitySummary.totals,
          top_window_titles: entitySummary.top_window_titles,
          top_url_hosts: entitySummary.top_url_hosts,
          recent_sessions: entitySummary.recent_sessions,
          calendar_events: entitySummary.calendar_events,
          open_loops: entitySummary.open_loops,
          notes: entitySummary.notes,
        },
        null,
        2,
      ),
    );
  } else {
    console.log('(entity not found)');
  }
}
