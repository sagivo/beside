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

function englishDate(day) {
  return new Date(`${day}T12:00:00`).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'beside-events-smoke-'));
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

    // Calendar extraction should only persist events for the target
    // capture day. Week/month views can show other columns, but those
    // belong to their own day scans.
    const captureDay = localDayKey();
    const staleVisibleDay = captureDay === '2026-05-12' ? '2026-05-13' : '2026-05-12';
    const nextDayDate = new Date(`${captureDay}T12:00:00`);
    nextDayDate.setDate(nextDayDate.getDate() + 1);
    const nextDay = localDayKey(nextDayDate);
    const nextDate = englishDate(nextDay);
    const misdatedFrameId = `frame_calendar_misdated_${randomUUID().slice(0, 8)}`;
    await storage.upsertFrame({
      id: `frame_calendar_old_${randomUUID().slice(0, 8)}`,
      timestamp: `${captureDay}T08:50:00.000Z`,
      day: captureDay,
      monitor: 0,
      app: 'Calendar',
      app_bundle_id: 'com.apple.iCal',
      window_title: 'Calendar — month view',
      url: null,
      text:
        'Calendar May 2026 Sun Mon Tue 12 Wed 13 Thu 14 Fri 15 Sat 16 8 AM 9 AM 10 AM ' +
        'Past Strategy Review Today Sync Removed Calendar Item',
      text_source: 'ocr',
      asset_path: null,
      perceptual_hash: `cal_old_${randomUUID().slice(0, 8)}`,
      trigger: 'screenshot',
      session_id: 'sess_calendar_smoke',
      duration_ms: null,
      entity_path: null,
      entity_kind: null,
      activity_session_id: null,
      meeting_id: null,
      source_event_ids: [],
    });
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
    await storage.upsertFrame({
      id: misdatedFrameId,
      timestamp: `${captureDay}T08:55:00.000Z`,
      day: captureDay,
      monitor: 0,
      app: 'Calendar',
      app_bundle_id: 'com.apple.iCal',
      window_title: 'Calendar — month view',
      url: null,
      text:
        `Calendar May 2026 Sun Mon Tue 12 Wed 13 Thu 14 Fri 15 Sat 16 8 AM 9 AM 10 AM ` +
        `Birthday Cheers. Starts on ${nextDate} at 4:00 PM and ends at 5:00 PM.`,
      text_source: 'ocr_accessibility',
      asset_path: null,
      perceptual_hash: `cal_misdated_${randomUUID().slice(0, 8)}`,
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
      id: `event_removed_calendar_${randomUUID().slice(0, 8)}`,
      day: captureDay,
      starts_at: `${captureDay}T14:00:00.000Z`,
      ends_at: `${captureDay}T14:30:00.000Z`,
      kind: 'calendar',
      source: 'calendar_screen',
      title: 'Removed Calendar Item',
      source_app: 'Calendar',
      context_md: 'This row should be removed when a newer calendar capture has fewer events.',
      attendees: [],
      links: [],
      meeting_id: null,
      evidence_frame_ids: [],
      content_hash: 'removed-calendar-row',
      status: 'ready',
      failure_reason: null,
      created_at: `${captureDay}T08:00:00.000Z`,
      updated_at: `${captureDay}T08:00:00.000Z`,
    });
    await storage.upsertDayEvent({
      id: `event_stale_visible_calendar_${randomUUID().slice(0, 8)}`,
      day: staleVisibleDay,
      starts_at: `${staleVisibleDay}T08:00:00.000Z`,
      ends_at: `${staleVisibleDay}T08:30:00.000Z`,
      kind: 'calendar',
      source: 'calendar_screen',
      title: 'Stale Visible Calendar Item',
      source_app: 'Calendar',
      context_md: 'This row should be removed because the latest calendar capture still shows this day.',
      attendees: [],
      links: [],
      meeting_id: null,
      evidence_frame_ids: [],
      content_hash: 'stale-visible-calendar-row',
      status: 'ready',
      failure_reason: null,
      created_at: `${staleVisibleDay}T08:00:00.000Z`,
      updated_at: `${staleVisibleDay}T08:00:00.000Z`,
    });
    await storage.upsertDayEvent({
      id: `event_misdated_calendar_${randomUUID().slice(0, 8)}`,
      day: captureDay,
      starts_at: `${captureDay}T16:00:00.000Z`,
      ends_at: `${captureDay}T17:00:00.000Z`,
      kind: 'calendar',
      source: 'calendar_screen',
      title: 'Birthday Cheers',
      source_app: 'Calendar',
      context_md: 'This row came from a legacy week-view parse and should be purged.',
      attendees: [],
      links: [],
      meeting_id: null,
      evidence_frame_ids: [misdatedFrameId],
      content_hash: 'misdated-calendar-row',
      status: 'ready',
      failure_reason: null,
      created_at: `${captureDay}T08:00:00.000Z`,
      updated_at: `${captureDay}T08:00:00.000Z`,
    });

    const availableModel = {
      ...stubModel,
      isAvailable: async () => true,
      complete: async (prompt) => {
        assert(
          !prompt.includes('Removed Calendar Item'),
          'calendar extraction prompt uses the latest calendar capture',
        );
        return JSON.stringify({
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
        });
      },
    };
    const llmExtractor = new EventExtractor(storage, availableModel, logger, {
      llmEnabled: true,
      minTextChars: 20,
    });
    const r3 = await llmExtractor.tick();
    assert(r3.llmExtracted === 1, `calendar extraction only accepted the target day (got ${r3.llmExtracted})`);
    const pastEvents = await storage.listDayEvents({ day: '1999-12-31', kind: 'calendar' });
    const todayEvents = await storage.listDayEvents({ day: captureDay, kind: 'calendar' });
    const visibleDayEvents = await storage.listDayEvents({ day: staleVisibleDay, kind: 'calendar' });
    const futureEvents = await storage.listDayEvents({ day: '2050-01-02', kind: 'calendar' });
    assert(
      !pastEvents.some((e) => e.title === 'Past Strategy Review'),
      'calendar extraction skips non-target past-dated events',
    );
    assert(
      todayEvents.some((e) => e.title === 'Today Sync'),
      'calendar extraction stores current-day events',
    );
    assert(
      !todayEvents.some((e) => ['Stale Calendar Item', 'Removed Calendar Item', 'Birthday Cheers'].includes(e.title)),
      'calendar extraction removes stale and legacy misdated events for the target day',
    );
    assert(
      visibleDayEvents.some((e) => e.title === 'Stale Visible Calendar Item'),
      'calendar extraction leaves other visible days for their own scan',
    );
    assert(
      !futureEvents.some((e) => e.title === 'Future Planning'),
      'calendar extraction skips non-target future-dated events',
    );
    const canonicalToday = await storage.listCalendarEvents({ day: captureDay, status: 'active' });
    assert(
      canonicalToday.some((e) => e.title === 'Today Sync' && e.source_app === 'Apple Calendar'),
      'calendar extraction writes canonical source-scoped calendar events',
    );

    const linkedMeetingId = `mtg_calendar_link_${randomUUID().slice(0, 8)}`;
    const todaySyncCanonical = canonicalToday.find((e) => e.title === 'Today Sync');
    const linkedStart = new Date(Date.parse(todaySyncCanonical?.starts_at ?? `${captureDay}T12:30:00.000Z`) + 4 * 60_000);
    const linkedEnd = new Date(linkedStart.getTime() + 28 * 60_000);
    await storage.upsertMeeting({
      ...meeting,
      id: linkedMeetingId,
      title: 'Today Sync',
      started_at: linkedStart.toISOString(),
      ended_at: linkedEnd.toISOString(),
      day: captureDay,
      duration_ms: 31 * 60_000,
      content_hash: `linked-${randomUUID()}`,
      summary_status: 'ready',
      summary_json: {
        ...meeting.summary_json,
        title: 'Today Sync',
        tldr: 'Discussed the calendar-linked sync.',
      },
      updated_at: `${captureDay}T13:03:00.000Z`,
    });
    const remoteOnlyDay = '2026-05-09';
    const remoteOnlyCalendarId = `calevt_remote_only_${randomUUID().slice(0, 8)}`;
    await storage.upsertCalendarEvent({
      id: remoteOnlyCalendarId,
      source_key: 'apple_calendar:com.apple.ical',
      provider: 'apple_calendar',
      day: remoteOnlyDay,
      starts_at: `${remoteOnlyDay}T10:00:00.000Z`,
      ends_at: `${remoteOnlyDay}T11:00:00.000Z`,
      title: 'Engineering Staff Meeting',
      location: null,
      attendees: [],
      links: ['https://zoom.us/j/123456789'],
      notes: null,
      source_app: 'Apple Calendar',
      source_url: null,
      source_bundle_id: 'com.apple.iCal',
      evidence_frame_ids: [],
      first_seen_capture_id: null,
      last_seen_capture_id: null,
      status: 'active',
      content_hash: `remote-only-${randomUUID()}`,
      meeting_id: null,
      actual_started_at: null,
      actual_ended_at: null,
      meeting_platform: null,
      meeting_summary_status: null,
      created_at: `${remoteOnlyDay}T09:00:00.000Z`,
      updated_at: `${remoteOnlyDay}T09:00:00.000Z`,
    });
    const remoteOnlyMeetingId = `mtg_remote_only_${randomUUID().slice(0, 8)}`;
    await storage.upsertMeeting({
      ...meeting,
      id: remoteOnlyMeetingId,
      title: null,
      started_at: `${remoteOnlyDay}T12:00:00.000Z`,
      ended_at: `${remoteOnlyDay}T12:30:00.000Z`,
      day: remoteOnlyDay,
      duration_ms: 30 * 60_000,
      content_hash: `remote-only-meeting-${randomUUID()}`,
      summary_status: 'ready',
      summary_json: {
        ...meeting.summary_json,
        title: null,
        tldr: 'Unrelated captured Zoom meeting.',
      },
      updated_at: `${remoteOnlyDay}T12:35:00.000Z`,
    });
    const linker = new EventExtractor(storage, stubModel, logger, { llmEnabled: false });
    await linker.tick();
    const enrichedCanonical = (await storage.listCalendarEvents({ day: captureDay, status: 'active' })).find((e) => e.title === 'Today Sync');
    const remoteOnlyCanonical = (await storage.listCalendarEvents({ day: remoteOnlyDay, status: 'active' })).find((e) => e.id === remoteOnlyCalendarId);
    assert(
      enrichedCanonical?.meeting_id === linkedMeetingId,
      'calendar event links to captured meeting',
    );
    assert(
      remoteOnlyCanonical?.meeting_id == null,
      'remote meeting link requires more than a same-day Zoom signal',
    );
    assert(
      enrichedCanonical &&
        new Date(enrichedCanonical.starts_at).getMinutes() === 30 &&
        enrichedCanonical.actual_started_at &&
        new Date(enrichedCanonical.actual_started_at).getMinutes() === 35,
      'calendar enrichment preserves scheduled time while recording actual meeting time',
    );

    const structuredTmp = await fs.mkdtemp(
      path.join(os.tmpdir(), 'beside-events-structured-calendar-'),
    );
    try {
      const structuredStorage = await storageMod.default({
        dataDir: structuredTmp,
        logger,
        config: { path: structuredTmp },
      });
      const structuredDay = localDayKey();
      const structuredDate = englishDate(structuredDay);
      const structuredNextDateObj = new Date(`${structuredDay}T12:00:00`);
      structuredNextDateObj.setDate(structuredNextDateObj.getDate() + 1);
      const structuredNextDay = localDayKey(structuredNextDateObj);
      const structuredNextDate = englishDate(structuredNextDay);
      await structuredStorage.upsertCalendarEvent({
        id: `calevt_alias_${randomUUID().slice(0, 8)}`,
        source_key: 'apple_calendar:com.tinyspeck.slackmacgap',
        provider: 'apple_calendar',
        day: structuredDay,
        starts_at: `${structuredDay}T09:00:00.000Z`,
        ends_at: `${structuredDay}T09:30:00.000Z`,
        title: 'Legacy Alias Calendar Item',
        location: null,
        attendees: [],
        links: [],
        notes: null,
        source_app: 'Apple Calendar',
        source_url: null,
        source_bundle_id: 'com.tinyspeck.slackmacgap',
        evidence_frame_ids: [],
        first_seen_capture_id: null,
        last_seen_capture_id: null,
        status: 'active',
        content_hash: 'legacy-alias-calendar-item',
        meeting_id: null,
        actual_started_at: null,
        actual_ended_at: null,
        meeting_platform: null,
        meeting_summary_status: null,
        created_at: `${structuredDay}T08:00:00.000Z`,
        updated_at: `${structuredDay}T08:00:00.000Z`,
      });
      await structuredStorage.upsertDayEvent({
        id: `evt_alias_${randomUUID().slice(0, 8)}`,
        day: structuredDay,
        starts_at: `${structuredDay}T09:00:00.000Z`,
        ends_at: `${structuredDay}T09:30:00.000Z`,
        kind: 'calendar',
        source: 'calendar_screen',
        title: 'Legacy Alias Calendar Item',
        source_app: 'Apple Calendar',
        context_md: 'Should be replaced by the canonical Apple Calendar projection.',
        attendees: [],
        links: [],
        meeting_id: null,
        evidence_frame_ids: [],
        content_hash: 'legacy-alias-day-event',
        status: 'ready',
        failure_reason: null,
        created_at: `${structuredDay}T08:00:00.000Z`,
        updated_at: `${structuredDay}T08:00:00.000Z`,
      });
      await structuredStorage.upsertFrame({
        id: `frame_structured_calendar_${randomUUID().slice(0, 8)}`,
        timestamp: `${structuredDay}T09:00:00.000Z`,
        day: structuredDay,
        monitor: 0,
        app: 'Calendar',
        app_bundle_id: 'com.apple.iCal',
        window_title: 'Calendar',
        url: null,
        text:
          `Calendar May 2026 Mon Tue Wed Thu Fri 8 AM 9 AM 10 AM 11 AM Noon 1 PM 2 PM 3 PM 4 PM\n` +
          `Tuesday\n` +
          `Open Enrollment Office Hour at Cupertino-1-Palaven (4) [Zoom Room]. Starts on ${structuredDate} at 3:00 PM and ends at 3:30 PM.\n` +
          `Maya / Balaji - 1:1 at Cupertino Meeting Room - Vimire, Cupertino-1-Vimire (4) [Zoom Room]. Starts on ${structuredDate} at 3:30 PM and ends at 4:00 PM.\n` +
          `Adriana's Birthday's birthday. ${structuredDate}, All-Day\n` +
          `Hackathon Demos. Starts on ${structuredNextDate} at 10:00 AM and ends at 12:30 PM.\n`,
        text_source: 'ocr_accessibility',
        asset_path: null,
        perceptual_hash: `structured_cal_${randomUUID().slice(0, 8)}`,
        trigger: 'screenshot',
        session_id: 'sess_structured_calendar_smoke',
        duration_ms: null,
        entity_path: null,
        entity_kind: null,
        activity_session_id: null,
        meeting_id: null,
        source_event_ids: [],
      });

      const wrongCalendarModel = {
        ...stubModel,
        isAvailable: async () => true,
        complete: async () =>
          JSON.stringify({
            events: [
              {
                title: 'Open Enrollment Office Hour',
                kind: 'calendar',
                starts_at: `${structuredDay}T11:30:00`,
                ends_at: `${structuredDay}T12:45:00`,
                attendees: [],
                context: 'An office hour for open enrollment.',
              },
              {
                title: 'Maya / Balaji - 1:1',
                kind: 'calendar',
                starts_at: `${structuredDay}T13:30:00`,
                ends_at: `${structuredDay}T16:00:00`,
                attendees: [],
                context: 'A one-on-one meeting between Maya and Balaji.',
              },
              {
                title: "Adriana's Birthday's birthday",
                kind: 'calendar',
                starts_at: `${structuredDay}T00:00:00`,
                ends_at: `${structuredDay}T23:59:59`,
                attendees: [],
                context: 'An all-day birthday event.',
              },
              {
                title: "Adriana's Birthday's birthday",
                kind: 'calendar',
                starts_at: `${structuredDay}T14:00:00`,
                ends_at: null,
                attendees: [],
                context: 'A duplicate timed interpretation of the all-day birthday.',
              },
              {
                title: 'Hackathon Demos Part 1',
                kind: 'calendar',
                starts_at: `${structuredDay}T10:00:00`,
                ends_at: `${structuredDay}T11:15:00`,
                attendees: [],
                context: 'A visible event from another day in the week view.',
              },
            ],
          }),
      };
      const structuredExtractor = new EventExtractor(
        structuredStorage,
        wrongCalendarModel,
        logger,
        {
          llmEnabled: true,
          minTextChars: 20,
          lookbackDays: 1,
        },
      );
      await structuredExtractor.tick({ lookbackDays: 1 });
      const structuredEvents = await structuredStorage.listDayEvents({
        day: structuredDay,
        kind: 'calendar',
        order: 'chronological',
      });
      const openEnrollment = structuredEvents.find((e) =>
        e.title.includes('Open Enrollment Office Hour'),
      );
      const balaji = structuredEvents.find((e) => e.title.includes('Maya / Balaji'));
      assert(
        openEnrollment &&
          new Date(openEnrollment.starts_at).getHours() === 15 &&
          new Date(openEnrollment.starts_at).getMinutes() === 0,
        'structured calendar accessibility time overrides wrong LLM time for Open Enrollment',
      );
      assert(
        balaji &&
          new Date(balaji.starts_at).getHours() === 15 &&
          new Date(balaji.starts_at).getMinutes() === 30 &&
          new Date(balaji.ends_at ?? '').getHours() === 16,
        'structured calendar accessibility time overrides wrong LLM time for Maya / Balaji',
      );
      const birthdayEvents = structuredEvents.filter((e) =>
        e.title === "Adriana's Birthday's birthday",
      );
      assert(
        birthdayEvents.length === 1 &&
          new Date(birthdayEvents[0].starts_at).getHours() === 0 &&
          birthdayEvents[0].ends_at &&
          new Date(birthdayEvents[0].ends_at).getHours() === 0,
        'all-day calendar event suppresses duplicate timed interpretations',
      );
      assert(
        !structuredEvents.some((e) => /Hackathon Demos/i.test(e.title)),
        'structured calendar extraction rejects LLM events that belong to another visible day',
      );
      assert(
        !structuredEvents.some((e) => e.title === 'Legacy Alias Calendar Item'),
        'canonical Apple Calendar projection removes legacy foreground-app source aliases',
      );
      const activeAliases = await structuredStorage.listCalendarEvents({
        day: structuredDay,
        status: 'active',
        order: 'chronological',
      });
      assert(
        activeAliases.every((e) => e.source_key !== 'apple_calendar:com.tinyspeck.slackmacgap'),
        'legacy Apple Calendar alias source is retired after canonical capture',
      );
    } finally {
      await fs.rm(structuredTmp, { recursive: true, force: true });
    }

    const falseCalendarTmp = await fs.mkdtemp(
      path.join(os.tmpdir(), 'beside-events-false-calendar-'),
    );
    try {
      const falseStorage = await storageMod.default({
        dataDir: falseCalendarTmp,
        logger,
        config: { path: falseCalendarTmp },
      });
      const falseDay = localDayKey();
      await falseStorage.upsertDayEvent({
        id: `event_keep_calendar_${randomUUID().slice(0, 8)}`,
        day: falseDay,
        starts_at: `${falseDay}T09:00:00.000Z`,
        ends_at: `${falseDay}T09:30:00.000Z`,
        kind: 'calendar',
        source: 'calendar_screen',
        title: 'Keep Existing Calendar Item',
        source_app: 'Calendar',
        context_md: 'This row should survive a false native-calendar metadata frame.',
        attendees: [],
        links: [],
        meeting_id: null,
        evidence_frame_ids: [],
        content_hash: 'keep-existing-calendar-row',
        status: 'ready',
        failure_reason: null,
        created_at: `${falseDay}T08:00:00.000Z`,
        updated_at: `${falseDay}T08:00:00.000Z`,
      });
      await falseStorage.upsertFrame({
        id: `frame_false_calendar_${randomUUID().slice(0, 8)}`,
        timestamp: `${falseDay}T10:00:00.000Z`,
        day: falseDay,
        monitor: 0,
        app: 'Calendar',
        app_bundle_id: 'com.apple.iCal',
        window_title: 'Calendar',
        url: null,
        text:
          'Firefox File Edit View History Bookmarks Profiles Tools Window Help ' +
          'Saved Recents Austin Cedar Groupon Codex Agenda Calendar mention only. ' +
          'This is not a calendar grid and has no weekday row or time gutter.',
        text_source: 'ocr',
        asset_path: null,
        perceptual_hash: `false_cal_${randomUUID().slice(0, 8)}`,
        trigger: 'screenshot',
        session_id: 'sess_false_calendar_smoke',
        duration_ms: null,
        entity_path: null,
        entity_kind: null,
        activity_session_id: null,
        meeting_id: null,
        source_event_ids: [],
      });

      const emptyCalendarModel = {
        ...stubModel,
        isAvailable: async () => true,
        complete: async () => '{"events":[]}',
        completeWithVision: async () => '{"events":[]}',
      };
      const falseExtractor = new EventExtractor(falseStorage, emptyCalendarModel, logger, {
        llmEnabled: true,
        minTextChars: 20,
        lookbackDays: 1,
      });
      await falseExtractor.tick({ lookbackDays: 1 });
      const keptEvents = await falseStorage.listDayEvents({ day: falseDay, kind: 'calendar' });
      assert(
        keptEvents.some((e) => e.title === 'Keep Existing Calendar Item'),
        'false/empty calendar pass preserves existing calendar rows',
      );
    } finally {
      await fs.rm(falseCalendarTmp, { recursive: true, force: true });
    }

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
