import { createHash } from 'node:crypto';
import type { DayEvent, EntityRecord, Frame, Meeting } from '@cofounderos/interfaces';
import { resolveDateAnchor } from './agent/date.js';
import { compactFrame, getDayActivitySummary } from './agent/tools.js';
import type { CompactFrame, DayActivitySummaryResult, DateAnchor } from './agent/types.js';
import type { OrchestratorHandles } from './orchestrator.js';

export type RuntimeActionCenterSource = 'llm' | 'fallback';
export type RuntimeActionCenterUrgency = 'high' | 'medium' | 'low';
export type RuntimeFollowupCategory = 'reply' | 'send' | 'decide' | 'schedule' | 'task';

export interface RuntimeActionCenterFollowup {
  category: RuntimeFollowupCategory;
  title: string;
  body: string;
  urgency: RuntimeActionCenterUrgency;
  evidenceIds: string[];
}

export interface RuntimeActionCenterProject {
  path: string;
  title: string;
  kind: string;
  summary: string;
  status: string;
  nextActions: string[];
  evidenceIds: string[];
}

export interface RuntimeMeetingWorkBridge {
  meetingId: string;
  title: string;
  startedAt: string;
  summary: string;
  workAfter: string[];
  followups: string[];
  evidenceIds: string[];
}

export interface RuntimeActionCenter {
  day: string;
  generatedAt: string;
  source: RuntimeActionCenterSource;
  modelName: string;
  modelReady: boolean;
  followups: RuntimeActionCenterFollowup[];
  projects: RuntimeActionCenterProject[];
  meetingBridges: RuntimeMeetingWorkBridge[];
  evidence: Array<{
    id: string;
    label: string;
    kind: 'event' | 'meeting' | 'frame' | 'entity';
    at?: string;
  }>;
  signature: string;
}

export interface RuntimeActionCenterQuery {
  day?: string;
}

type ActionCenterContext = {
  day: string;
  generatedAt: string;
  screenFollowups: ScreenFollowupSignal[];
  followupSignals: FollowupSignal[];
  projects: ProjectSignal[];
  meetingBridges: MeetingBridgeSignal[];
};

type ScreenFollowupSignal = RuntimeActionCenterFollowup & {
  source: 'email' | 'chat';
  at: string;
};

type FollowupSignal = {
  evidence_id: string;
  kind: string;
  title: string;
  body: string;
  at: string;
};

type ProjectSignal = {
  evidence_id: string;
  path: string;
  title: string;
  kind: string;
  focused_min: number;
  frame_count: number;
  last_seen: string;
  recent: string[];
};

type MeetingBridgeSignal = {
  evidence_id: string;
  meeting_id: string;
  title: string;
  started_at: string;
  ended_at: string;
  tldr: string;
  meeting_followups: string[];
  work_after: Array<{
    evidence_id: string;
    at: string;
    app: string;
    title: string;
    entity: string | null;
    excerpt: string;
  }>;
};

type ModelPayload = {
  followups?: unknown;
  projects?: unknown;
  meeting_bridges?: unknown;
};

const ACTION_CENTER_TIMEOUT_MS = 90_000;
const SCREEN_FOLLOWUP_TIMEOUT_MS = 60_000;
const MAX_CONTEXT_CHARS = 12_000;
const SCREEN_FOLLOWUP_MAX_FRAMES_PER_SOURCE = 4;
const SCREEN_FOLLOWUP_MAX_PROMPT_CHARS = 10_000;
const SCREEN_FOLLOWUP_MIN_CONFIDENCE = 0.62;

export async function buildRuntimeActionCenter(
  handles: OrchestratorHandles,
  query: RuntimeActionCenterQuery = {},
): Promise<RuntimeActionCenter> {
  const anchor = resolveActionAnchor(query.day);
  const generatedAt = new Date().toISOString();
  const modelInfo = handles.model.getModelInfo();
  const modelReady = await handles.model.isAvailable().catch(() => false);

  const [daily, events, meetings, entities] = await Promise.all([
    getDayActivitySummary({ storage: handles.storage, strategy: handles.strategy }, anchor),
    handles.storage
      .listDayEvents({ day: anchor.day, order: 'chronological', limit: 180 })
      .catch(() => [] as DayEvent[]),
    handles.storage
      .listMeetings({ from: anchor.fromIso, to: anchor.toIso, order: 'recent', limit: 80 })
      .catch(() => [] as Meeting[]),
    handles.storage.listEntities({ limit: 120 }).catch(() => [] as EntityRecord[]),
  ]);

  const cleanEvents = events
    .filter((event) => event.title !== '__merged__')
    .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
  const cleanMeetings = meetings
    .filter((meeting) => meeting.day === anchor.day)
    .sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));
  const projectSignals = await buildProjectSignals(handles, entities, anchor);
  const bridgeSignals = await buildBridgeSignals(handles, cleanMeetings, anchor);
  const screenFollowups = modelReady
    ? await buildScreenFollowupSignals(handles, anchor).catch((err) => {
        handles.logger.debug('screen follow-up extraction failed', {
          day: anchor.day,
          err: String(err),
        });
        return [] as ScreenFollowupSignal[];
      })
    : [];
  const followupSignals = buildFollowupSignals(daily, cleanEvents, cleanMeetings);
  const context: ActionCenterContext = {
    day: anchor.day,
    generatedAt,
    screenFollowups,
    followupSignals,
    projects: projectSignals,
    meetingBridges: bridgeSignals,
  };
  const evidence = buildEvidence(context);
  const evidenceIds = new Set(evidence.map((item) => item.id));
  const signature = createHash('sha1').update(JSON.stringify(context)).digest('hex');

  if (modelReady) {
    try {
      const raw = await withTimeout(
        handles.model.complete(buildActionCenterPrompt(context), {
          systemPrompt: ACTION_CENTER_SYSTEM_PROMPT,
          responseFormat: 'json',
          temperature: 0.08,
          maxTokens: 1800,
        }),
      );
      const parsed = parseModelPayload(raw, context, evidenceIds);
      if (parsed) {
        const merged = {
          followups: mergeFollowups(
            screenFollowups,
            parsed.followups.length > 0
              ? parsed.followups
              : fallbackFollowups(followupSignals, []),
          ),
          projects: parsed.projects.length > 0 ? parsed.projects : fallbackProjects(projectSignals),
          meetingBridges: parsed.meetingBridges.length > 0
            ? parsed.meetingBridges
            : fallbackBridges(bridgeSignals),
        };
        return {
          day: anchor.day,
          generatedAt,
          source: 'llm',
          modelName: modelInfo.name,
          modelReady,
          ...merged,
          evidence,
          signature,
        };
      }
      handles.logger.debug('action center model returned unusable JSON', {
        day: anchor.day,
        sample: truncateText(raw, 500),
      });
    } catch (err) {
      handles.logger.debug('action center model synthesis failed', {
        day: anchor.day,
        err: String(err),
      });
    }
  }

  if (screenFollowups.length > 0) {
    return {
      day: anchor.day,
      generatedAt,
      source: 'llm',
      modelName: modelInfo.name,
      modelReady,
      followups: mergeFollowups(screenFollowups, []),
      projects: fallbackProjects(projectSignals),
      meetingBridges: fallbackBridges(bridgeSignals),
      evidence,
      signature,
    };
  }

  return {
    day: anchor.day,
    generatedAt,
    source: 'fallback',
    modelName: modelInfo.name,
    modelReady,
    followups: fallbackFollowups(followupSignals, screenFollowups),
    projects: fallbackProjects(projectSignals),
    meetingBridges: fallbackBridges(bridgeSignals),
    evidence,
    signature,
  };
}

function resolveActionAnchor(day?: string): DateAnchor {
  if (typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return resolveDateAnchor(day);
  }
  return resolveDateAnchor('today');
}

const SCREEN_FOLLOWUP_SYSTEM_PROMPT = `You extract only actionable follow-ups from the user's recent communication screenshots.

The screenshots may show mail inboxes (Apple Mail, Gmail, Outlook, Superhuman, etc.) or chat apps (Slack, Microsoft Teams, Discord, etc.). Identify emails or messages that are waiting on the user.

Rules:
- Use only the supplied screenshots/OCR. Do not invent senders, requests, deadlines, or status.
- Include an item only when the user likely needs to reply, send something, decide, schedule, review, or do a task.
- Skip newsletters, marketing, generic unread counts, sidebars, channel lists, resolved threads, and conversations where the user visibly replied last.
- Prefer direct asks, mentions, DMs, assigned/review requests, explicit "waiting on you", "can you", "please reply/respond", or scheduling questions.
- Every item must include one or more evidence_ids copied exactly from the frame blocks.
- If uncertain, omit the item.
- Return JSON only.`;

type ScreenFollowupFrame = {
  source: ScreenFollowupSignal['source'];
  frame: Frame;
};

type ScreenFollowupEvidence = {
  source: ScreenFollowupSignal['source'];
  at: string;
};

async function buildScreenFollowupSignals(
  handles: OrchestratorHandles,
  anchor: DateAnchor,
): Promise<ScreenFollowupSignal[]> {
  const frames = await handles.storage.searchFrames({
    from: anchor.fromIso,
    to: anchor.toIso,
    limit: 220,
  }).catch(() => [] as Frame[]);
  const candidates = selectScreenFollowupFrames(frames);
  if (candidates.length === 0) return [];

  const modelInfo = handles.model.getModelInfo();
  const { images, imageFrameIds } = modelInfo.supportsVision
    ? await loadScreenFollowupImages(handles, candidates)
    : { images: [] as Buffer[], imageFrameIds: new Map<string, number>() };
  const evidence = new Map<string, ScreenFollowupEvidence>(
    candidates.map(({ source, frame }) => [
      frameEvidenceId(frame.id),
      { source, at: frame.timestamp },
    ]),
  );
  const prompt = buildScreenFollowupPrompt(anchor, candidates, imageFrameIds, images.length > 0);
  const raw = await withScreenFollowupTimeout(
    images.length > 0
      ? handles.model.completeWithVision(prompt, images, {
          systemPrompt: SCREEN_FOLLOWUP_SYSTEM_PROMPT,
          responseFormat: 'json',
          temperature: 0.05,
          maxTokens: 1000,
        })
      : handles.model.complete(prompt, {
          systemPrompt: SCREEN_FOLLOWUP_SYSTEM_PROMPT,
          responseFormat: 'json',
          temperature: 0.05,
          maxTokens: 1000,
        }),
  );
  return parseScreenFollowupPayload(raw, evidence);
}

function selectScreenFollowupFrames(frames: Frame[]): ScreenFollowupFrame[] {
  const buckets: Record<ScreenFollowupSignal['source'], ScreenFollowupFrame[]> = {
    email: [],
    chat: [],
  };
  const seen = new Set<string>();
  const sorted = frames
    .slice()
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  for (const frame of sorted) {
    const source = classifyCommunicationSurface(frame);
    if (!source) continue;
    if (buckets[source].length >= SCREEN_FOLLOWUP_MAX_FRAMES_PER_SOURCE) continue;
    const text = (frame.text ?? '').trim();
    if (!frame.asset_path && text.length < 30) continue;
    const key = screenFrameDedupeKey(source, frame);
    if (seen.has(key)) continue;
    seen.add(key);
    buckets[source].push({ source, frame });
  }

  return [...buckets.email, ...buckets.chat]
    .sort((a, b) => b.frame.timestamp.localeCompare(a.frame.timestamp));
}

function classifyCommunicationSurface(frame: Frame): ScreenFollowupSignal['source'] | null {
  if (isEmailSurface(frame)) return 'email';
  if (isChatSurface(frame)) return 'chat';
  return null;
}

function isEmailSurface(frame: Frame): boolean {
  const app = (frame.app ?? '').toLowerCase();
  const bundle = (frame.app_bundle_id ?? '').toLowerCase();
  if (
    [
      'mail',
      'outlook',
      'microsoft outlook',
      'spark',
      'airmail',
      'superhuman',
      'hey',
      'mimestream',
      'thunderbird',
    ].includes(app)
  ) {
    return true;
  }
  if (
    bundle.startsWith('com.apple.mail') ||
    bundle.startsWith('com.microsoft.outlook') ||
    bundle.startsWith('com.readdle.smartemail') ||
    bundle.startsWith('com.superhuman')
  ) {
    return true;
  }
  const url = (frame.url ?? '').toLowerCase();
  return (
    /^https?:\/\/mail\.google\.com/.test(url) ||
    /^https?:\/\/outlook\.(live|office|office365)\.com\/(?:mail|owa)/.test(url) ||
    /^https?:\/\/(?:www\.)?icloud\.com\/mail/.test(url) ||
    /^https?:\/\/app\.fastmail\.com\/mail/.test(url) ||
    /^https?:\/\/mail\.yahoo\.com/.test(url) ||
    /^https?:\/\/mail\.proton\.me/.test(url) ||
    /^https?:\/\/(?:.+\.)?superhuman\.com/.test(url)
  );
}

function isChatSurface(frame: Frame): boolean {
  const app = (frame.app ?? '').toLowerCase();
  const bundle = (frame.app_bundle_id ?? '').toLowerCase();
  if (
    app === 'slack' ||
    app === 'discord' ||
    app === 'microsoft teams' ||
    app === 'teams' ||
    app === 'messages' ||
    app === 'imessage'
  ) {
    return true;
  }
  if (
    bundle.startsWith('com.tinyspeck.slackmacgap') ||
    bundle.startsWith('com.microsoft.teams') ||
    bundle.startsWith('com.apple.messages')
  ) {
    return true;
  }
  const url = (frame.url ?? '').toLowerCase();
  return (
    /^https?:\/\/app\.slack\.com/.test(url) ||
    /^https?:\/\/.+\.slack\.com/.test(url) ||
    /^https?:\/\/teams\.microsoft\.com/.test(url) ||
    /^https?:\/\/(?:www\.)?discord\.com\/channels/.test(url)
  );
}

function screenFrameDedupeKey(source: ScreenFollowupSignal['source'], frame: Frame): string {
  const surface = frame.url ? hostAndPath(frame.url) : frame.window_title || frame.app || 'unknown';
  const body =
    frame.perceptual_hash ??
    hashForKey(`${frame.window_title}\n${frame.text ?? ''}`.slice(0, 1600));
  return `${source}:${surface.toLowerCase()}:${body}`;
}

function hostAndPath(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return url;
  }
}

async function loadScreenFollowupImages(
  handles: OrchestratorHandles,
  candidates: ScreenFollowupFrame[],
): Promise<{ images: Buffer[]; imageFrameIds: Map<string, number> }> {
  const images: Buffer[] = [];
  const imageFrameIds = new Map<string, number>();
  for (const { frame } of candidates) {
    if (!frame.asset_path) continue;
    try {
      const image = await handles.storage.readAsset(frame.asset_path);
      images.push(image);
      imageFrameIds.set(frame.id, images.length);
    } catch (err) {
      handles.logger.debug('could not load communication screenshot for follow-up scan', {
        frameId: frame.id,
        assetPath: frame.asset_path,
        err: String(err),
      });
    }
  }
  return { images, imageFrameIds };
}

function buildScreenFollowupPrompt(
  anchor: DateAnchor,
  candidates: ScreenFollowupFrame[],
  imageFrameIds: Map<string, number>,
  vision: boolean,
): string {
  const header = [
    `User-local day: ${anchor.day}`,
    vision
      ? 'Screenshots are attached in the same order as their image numbers below. Use the screenshot first and OCR as backup.'
      : 'No screenshot attachment is available to this model; use the OCR text conservatively.',
    '',
    'Return this JSON shape:',
    '{ "followups": [ { "title": string, "body": string, "category": "reply|send|decide|schedule|task", "urgency": "high|medium|low", "evidence_ids": ["frame:..."], "confidence": number } ] }',
    '',
    'Category guide: reply = user should answer; send = user owes an artifact/info; decide = user must choose/approve; schedule = user should coordinate time; task = user should do non-message work.',
    '',
    'Recent communication frames:',
  ].join('\n');

  const blocks: string[] = [];
  let used = header.length;
  for (const { source, frame } of candidates) {
    const imageIndex = imageFrameIds.get(frame.id);
    const text = collapseForPrompt(frame.text ?? '', 1800);
    const block = [
      '',
      `[${frameEvidenceId(frame.id)}] source=${source} timestamp=${frame.timestamp}${imageIndex ? ` image=${imageIndex}` : ''}`,
      `app="${frame.app ?? ''}" title="${frame.window_title ?? ''}" url="${frame.url ?? ''}"`,
      text ? `ocr:\n${text}` : 'ocr: (none)',
    ].join('\n');
    if (used + block.length > SCREEN_FOLLOWUP_MAX_PROMPT_CHARS) break;
    blocks.push(block);
    used += block.length;
  }

  return `${header}${blocks.join('\n')}\n\nExtract only items waiting on the user. Empty array is fine.`;
}

function parseScreenFollowupPayload(
  raw: string,
  evidence: Map<string, ScreenFollowupEvidence>,
): ScreenFollowupSignal[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonObject(raw));
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const items = (parsed as { followups?: unknown }).followups;
  if (!Array.isArray(items)) return [];

  const out: ScreenFollowupSignal[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const confidence = typeof obj.confidence === 'number' ? obj.confidence : 1;
    if (confidence < SCREEN_FOLLOWUP_MIN_CONFIDENCE) continue;
    const title = cleanLine(obj.title, 130);
    if (!title) continue;
    const ids = stringArray(obj.evidence_ids ?? obj.frame_ids)
      .map(normaliseFrameEvidenceId)
      .filter((id) => evidence.has(id))
      .slice(0, 3);
    if (ids.length === 0) continue;
    const first = evidence.get(ids[0]!)!;
    out.push({
      source: first.source,
      at: first.at,
      category: normaliseCategory(obj.category),
      title,
      body: cleanLine(obj.body, 220),
      urgency: normaliseUrgency(obj.urgency),
      evidenceIds: ids,
    });
    if (out.length >= 8) break;
  }

  return mergeScreenFollowupDuplicates(out)
    .sort((a, b) => urgencyRank(b.urgency) - urgencyRank(a.urgency) || b.at.localeCompare(a.at))
    .slice(0, 6);
}

function normaliseFrameEvidenceId(id: string): string {
  const trimmed = id.trim();
  return trimmed.startsWith('frame:') ? trimmed : frameEvidenceId(trimmed);
}

function mergeScreenFollowupDuplicates(items: ScreenFollowupSignal[]): ScreenFollowupSignal[] {
  const out: ScreenFollowupSignal[] = [];
  for (const item of items) {
    if (out.some((existing) => followupLooksDuplicate(existing, item))) continue;
    out.push(item);
  }
  return out;
}

function buildFollowupSignals(
  daily: DayActivitySummaryResult,
  events: DayEvent[],
  meetings: Meeting[],
): FollowupSignal[] {
  const signals: FollowupSignal[] = [];
  for (const meeting of meetings) {
    const title = meeting.summary_json?.title ?? meeting.title ?? platformLabel(meeting.platform);
    for (const item of meeting.summary_json?.action_items ?? []) {
      signals.push({
        evidence_id: meetingEvidenceId(meeting.id),
        kind: 'meeting_action',
        title: item.owner ? `${item.owner}: ${item.task}` : item.task,
        body: title,
        at: meeting.started_at,
      });
    }
    for (const question of meeting.summary_json?.open_questions ?? []) {
      signals.push({
        evidence_id: meetingEvidenceId(meeting.id),
        kind: 'open_question',
        title: question.text,
        body: title,
        at: meeting.started_at,
      });
    }
  }
  for (const event of events) {
    if (event.kind !== 'task' && event.kind !== 'communication') continue;
    signals.push({
      evidence_id: eventEvidenceId(event.id),
      kind: event.kind,
      title: truncateText(event.title || event.source_app || event.kind, 160),
      body: truncateText(stripMarkdown(event.context_md ?? event.source_app ?? event.source), 240),
      at: event.starts_at,
    });
  }
  for (const frame of daily.open_loop_candidates.slice(0, 8)) {
    signals.push({
      evidence_id: frameEvidenceId(frame.id),
      kind: 'screen_open_loop',
      title: truncateText(frame.window_title || frame.app, 160),
      body: truncateText(frame.excerpt ?? '', 260),
      at: frame.timestamp,
    });
  }
  return dedupeByTitle(signals)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 18);
}

async function buildProjectSignals(
  handles: OrchestratorHandles,
  entities: EntityRecord[],
  anchor: DateAnchor,
): Promise<ProjectSignal[]> {
  const meaningful = entities
    .filter((entity) => ['project', 'repo', 'doc', 'channel'].includes(entity.kind))
    .filter((entity) => !/^(apps|meetings)\//.test(entity.path))
    .sort((a, b) =>
      b.lastSeen.localeCompare(a.lastSeen) ||
      b.totalFocusedMs - a.totalFocusedMs ||
      b.frameCount - a.frameCount,
    )
    .slice(0, 6);

  const out: ProjectSignal[] = [];
  for (const entity of meaningful) {
    const frames = await handles.storage.searchFrames({
      entityPath: entity.path,
      from: shiftIso(anchor.fromIso, -7 * 24 * 60),
      to: anchor.toIso,
      limit: 8,
    }).catch(() => [] as Frame[]);
    const compact = frames.map((frame) => compactFrame(frame, 180));
    out.push({
      evidence_id: entityEvidenceId(entity.path),
      path: entity.path,
      title: entity.title || displayEntity(entity.path),
      kind: entity.kind,
      focused_min: Math.round(entity.totalFocusedMs / 60000),
      frame_count: entity.frameCount,
      last_seen: entity.lastSeen,
      recent: compact
        .filter((frame) => frame.excerpt && !frame.garbled)
        .map((frame) => `${frame.app}: ${frame.excerpt}`)
        .slice(0, 4),
    });
  }
  return out;
}

async function buildBridgeSignals(
  handles: OrchestratorHandles,
  meetings: Meeting[],
  anchor: DateAnchor,
): Promise<MeetingBridgeSignal[]> {
  const ready = meetings
    .filter((meeting) => meeting.summary_json || meeting.summary_md)
    .slice(-6);
  const out: MeetingBridgeSignal[] = [];
  for (const meeting of ready) {
    const from = meeting.ended_at;
    const to = new Date(
      Math.min(Date.parse(anchor.toIso), Date.parse(meeting.ended_at) + 4 * 60 * 60_000),
    ).toISOString();
    const frames = await handles.storage.searchFrames({
      from,
      to,
      limit: 40,
    }).catch(() => [] as Frame[]);
    const workFrames = frames
      .filter((frame) => frame.meeting_id !== meeting.id)
      .filter((frame) => frame.entity_kind !== 'meeting')
      .filter((frame) => !['CofounderOS', 'Audio', 'loginwindow'].includes(frame.app))
      .map((frame) => compactFrame(frame, 180))
      .filter((frame) => frame.excerpt || frame.entity_path)
      .slice(0, 8);
    const summary = meeting.summary_json;
    out.push({
      evidence_id: meetingEvidenceId(meeting.id),
      meeting_id: meeting.id,
      title: summary?.title ?? meeting.title ?? platformLabel(meeting.platform),
      started_at: meeting.started_at,
      ended_at: meeting.ended_at,
      tldr: truncateText(summary?.tldr ?? stripMarkdown(meeting.summary_md ?? ''), 260),
      meeting_followups: [
        ...(summary?.action_items ?? []).map((item) => item.owner ? `${item.owner}: ${item.task}` : item.task),
        ...(summary?.open_questions ?? []).map((item) => item.text),
      ].slice(0, 6),
      work_after: workFrames.map((frame) => ({
        evidence_id: frameEvidenceId(frame.id),
        at: frame.timestamp,
        app: frame.app,
        title: truncateText(frame.window_title, 120),
        entity: frame.entity_path,
        excerpt: truncateText(frame.excerpt ?? '', 180),
      })),
    });
  }
  return out.filter((bridge) => bridge.meeting_followups.length > 0 || bridge.work_after.length > 0);
}

const ACTION_CENTER_SYSTEM_PROMPT = `You are the local CofounderOS work-triage model.

You receive locally captured evidence from the user's device. Produce three product surfaces:
1. Follow-up radar: specific replies, sends, decisions, scheduling, or tasks.
2. Active project memory: project status and next actions.
3. Meeting-to-work bridge: what work happened after meetings and what follow-up remains.

Rules:
- Use only the JSON context. Do not invent people, deadlines, meetings, projects, files, or decisions.
- Every item must include 1-3 evidence_ids copied exactly from context.
- Keep screenFollowups when present unless stronger context proves the user already handled them.
- Prefer concrete, actionable items over generic summaries.
- If evidence is weak, omit the item.
- Return JSON only.`;

function buildActionCenterPrompt(context: ActionCenterContext): string {
  return `Create the CofounderOS action center.

Return this JSON shape:
{
  "followups": [
    { "category": "reply|send|decide|schedule|task", "title": "specific action", "body": "why / source context", "urgency": "high|medium|low", "evidence_ids": ["event:..."] }
  ],
  "projects": [
    { "path": "entity path from context", "title": "project title", "summary": "current status", "status": "short state label", "next_actions": ["next thing"], "evidence_ids": ["entity:..."] }
  ],
  "meeting_bridges": [
    { "meeting_id": "id from context", "summary": "how meeting connected to later work", "work_after": ["specific work after"], "followups": ["remaining follow-up"], "evidence_ids": ["meeting:..."] }
  ]
}

Limits:
- followups: max 6.
- projects: max 4.
- meeting_bridges: max 4.
- Keep strings concise.

Context:
${serializeContext(context)}`;
}

function serializeContext(context: ActionCenterContext): string {
  const slim = {
    day: context.day,
    generatedAt: context.generatedAt,
    screenFollowups: context.screenFollowups.slice(0, 6).map((followup) => ({
      source: followup.source,
      at: followup.at,
      category: followup.category,
      title: followup.title,
      body: truncateText(followup.body, 180),
      urgency: followup.urgency,
      evidence_ids: followup.evidenceIds.slice(0, 3),
    })),
    followupSignals: context.followupSignals.slice(0, 14),
    projects: context.projects.slice(0, 5).map((project) => ({
      ...project,
      recent: project.recent.slice(0, 3).map((item) => truncateText(item, 160)),
    })),
    meetingBridges: context.meetingBridges.slice(0, 5).map((bridge) => ({
      ...bridge,
      tldr: truncateText(bridge.tldr, 180),
      meeting_followups: bridge.meeting_followups.slice(0, 4),
      work_after: bridge.work_after.slice(0, 5),
    })),
  };
  let json = JSON.stringify(slim, null, 2);
  if (json.length <= MAX_CONTEXT_CHARS) return json;
  json = JSON.stringify({
    ...slim,
    screenFollowups: slim.screenFollowups.slice(0, 5),
    followupSignals: slim.followupSignals.slice(0, 10),
    projects: slim.projects.slice(0, 4).map((project) => ({ ...project, recent: project.recent.slice(0, 2) })),
    meetingBridges: slim.meetingBridges.slice(0, 3).map((bridge) => ({
      ...bridge,
      work_after: bridge.work_after.slice(0, 3),
    })),
  }, null, 2);
  return json.length <= MAX_CONTEXT_CHARS ? json : `${json.slice(0, MAX_CONTEXT_CHARS - 3)}...`;
}

function parseModelPayload(
  raw: string,
  context: ActionCenterContext,
  evidenceIds: Set<string>,
): Pick<RuntimeActionCenter, 'followups' | 'projects' | 'meetingBridges'> | null {
  let parsed: ModelPayload;
  try {
    parsed = JSON.parse(extractJsonObject(raw)) as ModelPayload;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const followups = parseFollowups(parsed.followups, evidenceIds);
  const projects = parseProjects(parsed.projects, context.projects, evidenceIds);
  const meetingBridges = parseBridges(parsed.meeting_bridges, context.meetingBridges, evidenceIds);
  if (followups.length === 0 && projects.length === 0 && meetingBridges.length === 0) return null;
  return { followups, projects, meetingBridges };
}

function parseFollowups(value: unknown, evidenceIds: Set<string>): RuntimeActionCenterFollowup[] {
  if (!Array.isArray(value)) return [];
  const out: RuntimeActionCenterFollowup[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const title = cleanLine(obj.title, 130);
    const evidence = stringArray(obj.evidence_ids).filter((id) => evidenceIds.has(id)).slice(0, 3);
    if (!title || evidence.length === 0) continue;
    out.push({
      category: normaliseCategory(obj.category),
      title,
      body: cleanLine(obj.body, 220),
      urgency: normaliseUrgency(obj.urgency),
      evidenceIds: evidence,
    });
    if (out.length >= 6) break;
  }
  return out;
}

function parseProjects(
  value: unknown,
  contextProjects: ProjectSignal[],
  evidenceIds: Set<string>,
): RuntimeActionCenterProject[] {
  if (!Array.isArray(value)) return [];
  const byPath = new Map(contextProjects.map((project) => [project.path, project]));
  const out: RuntimeActionCenterProject[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const path = typeof obj.path === 'string' ? obj.path : '';
    const source = byPath.get(path);
    if (!source) continue;
    const evidence = stringArray(obj.evidence_ids).filter((id) => evidenceIds.has(id)).slice(0, 3);
    if (evidence.length === 0) continue;
    out.push({
      path,
      title: cleanLine(obj.title, 100) || source.title,
      kind: source.kind,
      summary: cleanLine(obj.summary, 260),
      status: cleanLine(obj.status, 80),
      nextActions: stringArray(obj.next_actions).map((item) => truncateText(item, 140)).slice(0, 3),
      evidenceIds: evidence,
    });
    if (out.length >= 4) break;
  }
  return out;
}

function parseBridges(
  value: unknown,
  contextBridges: MeetingBridgeSignal[],
  evidenceIds: Set<string>,
): RuntimeMeetingWorkBridge[] {
  if (!Array.isArray(value)) return [];
  const byId = new Map(contextBridges.map((bridge) => [bridge.meeting_id, bridge]));
  const out: RuntimeMeetingWorkBridge[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const meetingId = typeof obj.meeting_id === 'string' ? obj.meeting_id : '';
    const source = byId.get(meetingId);
    if (!source) continue;
    const evidence = stringArray(obj.evidence_ids).filter((id) => evidenceIds.has(id)).slice(0, 3);
    if (evidence.length === 0) continue;
    out.push({
      meetingId,
      title: source.title,
      startedAt: source.started_at,
      summary: cleanLine(obj.summary, 260),
      workAfter: stringArray(obj.work_after).map((item) => truncateText(item, 160)).slice(0, 4),
      followups: stringArray(obj.followups).map((item) => truncateText(item, 160)).slice(0, 4),
      evidenceIds: evidence,
    });
    if (out.length >= 4) break;
  }
  return out;
}

function fallbackFollowups(
  signals: FollowupSignal[],
  screenFollowups: ScreenFollowupSignal[],
): RuntimeActionCenterFollowup[] {
  return mergeFollowups(
    screenFollowups,
    signals.slice(0, 6).map((signal) => ({
      category: signal.kind === 'communication' ? 'reply' : 'task',
      title: signal.title,
      body: signal.body,
      urgency: signal.kind === 'meeting_action' ? 'high' : 'medium',
      evidenceIds: [signal.evidence_id],
    })),
  );
}

function fallbackProjects(projects: ProjectSignal[]): RuntimeActionCenterProject[] {
  return projects.slice(0, 4).map((project) => ({
    path: project.path,
    title: project.title,
    kind: project.kind,
    summary: project.recent[0] ?? `${project.focused_min} focused minutes captured recently.`,
    status: project.last_seen ? `Last seen ${project.last_seen.slice(0, 10)}` : 'Active',
    nextActions: project.recent.slice(0, 2),
    evidenceIds: [project.evidence_id],
  }));
}

function fallbackBridges(bridges: MeetingBridgeSignal[]): RuntimeMeetingWorkBridge[] {
  return bridges.slice(0, 4).map((bridge) => ({
    meetingId: bridge.meeting_id,
    title: bridge.title,
    startedAt: bridge.started_at,
    summary: bridge.work_after[0]
      ? `After this meeting, work shifted into ${bridge.work_after[0].entity ?? bridge.work_after[0].app}.`
      : bridge.tldr,
    workAfter: bridge.work_after.map((frame) => frame.entity ?? (frame.title || frame.app)).slice(0, 4),
    followups: bridge.meeting_followups.slice(0, 4),
    evidenceIds: [bridge.evidence_id, ...bridge.work_after.map((frame) => frame.evidence_id).slice(0, 2)],
  }));
}

function mergeFollowups(
  priority: Array<RuntimeActionCenterFollowup | ScreenFollowupSignal>,
  rest: RuntimeActionCenterFollowup[],
): RuntimeActionCenterFollowup[] {
  const out: RuntimeActionCenterFollowup[] = [];
  for (const item of [...priority, ...rest]) {
    const clean = stripFollowupRuntimeFields(item);
    if (!clean.title || clean.evidenceIds.length === 0) continue;
    if (out.some((existing) => followupLooksDuplicate(existing, clean))) continue;
    out.push(clean);
    if (out.length >= 6) break;
  }
  return out;
}

function stripFollowupRuntimeFields(
  item: RuntimeActionCenterFollowup | ScreenFollowupSignal,
): RuntimeActionCenterFollowup {
  return {
    category: item.category,
    title: item.title,
    body: item.body,
    urgency: item.urgency,
    evidenceIds: item.evidenceIds.slice(0, 3),
  };
}

function followupLooksDuplicate(
  a: Pick<RuntimeActionCenterFollowup, 'title' | 'evidenceIds'>,
  b: Pick<RuntimeActionCenterFollowup, 'title' | 'evidenceIds'>,
): boolean {
  if (a.evidenceIds.some((id) => b.evidenceIds.includes(id))) return true;
  const ak = normaliseFollowupTitle(a.title);
  const bk = normaliseFollowupTitle(b.title);
  if (!ak || !bk) return false;
  return ak === bk || (ak.length > 18 && bk.includes(ak)) || (bk.length > 18 && ak.includes(bk));
}

function normaliseFollowupTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(reply|respond|follow up|followup|send|decide|schedule|task)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function urgencyRank(urgency: RuntimeActionCenterUrgency): number {
  switch (urgency) {
    case 'high':
      return 3;
    case 'medium':
      return 2;
    case 'low':
      return 1;
  }
}

function buildEvidence(context: ActionCenterContext): RuntimeActionCenter['evidence'] {
  const evidence: RuntimeActionCenter['evidence'] = [];
  for (const followup of context.screenFollowups) {
    for (const id of followup.evidenceIds) {
      evidence.push({ id, label: followup.title, kind: kindFromEvidence(id), at: followup.at });
    }
  }
  for (const signal of context.followupSignals) {
    evidence.push({ id: signal.evidence_id, label: signal.title, kind: kindFromEvidence(signal.evidence_id), at: signal.at });
  }
  for (const project of context.projects) {
    evidence.push({ id: project.evidence_id, label: project.title, kind: 'entity', at: project.last_seen });
  }
  for (const bridge of context.meetingBridges) {
    evidence.push({ id: bridge.evidence_id, label: bridge.title, kind: 'meeting', at: bridge.started_at });
    for (const frame of bridge.work_after) {
      evidence.push({ id: frame.evidence_id, label: frame.title || frame.app, kind: 'frame', at: frame.at });
    }
  }
  const seen = new Set<string>();
  return evidence.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function kindFromEvidence(id: string): RuntimeActionCenter['evidence'][number]['kind'] {
  if (id.startsWith('meeting:')) return 'meeting';
  if (id.startsWith('frame:')) return 'frame';
  if (id.startsWith('entity:')) return 'entity';
  return 'event';
}

function dedupeByTitle<T extends { title: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.title.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normaliseCategory(value: unknown): RuntimeFollowupCategory {
  return value === 'reply' || value === 'send' || value === 'decide' || value === 'schedule' || value === 'task'
    ? value
    : 'task';
}

function normaliseUrgency(value: unknown): RuntimeActionCenterUrgency {
  return value === 'high' || value === 'medium' || value === 'low' ? value : 'medium';
}

function cleanLine(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') return '';
  return truncateText(value.replace(/\s+/g, ' ').replace(/^[-*]\s+/, '').trim(), maxChars);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) return trimmed;
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) return trimmed.slice(firstBrace, lastBrace + 1);
  return trimmed;
}

function stripMarkdown(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[#>*_~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateText(value: string, maxChars: number): string {
  const cleaned = value.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function collapseForPrompt(value: string, maxChars: number): string {
  const cleaned = value
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function hashForKey(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 12);
}

function displayEntity(path: string): string {
  return path
    .split('/')
    .filter(Boolean)
    .pop()
    ?.replace(/[-_]+/g, ' ') ?? path;
}

function eventEvidenceId(id: string): string {
  return `event:${id}`;
}

function meetingEvidenceId(id: string): string {
  return `meeting:${id}`;
}

function frameEvidenceId(id: string): string {
  return `frame:${id}`;
}

function entityEvidenceId(path: string): string {
  return `entity:${path}`;
}

function shiftIso(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

function platformLabel(platform: Meeting['platform']): string {
  const labels: Record<Meeting['platform'], string> = {
    zoom: 'Zoom meeting',
    meet: 'Google Meet',
    teams: 'Teams meeting',
    webex: 'Webex meeting',
    whereby: 'Whereby meeting',
    around: 'Around meeting',
    other: 'Meeting',
  };
  return labels[platform] ?? 'Meeting';
}

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('action center generation timed out')), ACTION_CENTER_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function withScreenFollowupTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('screen follow-up extraction timed out')), SCREEN_FOLLOWUP_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
