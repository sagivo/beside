#!/usr/bin/env node
// Smoke + audit harness for the in-process chat agent.
//
// What it does:
//   1. Builds a fake IStorage with synthetic frames / sessions / entities.
//   2. Builds a scriptable IModelAdapter that:
//        - records every prompt that was sent to it;
//        - returns a canned response so we exercise the full
//          classify → plan → execute → compose pipeline deterministically.
//   3. Runs `runChatTurn` for a battery of representative messages
//      covering every intent the harness understands.
//   4. Captures the emitted stream events and the final answer text,
//      then audits both against the harness's own hard rules
//      (no closers, no inventing app/channel/people names, follow the
//      output template, no hallucinated stats, etc).
//
// Usage:
//   node packages/runtime/scripts/smoke-harness.mjs
//   node packages/runtime/scripts/smoke-harness.mjs --verbose
//   node packages/runtime/scripts/smoke-harness.mjs --only people_context

import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(new URL('../../..', import.meta.url).pathname);
const harnessMod = await import(
  pathToFileURL(path.join(repoRoot, 'packages/runtime/dist/agent/harness.js')).href
);

const args = new Set(process.argv.slice(2));
const verbose = args.has('--verbose') || args.has('-v');
const onlyArgIdx = process.argv.indexOf('--only');
const only = onlyArgIdx >= 0 ? process.argv[onlyArgIdx + 1] : null;

// ---------------------------------------------------------------------------
// Fake storage
// ---------------------------------------------------------------------------

const TODAY = new Date();
const TODAY_YMD = TODAY.toISOString().slice(0, 10);
function isoAt(hours, minutes = 0) {
  const d = new Date(TODAY);
  d.setHours(hours, minutes, 0, 0);
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
  // Calendar UI
  frame({
    id: 'f_cal_1',
    timestamp: isoAt(8, 45),
    app: 'Chrome',
    url: 'https://calendar.google.com/calendar/u/0/r',
    window_title: 'Google Calendar — Today',
    text: [
      'Today',
      '9:00 – 9:30 AM',
      'Standup with Maya',
      '11:30 AM – 12:00 PM',
      'Investor Sync — Acme',
      '2:00 PM',
      'Beside deep dive',
    ].join('\n'),
  }),
  // Slack channel with unanswered mention
  frame({
    id: 'f_slack_1',
    timestamp: isoAt(10, 5),
    app: 'Slack',
    url: 'https://app.slack.com/client/T1/C2',
    window_title: 'Slack — #sdk-warn-alerts-prod',
    entity_path: 'channels/sdk-warn-alerts-prod',
    entity_kind: 'channel',
    text: [
      '#sdk-warn-alerts-prod',
      'Maya 9:01 AM',
      'Hey @alex any thoughts on the new alert routing? reply needed',
      '3 replies',
    ].join('\n'),
  }),
  // Slack DM with Tanya — the "people_context" story
  frame({
    id: 'f_slack_tanya',
    timestamp: isoAt(11, 12),
    app: 'Slack',
    url: 'https://app.slack.com/client/T1/D9',
    window_title: 'Slack — Tanya Reyes (DM)',
    entity_path: 'contacts/tanya-reyes',
    entity_kind: 'contact',
    text: [
      'Tanya Reyes 11:10 AM',
      'I will push the migration script EOW. Doing today: review your draft. Not blocking.',
      'Alex 11:11 AM',
      'sounds good, ping me when ready',
    ].join('\n'),
  }),
  // GitHub PR review pending
  frame({
    id: 'f_pr_1',
    timestamp: isoAt(13, 20),
    app: 'Chrome',
    url: 'https://github.com/beside/core/pull/123',
    window_title: 'Pull Request #123 · beside/core — Review requested',
    text: 'Review requested · Alex wants to merge 3 commits into main. @you',
  }),
  // Recall_event target
  frame({
    id: 'f_paris_1',
    timestamp: isoAt(15, 0),
    app: 'Notes',
    window_title: 'Trip planning — Paris',
    text: 'Paris itinerary: day one Louvre, day two Versailles. Booked AF flight 0042.',
  }),
  // Generic working frame for time_audit top entity
  frame({
    id: 'f_cursor_1',
    timestamp: isoAt(16, 0),
    app: 'Cursor',
    window_title: 'beside — index.ts',
    entity_path: 'projects/beside',
    entity_kind: 'project',
    text: 'beside repo, working on agent harness',
  }),
];

function session(id, startH, startM, endH, endM, app, entity) {
  const started = isoAt(startH, startM);
  const ended = isoAt(endH, endM);
  const ms = Date.parse(ended) - Date.parse(started);
  return {
    id,
    started_at: started,
    ended_at: ended,
    active_ms: ms,
    duration_ms: ms,
    frame_count: 12,
    primary_app: app,
    primary_entity_path: entity ?? null,
  };
}

const SESSIONS = [
  session('s1', 9, 0, 10, 30, 'Cursor', 'projects/beside'),
  session('s2', 10, 30, 11, 30, 'Slack', 'channels/sdk-warn-alerts-prod'),
  session('s3', 13, 0, 14, 30, 'Chrome', 'projects/beside'),
  session('s4', 15, 0, 16, 30, 'Cursor', 'projects/beside'),
];

const ENTITIES = [
  {
    path: 'projects/beside',
    title: 'beside',
    kind: 'project',
    lastSeen: isoAt(16, 30),
    frameCount: 24,
    totalFocusedMs: 4 * 60 * 60 * 1000,
  },
  {
    path: 'contacts/tanya-reyes',
    title: 'Tanya Reyes',
    kind: 'contact',
    lastSeen: isoAt(11, 12),
    frameCount: 6,
    totalFocusedMs: 30 * 60 * 1000,
  },
  {
    path: 'channels/sdk-warn-alerts-prod',
    title: '#sdk-warn-alerts-prod',
    kind: 'channel',
    lastSeen: isoAt(10, 5),
    frameCount: 4,
    totalFocusedMs: 20 * 60 * 1000,
  },
];

function ftsMatch(frame, query) {
  const q = query.toLowerCase();
  const hay = `${frame.app} ${frame.window_title} ${frame.url ?? ''} ${frame.text ?? ''} ${frame.entity_path ?? ''}`.toLowerCase();
  const tokens = q.split(/\s+/).filter((t) => t.length > 1);
  if (tokens.length === 0) return false;
  return tokens.some((t) => hay.includes(t));
}

const fakeStorage = {
  async init() {},
  async write() {},
  async writeAsset() {},
  async readEvents() {
    return [];
  },
  async countEvents() {
    return 0;
  },
  async readAsset() {
    return Buffer.alloc(0);
  },
  async listDays() {
    return [TODAY_YMD];
  },
  async getStats() {
    return {
      totalEvents: 0,
      totalAssetBytes: 0,
      oldestEvent: null,
      newestEvent: null,
      eventsByType: {},
      eventsByApp: {},
    };
  },
  async isAvailable() {
    return true;
  },
  async markIndexed() {},
  async clearIndexCheckpoint() {},
  async getIndexCheckpoint() {
    return null;
  },
  getRoot() {
    return '/tmp/fake-storage-root';
  },
  async upsertFrame() {},
  async searchFrames(query) {
    let candidates = FRAMES.slice();
    if (query.day) candidates = candidates.filter((f) => f.day === query.day);
    if (query.from) candidates = candidates.filter((f) => f.timestamp >= query.from);
    if (query.to) candidates = candidates.filter((f) => f.timestamp <= query.to);
    if (query.text) candidates = candidates.filter((f) => ftsMatch(f, query.text));
    candidates.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return candidates.slice(0, query.limit ?? 50);
  },
  async getFrameContext(frameId, before, after) {
    const idx = FRAMES.findIndex((f) => f.id === frameId);
    if (idx === -1) return null;
    return {
      anchor: FRAMES[idx],
      before: FRAMES.slice(Math.max(0, idx - before), idx),
      after: FRAMES.slice(idx + 1, idx + 1 + after),
    };
  },
  async getJournal() {
    return FRAMES;
  },
  async listFramesNeedingOcr() {
    return [];
  },
  async setFrameText() {},
  async markFramed() {},
  async listFramesNeedingEmbedding() {
    return [];
  },
  async upsertFrameEmbedding() {},
  async searchFrameEmbeddings() {
    return [];
  },
  async clearFrameEmbeddings() {},
  async listFramesNeedingResolution() {
    return [];
  },
  async resolveFrameToEntity() {},
  async rebuildEntityCounts() {},
  async getEntity(path) {
    return ENTITIES.find((e) => e.path === path) ?? null;
  },
  async listEntities(query) {
    let out = ENTITIES.slice();
    if (query.kind) out = out.filter((e) => e.kind === query.kind);
    return out.slice(0, query.limit ?? 25);
  },
  async searchEntities(query) {
    const q = (query.text ?? '').toLowerCase();
    let out = ENTITIES.filter((e) =>
      e.title.toLowerCase().includes(q) || e.path.toLowerCase().includes(q),
    );
    if (query.kind) out = out.filter((e) => e.kind === query.kind);
    return out.slice(0, query.limit ?? 25);
  },
  async getEntityFrames(entityPath, limit) {
    return FRAMES.filter((f) => f.entity_path === entityPath).slice(0, limit ?? 10);
  },
  async listEntityCoOccurrences() {
    return [];
  },
  async getEntityTimeline() {
    return [];
  },
  async listSessions(query) {
    let out = SESSIONS.slice();
    if (query.day) out = out.filter((s) => s.started_at.slice(0, 10) === query.day);
    if (query.order === 'chronological') out.sort((a, b) => a.started_at.localeCompare(b.started_at));
    else out.sort((a, b) => b.started_at.localeCompare(a.started_at));
    return out.slice(0, query.limit ?? 60);
  },
  async getSession(id) {
    return SESSIONS.find((s) => s.id === id) ?? null;
  },
  async getSessionFrames() {
    return [];
  },
  async deleteFrame() {
    return { assetPath: null };
  },
  async deleteAllMemory() {
    return { frames: 0, events: 0, assetBytes: 0 };
  },
};

// ---------------------------------------------------------------------------
// Scriptable model
// ---------------------------------------------------------------------------

function createScriptedModel({ scenario }) {
  const prompts = [];
  const completions = [];

  return {
    prompts,
    completions,
    async isAvailable() {
      return true;
    },
    getModelInfo() {
      return {
        name: 'fake-llm',
        isLocal: true,
        supportsVision: false,
      };
    },
    async complete(prompt, options) {
      prompts.push({ prompt, options, kind: 'complete' });
      // Router gate: emits JSON. Pick a plausible route based on scenario hint.
      if (options?.responseFormat === 'json' && /You are the router/.test(prompt)) {
        const out = JSON.stringify(scenario.routerJson);
        completions.push({ kind: 'route', out });
        return out;
      }
      // Intent classifier (cheaper path; we don't usually hit it because the
      // router covers it, but include it anyway).
      if (options?.responseFormat === 'json' && /classify/.test(prompt) === false && /Possible intents/.test(prompt)) {
        const out = JSON.stringify({ intent: scenario.routerJson.intent ?? 'general' });
        completions.push({ kind: 'intent', out });
        return out;
      }
      // People synthesis
      if (/evidence-synthesis step for Beside/.test(prompt)) {
        const out = scenario.peopleSynthesis ?? 'No useful update found.';
        completions.push({ kind: 'people-synthesis', out });
        return out;
      }
      // Final compose (non-streaming fallback)
      const out = scenario.composeAnswer ?? 'STUB ANSWER';
      completions.push({ kind: 'compose', out });
      return out;
    },
    async completeStream(prompt, options, onChunk) {
      prompts.push({ prompt, options, kind: 'completeStream' });
      const out = scenario.composeAnswer ?? 'STUB ANSWER';
      // Stream in two chunks to exercise the streaming path.
      const half = Math.floor(out.length / 2);
      onChunk(out.slice(0, half));
      onChunk(out.slice(half));
      completions.push({ kind: 'compose-stream', out });
      return out;
    },
    async completeWithVision(prompt) {
      prompts.push({ prompt, options: {}, kind: 'completeWithVision' });
      const out = scenario.peopleSynthesis ?? 'No useful update found.';
      completions.push({ kind: 'people-vision', out });
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Audit rules
// ---------------------------------------------------------------------------

const FORBIDDEN_CLOSERS = [
  'what else can i help',
  'let me know if',
  'hope this helps',
  'happy to help',
  'feel free to ask',
];

const PREAMBLES = [
  'sure!',
  'sure,',
  'based on your data,',
  'based on the context provided',
  'based on the captured',
];

function auditAnswer({ scenario, answer, prompts }) {
  const findings = [];
  const lower = answer.toLowerCase();

  // 1. Closers (rule from prompts.ts).
  for (const c of FORBIDDEN_CLOSERS) {
    if (lower.includes(c)) findings.push({ severity: 'fail', rule: 'closer', detail: c });
  }
  // 2. Preambles.
  for (const p of PREAMBLES) {
    if (lower.startsWith(p)) findings.push({ severity: 'fail', rule: 'preamble', detail: p });
  }
  // 3. Frame-count / session-count stats unless time_audit.
  if (scenario.intent !== 'time_audit') {
    if (/\b\d+\s+frames?\b/i.test(answer)) {
      findings.push({ severity: 'fail', rule: 'stats-frames', detail: 'frame count leaked' });
    }
    if (/\b\d+\s+sessions?\b/i.test(answer) && scenario.intent !== 'day_overview') {
      // day overview says "across N sessions" sometimes — flag separately
      findings.push({ severity: 'warn', rule: 'stats-sessions', detail: 'session count' });
    }
  }
  // 4. Output template adherence: per-intent expected leading marker.
  const heads = {
    day_overview: /\*\*today'?s calendar:?\*\*/i,
    calendar_check: /\*\*\d{1,2}:\d{2}\s*(am|pm)?\*\*/i,
    open_loops: /^[-*]\s+/m,
    time_audit: /you spent\s+\*\*/i,
    project_status: /[a-z]/i, // weak — just must not be empty
    people_context: /[a-z]/i,
  };
  if (heads[scenario.intent] && !heads[scenario.intent].test(answer) && answer.trim().length > 0) {
    findings.push({
      severity: 'warn',
      rule: 'template',
      detail: `expected per-intent shape for ${scenario.intent}`,
    });
  }
  // 5. Hallucination canary: if scenario.canary is set, the model should
  //    NOT have invented anything from that list.
  for (const word of scenario.hallucinationCanary ?? []) {
    if (lower.includes(word.toLowerCase())) {
      findings.push({ severity: 'fail', rule: 'hallucination', detail: word });
    }
  }
  // 6. Empty answer.
  if (!answer.trim()) {
    findings.push({ severity: 'fail', rule: 'empty', detail: 'no content emitted' });
  }
  // 7. Prompt-level checks: tools-mode compose must include the CONTEXT
  //    block — but only when we actually expected the model to compose
  //    (skip both the direct path AND the no-evidence short-circuit).
  const composePrompt = prompts.find(
    (p) => p.kind === 'completeStream' || (p.kind === 'complete' && /OUTPUT FORMAT/.test(p.prompt)),
  );
  if (
    scenario.expectsTools &&
    !scenario.expectShortCircuitNoEvidence &&
    !composePrompt
  ) {
    findings.push({ severity: 'fail', rule: 'missing-compose', detail: 'no compose prompt was sent' });
  }
  if (
    scenario.expectsTools &&
    composePrompt &&
    !/CONTEXT:/.test(composePrompt.prompt)
  ) {
    findings.push({ severity: 'fail', rule: 'missing-context', detail: 'compose prompt lacks CONTEXT block' });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const SCENARIOS = [
  {
    name: 'day_overview — clean',
    message: "What's on my plate today?",
    intent: 'day_overview',
    routerJson: { route: 'tools', intent: 'day_overview', reason: 'plate' },
    expectsTools: true,
    composeAnswer: [
      "**Today's calendar:**",
      '- 9:00 AM — Standup with Maya',
      '- 11:30 AM — Investor Sync (Acme)',
      '- 2:00 PM — Beside deep dive',
      '',
      '**Pending / open loops:**',
      '- @you in #sdk-warn-alerts-prod — reply needed on alert routing.',
      '- PR #123 in beside/core — review requested.',
      '',
      '**What you\'ve been on:** mostly beside in Cursor.',
    ].join('\n'),
    hallucinationCanary: ['paris', 'whatsapp'],
  },
  {
    name: 'day_overview — bad model output (closer + frame stat)',
    message: "What's on my plate today?",
    intent: 'day_overview',
    routerJson: { route: 'tools', intent: 'day_overview', reason: 'plate' },
    expectsTools: true,
    composeAnswer: [
      'Sure! Based on your data, you have 458 frames captured.',
      "**Today's calendar:**",
      '- 9:00 AM — Standup with Maya',
      '',
      'Hope this helps! What else can I help you with?',
    ].join('\n'),
    hallucinationCanary: [],
    expectAuditFailures: ['preamble', 'closer', 'stats-frames'],
  },
  {
    name: 'calendar_check',
    message: 'do i have meetings today?',
    intent: 'calendar_check',
    routerJson: { route: 'tools', intent: 'calendar_check', reason: 'meetings' },
    expectsTools: true,
    composeAnswer: [
      '- **9:00 AM** — Standup with Maya',
      '- **11:30 AM** — Investor Sync — Acme',
      '- **2:00 PM** — Beside deep dive',
    ].join('\n'),
    hallucinationCanary: ['paris'],
  },
  {
    name: 'open_loops',
    message: 'any open loops i should clear?',
    intent: 'open_loops',
    routerJson: { route: 'tools', intent: 'open_loops', reason: 'open loops' },
    expectsTools: true,
    composeAnswer: [
      '- **#sdk-warn-alerts-prod (Slack)** — Maya asked about alert routing; reply needed.',
      '- **PR #123 in beside/core (GitHub)** — review requested.',
    ].join('\n'),
  },
  {
    name: 'recall_event — has match',
    message: 'when did i plan that paris trip?',
    intent: 'recall_event',
    routerJson: { route: 'tools', intent: 'recall_event', reason: 'paris trip' },
    expectsTools: true,
    composeAnswer:
      'Earlier today around 3:00 PM you were in Notes laying out a Paris itinerary (Louvre day one, Versailles day two, AF flight 0042 booked).',
    hallucinationCanary: ['rome', 'whatsapp', 'tanya'],
  },
  {
    name: 'recall_event — NO match (deterministic short circuit)',
    message: 'when did i visit timbuktu?',
    intent: 'recall_event',
    routerJson: { route: 'tools', intent: 'recall_event', reason: 'event' },
    expectsTools: true,
    expectShortCircuitNoEvidence: true,
    composeAnswer: 'I would invent something here if you let me. WhatsApp! Tanya!',
    hallucinationCanary: ['whatsapp', 'tanya'],
  },
  {
    name: 'time_audit',
    message: 'how much time did i spend today?',
    intent: 'time_audit',
    routerJson: { route: 'tools', intent: 'time_audit', reason: 'how much time' },
    expectsTools: true,
    composeAnswer: [
      'You spent **5h** active today across 4 sessions.',
      '',
      '**Top apps**',
      '- Cursor — 3h',
      '- Slack — 1h',
      '',
      '**Top focus**',
      '- beside (project) — 4h',
    ].join('\n'),
  },
  {
    name: 'project_status',
    message: "what's the status of beside?",
    intent: 'project_status',
    routerJson: { route: 'tools', intent: 'project_status', reason: 'status' },
    expectsTools: true,
    composeAnswer: [
      "You've been heads-down in beside this week, mostly the agent harness in Cursor.",
      '',
      '**Recent attention**',
      `- ${TODAY_YMD}: 4h`,
      '',
      '**Connected to** Tanya Reyes (contact), #sdk-warn-alerts-prod (channel).',
    ].join('\n'),
  },
  {
    name: 'people_context — has clean contact',
    message: "what's the latest with Tanya?",
    intent: 'people_context',
    routerJson: { route: 'tools', intent: 'people_context', reason: 'latest with person' },
    expectsTools: true,
    peopleSynthesis: [
      '**Synthesis:** Tanya plans to push the migration script EOW; reviewing your draft today, not blocking.',
      '**Recent messages:** ',
      '- Slack DM ~11:10 AM — Tanya: "I will push the migration script EOW. Doing today: review your draft."',
      '**Commitments / todos:** push migration script EOW.',
      '**Open loops:** none I can confirm.',
      '**Rejected noise:** sidebar/roster captures discarded.',
    ].join('\n'),
    composeAnswer: [
      'Tanya is reviewing your draft today and aims to push the migration script by end of week (not blocking).',
      '',
      '**Recent messages**',
      '- Slack DM ~11:10 AM — Tanya: plans EOW migration push, reviewing your draft today.',
      '',
      '**Commitments / todos**',
      '- Tanya: push migration script EOW.',
      '',
      '**Open loops**',
      '- None I can confirm.',
    ].join('\n'),
    hallucinationCanary: ['whatsapp'],
  },
  {
    name: 'direct — greeting',
    message: 'hey there',
    intent: 'general',
    routerJson: { route: 'direct', reason: 'greeting' },
    expectsTools: false,
    composeAnswer: 'Hey! What can I dig into for you?',
  },
  {
    name: 'direct — code question',
    message: 'how do i write a typescript generic for a hash map?',
    intent: 'general',
    routerJson: { route: 'direct', reason: 'code question' },
    expectsTools: false,
    composeAnswer:
      'Use a `Record<K, V>` or define `interface HashMap<K extends string | number | symbol, V> { [key in K]?: V }`.',
  },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child() {
    return logger;
  },
};

async function runScenario(scenario) {
  const model = createScriptedModel({ scenario });
  const events = [];
  let answer = '';

  const input = {
    turnId: `t_${scenario.name}`,
    conversationId: 'conv_test',
    message: scenario.message,
    history: [],
  };

  const { done } = harnessMod.runChatTurn(
    { storage: fakeStorage, model, logger },
    input,
    (ev) => {
      events.push(ev);
      if (ev.kind === 'content') answer += ev.delta;
    },
  );
  await done;

  const findings = auditAnswer({ scenario, answer, prompts: model.prompts });

  // Deterministic short-circuit case: the harness should never call the
  // streaming compose path when there's no evidence.
  if (scenario.expectShortCircuitNoEvidence) {
    const composeUsedModel = model.prompts.some(
      (p) => p.kind === 'completeStream' || (p.kind === 'complete' && /OUTPUT FORMAT/.test(p.prompt)),
    );
    if (composeUsedModel) {
      findings.push({
        severity: 'fail',
        rule: 'short-circuit',
        detail: 'no-evidence path called the model anyway',
      });
    }
    if (!/don'?t see that in your captures/i.test(answer)) {
      findings.push({
        severity: 'fail',
        rule: 'short-circuit',
        detail: 'no-evidence answer should be the canned line',
      });
    }
  }

  // If the test expected certain audit failures, they should fire.
  if (scenario.expectAuditFailures) {
    for (const expected of scenario.expectAuditFailures) {
      if (!findings.some((f) => f.rule === expected)) {
        findings.push({
          severity: 'warn',
          rule: 'audit-coverage',
          detail: `expected audit rule "${expected}" to flag this answer; it didn't`,
        });
      }
    }
  }

  return { events, answer, findings, prompts: model.prompts };
}

const filtered = only ? SCENARIOS.filter((s) => s.name.startsWith(only)) : SCENARIOS;
let totalFails = 0;
let totalWarns = 0;

console.log(`Running ${filtered.length} harness scenarios...\n`);

for (const scenario of filtered) {
  process.stdout.write(`▶ ${scenario.name}  `);
  let result;
  try {
    result = await runScenario(scenario);
  } catch (err) {
    console.log('CRASH');
    console.log(`  ${err.message}`);
    totalFails += 1;
    continue;
  }
  const expected = new Set(scenario.expectAuditFailures ?? []);
  const realFails = result.findings.filter(
    (f) => f.severity === 'fail' && !expected.has(f.rule),
  );
  const realWarns = result.findings.filter((f) => f.severity === 'warn');
  if (realFails.length === 0) {
    console.log(`OK${realWarns.length > 0 ? ` (${realWarns.length} warn)` : ''}`);
  } else {
    console.log(`FAIL (${realFails.length})`);
  }
  totalFails += realFails.length;
  totalWarns += realWarns.length;

  for (const f of realFails) console.log(`    ✗ ${f.rule}: ${f.detail}`);
  for (const f of realWarns) console.log(`    ! ${f.rule}: ${f.detail}`);

  if (verbose) {
    console.log('  --- ANSWER ---');
    console.log(
      result.answer
        .split('\n')
        .map((l) => `    ${l}`)
        .join('\n'),
    );
    console.log('  --- EVENTS ---');
    for (const e of result.events) {
      if (e.kind === 'content') continue;
      console.log(`    [${e.kind}] ${e.tool ?? e.phase ?? e.intent ?? e.text ?? e.message ?? ''}`);
    }
  }
  console.log();
}

console.log(`\n${filtered.length - totalFails} scenarios passed, ${totalFails} failed, ${totalWarns} warnings.`);
process.exit(totalFails === 0 ? 0 : 1);
