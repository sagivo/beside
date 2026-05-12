#!/usr/bin/env node
/**
 * Smoke test for the MeetingBuilder + MeetingSummarizer roundtrip.
 *
 * Builds a real LocalStorage in a tempdir, writes a synthetic Zoom-style
 * sequence of frames + an audio_transcript event with timed turns,
 * then runs MeetingBuilder.drain() and asserts:
 *   1. one Meeting row was created with the right window
 *   2. all meeting screenshot frames + the audio frame were assigned to it
 *   3. transcript turns were extracted with offsets and aligned to
 *      a screenshot frame via visual_frame_id
 *   4. links and attendees were collected
 *   5. the deterministic Stage A summary renders
 *
 * Bypasses the LLM step — we want this to be hermetic.
 *
 * Usage:
 *   node packages/runtime/scripts/smoke-meetings.mjs
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

const { MeetingBuilder, buildStageA, renderSummaryMarkdown } = runtimeMod;

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

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'beside-meetings-smoke-'));
  try {
    const ctx = { dataDir: tmp, logger, config: { path: tmp } };
    const storage = await storageMod.default(ctx);

    const now = new Date('2026-05-07T15:30:00.000Z');
    const meetingEntity = 'meetings/2026-05-07-q3-roadmap';

    // 6 screenshot frames spread across ~10 minutes.
    const screens = [];
    for (let i = 0; i < 6; i++) {
      const ts = new Date(now.getTime() + i * 90_000).toISOString();
      const frameId = `frm_screen_${i}_${randomUUID().slice(0, 8)}`;
      const frame = {
        id: frameId,
        timestamp: ts,
        day: ts.slice(0, 10),
        monitor: 0,
        app: 'zoom.us',
        app_bundle_id: 'us.zoom.xos',
        window_title: i === 0 ? 'Q3 Roadmap call' : `Slide ${i}: pricing`,
        url: null,
        text: i === 2 ? 'See https://example.com/pricing for the proposal.' : null,
        text_source: 'ocr',
        asset_path: `raw/2026-05-07/screenshots/zoom_${i}.webp`,
        perceptual_hash: null,
        trigger: 'window_focus',
        session_id: 'sess_demo',
        duration_ms: 30_000,
        entity_path: meetingEntity,
        entity_kind: 'meeting',
        activity_session_id: 'act_demo',
        meeting_id: null,
        source_event_ids: [],
      };
      await storage.upsertFrame(frame);
      // upsertFrame does not write entity_path/entity_kind; the
      // entity-resolver normally fills those in. Replicate that step
      // explicitly so listFramesNeedingMeetingAssignment can see the
      // frames as meeting-kind.
      await storage.resolveFrameToEntity(frame.id, {
        kind: 'meeting',
        path: meetingEntity,
        title: 'Q3 Roadmap',
      });
      screens.push(frame);
    }

    // One audio_transcript event covering most of the meeting, with
    // explicit per-turn offsets in metadata.turns. The MeetingBuilder
    // reads metadata via storage.readEvents on the frame's source_event_ids.
    const audioEventId = `evt_audio_${randomUUID().slice(0, 8)}`;
    // Native chunks are 5 minutes by default, so a chunk may start
    // before the first meeting screenshot while still overlapping the
    // meeting. The builder should attach by interval overlap, not just
    // by chunk start timestamp.
    const audioStartIso = new Date(now.getTime() - 120_000).toISOString();
    const audioEvent = {
      id: audioEventId,
      timestamp: audioStartIso,
      session_id: 'sess_demo',
      type: 'audio_transcript',
      app: 'Audio',
      app_bundle_id: 'beside.audio',
      window_title: 'native-2026-05-07-15-30-30-000-1.m4a',
      url: null,
      content: 'Alice: kicking off Q3 roadmap. Bob: pricing slide is the key change. https://example.com/pricing',
      asset_path: null,
      duration_ms: 480_000,
      idle_before_ms: null,
      screen_index: 0,
      metadata: {
        source: 'whisper',
        original_filename: 'native-2026-05-07-15-30-30-000-1.m4a',
        whisper_model: 'base',
        duration_ms: 480_000,
        turns: [
          { offset_ms: 150_000, end_ms: 155_000, speaker: 'Alice', text: 'kicking off Q3 roadmap', source: 'whisper' },
          { offset_ms: 210_000, end_ms: 214_000, speaker: 'Bob', text: 'pricing slide is the key change', source: 'whisper' },
          { offset_ms: 360_000, end_ms: 368_000, speaker: 'Alice', text: 'see the link in chat', source: 'whisper' },
        ],
      },
      privacy_filtered: false,
      capture_plugin: 'audio-transcript-worker',
    };
    await storage.write(audioEvent);

    // Build the audio frame (manually — FrameBuilder isn't part of this smoke).
    const audioFrameId = `frm_audio_${randomUUID().slice(0, 8)}`;
    const audioFrame = {
      id: audioFrameId,
      timestamp: audioStartIso,
      day: audioStartIso.slice(0, 10),
      monitor: 0,
      app: 'Audio',
      app_bundle_id: 'beside.audio',
      window_title: 'native-2026-05-07-15-30-30-000-1.m4a',
      url: null,
      text: audioEvent.content,
      text_source: 'audio',
      asset_path: null,
      perceptual_hash: null,
      trigger: 'audio',
      session_id: 'sess_demo',
      duration_ms: null,
      entity_path: 'apps/audio',
      entity_kind: 'app',
      activity_session_id: 'act_demo',
      meeting_id: null,
      source_event_ids: [audioEventId],
    };
    await storage.upsertFrame(audioFrame);
    // The audio frame is NOT a meeting-kind frame — leave its entity
    // resolution to MeetingBuilder's `listAudioFramesInRange` overlap
    // join. We do still need entity_path != null to keep the frame
    // valid in other queries; pretend the resolver tagged it as the
    // catch-all `apps/audio`.
    await storage.resolveFrameToEntity(audioFrame.id, {
      kind: 'app',
      path: 'apps/audio',
      title: 'Audio',
    });

    // Run the MeetingBuilder.
    const builder = new MeetingBuilder(storage, logger, {
      meetingIdleMs: 120_000,
      minDurationMs: 60_000,
    });
    const result = await builder.drain();
    assert(result.meetingsCreated === 1, `MeetingBuilder created exactly 1 meeting (got ${result.meetingsCreated})`);
    assert(result.audioFramesAttached === 1, `MeetingBuilder attached exactly 1 audio frame (got ${result.audioFramesAttached})`);
    assert(result.turnsBuilt >= 3, `MeetingBuilder built >= 3 turns (got ${result.turnsBuilt})`);

    const meetings = await storage.listMeetings({ day: '2026-05-07' });
    assert(meetings.length === 1, `listMeetings returned 1 row (got ${meetings.length})`);
    const meeting = meetings[0];
    assert(meeting.entity_path === meetingEntity, `meeting entity_path == ${meetingEntity}`);
    assert(meeting.platform === 'zoom', `meeting platform inferred as zoom (got ${meeting.platform})`);
    assert(meeting.screenshot_count === 6, `meeting has 6 screenshots (got ${meeting.screenshot_count})`);
    assert(meeting.audio_chunk_count === 1, `meeting has 1 audio chunk (got ${meeting.audio_chunk_count})`);
    assert(meeting.attendees.includes('Alice') && meeting.attendees.includes('Bob'), 'attendees include Alice + Bob');
    assert(meeting.links.some((l) => l.includes('example.com/pricing')), 'links include https://example.com/pricing');
    assert(meeting.summary_status === 'pending', `summary_status starts pending (got ${meeting.summary_status})`);

    const turns = await storage.getMeetingTurns(meeting.id);
    assert(turns.length >= 3, `turns >= 3 (got ${turns.length})`);
    const aliceTurn = turns.find((t) => t.speaker === 'Alice' && t.text.startsWith('kicking off'));
    assert(aliceTurn != null, 'Alice opening turn exists');
    assert(
      aliceTurn?.visual_frame_id != null,
      `Alice opening turn aligned to a screenshot frame (got ${aliceTurn?.visual_frame_id ?? 'null'})`,
    );
    const bobTurn = turns.find((t) => t.speaker === 'Bob');
    assert(bobTurn != null, 'Bob turn exists');
    assert(
      bobTurn?.visual_frame_id != null && bobTurn.visual_frame_id !== aliceTurn?.visual_frame_id,
      'Bob turn aligned to a later screenshot than Alice',
    );

    // Stage A summary should produce a TL;DR + agenda + key moments
    // entirely from data, no model call.
    const stageA = buildStageA(meeting, turns, screens);
    assert(stageA.tldr.length > 0, 'Stage A produced a non-empty TL;DR');
    assert(stageA.agenda.length > 0, 'Stage A produced non-empty agenda');
    assert(stageA.attendees_seen.length === 2, 'Stage A picked up 2 attendees');
    assert(stageA.key_moments.length >= 1, 'Stage A picked at least 1 key moment');
    assert(
      stageA.links_shared.some((l) => l.includes('example.com/pricing')),
      'Stage A surfaces shared link',
    );
    const md = renderSummaryMarkdown(meeting, stageA, turns, screens);
    assert(md.includes('**TL;DR.**'), 'rendered markdown contains TL;DR header');
    assert(md.includes(meeting.entity_path), 'rendered markdown links the meeting entity');

    await storage.setMeetingSummary(meeting.id, {
      status: 'ready',
      md,
      json: stageA,
      contentHash: meeting.content_hash,
      failureReason: null,
    });

    // Late transcript arrival after a summary was already ready should
    // invalidate the summary, attach the audio, and put the meeting
    // back into the pending queue.
    const lateAudioEventId = `evt_audio_${randomUUID().slice(0, 8)}`;
    const lateAudioStart = new Date(now.getTime() + 3 * 60_000).toISOString();
    const lateAudioEvent = {
      id: lateAudioEventId,
      timestamp: lateAudioStart,
      session_id: 'sess_demo_late',
      type: 'audio_transcript',
      app: 'Audio',
      app_bundle_id: 'beside.audio',
      window_title: 'native-2026-05-07-15-33-00-000-2.m4a',
      url: null,
      content: 'Carol: add launch-risk follow-up to the Q3 roadmap.',
      asset_path: null,
      duration_ms: 60_000,
      idle_before_ms: null,
      screen_index: 0,
      metadata: {
        source: 'whisper',
        original_filename: 'native-2026-05-07-15-33-00-000-2.m4a',
        whisper_model: 'base',
        duration_ms: 60_000,
        turns: [
          { offset_ms: 0, end_ms: 5000, speaker: 'Carol', text: 'add launch-risk follow-up to the Q3 roadmap', source: 'whisper' },
        ],
        recording_context: {
          source: 'nearby_screen',
          confidence: 100,
          reason: 'resolved_meeting_frame',
          observed_at: screens[2].timestamp,
          frame_id: screens[2].id,
          app: screens[2].app,
          window_title: screens[2].window_title,
          url: screens[2].url,
          entity_path: meetingEntity,
          entity_kind: 'meeting',
          meeting_id: meeting.id,
          platform: 'zoom',
          title: 'Q3 Roadmap',
          meeting_url: null,
        },
      },
      privacy_filtered: false,
      capture_plugin: 'audio-transcript-worker',
    };
    await storage.write(lateAudioEvent);
    const lateAudioFrameId = `frm_audio_${randomUUID().slice(0, 8)}`;
    await storage.upsertFrame({
      id: lateAudioFrameId,
      timestamp: lateAudioStart,
      day: lateAudioStart.slice(0, 10),
      monitor: 0,
      app: 'Audio',
      app_bundle_id: 'beside.audio',
      window_title: lateAudioEvent.window_title,
      url: null,
      text: lateAudioEvent.content,
      text_source: 'audio',
      asset_path: null,
      perceptual_hash: null,
      trigger: 'audio',
      session_id: 'sess_demo_late',
      duration_ms: 60_000,
      entity_path: 'apps/audio',
      entity_kind: 'app',
      activity_session_id: 'act_demo',
      meeting_id: null,
      source_event_ids: [lateAudioEventId],
    });
    await storage.resolveFrameToEntity(lateAudioFrameId, {
      kind: 'app',
      path: 'apps/audio',
      title: 'Audio',
    });
    const lateResult = await builder.drain();
    assert(lateResult.audioFramesAttached >= 2, `late audio reattached meeting audio (got ${lateResult.audioFramesAttached})`);
    const [updatedMeeting] = await storage.listMeetings({ day: '2026-05-07' });
    assert(updatedMeeting.audio_chunk_count === 2, `late audio raised audio chunk count to 2 (got ${updatedMeeting.audio_chunk_count})`);
    assert(updatedMeeting.summary_status === 'pending', `late audio invalidated ready summary (got ${updatedMeeting.summary_status})`);
    assert(updatedMeeting.summary_md === null, 'late audio cleared stale summary markdown');

    // Idempotency: re-running drain shouldn't double up.
    const result2 = await builder.drain();
    assert(result2.framesProcessed === 0, 'second drain processes 0 frames (idempotent)');
    const meetings2 = await storage.listMeetings({ day: '2026-05-07' });
    assert(meetings2.length === 1, 'still exactly 1 meeting after re-drain');

    // Audio-first attribution: if a native audio chunk was captured while
    // the screen showed a planned/current calendar or Meet context, the
    // transcript should still become a meeting even when no visual frame
    // was pre-resolved as entity_kind=meeting.
    const contextTs = '2026-05-11T16:00:00.000Z';
    const contextFrameId = `frm_context_${randomUUID().slice(0, 8)}`;
    const contextFrame = {
      id: contextFrameId,
      timestamp: contextTs,
      day: '2026-05-11',
      monitor: 0,
      app: 'Google Chrome',
      app_bundle_id: 'com.google.Chrome',
      window_title: 'Google Calendar - Google Chrome',
      url: 'https://meet.google.com/landing',
      text: [
        '11:00 AM',
        'openbox sync',
        'Now',
        'Join with Google Meet',
        'meet.google.com/abc-defg-hij',
      ].join('\n'),
      text_source: 'ocr',
      asset_path: 'raw/2026-05-11/screenshots/calendar_openbox.webp',
      perceptual_hash: null,
      trigger: 'screenshot',
      session_id: 'sess_audio_context',
      duration_ms: 30_000,
      entity_path: null,
      entity_kind: null,
      activity_session_id: 'act_audio_context',
      meeting_id: null,
      source_event_ids: [],
    };
    await storage.upsertFrame(contextFrame);
    await storage.resolveFrameToEntity(contextFrame.id, {
      kind: 'app',
      path: 'apps/google-chrome',
      title: 'Google Chrome',
    });

    const contextualAudioEventId = `evt_audio_${randomUUID().slice(0, 8)}`;
    const contextualAudioStart = '2026-05-11T16:01:00.000Z';
    const contextualAudioEvent = {
      id: contextualAudioEventId,
      timestamp: contextualAudioStart,
      session_id: 'sess_audio_context',
      type: 'audio_transcript',
      app: 'Audio',
      app_bundle_id: 'beside.audio',
      window_title: 'native-2026-05-11-11-01-00-000-1.m4a',
      url: null,
      content: 'Alice: openbox sync standup is starting. Bob: I will review the GitHub sync follow-up.',
      asset_path: null,
      duration_ms: 240_000,
      idle_before_ms: null,
      screen_index: 0,
      metadata: {
        source: 'whisper',
        original_filename: 'native-2026-05-11-11-01-00-000-1.m4a',
        whisper_model: 'base',
        duration_ms: 240_000,
        turns: [
          { offset_ms: 0, end_ms: 5000, speaker: 'Alice', text: 'openbox sync standup is starting', source: 'whisper' },
          { offset_ms: 90_000, end_ms: 94_000, speaker: 'Bob', text: 'I will review the GitHub sync follow-up', source: 'whisper' },
        ],
        recording_context: {
          source: 'nearby_screen',
          confidence: 98,
          reason: 'calendar_or_meet_landing_event,platform_meet,meeting_url',
          observed_at: contextTs,
          frame_id: contextFrameId,
          app: contextFrame.app,
          window_title: contextFrame.window_title,
          url: contextFrame.url,
          entity_path: null,
          entity_kind: 'app',
          meeting_id: null,
          platform: 'meet',
          title: 'openbox sync',
          meeting_url: 'https://meet.google.com/abc-defg-hij',
        },
      },
      privacy_filtered: false,
      capture_plugin: 'audio-transcript-worker',
    };
    await storage.write(contextualAudioEvent);

    const contextualAudioFrameId = `frm_audio_${randomUUID().slice(0, 8)}`;
    const contextualAudioFrame = {
      id: contextualAudioFrameId,
      timestamp: contextualAudioStart,
      day: '2026-05-11',
      monitor: 0,
      app: 'Audio',
      app_bundle_id: 'beside.audio',
      window_title: 'native-2026-05-11-11-01-00-000-1.m4a',
      url: null,
      text: contextualAudioEvent.content,
      text_source: 'audio',
      asset_path: null,
      perceptual_hash: null,
      trigger: 'audio',
      session_id: 'sess_audio_context',
      duration_ms: 240_000,
      entity_path: 'apps/audio',
      entity_kind: 'app',
      activity_session_id: 'act_audio_context',
      meeting_id: null,
      source_event_ids: [contextualAudioEventId],
    };
    await storage.upsertFrame(contextualAudioFrame);
    await storage.resolveFrameToEntity(contextualAudioFrame.id, {
      kind: 'app',
      path: 'apps/audio',
      title: 'Audio',
    });

    const contextualResult = await builder.drain();
    assert(
      contextualResult.meetingsCreated === 1,
      `contextual audio created exactly 1 meeting (got ${contextualResult.meetingsCreated})`,
    );
    assert(
      contextualResult.audioFramesAttached === 1,
      `contextual audio attached exactly 1 audio frame (got ${contextualResult.audioFramesAttached})`,
    );
    assert(contextualResult.turnsBuilt >= 2, `contextual audio built >= 2 turns (got ${contextualResult.turnsBuilt})`);

    const contextualMeetings = await storage.listMeetings({ day: '2026-05-11' });
    assert(contextualMeetings.length === 1, `contextual day has 1 meeting (got ${contextualMeetings.length})`);
    const contextualMeeting = contextualMeetings[0];
    assert(
      contextualMeeting.entity_path === 'meetings/2026-05-11-openbox-sync',
      `contextual meeting entity_path == meetings/2026-05-11-openbox-sync (got ${contextualMeeting.entity_path})`,
    );
    assert(contextualMeeting.title === 'openbox sync', `contextual meeting title inferred from screen (got ${contextualMeeting.title})`);
    assert(contextualMeeting.platform === 'meet', `contextual meeting platform inferred as meet (got ${contextualMeeting.platform})`);
    assert(contextualMeeting.screenshot_count === 1, `contextual meeting kept 1 context screenshot (got ${contextualMeeting.screenshot_count})`);
    assert(contextualMeeting.audio_chunk_count === 1, `contextual meeting has 1 audio chunk (got ${contextualMeeting.audio_chunk_count})`);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }

  console.log('');
  if (failures > 0) {
    console.error(`${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('All meeting builder + Stage A summary checks passed.');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
