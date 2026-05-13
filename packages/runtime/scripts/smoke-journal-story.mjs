import assert from 'node:assert/strict';
import { insertJournalStory, renderDeterministicObservedJournalStory } from '../dist/journal-story.js';

const day = '2026-05-08';
const sessions = [
  session('act_work', '2026-05-08T16:12:00.000Z', '2026-05-08T16:45:00.000Z'),
  session('act_comms', '2026-05-08T17:16:00.000Z', '2026-05-08T17:22:00.000Z'),
];

const frames = [
  frame({
    id: 'frm_work_1',
    activity_session_id: 'act_work',
    timestamp: '2026-05-08T16:15:00.000Z',
    app: 'Warp',
    window_title: 'Redesign app interface for modern UX',
    entity_path: 'projects/ux',
    text: 'Both pass clean. Summary of the redesign Design system warm-neutral surface brand gradient Sidebar. 15 files changed, 1184 insertions(+), 184 deletions(-).',
  }),
  frame({
    id: 'frm_slack_1',
    activity_session_id: 'act_comms',
    timestamp: '2026-05-08T17:20:00.000Z',
    app: 'Slack',
    window_title: 'adam.perea-kane (DM) - Postman - Slack',
    entity_path: 'contacts/adam-perea-kane',
    text: 'maya.chen 11:01 AM can you post today the status of the feature parity work? feature matrix and status of each sdk adam.perea-kane 11:01 AM yup, will do',
  }),
  frame({
    id: 'frm_news_1',
    activity_session_id: 'act_comms',
    timestamp: '2026-05-08T17:21:00.000Z',
    app: 'Mail',
    window_title: 'All Inboxes',
    entity_path: 'apps/mail',
    text: 'Hacker Newsletter #793 agentic engineering links and training an LLM from scratch',
  }),
];

const story = renderDeterministicObservedJournalStory(frames, sessions) ?? '';
assert.match(story, /## Story/);
assert.match(story, /feature parity status/);
assert.match(story, /Adam said he would post/);
assert.match(story, /typecheck and build passed|clean verification/);
assert.doesNotMatch(story, /Hacker Newsletter #793\*\*:|newsletter.+Follow-ups/i);

const merged = insertJournalStory('# Journal\n\n## What happened\nold\n\n## Timeline\nraw\n', story);
assert.match(merged, /## Story/);
assert.doesNotMatch(merged, /## What happened/);
assert.match(merged, /## Timeline/);

function session(id, started_at, ended_at) {
  return {
    id,
    day,
    started_at,
    ended_at,
    duration_ms: Date.parse(ended_at) - Date.parse(started_at),
    active_ms: Date.parse(ended_at) - Date.parse(started_at),
    primary_app: null,
    primary_entity_path: null,
    primary_entity_kind: null,
    entities: [],
    app_counts: {},
  };
}

function frame(overrides) {
  return {
    id: overrides.id,
    timestamp: overrides.timestamp,
    day,
    monitor: 0,
    app: overrides.app,
    app_bundle_id: '',
    window_title: overrides.window_title,
    url: null,
    text: overrides.text ?? null,
    text_source: 'ocr_accessibility',
    asset_path: null,
    perceptual_hash: null,
    trigger: 'screenshot',
    session_id: 'capture',
    duration_ms: 60_000,
    entity_path: overrides.entity_path,
    entity_kind: null,
    activity_session_id: overrides.activity_session_id,
    meeting_id: null,
    source_event_ids: [overrides.id.replace(/^frm_/, 'evt_')],
  };
}
