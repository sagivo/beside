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

function localDayKey(date = new Date()) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

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
    const meeting2 = {
      ...meeting,
      id: `mtg_test_${randomUUID().slice(0, 8)}`,
      started_at: `${day}T10:05:00.000Z`,
      ended_at: `${day}T10:15:00.000Z`,
      duration_ms: 10 * 60_000,
      frame_count: 2,
      screenshot_count: 2,
      audio_chunk_count: 0,
      transcript_chars: 0,
      content_hash: 'def456',
      summary_md: null,
      summary_json: null,
      attendees: [],
      links: [],
      updated_at: `${day}T10:16:00.000Z`,
    };
    await storage.upsertMeeting(meeting2);

    const extractor = new EventExtractor(storage, stubModel, logger, {
      llmEnabled: true,
    });

    const r1 = await extractor.tick();
    assert(r1.meetingsLifted === 2, `first tick lifted 2 meetings (got ${r1.meetingsLifted})`);
    assert(r1.llmExtracted === 0, 'LLM pass short-circuited when model unavailable');

    const events = await storage.listDayEvents({ day, order: 'chronological' });
    assert(events.length === 2, `listDayEvents returned 2 events (got ${events.length})`);
    assert(events.every((event) => event.title !== '__merged__'), 'meeting lift preserves sibling meetings');
    const evt = events.find((event) => event.meeting_id === meetingId) ?? events[0];
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
    assert(events2.length === 2, `still exactly 2 events after re-tick (got ${events2.length})`);

    // listDayEvents kind filter works.
    const meetingEvents = await storage.listDayEvents({ kind: 'meeting', day });
    assert(meetingEvents.length === 2, 'kind=meeting filter returns both meeting events');
    const calendarEvents = await storage.listDayEvents({ kind: 'calendar', day });
    assert(calendarEvents.length === 0, 'kind=calendar filter excludes the meeting event');

    // clearAllDayEvents wipes them.
    await storage.clearAllDayEvents();
    const events3 = await storage.listDayEvents({ day });
    assert(events3.length === 0, `clearAllDayEvents wiped the table (got ${events3.length})`);

    // LLM calendar extraction should trust the event date visible on
    // the calendar, not filter by proximity to "now". One calendar
    // screenshot can legitimately show past, current, and future items.
    const captureDay = localDayKey();
    await storage.upsertFrame({
      id: `frame_calendar_${randomUUID().slice(0, 8)}`,
      timestamp: `${captureDay}T09:00:00.000Z`,
      day: captureDay,
      monitor: 0,
      app: 'Calendar',
      app_bundle_id: 'com.apple.iCal',
      window_title: 'Calendar — month view',
      url: null,
      text:
        'Calendar May 2026 Sun Mon Tue 12 Wed 13 Thu 14 Fri 15 Sat 16 8 AM 9 AM 10 AM ' +
        'Past Strategy Review Today Sync Future Planning',
      text_source: 'ocr',
      asset_path: null,
      perceptual_hash: `cal_${randomUUID().slice(0, 8)}`,
      trigger: 'screenshot',
      session_id: 'sess_calendar_smoke',
      duration_ms: null,
      entity_path: null,
      entity_kind: null,
      activity_session_id: null,
      meeting_id: null,
      source_event_ids: [],
    });
    await storage.upsertDayEvent({
      id: `event_stale_calendar_${randomUUID().slice(0, 8)}`,
      day: captureDay,
      starts_at: `${captureDay}T08:00:00.000Z`,
      ends_at: `${captureDay}T08:30:00.000Z`,
      kind: 'calendar',
      source: 'calendar_screen',
      title: 'Stale Calendar Item',
      source_app: 'Calendar',
      context_md: 'This row should be removed when the visible calendar day is rescanned.',
      attendees: [],
      links: [],
      meeting_id: null,
      evidence_frame_ids: [],
      content_hash: 'stale-calendar-row',
      status: 'ready',
      failure_reason: null,
      created_at: `${captureDay}T08:00:00.000Z`,
      updated_at: `${captureDay}T08:00:00.000Z`,
    });
    await storage.upsertDayEvent({
      id: `event_stale_visible_calendar_${randomUUID().slice(0, 8)}`,
      day: '2026-05-12',
      starts_at: '2026-05-12T08:00:00.000Z',
      ends_at: '2026-05-12T08:30:00.000Z',
      kind: 'calendar',
      source: 'calendar_screen',
      title: 'Stale Visible Calendar Item',
      source_app: 'Calendar',
      context_md: 'This row should be removed because May 12 is visible in the rescanned calendar.',
      attendees: [],
      links: [],
      meeting_id: null,
      evidence_frame_ids: [],
      content_hash: 'stale-visible-calendar-row',
      status: 'ready',
      failure_reason: null,
      created_at: '2026-05-12T08:00:00.000Z',
      updated_at: '2026-05-12T08:00:00.000Z',
    });

    const availableModel = {
      ...stubModel,
      isAvailable: async () => true,
      complete: async () =>
        JSON.stringify({
          events: [
            {
              title: 'Past Strategy Review',
              kind: 'calendar',
              starts_at: '1999-12-31T10:00:00',
              ends_at: '1999-12-31T11:00:00',
              attendees: [],
              context: 'A dated calendar event in the past.',
            },
            {
              title: 'Today Sync',
              kind: 'calendar',
              starts_at: `${captureDay}T12:30:00`,
              ends_at: `${captureDay}T13:00:00`,
              attendees: [],
              context: 'A dated calendar event for the capture day.',
            },
            {
              title: 'Future Planning',
              kind: 'calendar',
              starts_at: '2050-01-02T15:00:00',
              ends_at: '2050-01-02T16:00:00',
              attendees: [],
              context: 'A dated calendar event in the future.',
            },
          ],
        }),
    };
    const llmExtractor = new EventExtractor(storage, availableModel, logger, {
      llmEnabled: true,
      minTextChars: 20,
    });
    const r3 = await llmExtractor.tick();
    assert(r3.llmExtracted >= 3, `calendar extraction accepted past/today/future dates (got ${r3.llmExtracted})`);
    const pastEvents = await storage.listDayEvents({ day: '1999-12-31', kind: 'calendar' });
    const todayEvents = await storage.listDayEvents({ day: captureDay, kind: 'calendar' });
    const visibleDayEvents = await storage.listDayEvents({ day: '2026-05-12', kind: 'calendar' });
    const futureEvents = await storage.listDayEvents({ day: '2050-01-02', kind: 'calendar' });
    assert(
      pastEvents.some((e) => e.title === 'Past Strategy Review'),
      'calendar extraction stores past-dated events',
    );
    assert(
      todayEvents.some((e) => e.title === 'Today Sync'),
      'calendar extraction stores current-day events',
    );
    assert(
      !todayEvents.some((e) => e.title === 'Stale Calendar Item'),
      'calendar extraction replaces stale events from the rescanned calendar day',
    );
    assert(
      !visibleDayEvents.some((e) => e.title === 'Stale Visible Calendar Item'),
      'calendar extraction clears stale events from visible days with no fresh candidate',
    );
    assert(
      futureEvents.some((e) => e.title === 'Future Planning'),
      'calendar extraction stores future-dated events',
    );

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
