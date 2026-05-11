#!/usr/bin/env node
/**
 * Smoke test for the EventExtractor.
 *
 * Builds a real LocalStorage in a tempdir, seeds:
 *   1. a Meeting row (existing fixture pattern)
 *   2. a synthetic "calendar app" frame with OCR text on the same day
 *
 * Then asserts:
 *   - EventExtractor.liftMeetings() creates a DayEvent for the meeting
 *     (deterministic id, no model needed)
 *   - Re-running the lift is idempotent (same content hash → 0 new rows)
 *   - storage.listDayEvents({ day }) returns the lifted event
 *
 * The LLM-driven extraction pass is skipped here — the model adapter is
 * stubbed to "unavailable" so the smoke test stays hermetic and CI-safe.
 *
 * Usage:
 *   node packages/runtime/scripts/smoke-events.mjs
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(new URL('../../..', import.meta.url).pathname);

const storageMod = await import(
  pathToFileURL(path.join(repoRoot, 'plugins/storage/local/dist/index.js')).href
);
const runtimeMod = await import(
  pathToFileURL(path.join(repoRoot, 'packages/runtime/dist/index.js')).href
);

const { EventExtractor } = runtimeMod;

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log(`OK   ${msg}`);
  } else {
    failures++;
    console.error(`FAIL ${msg}`);
  }
}

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (msg, extra) => console.warn(`[warn] ${msg}`, extra ?? ''),
  error: (msg, extra) => console.error(`[err]  ${msg}`, extra ?? ''),
  child: () => logger,
};

// Stub model adapter: claims unavailability so the LLM pass short-circuits.
const stubModel = {
  isAvailable: async () => false,
  complete: async () => '{"events":[]}',
  completeWithVision: async () => '{"events":[]}',
  getModelInfo: () => ({
    name: 'stub',
    contextWindowTokens: 0,
    isLocal: true,
    supportsVision: false,
    costPerMillionTokens: 0,
  }),
};

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cofounderos-events-smoke-'));
  try {
    const ctx = { dataDir: tmp, logger, config: { path: tmp } };
    const storage = await storageMod.default(ctx);

    const day = '2026-05-11';
    const meetingId = `mtg_test_${randomUUID().slice(0, 8)}`;
    const meeting = {
      id: meetingId,
      entity_path: `meetings/${day}-standup`,
      title: 'Eng Standup',
      platform: 'zoom',
      started_at: `${day}T09:30:00.000Z`,
      ended_at: `${day}T09:50:00.000Z`,
      day,
      duration_ms: 20 * 60_000,
      frame_count: 4,
      screenshot_count: 4,
      audio_chunk_count: 1,
      transcript_chars: 800,
      content_hash: 'abc123',
      summary_status: 'ready',
      summary_md: '# Eng Standup\n\nDiscussed the roadmap.',
      summary_json: {
        title: 'Eng Standup',
        tldr: 'Discussed sprint progress, blockers, and the Q3 roadmap.',
        agenda: [],
        decisions: [],
        action_items: [],
        open_questions: [],
        key_moments: [],
        attendees_seen: ['Alice', 'Bob'],
        links_shared: [],
        notes: null,
      },
      attendees: ['Alice', 'Bob'],
      links: ['https://example.com/roadmap'],
      failure_reason: null,
      updated_at: `${day}T10:00:00.000Z`,
    };
    await storage.upsertMeeting(meeting);

    const extractor = new EventExtractor(storage, stubModel, logger, {
      llmEnabled: true,
    });

    const r1 = await extractor.tick();
    assert(r1.meetingsLifted === 1, `first tick lifted 1 meeting (got ${r1.meetingsLifted})`);
    assert(r1.llmExtracted === 0, 'LLM pass short-circuited when model unavailable');

    const events = await storage.listDayEvents({ day, order: 'chronological' });
    assert(events.length === 1, `listDayEvents returned 1 event (got ${events.length})`);
    const evt = events[0];
    assert(evt.kind === 'meeting', `event kind = meeting (got ${evt.kind})`);
    assert(evt.source === 'meeting_capture', `source = meeting_capture (got ${evt.source})`);
    assert(evt.meeting_id === meetingId, `event linked to meeting id`);
    assert(evt.title === 'Eng Standup', `title pulled from meeting (got "${evt.title}")`);
    assert(
      (evt.context_md ?? '').includes('roadmap'),
      `context_md surfaces meeting TL;DR (got "${evt.context_md}")`,
    );
    assert(
      evt.attendees.includes('Alice') && evt.attendees.includes('Bob'),
      'attendees propagated from meeting',
    );
    assert(
      evt.links.includes('https://example.com/roadmap'),
      'links propagated from meeting',
    );

    // Idempotent second tick: nothing changed → upsert no-op.
    const r2 = await extractor.tick();
    assert(r2.meetingsLifted === 0, `second tick lifted 0 (got ${r2.meetingsLifted})`);
    const events2 = await storage.listDayEvents({ day });
    assert(events2.length === 1, `still exactly 1 event after re-tick (got ${events2.length})`);

    // listDayEvents kind filter works.
    const meetingEvents = await storage.listDayEvents({ kind: 'meeting', day });
    assert(meetingEvents.length === 1, 'kind=meeting filter returns the event');
    const calendarEvents = await storage.listDayEvents({ kind: 'calendar', day });
    assert(calendarEvents.length === 0, 'kind=calendar filter excludes the meeting event');

    // clearAllDayEvents wipes them.
    await storage.clearAllDayEvents();
    const events3 = await storage.listDayEvents({ day });
    assert(events3.length === 0, `clearAllDayEvents wiped the table (got ${events3.length})`);

    if (failures === 0) {
      console.log('All event extractor checks passed.');
    } else {
      console.error(`${failures} assertion(s) failed`);
      process.exit(1);
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
