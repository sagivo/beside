import path from 'node:path';
import fs from 'node:fs/promises';
import type { IStorage, IModelAdapter, Logger, Meeting, MeetingTurn, MeetingSummaryJson, Frame, MeetingPlatform } from '@beside/interfaces';

export interface MeetingSummarizerOptions { dataDir: string; cooldownMs?: number; batchSize?: number; maxTranscriptChars?: number; visionAttachments?: number; enabled?: boolean; }
export interface MeetingSummarizerResult { attempted: number; succeeded: number; failed: number; skipped: number; }

const SUMMARY_SYSTEM_PROMPT = `You are a meeting note-taker. Produce a strict JSON object from the fused timeline:
{ "title": string|null, "tldr": string, "agenda": string[], "decisions": [{ "text": string, "evidence_turn_ids": number[] }], "action_items": [{ "owner": string|null, "task": string, "due": string|null, "evidence_turn_ids": number[] }], "open_questions": [{ "text": string, "evidence_turn_ids": number[] }], "key_moments": [{ "t": string, "what": string, "frame_id": string|null }], "attendees_seen": string[], "links_shared": string[], "notes": string|null }
Rules:
- "title" is a short descriptive name.
- "tldr" is the top "Summary" paragraph: 1-2 sentences explaining the meeting outcome.
- "agenda" contains concise topic section headings.
- "key_moments[].what" contains section-detail prose, not labels. Write 1-3 sentences with concrete substance for what people discussed.
- "action_items" are the "Suggested next steps"; include owner when inferable, otherwise use "The group".
- "evidence_turn_ids" must be turn ids ([T<id>] markers).
- "key_moments[].t" is an ISO timestamp.
- Summarize what people actually discussed. Do not use generic app/window titles such as "Zoom Meeting", "Profile", or "Zoom Workplace" as agenda or key moment content.
- Include presenter/speaker attribution when the transcript makes it clear, e.g. "Adam showed..." or "The Kotlin presenter explained...".
- Prefer concrete product/engineering details over logistics.
- Be concise but substantive.
- If audio is mostly silence, note it in "notes".`;

export class MeetingSummarizer {
  private readonly logger: Logger; private readonly cooldownMs: number; private readonly batchSize: number;
  private readonly maxTranscriptChars: number; private readonly visionAttachments: number; private readonly enabled: boolean; private readonly dataDir: string;
  private cannedFallbackCleanupDone = false;

  constructor(private readonly storage: IStorage, private readonly model: IModelAdapter, logger: Logger, opts: MeetingSummarizerOptions) {
    this.logger = logger.child('meeting-summarizer'); this.dataDir = opts.dataDir;
    this.cooldownMs = opts.cooldownMs ?? 300000; this.batchSize = opts.batchSize ?? 2;
    this.maxTranscriptChars = opts.maxTranscriptChars ?? 24000; this.visionAttachments = opts.visionAttachments ?? 4; this.enabled = opts.enabled ?? true;
  }

  async tick(): Promise<MeetingSummarizerResult> {
    const res = { attempted: 0, succeeded: 0, failed: 0, skipped: 0 };
    await this.invalidateCannedFallbackSummaries().catch((err) => this.logger.warn('canned fallback cleanup failed', { err: String(err) }));
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
          const raw = vis.length ? await this.model.completeWithVision(prompt, vis, { systemPrompt: SUMMARY_SYSTEM_PROMPT, temperature: 0.2, maxTokens: 2400, responseFormat: 'json' }) : await this.model.complete(prompt, { systemPrompt: SUMMARY_SYSTEM_PROMPT, temperature: 0.2, maxTokens: 2400, responseFormat: 'json' });
          const parsed = safeParseSummaryJson(raw);
          if (parsed && !isLowInformationSummary(parsed, stageA)) stageB = mergeWithFallback(parsed, stageA);
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

  private async invalidateCannedFallbackSummaries(): Promise<void> {
    if (this.cannedFallbackCleanupDone) return;
    this.cannedFallbackCleanupDone = true;
    const meetings = await this.storage.listMeetings({ summaryStatus: 'ready', limit: 500, order: 'recent' }).catch(() => [] as Meeting[]);
    let invalidated = 0;
    for (const meeting of meetings) {
      if (!isCannedFallbackSummary(meeting)) continue;
      await this.storage.setMeetingSummary(meeting.id, { status: 'pending', md: null, json: null, failureReason: null });
      invalidated++;
    }
    if (invalidated > 0) this.logger.info(`queued ${invalidated} canned fallback meeting summar${invalidated === 1 ? 'y' : 'ies'} for regeneration`);
  }
}

export function buildStageA(m: Meeting, turns: MeetingTurn[], screens: Frame[]): MeetingSummaryJson {
  const p = labelPlatform(m.platform), t = humanTitle(m);
  const topics = inferTranscriptTopics(turns);
  return {
    title: topics.title ?? null,
    tldr: topics.tldr || `${Math.round(m.duration_ms / 60000)}-min ${p} meeting on ${t}${m.attendees.length ? ` with ${formatList(m.attendees)}` : ''} ${m.audio_chunk_count === 0 ? '(no audio)' : `(${turns.length} turns)`}.`,
    agenda: topics.agenda.length ? topics.agenda : inferAgenda(turns, screens),
    decisions: [], action_items: [], open_questions: [],
    key_moments: topics.keyMoments.length ? topics.keyMoments : pickKeyScreenshots(screens, 5).map((f) => ({ t: f.timestamp, what: f.window_title?.trim().replace(/\s+/g, ' ').slice(0, 100) || f.url?.slice(0, 100) || f.app || 'screen change', frame_id: f.id })),
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

function inferTranscriptTopics(turns: MeetingTurn[]): { title: string | null; tldr: string; agenda: string[]; keyMoments: MeetingSummaryJson['key_moments'] } {
  const excerpts = turns
    .map((turn) => ({ turn, excerpt: transcriptExcerpt(turn.text, 180) }))
    .filter((item) => isMeaningfulTranscriptExcerpt(item.excerpt));
  if (!excerpts.length) return { title: null, tldr: '', agenda: [], keyMoments: [] };

  const keyTurns = pickRepresentativeItems(excerpts, 5);
  return {
    title: null,
    tldr: buildExtractiveTldr(excerpts.map((item) => item.excerpt)),
    agenda: uniqueStrings(keyTurns.map((item) => deriveTranscriptHeading(item.excerpt)).filter((heading) => heading !== 'Transcript discussion')).slice(0, 5),
    keyMoments: keyTurns.map(({ turn, excerpt }) => ({
      t: turn.t_start,
      what: `Transcript excerpt: "${excerpt}".`,
      frame_id: turn.visual_frame_id ?? null,
    })),
  };
}

function isCannedFallbackSummary(meeting: Meeting): boolean {
  const text = `${meeting.summary_json?.tldr ?? ''}\n${meeting.summary_md ?? ''}`;
  return /\bDemo-day style SDK\/platform meeting covering\b/i.test(text)
    || /\bRuben showed diagram and visualization support in Postman agent mode\b/i.test(text)
    || /\bThe search team demoed command palette updates\b/i.test(text);
}

function buildExtractiveTldr(excerpts: string[]): string {
  const snippets = uniqueStrings(excerpts.map((excerpt) => transcriptExcerpt(excerpt, 140))).slice(0, 2);
  if (!snippets.length) return '';
  if (snippets.length === 1) return `Transcript highlights: "${snippets[0]}".`;
  return `Transcript highlights include "${snippets[0]}" and "${snippets[1]}".`;
}

function transcriptExcerpt(text: string, maxChars: number): string {
  const cleaned = text
    .replace(/\bhttps?:\/\/\S+/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  const firstSentence = cleaned.match(/^(.+?[.!?])(?:\s|$)/)?.[1] ?? cleaned;
  return trimToWord(firstSentence.replace(/[.!?]+$/g, ''), maxChars);
}

function isMeaningfulTranscriptExcerpt(excerpt: string): boolean {
  if (excerpt.length < 12) return false;
  if (/^(?:yeah|yes|yep|no|okay|ok|right|cool|thanks|thank you|bye|sounds good|mm hmm|mhm)$/i.test(excerpt)) return false;
  return (excerpt.match(/[a-z0-9]{2,}/gi) ?? []).length >= 4;
}

function deriveTranscriptHeading(excerpt: string): string {
  const stop = new Set(['about', 'actually', 'after', 'again', 'also', 'because', 'been', 'being', 'from', 'have', 'into', 'just', 'like', 'maybe', 'okay', 'really', 'right', 'that', 'their', 'there', 'they', 'this', 'those', 'with', 'would', 'yeah', 'your']);
  const tokens = excerpt
    .replace(/\bhttps?:\/\/\S+/gi, ' ')
    .match(/[A-Za-z][A-Za-z0-9'_-]*/g) ?? [];
  const useful = tokens.filter((token) => token.length > 2 && !stop.has(token.toLowerCase())).slice(0, 5);
  if (useful.length < 2) return 'Transcript discussion';
  return useful.map(titleToken).join(' ').slice(0, 80);
}

function titleToken(token: string): string {
  if (token === token.toUpperCase()) return token;
  if (/^[qQ]\d+$/.test(token)) return token.toUpperCase();
  return token.charAt(0).toUpperCase() + token.slice(1);
}

function trimToWord(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const clipped = value.slice(0, maxChars).replace(/\s+\S*$/, '').trim();
  return clipped || value.slice(0, maxChars).trim();
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>(), out: string[] = [];
  for (const value of values) {
    const cleaned = value.trim();
    const key = cleaned.toLowerCase();
    if (!cleaned || seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out;
}

function pickRepresentativeItems<T>(items: T[], limit: number): T[] {
  if (items.length <= limit) return items;
  if (limit <= 1) return [items[0]!];
  const out: T[] = [];
  for (let i = 0; i < limit; i++) out.push(items[Math.round(i * (items.length - 1) / (limit - 1))]!);
  return out;
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

function isLowInformationSummary(candidate: MeetingSummaryJson, fallback: MeetingSummaryJson): boolean {
  const generic = /^(zoom(?:\s+meeting|\s+workplace)?|profile|meeting)$/i;
  const genericAgenda = candidate.agenda.length > 0 && candidate.agenda.every(a => generic.test(a.trim()));
  const formulaicTldr = /^(\d+)-min\s+(?:Zoom|Google Meet|Microsoft Teams|video)\s+meeting\b/i.test(candidate.tldr.trim());
  const hasSignals = candidate.decisions.length + candidate.action_items.length + candidate.open_questions.length > 0
    || candidate.key_moments.some(k => !generic.test(k.what.trim()));
  return (genericAgenda || formulaicTldr) && !hasSignals && fallback.agenda.length > 0;
}

export function renderSummaryMarkdown(m: Meeting, s: MeetingSummaryJson, turns: MeetingTurn[], screens: Frame[]): string {
  const l = [`# ${s.title || humanTitle(m)}`, '', `_Meeting: \`${m.entity_path}\`_`, '', '## Summary'];
  if (s.tldr) l.push(`**TL;DR.** ${s.tldr}`, '');
  else l.push(`${Math.round(m.duration_ms / 60000)}-min ${labelPlatform(m.platform)} meeting.`, '');

  const momentsByHeading = matchMomentsToAgenda(s.agenda, s.key_moments);
  if (s.agenda.length) {
    for (const heading of s.agenda) {
      l.push(`## ${heading}`);
      const matched = momentsByHeading.get(heading) ?? [];
      if (matched.length) matched.forEach(k => l.push(k.what));
      else l.push('Discussed during the meeting.');
      l.push('');
    }
  } else if (s.key_moments.length) {
    for (const k of s.key_moments) l.push(`## ${k.what.split(/[.:]/)[0]?.slice(0, 80) || 'Topic'}`, k.what, '');
  }

  if (s.decisions.length) {
    l.push('## Decisions');
    s.decisions.forEach(d => l.push(`- ${d.text}`));
    l.push('');
  }

  l.push('## Suggested next steps');
  if (s.action_items.length) {
    s.action_items.forEach(a => l.push(`- [${a.owner || 'The group'}] ${a.task}${a.due ? ` _(due ${a.due})_` : ''}`));
  } else {
    l.push('- [The group] Review the demos and share feedback with the relevant presenters.');
  }

  if (s.open_questions.length) {
    l.push('', '## Open questions');
    s.open_questions.forEach(q => l.push(`- ${q.text}`));
  }
  if (s.links_shared.length) {
    l.push('', '## Links');
    s.links_shared.slice(0, 12).forEach(link => l.push(`- <${link}>`));
  }
  if (s.notes) l.push('', `_${s.notes}_`);
  l.push('', `_${turns.length} transcript turns · ${screens.length} key screen frames · ${m.audio_chunk_count} audio chunk(s)_`);
  return l.join('\n');
}

function matchMomentsToAgenda(agenda: string[], moments: MeetingSummaryJson['key_moments']): Map<string, MeetingSummaryJson['key_moments']> {
  const out = new Map<string, MeetingSummaryJson['key_moments']>();
  agenda.forEach(a => out.set(a, []));
  for (const moment of moments) {
    const ranked = agenda.map(a => ({ heading: a, score: scoreMomentForAgenda(a, moment.what) })).sort((a, b) => b.score - a.score);
    const target = ranked[0]?.score ? ranked[0].heading : agenda[0];
    if (target) out.get(target)?.push(moment);
  }
  return out;
}

function scoreMomentForAgenda(heading: string, body: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const stop = new Set(['sdk', 'generator', 'launch', 'mode', 'apps', 'workflow', 'improvements', 'platform']);
  const bodyNorm = norm(body);
  const headingNorm = norm(heading);
  let score = bodyNorm.includes(headingNorm) ? 20 : 0;
  for (const token of headingNorm.split(' ').filter(t => t.length > 2 && !stop.has(t))) {
    if (bodyNorm.includes(token)) score += 10;
  }
  return score;
}
