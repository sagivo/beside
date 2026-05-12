import { createHash } from 'node:crypto';
import type { DayEvent, EntityRecord, Frame, Meeting } from '@beside/interfaces';
import { resolveDateAnchor } from './agent/date.js';
import { compactFrame, getDayActivitySummary } from './agent/tools.js';
import type { CompactFrame, DayActivitySummaryResult, DateAnchor } from './agent/types.js';
import type { OrchestratorHandles } from './orchestrator.js';

export type RuntimeActionCenterSource = 'llm' | 'fallback';
export type RuntimeActionCenterUrgency = 'high' | 'medium' | 'low';
export type RuntimeFollowupCategory = 'reply' | 'send' | 'decide' | 'schedule' | 'task';

export interface RuntimeActionCenterFollowup { app?: string; category: RuntimeFollowupCategory; title: string; body: string; urgency: RuntimeActionCenterUrgency; evidenceIds: string[]; }
export interface RuntimeActionCenterProject { path: string; title: string; kind: string; summary: string; status: string; nextActions: string[]; evidenceIds: string[]; }
export interface RuntimeMeetingWorkBridge { meetingId: string; title: string; startedAt: string; summary: string; workAfter: string[]; followups: string[]; evidenceIds: string[]; }

export interface RuntimeActionCenter {
  day: string; generatedAt: string; source: RuntimeActionCenterSource; modelName: string; modelReady: boolean;
  followups: RuntimeActionCenterFollowup[]; projects: RuntimeActionCenterProject[]; meetingBridges: RuntimeMeetingWorkBridge[];
  evidence: Array<{ id: string; label: string; kind: 'event' | 'meeting' | 'frame' | 'entity'; at?: string; }>; signature: string;
}

export interface RuntimeActionCenterQuery { day?: string; }

type ActionCenterContext = { day: string; generatedAt: string; screenFollowups: ScreenFollowupSignal[]; followupSignals: FollowupSignal[]; projects: ProjectSignal[]; meetingBridges: MeetingBridgeSignal[]; };
type ScreenFollowupSignal = RuntimeActionCenterFollowup & { app?: string; source: 'email' | 'chat'; at: string; };
type FollowupSignal = { evidence_id: string; kind: string; title: string; body: string; at: string; app?: string; };
type ProjectSignal = { evidence_id: string; path: string; title: string; kind: string; focused_min: number; frame_count: number; last_seen: string; recent: string[]; };
type MeetingBridgeSignal = { evidence_id: string; meeting_id: string; title: string; started_at: string; ended_at: string; tldr: string; meeting_followups: string[]; work_after: Array<{ evidence_id: string; at: string; app: string; title: string; entity: string | null; excerpt: string; }>; };

const ACTION_CENTER_TIMEOUT_MS = 90_000, SCREEN_FOLLOWUP_TIMEOUT_MS = 60_000, MAX_CONTEXT_CHARS = 12_000, SCREEN_FOLLOWUP_MAX_FRAMES_PER_SOURCE = 4, SCREEN_FOLLOWUP_MAX_PROMPT_CHARS = 10_000, SCREEN_FOLLOWUP_MIN_CONFIDENCE = 0.62;

export async function buildRuntimeActionCenter(handles: OrchestratorHandles, query: RuntimeActionCenterQuery = {}): Promise<RuntimeActionCenter> {
  const anchor = resolveActionAnchor(query.day), generatedAt = new Date().toISOString(), modelInfo = handles.model.getModelInfo();
  const modelReady = await handles.model.isAvailable().catch(() => false);

  const [daily, events, meetings, entities] = await Promise.all([
    getDayActivitySummary({ storage: handles.storage, strategy: handles.strategy }, anchor),
    handles.storage.listDayEvents({ day: anchor.day, order: 'chronological', limit: 180 }).catch(() => [] as DayEvent[]),
    handles.storage.listMeetings({ from: anchor.fromIso, to: anchor.toIso, order: 'recent', limit: 80 }).catch(() => [] as Meeting[]),
    handles.storage.listEntities({ limit: 120 }).catch(() => [] as EntityRecord[]),
  ]);

  const cleanEvents = events.filter(e => e.title !== '__merged__').sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
  const cleanMeetings = meetings.filter(m => m.day === anchor.day).sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));
  const projectSignals = await buildProjectSignals(handles, entities, anchor);
  const bridgeSignals = await buildBridgeSignals(handles, cleanMeetings, anchor);
  const screenFollowups = modelReady ? await buildScreenFollowupSignals(handles, anchor).catch(e => { handles.logger.debug('screen follow-up failed', { err: String(e) }); return []; }) : [];
  const followupSignals = buildFollowupSignals(daily, cleanEvents, cleanMeetings);
  const context: ActionCenterContext = { day: anchor.day, generatedAt, screenFollowups, followupSignals, projects: projectSignals, meetingBridges: bridgeSignals };
  const evidence = buildEvidence(context), evidenceIds = new Set(evidence.map(i => i.id)), signature = createHash('sha1').update(JSON.stringify(context)).digest('hex');

  if (modelReady) {
    try {
      const raw = await withTimeout(handles.model.complete(buildActionCenterPrompt(context), { systemPrompt: ACTION_CENTER_SYSTEM_PROMPT, responseFormat: 'json', temperature: 0.08, maxTokens: 1800 }), ACTION_CENTER_TIMEOUT_MS);
      const parsed = parseModelPayload(raw, context, evidenceIds);
      if (parsed) return { day: anchor.day, generatedAt, source: 'llm', modelName: modelInfo.name, modelReady, followups: mergeFollowups(screenFollowups, parsed.followups.length ? parsed.followups : fallbackFollowups(followupSignals, [])), projects: parsed.projects.length ? parsed.projects : fallbackProjects(projectSignals), meetingBridges: parsed.meetingBridges.length ? parsed.meetingBridges : fallbackBridges(bridgeSignals), evidence, signature };
      handles.logger.debug('action center unusable JSON');
    } catch (e) { handles.logger.debug('action center synthesis failed', { err: String(e) }); }
  }

  return { day: anchor.day, generatedAt, source: screenFollowups.length ? 'llm' : 'fallback', modelName: modelInfo.name, modelReady, followups: mergeFollowups(screenFollowups, screenFollowups.length ? [] : fallbackFollowups(followupSignals, [])), projects: fallbackProjects(projectSignals), meetingBridges: fallbackBridges(bridgeSignals), evidence, signature };
}

function resolveActionAnchor(day?: string): DateAnchor { return typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) ? resolveDateAnchor(day) : resolveDateAnchor('today'); }

const SCREEN_FOLLOWUP_SYSTEM_PROMPT = `You extract only actionable follow-ups from the user's recent communication screenshots.\nReturn JSON only.`;

async function buildScreenFollowupSignals(handles: OrchestratorHandles, anchor: DateAnchor): Promise<ScreenFollowupSignal[]> {
  const frames = await handles.storage.searchFrames({ from: anchor.fromIso, to: anchor.toIso, limit: 220 }).catch(() => [] as Frame[]);
  const candidates = selectScreenFollowupFrames(frames);
  if (!candidates.length) return [];
  const modelInfo = handles.model.getModelInfo();
  const { images, imageFrameIds } = modelInfo.supportsVision ? await loadScreenFollowupImages(handles, candidates) : { images: [], imageFrameIds: new Map<string, number>() };
  const evidence = new Map(candidates.map(({ source, frame }) => [frameEvidenceId(frame.id), { source, at: frame.timestamp }]));
  const prompt = buildScreenFollowupPrompt(anchor, candidates, imageFrameIds, images.length > 0);
  const raw = await withTimeout(images.length ? handles.model.completeWithVision(prompt, images, { systemPrompt: SCREEN_FOLLOWUP_SYSTEM_PROMPT, responseFormat: 'json', temperature: 0.05, maxTokens: 1000 }) : handles.model.complete(prompt, { systemPrompt: SCREEN_FOLLOWUP_SYSTEM_PROMPT, responseFormat: 'json', temperature: 0.05, maxTokens: 1000 }), SCREEN_FOLLOWUP_TIMEOUT_MS);
  return parseScreenFollowupPayload(raw, evidence);
}

function selectScreenFollowupFrames(frames: Frame[]): { source: 'email'|'chat'; frame: Frame }[] {
  const b = { email: [], chat: [] } as Record<'email'|'chat', any[]>, seen = new Set<string>();
  frames.slice().sort((a, b) => b.timestamp.localeCompare(a.timestamp)).forEach(f => {
    const src = classifyCommunicationSurface(f); if (!src || b[src].length >= SCREEN_FOLLOWUP_MAX_FRAMES_PER_SOURCE) return;
    if (!f.asset_path && (f.text ?? '').trim().length < 30) return;
    const key = `${src}:${hostAndPath(f.url ?? '')}:${f.perceptual_hash ?? hashForKey(`${f.window_title}\n${f.text ?? ''}`.slice(0, 1600))}`;
    if (!seen.has(key)) { seen.add(key); b[src].push({ source: src, frame: f }); }
  });
  return [...b.email, ...b.chat].sort((a, b) => b.frame.timestamp.localeCompare(a.frame.timestamp));
}

function classifyCommunicationSurface(frame: Frame): 'email'|'chat'|null {
  const a = (frame.app ?? '').toLowerCase(), u = (frame.url ?? '').toLowerCase();
  if (['mail', 'outlook', 'spark', 'superhuman', 'mimestream'].some(x => a.includes(x)) || u.includes('mail.')) return 'email';
  if (['slack', 'discord', 'teams', 'messages'].some(x => a.includes(x)) || u.includes('slack.com')) return 'chat';
  return null;
}

function hostAndPath(url: string): string { try { const p = new URL(url); return `${p.host}${p.pathname}`; } catch { return url; } }

async function loadScreenFollowupImages(handles: OrchestratorHandles, candidates: { frame: Frame }[]) {
  const images: Buffer[] = [], imageFrameIds = new Map<string, number>();
  for (const { frame } of candidates) if (frame.asset_path) try { images.push(await handles.storage.readAsset(frame.asset_path)); imageFrameIds.set(frame.id, images.length); } catch {}
  return { images, imageFrameIds };
}

function buildScreenFollowupPrompt(anchor: DateAnchor, candidates: { source: string; frame: Frame }[], imageFrameIds: Map<string, number>, vision: boolean): string {
  const head = [`Day: ${anchor.day}`, vision ? 'Use screenshots first.' : 'Use OCR conservatively.', 'Return JSON: { "followups": [ { "title": string, "body": string, "category": "reply|send|decide|schedule|task", "urgency": "high|medium|low", "evidence_ids": ["frame:..."], "confidence": number } ] }'].join('\n');
  let used = head.length, blocks: string[] = [];
  for (const { source, frame } of candidates) {
    const block = `\n[${frameEvidenceId(frame.id)}] source=${source} ${imageFrameIds.has(frame.id) ? `image=${imageFrameIds.get(frame.id)}` : ''}\napp="${frame.app}" title="${frame.window_title}" url="${frame.url}"\nocr:\n${collapseForPrompt(frame.text ?? '', 1800)}`;
    if (used + block.length > SCREEN_FOLLOWUP_MAX_PROMPT_CHARS) break;
    blocks.push(block); used += block.length;
  }
  return `${head}${blocks.join('\n')}\n\nExtract only actionable follow-ups.`;
}

type ScreenFollowupEvidence = { source: 'email' | 'chat'; at: string; };
function parseScreenFollowupPayload(raw: string, evidence: Map<string, ScreenFollowupEvidence>): ScreenFollowupSignal[] {
  try {
    const p = JSON.parse(extractJsonObject(raw)) as any;
    if (!Array.isArray(p?.followups)) return [];
    const out: ScreenFollowupSignal[] = [];
    for (const obj of p.followups) {
      if ((obj.confidence ?? 1) < SCREEN_FOLLOWUP_MIN_CONFIDENCE || !cleanLine(obj.title, 130)) continue;
      const ids = stringArray(obj.evidence_ids ?? obj.frame_ids).map(i => i.startsWith('frame:') ? i : frameEvidenceId(i)).filter(i => evidence.has(i)).slice(0, 3);
      if (!ids.length) continue;
      out.push({ source: evidence.get(ids[0]!)!.source, app: evidence.get(ids[0]!)!.source, at: evidence.get(ids[0]!)!.at, category: normaliseCategory(obj.category), title: cleanLine(obj.title, 130), body: cleanLine(obj.body, 220), urgency: normaliseUrgency(obj.urgency), evidenceIds: ids });
      if (out.length >= 8) break;
    }
    return mergeFollowups(out, []).sort((a, b) => urgencyRank(b.urgency) - urgencyRank(a.urgency) || (b as any).at.localeCompare((a as any).at)).slice(0, 6) as ScreenFollowupSignal[];
  } catch { return []; }
}

function buildFollowupSignals(daily: DayActivitySummaryResult, events: DayEvent[], meetings: Meeting[]): FollowupSignal[] {
  const sigs: FollowupSignal[] = [];
  meetings.forEach(m => {
    const t = m.summary_json?.title ?? m.title ?? m.platform;
    m.summary_json?.action_items?.forEach(i => sigs.push({ evidence_id: meetingEvidenceId(m.id), kind: 'meeting_action', title: i.owner ? `${i.owner}: ${i.task}` : i.task, body: t, at: m.started_at, app: platformLabel(m.platform) }));
    m.summary_json?.open_questions?.forEach(q => sigs.push({ evidence_id: meetingEvidenceId(m.id), kind: 'open_question', title: q.text, body: t, at: m.started_at, app: platformLabel(m.platform) }));
  });
  events.filter(e => ['task', 'communication'].includes(e.kind)).forEach(e => sigs.push({ evidence_id: eventEvidenceId(e.id), kind: e.kind, title: truncateText(e.title || e.source_app || e.kind, 160), body: truncateText(stripMarkdown(e.context_md ?? e.source_app ?? e.source), 240), at: e.starts_at, app: e.source_app || e.source }));
  daily.open_loop_candidates.slice(0, 8).forEach(f => sigs.push({ evidence_id: frameEvidenceId(f.id), kind: 'screen_open_loop', title: truncateText(f.window_title || f.app, 160), body: truncateText(f.excerpt ?? '', 260), at: f.timestamp, app: f.app }));
  return dedupeByTitle(sigs).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 18);
}

async function buildProjectSignals(handles: OrchestratorHandles, entities: EntityRecord[], anchor: DateAnchor): Promise<ProjectSignal[]> {
  const out: ProjectSignal[] = [];
  const valid = entities.filter(e => ['project', 'repo', 'doc', 'channel'].includes(e.kind) && !/^(apps|meetings)\//.test(e.path)).sort((a, b) => b.lastSeen.localeCompare(a.lastSeen) || b.totalFocusedMs - a.totalFocusedMs).slice(0, 6);
  for (const e of valid) {
    const fs = await handles.storage.searchFrames({ entityPath: e.path, from: shiftIso(anchor.fromIso, -7 * 24 * 60), to: anchor.toIso, limit: 8 }).catch(() => []);
    out.push({ evidence_id: entityEvidenceId(e.path), path: e.path, title: e.title || displayEntity(e.path), kind: e.kind, focused_min: Math.round(e.totalFocusedMs / 60000), frame_count: e.frameCount, last_seen: e.lastSeen, recent: fs.map(f => compactFrame(f, 180)).filter(f => f.excerpt && !f.garbled).map(f => `${f.app}: ${f.excerpt}`).slice(0, 4) });
  }
  return out;
}

async function buildBridgeSignals(handles: OrchestratorHandles, meetings: Meeting[], anchor: DateAnchor): Promise<MeetingBridgeSignal[]> {
  const out: MeetingBridgeSignal[] = [];
  for (const m of meetings.filter(m => m.summary_json || m.summary_md).slice(-6)) {
    const fs = await handles.storage.searchFrames({ from: m.ended_at, to: new Date(Math.min(Date.parse(anchor.toIso), Date.parse(m.ended_at) + 14400000)).toISOString(), limit: 40 }).catch(() => []);
    const wf = fs.filter(f => f.meeting_id !== m.id && f.entity_kind !== 'meeting' && !['Beside', 'Audio', 'loginwindow'].includes(f.app)).map(f => compactFrame(f, 180)).filter(f => f.excerpt || f.entity_path).slice(0, 8);
    out.push({ evidence_id: meetingEvidenceId(m.id), meeting_id: m.id, title: m.summary_json?.title ?? m.title ?? m.platform, started_at: m.started_at, ended_at: m.ended_at, tldr: truncateText(m.summary_json?.tldr ?? stripMarkdown(m.summary_md ?? ''), 260), meeting_followups: [...(m.summary_json?.action_items ?? []).map(i => i.owner ? `${i.owner}: ${i.task}` : i.task), ...(m.summary_json?.open_questions ?? []).map(q => q.text)].slice(0, 6), work_after: wf.map(f => ({ evidence_id: frameEvidenceId(f.id), at: f.timestamp, app: f.app, title: truncateText(f.window_title, 120), entity: f.entity_path, excerpt: truncateText(f.excerpt ?? '', 180) })) });
  }
  return out.filter(b => b.meeting_followups.length || b.work_after.length);
}

const ACTION_CENTER_SYSTEM_PROMPT = `You are the local Beside work-triage model. Return JSON.`;
function buildActionCenterPrompt(context: ActionCenterContext): string { return `Return JSON:\n{ "followups": [], "projects": [], "meeting_bridges": [] }\n\nContext:\n${serializeContext(context)}`; }

function serializeContext(ctx: ActionCenterContext) {
  const slim = { day: ctx.day, generatedAt: ctx.generatedAt, screenFollowups: ctx.screenFollowups.slice(0, 6).map(f => ({ source: f.source, category: f.category, title: f.title, body: truncateText(f.body, 180), urgency: f.urgency, evidence_ids: f.evidenceIds.slice(0, 3) })), followupSignals: ctx.followupSignals.slice(0, 14), projects: ctx.projects.slice(0, 5).map(p => ({ ...p, recent: p.recent.slice(0, 3).map(i => truncateText(i, 160)) })), meetingBridges: ctx.meetingBridges.slice(0, 5).map(b => ({ ...b, tldr: truncateText(b.tldr, 180), meeting_followups: b.meeting_followups.slice(0, 4), work_after: b.work_after.slice(0, 5) })) };
  let json = JSON.stringify(slim, null, 2); return json.length <= MAX_CONTEXT_CHARS ? json : JSON.stringify({ ...slim, screenFollowups: slim.screenFollowups.slice(0, 5), followupSignals: slim.followupSignals.slice(0, 10), projects: slim.projects.slice(0, 4).map(p => ({ ...p, recent: p.recent.slice(0, 2) })), meetingBridges: slim.meetingBridges.slice(0, 3).map(b => ({ ...b, work_after: b.work_after.slice(0, 3) })) }, null, 2).slice(0, MAX_CONTEXT_CHARS);
}

function parseModelPayload(raw: string, ctx: ActionCenterContext, evIds: Set<string>): Pick<RuntimeActionCenter, 'followups'|'projects'|'meetingBridges'> | null {
  try {
    const p = JSON.parse(extractJsonObject(raw)) as any; if (!p || typeof p !== 'object') return null;
    const fols = parseFollowups(p.followups, ctx, evIds), projs = parseProjects(p.projects, ctx.projects, evIds), brdgs = parseBridges(p.meeting_bridges, ctx.meetingBridges, evIds);
    return fols.length || projs.length || brdgs.length ? { followups: fols, projects: projs, meetingBridges: brdgs } : null;
  } catch { return null; }
}

function parseFollowups(v: unknown, ctx: ActionCenterContext, evIds: Set<string>): RuntimeActionCenterFollowup[] {
  if (!Array.isArray(v)) return [];
  const getApp = (id: string) => {
    const scr = ctx.screenFollowups.find(f => f.evidenceIds.includes(id));
    if (scr?.app) return scr.app;
    const fol = ctx.followupSignals.find(f => f.evidence_id === id);
    if (fol?.app) return fol.app;
    return undefined;
  };
  return v.filter(i => i && typeof i === 'object').map((i: any) => {
    const ids = stringArray(i.evidence_ids).filter(id => evIds.has(id)).slice(0, 3);
    return { app: ids.length ? getApp(ids[0]!) : undefined, category: normaliseCategory(i.category), title: cleanLine(i.title, 130), body: cleanLine(i.body, 220), urgency: normaliseUrgency(i.urgency), evidenceIds: ids };
  }).filter((i: any) => i.title && i.evidenceIds.length).slice(0, 6);
}

function parseProjects(v: unknown, ctxP: ProjectSignal[], evIds: Set<string>): RuntimeActionCenterProject[] {
  if (!Array.isArray(v)) return []; const byPath = new Map(ctxP.map(p => [p.path, p]));
  return v.filter(i => i && typeof i === 'object').map((i: any) => { const src = byPath.get(i.path); return src ? { path: i.path, title: cleanLine(i.title, 100) || src.title, kind: src.kind, summary: cleanLine(i.summary, 260), status: cleanLine(i.status, 80), nextActions: stringArray(i.next_actions).map(x => truncateText(x, 140)).slice(0, 3), evidenceIds: stringArray(i.evidence_ids).filter(id => evIds.has(id)).slice(0, 3) } : null; }).filter((i): i is RuntimeActionCenterProject => i !== null && i.evidenceIds.length > 0).slice(0, 4);
}

function parseBridges(v: unknown, ctxB: MeetingBridgeSignal[], evIds: Set<string>): RuntimeMeetingWorkBridge[] {
  if (!Array.isArray(v)) return []; const byId = new Map(ctxB.map(b => [b.meeting_id, b]));
  return v.filter(i => i && typeof i === 'object').map((i: any) => { const src = byId.get(i.meeting_id); return src ? { meetingId: i.meeting_id, title: src.title, startedAt: src.started_at, summary: cleanLine(i.summary, 260), workAfter: stringArray(i.work_after).map(x => truncateText(x, 160)).slice(0, 4), followups: stringArray(i.followups).map(x => truncateText(x, 160)).slice(0, 4), evidenceIds: stringArray(i.evidence_ids).filter(id => evIds.has(id)).slice(0, 3) } : null; }).filter((i): i is RuntimeMeetingWorkBridge => i !== null && i.evidenceIds.length > 0).slice(0, 4);
}

function fallbackFollowups(sigs: FollowupSignal[], scr: ScreenFollowupSignal[]) { return mergeFollowups(scr, sigs.slice(0, 6).map(s => ({ app: s.app, category: s.kind === 'communication' ? 'reply' : 'task', title: s.title, body: s.body, urgency: s.kind === 'meeting_action' ? 'high' : 'medium', evidenceIds: [s.evidence_id] }))); }
function fallbackProjects(ps: ProjectSignal[]) { return ps.slice(0, 4).map(p => ({ path: p.path, title: p.title, kind: p.kind, summary: p.recent[0] ?? `${p.focused_min} min focused.`, status: p.last_seen ? `Last seen ${p.last_seen.slice(0, 10)}` : 'Active', nextActions: p.recent.slice(0, 2), evidenceIds: [p.evidence_id] })); }
function fallbackBridges(bs: MeetingBridgeSignal[]) { return bs.slice(0, 4).map(b => ({ meetingId: b.meeting_id, title: b.title, startedAt: b.started_at, summary: b.work_after[0] ? `Work shifted into ${b.work_after[0].entity ?? b.work_after[0].app}.` : b.tldr, workAfter: b.work_after.map(f => f.entity ?? f.title ?? f.app).slice(0, 4), followups: b.meeting_followups.slice(0, 4), evidenceIds: [b.evidence_id, ...b.work_after.map(f => f.evidence_id).slice(0, 2)] })); }

function mergeFollowups(pri: any[], rst: any[]) {
  const out: RuntimeActionCenterFollowup[] = [];
  for (const i of [...pri, ...rst]) {
    const c = { app: i.app, category: i.category, title: i.title, body: i.body, urgency: i.urgency, evidenceIds: i.evidenceIds.slice(0, 3) };
    if (!c.title || !c.evidenceIds.length || out.some(e => e.evidenceIds.some(id => c.evidenceIds.includes(id)) || (e.title.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\b(reply|send|decide|schedule|task)\b/g, ' ').replace(/\s+/g, ' ').trim() === c.title.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\b(reply|send|decide|schedule|task)\b/g, ' ').replace(/\s+/g, ' ').trim()))) continue;
    out.push(c); if (out.length >= 6) break;
  }
  return out;
}

function buildEvidence(ctx: ActionCenterContext) {
  const ev: any[] = [], seen = new Set();
  const push = (id: string, l: string, k: string, a?: string) => { if (!seen.has(id)) { seen.add(id); ev.push({ id, label: l, kind: k, at: a }); } };
  ctx.screenFollowups.forEach(f => f.evidenceIds.forEach(id => push(id, f.title, id.split(':')[0], f.at)));
  ctx.followupSignals.forEach(s => push(s.evidence_id, s.title, s.evidence_id.split(':')[0], s.at));
  ctx.projects.forEach(p => push(p.evidence_id, p.title, 'entity', p.last_seen));
  ctx.meetingBridges.forEach(b => { push(b.evidence_id, b.title, 'meeting', b.started_at); b.work_after.forEach(f => push(f.evidence_id, f.title || f.app, 'frame', f.at)); });
  return ev;
}

function dedupeByTitle<T extends { title: string }>(items: T[]) { const seen = new Set(); return items.filter(i => { const k = i.title.toLowerCase().replace(/\s+/g, ' ').trim(); if (!k || seen.has(k)) return false; seen.add(k); return true; }); }
function normaliseCategory(v: any) { return ['reply', 'send', 'decide', 'schedule', 'task'].includes(v) ? v : 'task'; }
function normaliseUrgency(v: any) { return ['high', 'medium', 'low'].includes(v) ? v : 'medium'; }
function cleanLine(v: any, m: number) { return typeof v === 'string' ? truncateText(v.replace(/\s+/g, ' ').replace(/^[-*]\s+/, '').trim(), m) : ''; }
function stringArray(v: any) { return Array.isArray(v) ? v.filter(i => typeof i === 'string' && i.trim().length > 0) : []; }
function extractJsonObject(r: string) { const t = r.trim(), f = t.indexOf('{'), l = t.lastIndexOf('}'); return f >= 0 && l > f ? t.slice(f, l + 1) : t; }
function stripMarkdown(v: string) { return v.replace(/```[\s\S]*?```/g, ' ').replace(/`([^`]+)`/g, '$1').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[#>*_~]/g, ' ').replace(/\s+/g, ' ').trim(); }
function truncateText(v: string, m: number) { const c = v.replace(/\s+/g, ' ').trim(); return c.length <= m ? c : `${c.slice(0, Math.max(0, m - 3)).trimEnd()}...`; }
function collapseForPrompt(v: string, m: number) { const c = v.replace(/\r/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim(); return c.length <= m ? c : `${c.slice(0, Math.max(0, m - 3)).trimEnd()}...`; }
function hashForKey(v: string) { return createHash('sha1').update(v).digest('hex').slice(0, 12); }
function displayEntity(p: string) { return p.split('/').filter(Boolean).pop()?.replace(/[-_]+/g, ' ') ?? p; }
function eventEvidenceId(id: string) { return `event:${id}`; }
function meetingEvidenceId(id: string) { return `meeting:${id}`; }
function frameEvidenceId(id: string) { return `frame:${id}`; }
function entityEvidenceId(p: string) { return `entity:${p}`; }
function shiftIso(iso: string, min: number) { return new Date(Date.parse(iso) + min * 60_000).toISOString(); }
function platformLabel(p: string) { return { zoom: 'Zoom meeting', meet: 'Google Meet', teams: 'Teams meeting', webex: 'Webex meeting', whereby: 'Whereby meeting', around: 'Around meeting' }[p] || 'Meeting'; }
async function withTimeout<T>(p: Promise<T>, ms: number) { let t: any; const to = new Promise<never>((_, r) => { t = setTimeout(() => r(new Error('timeout')), ms); t.unref?.(); }); try { return await Promise.race([p, to]); } finally { if (t) clearTimeout(t); } }
function urgencyRank(u: any) { return u === 'high' ? 3 : u === 'medium' ? 2 : 1; }
