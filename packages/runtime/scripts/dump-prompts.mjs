#!/usr/bin/env node
// Dump the actual prompts the harness sends to the model for each
// representative intent. Useful for auditing prompt quality without
// needing a real local model running.

import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(new URL('../../..', import.meta.url).pathname);
const harnessMod = await import(
  pathToFileURL(path.join(repoRoot, 'packages/runtime/dist/agent/harness.js')).href
);

// Re-use the smoke harness scaffolding inline.
const TODAY = new Date();
const TODAY_YMD = TODAY.toISOString().slice(0, 10);
function isoAt(h, m = 0) {
  const d = new Date(TODAY);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}

function frame(over) {
  return {
    id: over.id,
    timestamp: over.timestamp,
    day: TODAY_YMD,
    monitor: 0,
    app: over.app ?? 'Chrome',
    app_bundle_id: '',
    window_title: over.window_title ?? '',
    url: over.url ?? null,
    text: over.text ?? null,
    text_source: 'ocr',
    asset_path: over.asset_path ?? null,
    perceptual_hash: null,
    trigger: null,
    session_id: 'sess_demo',
    duration_ms: 30000,
    entity_path: over.entity_path ?? null,
    entity_kind: over.entity_kind ?? null,
    activity_session_id: 'asess_demo',
    source_event_ids: [],
  };
}

const FRAMES = [
  frame({
    id: 'f_cal_1',
    timestamp: isoAt(8, 45),
    app: 'Chrome',
    url: 'https://calendar.google.com/calendar/u/0/r',
    window_title: 'Google Calendar — Today',
    text: 'Today\n9:00 – 9:30 AM\nStandup with Maya\n11:30 AM – 12:00 PM\nInvestor Sync — Acme\n2:00 PM\nCofounderOS deep dive',
  }),
  frame({
    id: 'f_slack_1',
    timestamp: isoAt(10, 5),
    app: 'Slack',
    url: 'https://app.slack.com/client/T1/C2',
    window_title: 'Slack — #sdk-warn-alerts-prod',
    entity_path: 'channels/sdk-warn-alerts-prod',
    entity_kind: 'channel',
    text: '#sdk-warn-alerts-prod\nMaya 9:01 AM\nHey @sagiv any thoughts on the new alert routing? reply needed\n3 replies',
  }),
  frame({
    id: 'f_slack_tanya',
    timestamp: isoAt(11, 12),
    app: 'Slack',
    url: 'https://app.slack.com/client/T1/D9',
    window_title: 'Slack — Tanya Reyes (DM)',
    entity_path: 'contacts/tanya-reyes',
    entity_kind: 'contact',
    text: 'Tanya Reyes 11:10 AM\nI will push the migration script EOW. Doing today: review your draft. Not blocking.\nsagiv 11:11 AM\nsounds good, ping me when ready',
  }),
  frame({
    id: 'f_pr_1',
    timestamp: isoAt(13, 20),
    app: 'Chrome',
    url: 'https://github.com/cofounderos/core/pull/123',
    window_title: 'Pull Request #123 · cofounderos/core — Review requested',
    text: 'Review requested · sagiv wants to merge 3 commits into main. @you',
  }),
  frame({
    id: 'f_paris_1',
    timestamp: isoAt(15, 0),
    app: 'Notes',
    window_title: 'Trip planning — Paris',
    text: 'Paris itinerary: day one Louvre, day two Versailles. Booked AF flight 0042.',
  }),
  frame({
    id: 'f_cursor_1',
    timestamp: isoAt(16, 0),
    app: 'Cursor',
    window_title: 'cofounderos — index.ts',
    entity_path: 'projects/cofounderos',
    entity_kind: 'project',
    text: 'cofounderos repo, working on agent harness',
  }),
];

const SESSIONS = [
  {
    id: 's1',
    started_at: isoAt(9, 0),
    ended_at: isoAt(10, 30),
    active_ms: 90 * 60 * 1000,
    duration_ms: 90 * 60 * 1000,
    frame_count: 12,
    primary_app: 'Cursor',
    primary_entity_path: 'projects/cofounderos',
  },
  {
    id: 's2',
    started_at: isoAt(13, 0),
    ended_at: isoAt(14, 30),
    active_ms: 90 * 60 * 1000,
    duration_ms: 90 * 60 * 1000,
    frame_count: 10,
    primary_app: 'Slack',
    primary_entity_path: 'channels/sdk-warn-alerts-prod',
  },
];

const ENTITIES = [
  {
    path: 'projects/cofounderos',
    title: 'cofounderos',
    kind: 'project',
    lastSeen: isoAt(16, 30),
    frameCount: 24,
    totalFocusedMs: 4 * 60 * 60 * 1000,
  },
];

function ftsMatch(f, q) {
  const hay = `${f.app} ${f.window_title} ${f.url ?? ''} ${f.text ?? ''}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1)
    .some((t) => hay.includes(t));
}

const storage = {
  async init() {},
  async write() {},
  async writeAsset() {},
  async readEvents() { return []; },
  async countEvents() { return 0; },
  async readAsset() { return Buffer.alloc(0); },
  async listDays() { return [TODAY_YMD]; },
  async getStats() { return { totalEvents: 0, totalAssetBytes: 0, oldestEvent: null, newestEvent: null, eventsByType: {}, eventsByApp: {} }; },
  async isAvailable() { return true; },
  async markIndexed() {},
  async clearIndexCheckpoint() {},
  async getIndexCheckpoint() { return null; },
  getRoot() { return '/tmp/x'; },
  async upsertFrame() {},
  async searchFrames(q) {
    let c = FRAMES.slice();
    if (q.day) c = c.filter((f) => f.day === q.day);
    if (q.from) c = c.filter((f) => f.timestamp >= q.from);
    if (q.to) c = c.filter((f) => f.timestamp <= q.to);
    if (q.text) c = c.filter((f) => ftsMatch(f, q.text));
    return c.slice(0, q.limit ?? 50);
  },
  async getFrameContext(id, b, a) {
    const i = FRAMES.findIndex((f) => f.id === id);
    if (i === -1) return null;
    return { anchor: FRAMES[i], before: FRAMES.slice(Math.max(0, i - b), i), after: FRAMES.slice(i + 1, i + 1 + a) };
  },
  async getJournal() { return FRAMES; },
  async listFramesNeedingOcr() { return []; },
  async setFrameText() {},
  async markFramed() {},
  async listFramesNeedingEmbedding() { return []; },
  async upsertFrameEmbedding() {},
  async searchFrameEmbeddings() { return []; },
  async clearFrameEmbeddings() {},
  async listFramesNeedingResolution() { return []; },
  async resolveFrameToEntity() {},
  async rebuildEntityCounts() {},
  async getEntity(p) { return ENTITIES.find((e) => e.path === p) ?? null; },
  async listEntities() { return ENTITIES; },
  async searchEntities() { return ENTITIES; },
  async getEntityFrames(p) { return FRAMES.filter((f) => f.entity_path === p); },
  async listEntityCoOccurrences() { return []; },
  async getEntityTimeline() { return []; },
  async listSessions() { return SESSIONS; },
  async getSession() { return null; },
  async getSessionFrames() { return []; },
  async deleteFrame() { return { assetPath: null }; },
  async deleteAllMemory() { return { frames: 0, events: 0, assetBytes: 0 }; },
};

function makeRecorder({ route, intent }) {
  const prompts = [];
  return {
    prompts,
    async isAvailable() { return true; },
    getModelInfo() { return { name: 'fake', isLocal: true, supportsVision: false }; },
    async complete(p, opts) {
      prompts.push({ p, opts });
      if (opts?.responseFormat === 'json' && /You are the router/.test(p)) {
        return JSON.stringify({ route, intent });
      }
      if (/evidence-synthesis/.test(p)) return '**Synthesis:** stub.\n**Recent messages:** stub.';
      return 'STUB';
    },
    async completeStream(p, opts, onChunk) {
      prompts.push({ p, opts, streaming: true });
      onChunk('STUB');
      return 'STUB';
    },
    async completeWithVision(p) {
      prompts.push({ p, opts: {} });
      return '**Synthesis:** stub.\n**Recent messages:** stub.';
    },
  };
}

const logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return logger; } };

const cases = [
  { name: 'daily_briefing', message: "what's on my plate today?", route: 'tools', intent: 'daily_briefing' },
  { name: 'calendar_check', message: 'do i have meetings today?', route: 'tools', intent: 'calendar_check' },
  { name: 'open_loops', message: 'any open loops?', route: 'tools', intent: 'open_loops' },
  { name: 'recall_event', message: 'when did i plan paris?', route: 'tools', intent: 'recall_event' },
  { name: 'people_context', message: "what's the latest with Tanya?", route: 'tools', intent: 'people_context' },
  { name: 'time_audit', message: 'how much time today?', route: 'tools', intent: 'time_audit' },
  { name: 'project_status', message: 'status of cofounderos?', route: 'tools', intent: 'project_status' },
  { name: 'topic_deep_dive', message: "what's the latest with onboarding?", route: 'tools', intent: 'topic_deep_dive' },
  { name: 'direct', message: 'hello!', route: 'direct', intent: 'general' },
];

const target = process.argv[2];
const filtered = target ? cases.filter((c) => c.name === target) : cases;

for (const c of filtered) {
  const model = makeRecorder({ route: c.route, intent: c.intent });
  const { done } = harnessMod.runChatTurn(
    { storage, model, logger },
    { turnId: `t_${c.name}`, conversationId: 'conv', message: c.message, history: [] },
    () => {},
  );
  await done;
  console.log('\n========================================================================');
  console.log(`SCENARIO: ${c.name}  (message: ${JSON.stringify(c.message)})`);
  console.log('========================================================================');
  for (const [i, entry] of model.prompts.entries()) {
    console.log(`\n--- prompt ${i + 1} (${entry.streaming ? 'STREAM' : 'COMPLETE'})${entry.opts?.responseFormat ? ` json` : ''} ---`);
    if (entry.opts?.systemPrompt) {
      console.log('[SYSTEM]');
      console.log(entry.opts.systemPrompt);
      console.log('[/SYSTEM]');
    }
    console.log(entry.p);
  }
}
