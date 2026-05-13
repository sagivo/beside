#!/usr/bin/env node
// Quick smoke test for the heuristic parsers in src/parsers.ts.
// Run with: node plugins/export/mcp/scripts/smoke-parsers.mjs

import {
  classifyFrame,
  extractCalendarEventsFromFrame,
  extractChatFromFrame,
  extractReviewItemFromFrame,
  isSelfFrame,
  dedupeCalendarEvents,
} from '../dist/parsers.js';

function frame(overrides) {
  return {
    id: 'frame_x',
    timestamp: '2026-05-06T09:00:00Z',
    day: '2026-05-06',
    monitor: 0,
    app: '',
    app_bundle_id: '',
    window_title: '',
    url: null,
    text: null,
    text_source: 'ocr',
    asset_path: null,
    perceptual_hash: null,
    trigger: null,
    session_id: 'sess_1',
    duration_ms: 30000,
    entity_path: null,
    entity_kind: null,
    activity_session_id: null,
    source_event_ids: [],
    ...overrides,
  };
}

const checks = [];

function expect(label, actual, predicate) {
  const ok = predicate(actual);
  checks.push({ label, ok, actual });
}

// 1. isSelfFrame should fire on beside app + entity_path
expect(
  'isSelfFrame: beside app',
  isSelfFrame(frame({ app: 'Beside' })),
  (v) => v === true,
);
expect(
  'isSelfFrame: apps/beside entity',
  isSelfFrame(frame({ entity_path: 'apps/beside', entity_kind: 'app' })),
  (v) => v === true,
);
expect(
  'isSelfFrame: random app does not match',
  isSelfFrame(frame({ app: 'Cursor' })),
  (v) => v === false,
);

// 2. classifyFrame
expect(
  'classifyFrame: Slack web',
  classifyFrame(frame({ url: 'https://app.slack.com/client/T123/C456', app: 'Chrome' })),
  (v) => v === 'chat',
);
expect(
  'classifyFrame: Google Calendar web',
  classifyFrame(frame({ url: 'https://calendar.google.com/calendar/u/0/r', app: 'Firefox' })),
  (v) => v === 'calendar',
);
expect(
  'classifyFrame: GitHub PR',
  classifyFrame(frame({ url: 'https://github.com/owner/repo/pull/42', app: 'Chrome' })),
  (v) => v === 'code-review',
);
expect(
  'classifyFrame: Cursor (none)',
  classifyFrame(frame({ app: 'Cursor', window_title: 'index.ts — workspace' })),
  (v) => v === null,
);

// 3. extractCalendarEventsFromFrame
const calFrame = frame({
  app: 'Google Calendar',
  url: 'https://calendar.google.com/calendar/u/0/r',
  text: [
    'Wed, May 6',
    '9:00 – 10:00 AM',
    'Standup with Maya',
    '11:30 AM – 12:00 PM',
    'Lunch',
    '2:00 PM',
    'Beside sync',
  ].join('\n'),
});
const calEvents = extractCalendarEventsFromFrame(calFrame);
expect(
  'extractCalendarEvents: parses standup',
  calEvents,
  (events) => events.some((e) => e.title.toLowerCase().includes('standup')),
);
expect(
  'extractCalendarEvents: parses afternoon sync',
  calEvents,
  (events) => events.some((e) => e.title.toLowerCase().includes('beside sync')),
);
expect(
  'dedupeCalendarEvents: unique titles per time_label',
  dedupeCalendarEvents([...calEvents, ...calEvents]),
  (events) => events.length === calEvents.length,
);

// Calendar OCR cruft should be filtered out by the sanitiser.
const noisyCal = frame({
  app: 'Calendar',
  text: [
    '10:30 - 11:30AM',
    '© 11:30AM ~ 12:45PM',
    '11:30AM - 12:30PM',
    '0 meet.google.com',
    '1:45 PM',
    '1[Zoom Interview',
  ].join('\n'),
});
const noisyEvents = extractCalendarEventsFromFrame(noisyCal);
expect(
  'extractCalendarEvents: rejects bare meet.google.com title',
  noisyEvents,
  (events) => !events.some((e) => /meet\.google\.com$/i.test(e.title)),
);
expect(
  'extractCalendarEvents: strips leading "1[" cruft',
  noisyEvents,
  (events) => events.some((e) => /^Zoom Interview/i.test(e.title)),
);
expect(
  'extractCalendarEvents: rejects pure-time-with-symbol title',
  noisyEvents,
  (events) => !events.some((e) => /^[©~\s]*\d/i.test(e.title) && e.title.length < 14),
);

// 4. extractChatFromFrame
const slackFrame = frame({
  app: 'Slack',
  url: 'https://app.slack.com/client/T1/C2',
  window_title: 'Slack — #sdk-warn-alerts-prod',
  text: [
    '#sdk-warn-alerts-prod',
    'Maya 9:01 AM',
    'Hey @alex any thoughts on the new alert routing?',
    '3 replies',
  ].join('\n'),
});
const chatSnippet = extractChatFromFrame(slackFrame);
expect(
  'extractChat: channel detected',
  chatSnippet?.channel,
  (v) => v === '#sdk-warn-alerts-prod',
);
expect(
  'extractChat: looks_unanswered',
  chatSnippet?.looks_unanswered,
  (v) => v === true,
);
expect(
  'extractChat: mentions',
  chatSnippet?.mentions,
  (v) => Array.isArray(v) && v.includes('@alex'),
);

// 5. extractReviewItemFromFrame
const prFrame = frame({
  app: 'Chrome',
  url: 'https://github.com/beside/core/pull/123',
  window_title: 'Add daily summary endpoint by Alex · Pull Request #123 · beside/core',
  text: 'Open · Alex wants to merge 3 commits into main from feature/daily-summary',
});
const prItem = extractReviewItemFromFrame(prFrame);
expect(
  'extractReviewItem: ref',
  prItem?.ref,
  (v) => v === 'beside/core#123',
);
expect(
  'extractReviewItem: status open',
  prItem?.status,
  (v) => v === 'open',
);
expect(
  'extractReviewItem: kind',
  prItem?.kind,
  (v) => v === 'pull_request',
);

// Report
let failures = 0;
for (const c of checks) {
  const tick = c.ok ? 'OK ' : 'FAIL';
  console.log(`${tick}  ${c.label}`);
  if (!c.ok) {
    failures += 1;
    console.log('     actual =', JSON.stringify(c.actual, null, 2));
  }
}
console.log(`\n${checks.length - failures}/${checks.length} checks passed.`);
process.exit(failures === 0 ? 0 : 1);
