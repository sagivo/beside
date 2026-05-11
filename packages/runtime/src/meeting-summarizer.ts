import path from 'node:path';
import fs from 'node:fs/promises';
import type {
  IStorage,
  IModelAdapter,
  Logger,
  Meeting,
  MeetingTurn,
  MeetingSummaryJson,
  Frame,
  MeetingPlatform,
} from '@cofounderos/interfaces';

/**
 * MeetingSummarizer — produces a structured per-meeting summary from
 * the fused transcript + screenshot timeline materialised by the
 * MeetingBuilder.
 *
 * Two-stage pipeline:
 *
 *   Stage A (deterministic) — extracts attendees, links, key
 *   screenshots, and basic facts directly from the data. These ship
 *   regardless of model availability.
 *
 *   Stage B (LLM) — builds a transcript-with-context prompt (with
 *   inline `[SCREEN @ ts ...]` markers each time the active screen
 *   changes), asks the model for a strict JSON response (TL;DR,
 *   decisions, action items, …), and renders it to markdown. Vision
 *   attachments — the most informative slide screenshots — are passed
 *   through `model.completeWithVision` when the adapter advertises
 *   support; otherwise we fall back to text-only.
 *
 * The summary write is idempotent: each meeting carries a
 * `content_hash` of (turns, key screenshots) and the summarizer
 * short-circuits when nothing has changed since the last successful
 * run.
 */

export interface MeetingSummarizerOptions {
  /** Base data dir; used to resolve screenshot asset paths for vision. */
  dataDir: string;
  /** Wait this long after a meeting closes before summarizing. Default 5 min. */
  cooldownMs?: number;
  /** Per-tick budget — number of meetings to summarise per scheduler beat. Default 2. */
  batchSize?: number;
  /** Cap the prompt's transcript section at this many chars. Default 24000. */
  maxTranscriptChars?: number;
  /** Number of vision attachments to send. 0 disables. Default 4. */
  visionAttachments?: number;
  /** Whether to enable Stage B (LLM) at all. Stage A still runs. Default true. */
  enabled?: boolean;
}

export interface MeetingSummarizerResult {
  attempted: number;
  succeeded: number;
  failed: number;
  skipped: number;
}

const SUMMARY_SYSTEM_PROMPT = `You are a meeting note-taker for the user. You are given a fused timeline of an online meeting: transcript turns interleaved with markers showing what was on the user's screen at each moment. Produce a strict JSON object that captures the meeting in a way that is useful tomorrow morning.

You MUST output valid JSON matching this schema EXACTLY (no prose around it):

{
  "title": string|null,
  "tldr": string,
  "agenda": string[],
  "decisions": [{ "text": string, "evidence_turn_ids": number[] }],
  "action_items": [{ "owner": string|null, "task": string, "due": string|null, "evidence_turn_ids": number[] }],
  "open_questions": [{ "text": string, "evidence_turn_ids": number[] }],
  "key_moments": [{ "t": string, "what": string, "frame_id": string|null }],
  "attendees_seen": string[],
  "links_shared": string[],
  "notes": string|null
}

Rules:
- "title" should be a short (2-6 word) descriptive name for this meeting inferred from the topic, e.g. "Weekly Engineering Standup" or "Q2 Planning Session". Use null if genuinely unknowable.
- "evidence_turn_ids" must be turn ids from the supplied transcript ([T<id>] markers).
- "key_moments[].t" is an ISO timestamp from the transcript or screen markers.
- Be concise. Empty arrays are fine.
- If the audio side is mostly silence (e.g. no remote audio captured), say so in "notes".
`;

export class MeetingSummarizer {
  private readonly logger: Logger;
  private readonly cooldownMs: number;
  private readonly batchSize: number;
  private readonly maxTranscriptChars: number;
  private readonly visionAttachments: number;
  private readonly enabled: boolean;
  private readonly dataDir: string;

  constructor(
    private readonly storage: IStorage,
    private readonly model: IModelAdapter,
    logger: Logger,
    opts: MeetingSummarizerOptions,
  ) {
    this.logger = logger.child('meeting-summarizer');
    this.dataDir = opts.dataDir;
    this.cooldownMs = opts.cooldownMs ?? 5 * 60_000;
    this.batchSize = opts.batchSize ?? 2;
    this.maxTranscriptChars = opts.maxTranscriptChars ?? 24_000;
    this.visionAttachments = opts.visionAttachments ?? 4;
    this.enabled = opts.enabled ?? true;
  }

  async tick(): Promise<MeetingSummarizerResult> {
    const empty: MeetingSummarizerResult = {
      attempted: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
    };
    const candidates = await this.findCandidates(this.batchSize);
    for (const meeting of candidates) {
      empty.attempted += 1;
      try {
        const ok = await this.summarise(meeting);
        if (ok === 'skipped') empty.skipped += 1;
        else if (ok === 'ok') empty.succeeded += 1;
        else empty.failed += 1;
      } catch (err) {
        empty.failed += 1;
        this.logger.warn(`summarise ${meeting.id} failed (continuing)`, { err: String(err) });
        await this.storage.setMeetingSummary(meeting.id, {
          status: 'failed',
          failureReason: String(err),
        });
      }
    }
    return empty;
  }

  async drain(): Promise<MeetingSummarizerResult> {
    const total: MeetingSummarizerResult = {
      attempted: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
    };
    for (let i = 0; i < 1000; i++) {
      const r = await this.tick();
      total.attempted += r.attempted;
      total.succeeded += r.succeeded;
      total.failed += r.failed;
      total.skipped += r.skipped;
      if (r.attempted === 0) break;
    }
    return total;
  }

  /**
   * Find meetings that:
   *   1. have status='pending', AND
   *   2. closed at least `cooldownMs` ago (gives the audio inbox time
   *      to drain — whisper is the laggard).
   *
   * We over-fetch from listMeetings and filter in JS so the storage
   * adapter doesn't need a new query path.
   */
  private async findCandidates(limit: number): Promise<Meeting[]> {
    const cutoff = Date.now() - this.cooldownMs;
    const pending = await this.storage.listMeetings({
      summaryStatus: 'pending',
      limit: limit * 4,
      order: 'recent',
    });
    return pending
      .filter((m) => Date.parse(m.ended_at) <= cutoff)
      .slice(0, limit);
  }

  private async summarise(
    meeting: Meeting,
  ): Promise<'ok' | 'skipped' | 'failed'> {
    await this.storage.setMeetingSummary(meeting.id, { status: 'running' });

    const turns = await this.storage.getMeetingTurns(meeting.id);
    const screens = (await this.storage.getMeetingFrames(meeting.id)).filter(
      (f) => f.entity_kind === 'meeting' && f.asset_path,
    );

    // Stage A — deterministic facts.
    const stageA = buildStageA(meeting, turns, screens);

    // Stage B — LLM. Best-effort. On failure or unavailability we
    // still write a useful summary built from Stage A only.
    let stageB: MeetingSummaryJson | null = null;
    let stageBErr: string | null = null;
    try {
      stageB = await this.runStageB(meeting, turns, screens, stageA);
    } catch (err) {
      stageBErr = String(err);
      this.logger.warn(`stage B failed for ${meeting.id}`, { err: stageBErr });
    }

    const final = stageB ?? stageA;
    const md = renderSummaryMarkdown(meeting, final, turns, screens);

    // Promote the LLM-generated title to the meeting row so it's
    // queryable without parsing the full JSON blob. Only overwrite if
    // the model produced a non-empty title — keep the heuristic one
    // from MeetingBuilder when the model returns null.
    const llmTitle = final.title ?? null;

    await this.storage.setMeetingSummary(meeting.id, {
      status: 'ready',
      md,
      json: final,
      contentHash: meeting.content_hash,
      failureReason: stageBErr,
      title: llmTitle ?? undefined,
    });
    this.logger.info(
      `summarised ${meeting.id} (${meeting.entity_path}, ${stageB ? 'llm' : 'deterministic'}, ${final.action_items.length} actions, ${final.decisions.length} decisions)`,
    );
    return 'ok';
  }

  private async runStageB(
    meeting: Meeting,
    turns: MeetingTurn[],
    screens: Frame[],
    fallback: MeetingSummaryJson,
  ): Promise<MeetingSummaryJson | null> {
    if (!this.enabled) return null;
    const prompt = buildPrompt(meeting, turns, screens, this.maxTranscriptChars);

    const visionImages = await this.loadVisionImages(meeting, screens);
    const supportsVision =
      this.model.getModelInfo().supportsVision && visionImages.length > 0;
    const raw = supportsVision
      ? await this.model.completeWithVision(prompt, visionImages, {
          systemPrompt: SUMMARY_SYSTEM_PROMPT,
          temperature: 0.2,
          maxTokens: 1500,
          responseFormat: 'json',
        })
      : await this.model.complete(prompt, {
          systemPrompt: SUMMARY_SYSTEM_PROMPT,
          temperature: 0.2,
          maxTokens: 1500,
          responseFormat: 'json',
        });
    const parsed = safeParseSummaryJson(raw);
    if (!parsed) return null;
    return mergeWithFallback(parsed, fallback);
  }

  private async loadVisionImages(meeting: Meeting, screens: Frame[]): Promise<Buffer[]> {
    if (this.visionAttachments <= 0) return [];
    if (!this.model.getModelInfo().supportsVision) return [];
    const picks = pickKeyScreenshots(screens, this.visionAttachments);
    const out: Buffer[] = [];
    for (const f of picks) {
      if (!f.asset_path) continue;
      const abs = path.isAbsolute(f.asset_path)
        ? f.asset_path
        : path.join(this.dataDir, f.asset_path);
      try {
        out.push(await fs.readFile(abs));
      } catch (err) {
        this.logger.debug(`could not load screenshot for vision ${f.asset_path}`, {
          err: String(err),
          meeting: meeting.id,
        });
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Helpers (pure, exported for test)
// ---------------------------------------------------------------------------

/**
 * Stage A — produce a structured summary from the data alone, no LLM.
 * The TL;DR is descriptive ("X-minute meeting on Y, captured Z turns")
 * rather than analytic; the LLM upgrades it when available. Returning
 * a real, useful object even when the LLM is offline / disabled is the
 * core graceful-degradation lever.
 */
export function buildStageA(
  meeting: Meeting,
  turns: MeetingTurn[],
  screens: Frame[],
): MeetingSummaryJson {
  const minutes = Math.round(meeting.duration_ms / 60_000);
  const platform = labelPlatform(meeting.platform);
  const tldrParts: string[] = [];
  tldrParts.push(`${minutes}-min ${platform} meeting on ${humanTitle(meeting)}`);
  if (meeting.attendees.length > 0) {
    tldrParts.push(`with ${formatList(meeting.attendees)}`);
  }
  if (meeting.audio_chunk_count === 0) {
    tldrParts.push('(no audio captured — visual-only summary)');
  } else {
    tldrParts.push(`(${turns.length} transcript turns over ${meeting.audio_chunk_count} audio chunk(s))`);
  }
  const tldr = tldrParts.join(' ') + '.';

  const agenda = inferAgenda(turns, screens);
  const links = meeting.links;
  const keyMoments = pickKeyScreenshots(screens, 5).map((f) => ({
    t: f.timestamp,
    what: describeScreen(f),
    frame_id: f.id,
  }));

  return {
    title: null,
    tldr,
    agenda,
    decisions: [],
    action_items: [],
    open_questions: [],
    key_moments: keyMoments,
    attendees_seen: meeting.attendees,
    links_shared: links,
    notes:
      meeting.audio_chunk_count === 0
        ? 'No audio captured for this meeting — summary built from screenshots only.'
        : null,
  };
}

function labelPlatform(p: MeetingPlatform): string {
  switch (p) {
    case 'zoom': return 'Zoom';
    case 'meet': return 'Google Meet';
    case 'teams': return 'Microsoft Teams';
    case 'webex': return 'Webex';
    case 'whereby': return 'Whereby';
    case 'around': return 'Around';
    case 'other':
    default:
      return 'video';
  }
}

function humanTitle(meeting: Meeting): string {
  // entity_path is `meetings/<day>-<slug>`. Take the slug, replace `-`
  // with space, title-case. Falls back to the path if anything's odd.
  const tail = meeting.entity_path.split('/').slice(-1)[0] ?? meeting.entity_path;
  const stripped = tail.replace(/^\d{4}-\d{2}-\d{2}-/, '');
  if (!stripped) return meeting.entity_path;
  return stripped
    .split('-')
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ');
}

function formatList(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  const head = items.slice(0, -1).join(', ');
  return `${head}, and ${items[items.length - 1]}`;
}

/**
 * Lightweight agenda extraction: find the most distinct screenshot
 * window titles across the meeting (each represents a topic shift in
 * the most common case — a new slide, a new doc, a new shared screen).
 * Caps at 5 items to keep the journal scannable.
 */
function inferAgenda(_turns: MeetingTurn[], screens: Frame[]): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const f of screens) {
    const t = (f.window_title ?? '').replace(/\s+/g, ' ').trim();
    if (!t || t.length < 4) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    order.push(truncate(t, 80));
    if (order.length >= 5) break;
  }
  return order;
}

/**
 * Pick up to `limit` screenshots that are visually distinct, spread
 * across the meeting timeline. We sample evenly: for N screens and
 * `limit` slots, take every ceil(N/limit)-th frame. Combined with the
 * upstream perceptual-hash dedupe in capture, this gives a good
 * "highlight reel" without needing to compute hashes here.
 */
export function pickKeyScreenshots(screens: Frame[], limit: number): Frame[] {
  const withAssets = screens.filter((f) => f.asset_path);
  if (withAssets.length === 0 || limit <= 0) return [];
  if (withAssets.length <= limit) return withAssets;
  const step = withAssets.length / limit;
  const picks: Frame[] = [];
  for (let i = 0; i < limit; i++) {
    const idx = Math.min(withAssets.length - 1, Math.floor(i * step));
    picks.push(withAssets[idx]!);
  }
  return picks;
}

function describeScreen(f: Frame): string {
  const title = (f.window_title ?? '').replace(/\s+/g, ' ').trim();
  if (title) return truncate(title, 100);
  if (f.url) return truncate(f.url, 100);
  return f.app || 'screen change';
}

/**
 * Build the prompt body. We interleave transcript turns with screen
 * markers so the model can reference what was on screen at any
 * moment. Every turn gets a stable id `[T<id>]` so the model can
 * cite it back as `evidence_turn_ids`.
 */
export function buildPrompt(
  meeting: Meeting,
  turns: MeetingTurn[],
  screens: Frame[],
  maxChars: number,
): string {
  const lines: string[] = [];
  lines.push(`MEETING: ${meeting.entity_path}`);
  lines.push(`Platform: ${labelPlatform(meeting.platform)}`);
  lines.push(`Window: ${meeting.started_at} → ${meeting.ended_at} (${Math.round(meeting.duration_ms / 60_000)} min)`);
  if (meeting.attendees.length > 0) {
    lines.push(`Observed attendees: ${meeting.attendees.join(', ')}`);
  }
  if (meeting.links.length > 0) {
    lines.push(`Links shared: ${meeting.links.slice(0, 10).join(', ')}`);
  }
  lines.push('');
  lines.push('--- Fused timeline ---');

  const items: Array<{ t: string; line: string }> = [];
  for (const turn of turns) {
    const speaker = turn.speaker ? `${turn.speaker}: ` : '';
    items.push({
      t: turn.t_start,
      line: `[T${turn.id} @ ${turn.t_start.slice(11, 19)}] ${speaker}${turn.text}`,
    });
  }
  // Emit a screen marker each time the visible screenshot changes.
  // We track distinct (asset_path, window_title) keys.
  let lastKey: string | null = null;
  for (const f of screens) {
    if (!f.asset_path) continue;
    const key = `${f.asset_path}|${f.window_title}`;
    if (key === lastKey) continue;
    lastKey = key;
    items.push({
      t: f.timestamp,
      line: `[SCREEN @ ${f.timestamp.slice(11, 19)} — ${describeScreen(f)} — frame_id=${f.id}]`,
    });
  }
  items.sort((a, b) => a.t.localeCompare(b.t));

  let body = '';
  for (const it of items) {
    if (body.length + it.line.length + 1 > maxChars) {
      body += `\n[…truncated, ${items.length - body.split('\n').length} more lines omitted…]`;
      break;
    }
    body += it.line + '\n';
  }
  lines.push(body.trim());
  lines.push('');
  lines.push(
    'Respond with the JSON object described in the system prompt. Do not include any commentary.',
  );
  return lines.join('\n');
}

/**
 * Validate + coerce a raw model response into a MeetingSummaryJson.
 * Returns null on parse failure or unrecognisable shape — caller
 * falls back to Stage A.
 */
export function safeParseSummaryJson(raw: string): MeetingSummaryJson | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonObject(raw));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  return {
    title: typeof obj.title === 'string' && obj.title.trim() ? obj.title.trim() : null,
    tldr: typeof obj.tldr === 'string' ? obj.tldr : '',
    agenda: stringArray(obj.agenda),
    decisions: pairArray(obj.decisions, 'text'),
    action_items: actionItemsArray(obj.action_items),
    open_questions: pairArray(obj.open_questions, 'text'),
    key_moments: keyMomentsArray(obj.key_moments),
    attendees_seen: stringArray(obj.attendees_seen),
    links_shared: stringArray(obj.links_shared),
    notes: typeof obj.notes === 'string' ? obj.notes : null,
  };
}

function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) return trimmed;
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
}

function stringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
}

function pairArray(v: unknown, textKey: string): Array<{ text: string; evidence_turn_ids: number[] }> {
  if (!Array.isArray(v)) return [];
  const out: Array<{ text: string; evidence_turn_ids: number[] }> = [];
  for (const item of v) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const text = typeof obj[textKey] === 'string' ? (obj[textKey] as string).trim() : '';
    if (!text) continue;
    out.push({
      text,
      evidence_turn_ids: numericArray(obj.evidence_turn_ids),
    });
  }
  return out;
}

function actionItemsArray(v: unknown): MeetingSummaryJson['action_items'] {
  if (!Array.isArray(v)) return [];
  const out: MeetingSummaryJson['action_items'] = [];
  for (const item of v) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const task = typeof obj.task === 'string' ? obj.task.trim() : '';
    if (!task) continue;
    out.push({
      owner: typeof obj.owner === 'string' && obj.owner.trim() ? obj.owner.trim() : null,
      task,
      due: typeof obj.due === 'string' && obj.due.trim() ? obj.due.trim() : null,
      evidence_turn_ids: numericArray(obj.evidence_turn_ids),
    });
  }
  return out;
}

function keyMomentsArray(v: unknown): MeetingSummaryJson['key_moments'] {
  if (!Array.isArray(v)) return [];
  const out: MeetingSummaryJson['key_moments'] = [];
  for (const item of v) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const what = typeof obj.what === 'string' ? obj.what.trim() : '';
    const t = typeof obj.t === 'string' ? obj.t.trim() : '';
    if (!what || !t) continue;
    out.push({
      t,
      what,
      frame_id: typeof obj.frame_id === 'string' && obj.frame_id ? obj.frame_id : null,
    });
  }
  return out;
}

function numericArray(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
}

/**
 * Merge an LLM-produced summary with the deterministic Stage A
 * fallback. The LLM wins on prose fields; deterministic data fills
 * in anything the LLM omitted (attendees, links, key_moments —
 * common omissions in our experience).
 */
function mergeWithFallback(
  llm: MeetingSummaryJson,
  fallback: MeetingSummaryJson,
): MeetingSummaryJson {
  return {
    title: llm.title ?? fallback.title,
    tldr: llm.tldr || fallback.tldr,
    agenda: llm.agenda.length > 0 ? llm.agenda : fallback.agenda,
    decisions: llm.decisions,
    action_items: llm.action_items,
    open_questions: llm.open_questions,
    key_moments: llm.key_moments.length > 0 ? llm.key_moments : fallback.key_moments,
    attendees_seen:
      llm.attendees_seen.length > 0 ? llm.attendees_seen : fallback.attendees_seen,
    links_shared: llm.links_shared.length > 0 ? llm.links_shared : fallback.links_shared,
    notes: llm.notes ?? fallback.notes,
  };
}

/**
 * Render the structured summary to markdown for the journal + MCP. We
 * include `(turn T<id>)` evidence pointers so a reader can chase any
 * claim back to its source turn via `get_meeting`.
 */
export function renderSummaryMarkdown(
  meeting: Meeting,
  s: MeetingSummaryJson,
  turns: MeetingTurn[],
  screens: Frame[],
): string {
  const lines: string[] = [];
  const start = meeting.started_at.slice(11, 16);
  const end = meeting.ended_at.slice(11, 16);
  const platform = labelPlatform(meeting.platform);
  lines.push(
    `### Meeting · ${start}-${end} · ${platform} · [[${meeting.entity_path}]]`,
  );
  lines.push('');
  if (s.tldr) {
    lines.push(`**TL;DR.** ${s.tldr}`);
    lines.push('');
  }
  if (s.attendees_seen.length > 0) {
    lines.push(`**Attendees seen:** ${s.attendees_seen.join(', ')}.`);
  }
  if (s.agenda.length > 0) {
    lines.push('**Agenda:**');
    for (const a of s.agenda) lines.push(`- ${a}`);
  }
  if (s.decisions.length > 0) {
    lines.push('');
    lines.push('**Decisions:**');
    for (const d of s.decisions) {
      lines.push(`- ${d.text}${formatTurnRefs(d.evidence_turn_ids)}`);
    }
  }
  if (s.action_items.length > 0) {
    lines.push('');
    lines.push('**Action items:**');
    for (const a of s.action_items) {
      const owner = a.owner ? `**${a.owner}** — ` : '';
      const due = a.due ? ` _(due ${a.due})_` : '';
      lines.push(`- ${owner}${a.task}${due}${formatTurnRefs(a.evidence_turn_ids)}`);
    }
  }
  if (s.open_questions.length > 0) {
    lines.push('');
    lines.push('**Open questions:**');
    for (const q of s.open_questions) {
      lines.push(`- ${q.text}${formatTurnRefs(q.evidence_turn_ids)}`);
    }
  }
  if (s.key_moments.length > 0) {
    lines.push('');
    lines.push('**Key moments:**');
    for (const k of s.key_moments) {
      lines.push(`- _${k.t.slice(11, 19)}_ — ${k.what}` + (k.frame_id ? ` (frame ${k.frame_id})` : ''));
    }
  }
  if (s.links_shared.length > 0) {
    lines.push('');
    lines.push('**Links:**');
    for (const link of s.links_shared.slice(0, 12)) {
      lines.push(`- <${link}>`);
    }
  }
  if (s.notes) {
    lines.push('');
    lines.push(`_${s.notes}_`);
  }
  // Stats footer.
  const screenCount = screens.length;
  lines.push('');
  lines.push(
    `_${turns.length} transcript turns · ${screenCount} key screen frames · ${meeting.audio_chunk_count} audio chunk(s)_`,
  );
  return lines.join('\n');
}

function formatTurnRefs(ids: number[]): string {
  if (!ids || ids.length === 0) return '';
  return ` _(turn${ids.length === 1 ? '' : 's'} ${ids.map((id) => `T${id}`).join(', ')})_`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
