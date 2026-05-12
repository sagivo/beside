import path from 'node:path';
import fs from 'node:fs/promises';
import type { IStorage, IModelAdapter, Logger, Meeting, MeetingTurn, MeetingSummaryJson, Frame, MeetingPlatform } from '@cofounderos/interfaces';

export interface MeetingSummarizerOptions { dataDir: string; cooldownMs?: number; batchSize?: number; maxTranscriptChars?: number; visionAttachments?: number; enabled?: boolean; }
export interface MeetingSummarizerResult { attempted: number; succeeded: number; failed: number; skipped: number; }

const SUMMARY_SYSTEM_PROMPT = `You are a meeting note-taker. Produce a strict JSON object from the fused timeline:
{ "title": string|null, "tldr": string, "agenda": string[], "decisions": [{ "text": string, "evidence_turn_ids": number[] }], "action_items": [{ "owner": string|null, "task": string, "due": string|null, "evidence_turn_ids": number[] }], "open_questions": [{ "text": string, "evidence_turn_ids": number[] }], "key_moments": [{ "t": string, "what": string, "frame_id": string|null }], "attendees_seen": string[], "links_shared": string[], "notes": string|null }
Rules:
- "title" is a short descriptive name.
- "evidence_turn_ids" must be turn ids ([T<id>] markers).
- "key_moments[].t" is an ISO timestamp.
- Be concise.
- If audio is mostly silence, note it in "notes".`;

export class MeetingSummarizer {
  private readonly logger: Logger; private readonly cooldownMs: number; private readonly batchSize: number;
  private readonly maxTranscriptChars: number; private readonly visionAttachments: number; private readonly enabled: boolean; private readonly dataDir: string;

  constructor(private readonly storage: IStorage, private readonly model: IModelAdapter, logger: Logger, opts: MeetingSummarizerOptions) {
    this.logger = logger.child('meeting-summarizer'); this.dataDir = opts.dataDir;
    this.cooldownMs = opts.cooldownMs ?? 300000; this.batchSize = opts.batchSize ?? 2;
    this.maxTranscriptChars = opts.maxTranscriptChars ?? 24000; this.visionAttachments = opts.visionAttachments ?? 4; this.enabled = opts.enabled ?? true;
  }

  async tick(): Promise<MeetingSummarizerResult> {
    const res = { attempted: 0, succeeded: 0, failed: 0, skipped: 0 };
    for (const m of await this.storage.listMeetings({ summaryStatus: 'pending', limit: this.batchSize * 4, order: 'recent' }).then(p => p.filter(x => Date.parse(x.ended_at) <= Date.now() - this.cooldownMs).slice(0, this.batchSize))) {
      res.attempted++;
      try {
        await this.storage.setMeetingSummary(m.id, { status: 'running' });
        const turns = await this.storage.getMeetingTurns(m.id), screens = (await this.storage.getMeetingFrames(m.id)).filter(f => f.entity_kind === 'meeting' && f.asset_path);
        const stageA = buildStageA(m, turns, screens);
        let stageB: MeetingSummaryJson | null = null, err: string | null = null;
        if (this.enabled) try {
          const vis = this.model.getModelInfo().supportsVision && this.visionAttachments > 0 ? await this.loadVisionImages(m, screens) : [];
          const prompt = buildPrompt(m, turns, screens, this.maxTranscriptChars);
          const raw = vis.length ? await this.model.completeWithVision(prompt, vis, { systemPrompt: SUMMARY_SYSTEM_PROMPT, temperature: 0.2, maxTokens: 1500, responseFormat: 'json' }) : await this.model.complete(prompt, { systemPrompt: SUMMARY_SYSTEM_PROMPT, temperature: 0.2, maxTokens: 1500, responseFormat: 'json' });
          const parsed = safeParseSummaryJson(raw);
          if (parsed) stageB = mergeWithFallback(parsed, stageA);
        } catch (e) { err = String(e); this.logger.warn(`stage B failed for ${m.id}`, { err }); }
        
        const final = stageB ?? stageA;
        await this.storage.setMeetingSummary(m.id, { status: 'ready', md: renderSummaryMarkdown(m, final, turns, screens), json: final, contentHash: m.content_hash, failureReason: err, title: final.title ?? undefined });
        this.logger.info(`summarised ${m.id} (${m.entity_path}, ${stageB ? 'llm' : 'det'}, ${final.action_items.length} acts, ${final.decisions.length} decs)`);
        res.succeeded++;
      } catch (e) { res.failed++; this.logger.warn(`summarise ${m.id} failed`, { err: String(e) }); await this.storage.setMeetingSummary(m.id, { status: 'failed', failureReason: String(e) }); }
    }
    return res;
  }

  async drain(): Promise<MeetingSummarizerResult> {
    const tot = { attempted: 0, succeeded: 0, failed: 0, skipped: 0 };
    for (let i = 0; i < 1000; i++) { const r = await this.tick(); tot.attempted += r.attempted; tot.succeeded += r.succeeded; tot.failed += r.failed; tot.skipped += r.skipped; if (r.attempted === 0) break; }
    return tot;
  }

  private async loadVisionImages(m: Meeting, screens: Frame[]): Promise<Buffer[]> {
    const out: Buffer[] = [];
    for (const f of pickKeyScreenshots(screens, this.visionAttachments)) {
      if (!f.asset_path) continue;
      try { out.push(await fs.readFile(path.isAbsolute(f.asset_path) ? f.asset_path : path.join(this.dataDir, f.asset_path))); } catch {}
    }
    return out;
  }
}

export function buildStageA(m: Meeting, turns: MeetingTurn[], screens: Frame[]): MeetingSummaryJson {
  const p = labelPlatform(m.platform), t = humanTitle(m);
  return {
    title: null,
    tldr: `${Math.round(m.duration_ms / 60000)}-min ${p} meeting on ${t}${m.attendees.length ? ` with ${formatList(m.attendees)}` : ''} ${m.audio_chunk_count === 0 ? '(no audio)' : `(${turns.length} turns)`}.`,
    agenda: inferAgenda(turns, screens), decisions: [], action_items: [], open_questions: [],
    key_moments: pickKeyScreenshots(screens, 5).map((f) => ({ t: f.timestamp, what: f.window_title?.trim().replace(/\s+/g, ' ').slice(0, 100) || f.url?.slice(0, 100) || f.app || 'screen change', frame_id: f.id })),
    attendees_seen: m.attendees, links_shared: m.links, notes: m.audio_chunk_count === 0 ? 'No audio captured.' : null,
  };
}

function labelPlatform(p: MeetingPlatform) { return { zoom: 'Zoom', meet: 'Google Meet', teams: 'Microsoft Teams', webex: 'Webex', whereby: 'Whereby', around: 'Around', other: 'video' }[p] || 'video'; }
function humanTitle(m: Meeting) { const t = m.entity_path.split('/').pop()?.replace(/^\d{4}-\d{2}-\d{2}-/, '') ?? m.entity_path; return t ? t.split('-').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' ') : m.entity_path; }
function formatList(i: string[]) { return !i.length ? '' : i.length === 1 ? i[0]! : i.length === 2 ? `${i[0]} and ${i[1]}` : `${i.slice(0, -1).join(', ')}, and ${i[i.length - 1]}`; }

function inferAgenda(_t: MeetingTurn[], screens: Frame[]): string[] {
  const s = new Set<string>(), o: string[] = [];
  for (const f of screens) { const t = (f.window_title ?? '').replace(/\s+/g, ' ').trim(); if (t.length < 4 || s.has(t.toLowerCase())) continue; s.add(t.toLowerCase()); o.push(t.slice(0, 80)); if (o.length >= 5) break; }
  return o;
}

export function pickKeyScreenshots(screens: Frame[], limit: number): Frame[] {
  const w = screens.filter((f) => f.asset_path); if (!w.length || limit <= 0) return []; if (w.length <= limit) return w;
  const p: Frame[] = [], s = w.length / limit; for (let i = 0; i < limit; i++) p.push(w[Math.min(w.length - 1, Math.floor(i * s))]!); return p;
}

export function buildPrompt(m: Meeting, turns: MeetingTurn[], screens: Frame[], maxChars: number): string {
  const lines = [`MEETING: ${m.entity_path}`, `Platform: ${labelPlatform(m.platform)}`, `Window: ${m.started_at} → ${m.ended_at} (${Math.round(m.duration_ms / 60000)} min)`];
  if (m.attendees.length) lines.push(`Observed attendees: ${m.attendees.join(', ')}`); if (m.links.length) lines.push(`Links shared: ${m.links.slice(0, 10).join(', ')}`);
  lines.push('', '--- Fused timeline ---');

  const items = turns.map(t => ({ t: t.t_start, line: `[T${t.id} @ ${t.t_start.slice(11, 19)}] ${t.speaker ? `${t.speaker}: ` : ''}${t.text}` }));
  let lk: string | null = null;
  screens.filter(f => f.asset_path).forEach(f => { const k = `${f.asset_path}|${f.window_title}`; if (k !== lk) { lk = k; items.push({ t: f.timestamp, line: `[SCREEN @ ${f.timestamp.slice(11, 19)} — ${f.window_title?.trim().slice(0, 100) || f.url?.slice(0, 100) || f.app || 'screen change'} — frame_id=${f.id}]` }); } });
  items.sort((a, b) => a.t.localeCompare(b.t));

  let b = '';
  for (const i of items) { if (b.length + i.line.length + 1 > maxChars) { b += `\n[…truncated, ${items.length - b.split('\n').length} more lines omitted…]`; break; } b += i.line + '\n'; }
  lines.push(b.trim(), '', 'Respond with JSON object only.'); return lines.join('\n');
}

export function safeParseSummaryJson(raw: string): MeetingSummaryJson | null {
  try {
    const t = raw.trim(), p = JSON.parse(t.startsWith('{') ? t : t.indexOf('{') >= 0 && t.lastIndexOf('}') > t.indexOf('{') ? t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1) : t) as any;
    if (!p || typeof p !== 'object') return null;
    const sa = (v: any) => Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()) : [], pa = (v: any, k: string) => Array.isArray(v) ? v.map(x => ({ text: x[k]?.trim(), evidence_turn_ids: Array.isArray(x.evidence_turn_ids) ? x.evidence_turn_ids.filter((n: any) => typeof n === 'number') : [] })).filter(x => x.text) : [];
    return { title: p.title?.trim() || null, tldr: p.tldr || '', agenda: sa(p.agenda), decisions: pa(p.decisions, 'text'), action_items: Array.isArray(p.action_items) ? p.action_items.map((x: any) => ({ owner: x.owner?.trim() || null, task: x.task?.trim(), due: x.due?.trim() || null, evidence_turn_ids: Array.isArray(x.evidence_turn_ids) ? x.evidence_turn_ids.filter((n: any) => typeof n === 'number') : [] })).filter((x: any) => x.task) : [], open_questions: pa(p.open_questions, 'text'), key_moments: Array.isArray(p.key_moments) ? p.key_moments.map((x: any) => ({ t: x.t?.trim(), what: x.what?.trim(), frame_id: x.frame_id || null })).filter((x: any) => x.t && x.what) : [], attendees_seen: sa(p.attendees_seen), links_shared: sa(p.links_shared), notes: p.notes || null };
  } catch { return null; }
}

function mergeWithFallback(l: MeetingSummaryJson, f: MeetingSummaryJson): MeetingSummaryJson { return { title: l.title ?? f.title, tldr: l.tldr || f.tldr, agenda: l.agenda.length ? l.agenda : f.agenda, decisions: l.decisions, action_items: l.action_items, open_questions: l.open_questions, key_moments: l.key_moments.length ? l.key_moments : f.key_moments, attendees_seen: l.attendees_seen.length ? l.attendees_seen : f.attendees_seen, links_shared: l.links_shared.length ? l.links_shared : f.links_shared, notes: l.notes ?? f.notes }; }

export function renderSummaryMarkdown(m: Meeting, s: MeetingSummaryJson, turns: MeetingTurn[], screens: Frame[]): string {
  const l = [`### Meeting · ${m.started_at.slice(11, 16)}-${m.ended_at.slice(11, 16)} · ${labelPlatform(m.platform)} · [[${m.entity_path}]]`, ''];
  if (s.tldr) l.push(`**TL;DR.** ${s.tldr}`, '');
  if (s.attendees_seen.length) l.push(`**Attendees seen:** ${s.attendees_seen.join(', ')}.`);
  if (s.agenda.length) { l.push('**Agenda:**'); s.agenda.forEach(a => l.push(`- ${a}`)); }
  if (s.decisions.length) { l.push('', '**Decisions:**'); s.decisions.forEach(d => l.push(`- ${d.text}${d.evidence_turn_ids?.length ? ` _(turn${d.evidence_turn_ids.length > 1 ? 's' : ''} ${d.evidence_turn_ids.map(id => `T${id}`).join(', ')})_` : ''}`)); }
  if (s.action_items.length) { l.push('', '**Action items:**'); s.action_items.forEach(a => l.push(`- ${a.owner ? `**${a.owner}** — ` : ''}${a.task}${a.due ? ` _(due ${a.due})_` : ''}${a.evidence_turn_ids?.length ? ` _(turn${a.evidence_turn_ids.length > 1 ? 's' : ''} ${a.evidence_turn_ids.map(id => `T${id}`).join(', ')})_` : ''}`)); }
  if (s.open_questions.length) { l.push('', '**Open questions:**'); s.open_questions.forEach(q => l.push(`- ${q.text}${q.evidence_turn_ids?.length ? ` _(turn${q.evidence_turn_ids.length > 1 ? 's' : ''} ${q.evidence_turn_ids.map(id => `T${id}`).join(', ')})_` : ''}`)); }
  if (s.key_moments.length) { l.push('', '**Key moments:**'); s.key_moments.forEach(k => l.push(`- _${k.t.slice(11, 19)}_ — ${k.what}${k.frame_id ? ` (frame ${k.frame_id})` : ''}`)); }
  if (s.links_shared.length) { l.push('', '**Links:**'); s.links_shared.slice(0, 12).forEach(link => l.push(`- <${link}>`)); }
  if (s.notes) l.push('', `_${s.notes}_`);
  l.push('', `_${turns.length} transcript turns · ${screens.length} key screen frames · ${m.audio_chunk_count} audio chunk(s)_`);
  return l.join('\n');
}
