import { createHash } from 'node:crypto';
import type {
  ActivitySession,
  Frame,
  IModelAdapter,
  Insight,
  InsightEvidence,
  InsightKind,
  InsightSeverity,
  IStorage,
  Logger,
} from '@cofounderos/interfaces';
import { redactPii } from './pii.js';

export interface InsightsWorkerOptions {
  enabled?: boolean;
  lookbackHours?: number;
  maxSessionsPerBatch?: number;
  minConfidence?: number;
  sensitiveKeywords?: string[];
}

export interface InsightsWorkerResult {
  candidates: number;
  generated: number;
  skippedReason?: string;
}

interface InsightCandidate {
  kind: InsightKind;
  severity: InsightSeverity;
  title: string;
  summary: string;
  recommendation: string;
  confidence: number;
  evidence: InsightEvidence;
}

const DISTRACTION_APPS = new Set([
  'Facebook',
  'Instagram',
  'Netflix',
  'Reddit',
  'TikTok',
  'Twitter',
  'X',
  'YouTube',
]);

const DISTRACTION_DOMAINS = [
  'facebook.com',
  'instagram.com',
  'netflix.com',
  'reddit.com',
  'tiktok.com',
  'twitter.com',
  'x.com',
  'youtube.com',
];

/**
 * InsightsWorker turns prepared frames/sessions into durable, actionable cards.
 *
 * Deterministic metrics find candidate patterns; the active local model only
 * polishes explanations and recommendations. If the model is unavailable or
 * returns invalid JSON, the deterministic cards are still persisted.
 */
export class InsightsWorker {
  private readonly logger: Logger;
  private readonly enabled: boolean;
  private readonly lookbackHours: number;
  private readonly maxSessionsPerBatch: number;
  private readonly minConfidence: number;
  private readonly sensitiveKeywords: string[];
  private warnedUnavailable = false;

  constructor(
    private readonly storage: IStorage,
    private readonly model: IModelAdapter,
    logger: Logger,
    opts: InsightsWorkerOptions = {},
  ) {
    this.logger = logger.child('insights-worker');
    this.enabled = opts.enabled ?? true;
    this.lookbackHours = opts.lookbackHours ?? 24;
    this.maxSessionsPerBatch = opts.maxSessionsPerBatch ?? 80;
    this.minConfidence = opts.minConfidence ?? 0.55;
    this.sensitiveKeywords = opts.sensitiveKeywords ?? [];
  }

  async tick(): Promise<InsightsWorkerResult> {
    if (!this.enabled) {
      return { candidates: 0, generated: 0, skippedReason: 'disabled' };
    }

    const ready = await this.model.isAvailable().catch(() => false);
    if (!ready) {
      if (!this.warnedUnavailable) {
        this.warnedUnavailable = true;
        this.logger.warn('local model is unavailable; insights generation skipped');
      }
      return { candidates: 0, generated: 0, skippedReason: 'model_unavailable' };
    }

    const period = this.currentPeriod();
    const sessions = await this.storage.listSessions({
      from: period.start,
      to: period.end,
      order: 'chronological',
      limit: this.maxSessionsPerBatch,
    });
    if (sessions.length === 0) {
      return { candidates: 0, generated: 0, skippedReason: 'no_sessions' };
    }

    const framesBySession = new Map<string, Frame[]>();
    const allFrames: Frame[] = [];
    for (const session of sessions) {
      const frames = await this.storage.getSessionFrames(session.id);
      framesBySession.set(session.id, frames);
      allFrames.push(...frames);
    }

    const candidates = this.buildCandidates(sessions, framesBySession, allFrames);
    if (candidates.length === 0) {
      return { candidates: 0, generated: 0, skippedReason: 'no_candidates' };
    }

    // Augment each candidate with the entity neighbourhood the storage
    // layer learned from session co-occurrence. Cheap (one query per
    // primary entity) and turns generic cards into "X happens alongside
    // Y, Z" — the kind of contextual signal that makes insights
    // actionable instead of obvious.
    const enriched = await this.enrichWithCoOccurrence(candidates).catch((err) => {
      this.logger.warn('co-occurrence enrichment failed; using bare candidates', {
        err: String(err),
      });
      return candidates;
    });

    const polished = await this.polishCandidates(enriched, period).catch((err) => {
      this.logger.warn('local model failed to polish insights; using deterministic cards', {
        err: String(err),
      });
      return enriched;
    });

    let generated = 0;
    const now = new Date().toISOString();
    for (const candidate of polished) {
      if (candidate.confidence < this.minConfidence) continue;
      const insight: Insight = {
        id: insightId(candidate.kind, period, candidate.evidence),
        kind: candidate.kind,
        severity: candidate.severity,
        title: candidate.title,
        summary: candidate.summary,
        recommendation: candidate.recommendation,
        confidence: clamp01(candidate.confidence),
        evidence: candidate.evidence,
        period,
        status: 'active',
        created_at: now,
        updated_at: now,
      };
      await this.storage.upsertInsight(insight);
      generated += 1;
    }

    if (generated > 0) {
      this.logger.info(`generated ${generated} insight(s) from ${candidates.length} candidate(s)`);
    }
    return { candidates: candidates.length, generated };
  }

  async drain(): Promise<InsightsWorkerResult> {
    return await this.tick();
  }

  private currentPeriod(): Insight['period'] {
    const end = new Date();
    const start = new Date(end.getTime() - this.lookbackHours * 60 * 60 * 1000);
    return {
      label: this.lookbackHours <= 24 ? 'Last 24 hours' : `Last ${this.lookbackHours} hours`,
      start: start.toISOString(),
      end: end.toISOString(),
    };
  }

  private buildCandidates(
    sessions: ActivitySession[],
    framesBySession: Map<string, Frame[]>,
    allFrames: Frame[],
  ): InsightCandidate[] {
    const candidates: InsightCandidate[] = [];
    const activeMs = sessions.reduce((sum, s) => sum + Math.max(0, s.active_ms), 0);
    const appMs = sumBy(sessions, (s) => s.primary_app ?? 'Unknown', (s) => s.active_ms);
    const entityMs = sumBy(
      sessions.filter((s) => s.primary_entity_path),
      (s) => s.primary_entity_path ?? 'Unknown',
      (s) => s.active_ms,
    );
    const switchCount = countSwitches(allFrames);
    const switchesPerHour = activeMs > 0 ? switchCount / (activeMs / 3_600_000) : 0;

    const wasted = this.findDistractingFrames(allFrames);
    if (wasted.ms >= 20 * 60_000) {
      candidates.push({
        kind: 'time_waste',
        severity: wasted.ms >= 60 * 60_000 ? 'high' : 'medium',
        title: 'Potential time sink detected',
        summary: `About ${formatDuration(wasted.ms)} went to low-signal apps or sites.`,
        recommendation: 'Batch or block this surface during your next focus window.',
        confidence: 0.72,
        evidence: {
          frameIds: wasted.frames.slice(0, 8).map((f) => f.id),
          apps: topKeys(wasted.appMs, 5),
          metrics: { minutes: Math.round(wasted.ms / 60_000) },
          snippets: this.snippets(wasted.frames),
        },
      });
    }

    const repeated = this.findRepeatedTask(allFrames);
    if (repeated) {
      candidates.push({
        kind: 'repeated_task',
        severity: 'medium',
        title: 'Repeated task pattern',
        summary: `You returned to "${repeated.label}" ${repeated.count} times.`,
        recommendation: 'Consider turning the steps into a checklist, script, or saved workflow.',
        confidence: 0.68,
        evidence: {
          frameIds: repeated.frames.slice(0, 8).map((f) => f.id),
          sessionIds: Array.from(repeated.sessionIds).slice(0, 8),
          apps: Array.from(new Set(repeated.frames.map((f) => f.app).filter(Boolean))).slice(0, 5),
          metrics: { occurrences: repeated.count, sessions: repeated.sessionIds.size },
          snippets: this.snippets(repeated.frames),
        },
      });
    }

    if (activeMs >= 30 * 60_000 && switchesPerHour >= 25) {
      candidates.push({
        kind: 'context_switching',
        severity: switchesPerHour >= 45 ? 'high' : 'medium',
        title: 'High context switching',
        summary: `Your session stream changed context about ${Math.round(switchesPerHour)} times per active hour.`,
        recommendation: 'Try grouping chat, docs, and implementation into separate blocks.',
        confidence: 0.7,
        evidence: {
          frameIds: allFrames.slice(0, 12).map((f) => f.id),
          sessionIds: sessions.slice(0, 8).map((s) => s.id),
          apps: topKeys(appMs, 6),
          entities: topKeys(entityMs, 6),
          metrics: {
            switches: switchCount,
            switchesPerHour: Math.round(switchesPerHour),
            activeMinutes: Math.round(activeMs / 60_000),
          },
        },
      });
    }

    const longest = sessions.reduce<ActivitySession | null>((best, s) => {
      if (!best || s.active_ms > best.active_ms) return s;
      return best;
    }, null);
    if (longest && longest.active_ms >= 45 * 60_000) {
      const label = longest.primary_entity_path ?? longest.primary_app ?? 'one focus area';
      candidates.push({
        kind: 'focus_opportunity',
        severity: 'info',
        title: 'Strong focus block',
        summary: `You had ${formatDuration(longest.active_ms)} of focused work on ${label}.`,
        recommendation: 'Protect the conditions around this block; it is a repeatable focus pattern.',
        confidence: 0.74,
        evidence: {
          sessionIds: [longest.id],
          frameIds: (framesBySession.get(longest.id) ?? []).slice(0, 8).map((f) => f.id),
          apps: longest.primary_app ? [longest.primary_app] : [],
          entities: longest.primary_entity_path ? [longest.primary_entity_path] : [],
          metrics: { activeMinutes: Math.round(longest.active_ms / 60_000) },
          snippets: this.snippets(framesBySession.get(longest.id) ?? []),
        },
      });
    } else if (activeMs >= 60 * 60_000) {
      candidates.push({
        kind: 'focus_opportunity',
        severity: 'low',
        title: 'Focus blocks were fragmented',
        summary: 'You had enough active time for deep work, but no long uninterrupted session stood out.',
        recommendation: 'Reserve one 45-minute block for the highest-value project tomorrow.',
        confidence: 0.61,
        evidence: {
          sessionIds: sessions.slice(0, 8).map((s) => s.id),
          apps: topKeys(appMs, 6),
          metrics: { activeMinutes: Math.round(activeMs / 60_000), sessionCount: sessions.length },
        },
      });
    }

    const topApp = topEntry(appMs);
    if (topApp && activeMs >= 30 * 60_000 && topApp[1] / activeMs >= 0.35) {
      candidates.push({
        kind: 'trend',
        severity: 'info',
        title: 'Dominant work surface',
        summary: `${topApp[0]} took ${formatDuration(topApp[1])}, your largest active bucket in this window.`,
        recommendation: 'Use this as the anchor when planning what to resume next.',
        confidence: 0.6,
        evidence: {
          apps: [topApp[0]],
          metrics: {
            activeMinutes: Math.round(activeMs / 60_000),
            appMinutes: Math.round(topApp[1] / 60_000),
            sharePercent: Math.round((topApp[1] / activeMs) * 100),
          },
        },
      });
    }

    return candidates.slice(0, 6);
  }

  /**
   * For each candidate that has a meaningful "subject" entity (a
   * project / repo / channel / contact / meeting / doc — not a bare
   * `apps/*` row), attach the top co-occurring entities pulled from
   * the storage layer's session-derived knowledge graph. Falls back
   * gracefully if the co-occurrence query fails for any candidate so
   * a single bad lookup never wipes the rest.
   *
   * What changes:
   *   - `evidence.entities` grows to include up-to-3 contextual
   *     partners (deduped, capped at 8 total).
   *   - For `focus_opportunity` / `trend`, the human-readable summary
   *     gains a "(alongside X, Y)" tail when partners are present, so
   *     the deterministic card already reads well even when the
   *     local model is offline and skips polishing.
   */
  private async enrichWithCoOccurrence(
    candidates: InsightCandidate[],
  ): Promise<InsightCandidate[]> {
    const out: InsightCandidate[] = [];
    for (const candidate of candidates) {
      const subject = pickSubjectEntity(candidate);
      if (!subject) {
        out.push(candidate);
        continue;
      }
      let neighbours: Awaited<ReturnType<IStorage['listEntityCoOccurrences']>>;
      try {
        neighbours = await this.storage.listEntityCoOccurrences(subject, 6);
      } catch {
        out.push(candidate);
        continue;
      }
      // Filter out apps/* (transient tools dilute the signal) and the
      // subject itself. Keep partners that share at least 2 sessions
      // OR carry meaningful focused time (≥30s) so we don't surface
      // spurious one-frame overlaps.
      const partners = neighbours
        .filter((n) => !n.path.startsWith('apps/'))
        .filter((n) => n.path !== subject)
        .filter((n) => n.sharedSessions >= 2 || n.sharedFocusedMs >= 30_000)
        .slice(0, 4);
      if (partners.length === 0) {
        out.push(candidate);
        continue;
      }
      const merged = Array.from(
        new Set([
          subject,
          ...partners.map((p) => p.path),
          ...(candidate.evidence.entities ?? []),
        ]),
      ).slice(0, 8);

      let summary = candidate.summary;
      if (
        (candidate.kind === 'focus_opportunity' || candidate.kind === 'trend') &&
        partners.length > 0
      ) {
        const names = partners.slice(0, 2).map((p) => humaniseEntityName(p.path));
        if (names.length > 0) {
          summary = `${candidate.summary.replace(/\.$/, '')} (alongside ${names.join(' and ')}).`;
        }
      }

      out.push({
        ...candidate,
        evidence: {
          ...candidate.evidence,
          entities: merged,
        },
        summary,
      });
    }
    return out;
  }

  private async polishCandidates(
    candidates: InsightCandidate[],
    period: Insight['period'],
  ): Promise<InsightCandidate[]> {
    const prompt = [
      'Rewrite these local activity insight candidates into concise, actionable insight cards.',
      'Return JSON only with this shape:',
      '{"insights":[{"index":0,"title":"...","summary":"...","recommendation":"...","severity":"info|low|medium|high","confidence":0.0}]}',
      'Do not invent evidence. Keep recommendations specific and non-judgmental.',
      'When `evidence.entities` lists more than the primary subject, the extra',
      'paths are co-occurring entities the user touched in the same activity',
      'sessions (e.g. teammates, channels, related projects). Mention them by',
      'name when they make the recommendation more useful — e.g. "your work on',
      'cofounderos consistently involves the postman-liblab-prs channel".',
      '',
      JSON.stringify({
        period,
        candidates: candidates.map((c, index) => ({
          index,
          kind: c.kind,
          title: c.title,
          summary: c.summary,
          recommendation: c.recommendation,
          severity: c.severity,
          confidence: c.confidence,
          evidence: c.evidence,
        })),
      }),
    ].join('\n');
    const raw = await this.model.complete(prompt, {
      responseFormat: 'json',
      temperature: 0.2,
      maxTokens: 1400,
      systemPrompt: 'You are a local productivity analyst. Be useful, brief, and evidence-grounded.',
    });
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { insights?: unknown }).insights)) {
      return candidates;
    }
    const updates = (parsed as { insights: unknown[] }).insights;
    return candidates.map((candidate, index) => {
      const update = updates.find((item): item is Record<string, unknown> => {
        return !!item && typeof item === 'object' && (item as { index?: unknown }).index === index;
      });
      if (!update) return candidate;
      return {
        ...candidate,
        title: textOr(candidate.title, update.title, 80),
        summary: textOr(candidate.summary, update.summary, 220),
        recommendation: textOr(candidate.recommendation, update.recommendation, 220),
        severity: severityOr(candidate.severity, update.severity),
        confidence: clamp01(numberOr(candidate.confidence, update.confidence)),
      };
    });
  }

  private findDistractingFrames(frames: Frame[]): { ms: number; frames: Frame[]; appMs: Map<string, number> } {
    let ms = 0;
    const appMs = new Map<string, number>();
    const out: Frame[] = [];
    for (const frame of frames) {
      if (!isDistracting(frame)) continue;
      const contribution = frame.duration_ms ?? 5_000;
      ms += contribution;
      out.push(frame);
      appMs.set(frame.app || 'Unknown', (appMs.get(frame.app || 'Unknown') ?? 0) + contribution);
    }
    return { ms, frames: out, appMs };
  }

  private findRepeatedTask(frames: Frame[]): {
    label: string;
    count: number;
    sessionIds: Set<string>;
    frames: Frame[];
  } | null {
    const buckets = new Map<string, { label: string; frames: Frame[]; sessionIds: Set<string> }>();
    for (const frame of frames) {
      const label = repeatLabel(frame);
      if (!label) continue;
      const key = label.toLowerCase();
      const bucket = buckets.get(key) ?? { label, frames: [], sessionIds: new Set<string>() };
      bucket.frames.push(frame);
      if (frame.activity_session_id) bucket.sessionIds.add(frame.activity_session_id);
      buckets.set(key, bucket);
    }
    let best: { label: string; frames: Frame[]; sessionIds: Set<string> } | null = null;
    for (const bucket of buckets.values()) {
      if (bucket.frames.length < 5 && bucket.sessionIds.size < 3) continue;
      if (!best || bucket.frames.length > best.frames.length) best = bucket;
    }
    return best
      ? {
          label: best.label,
          count: best.frames.length,
          sessionIds: best.sessionIds,
          frames: best.frames,
        }
      : null;
  }

  private snippets(frames: Frame[]): NonNullable<InsightEvidence['snippets']> {
    return frames
      .filter((frame) => frame.text || frame.window_title || frame.url)
      .slice(0, 3)
      .map((frame) => ({
        label: frame.app || 'Frame',
        frameId: frame.id,
        sessionId: frame.activity_session_id ?? undefined,
        text: redactPii(
          [frame.window_title, frame.url, frame.text].filter(Boolean).join(' | '),
          this.sensitiveKeywords,
        ).replace(/\s+/g, ' ').slice(0, 260),
      }));
  }
}

function isDistracting(frame: Frame): boolean {
  if (DISTRACTION_APPS.has(frame.app)) return true;
  const host = urlHost(frame.url);
  return !!host && DISTRACTION_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function urlHost(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

function repeatLabel(frame: Frame): string | null {
  if (frame.url) {
    try {
      const parsed = new URL(frame.url);
      const path = parsed.pathname.split('/').filter(Boolean).slice(0, 2).join('/');
      return `${parsed.hostname.replace(/^www\./, '')}/${path}`.replace(/\/$/, '');
    } catch {
      // fall through to title
    }
  }
  const title = frame.window_title
    .replace(/\s-\s.*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (title.length < 8) return null;
  return title.slice(0, 80);
}

function countSwitches(frames: Frame[]): number {
  let previous: string | null = null;
  let switches = 0;
  for (const frame of frames.slice().sort((a, b) => a.timestamp.localeCompare(b.timestamp))) {
    const current = frame.entity_path ?? frame.url ?? frame.app;
    if (!current) continue;
    if (previous && previous !== current) switches += 1;
    previous = current;
  }
  return switches;
}

function sumBy<T>(items: T[], keyFn: (item: T) => string, valueFn: (item: T) => number): Map<string, number> {
  const out = new Map<string, number>();
  for (const item of items) {
    const key = keyFn(item);
    out.set(key, (out.get(key) ?? 0) + Math.max(0, valueFn(item)));
  }
  return out;
}

function topEntry(values: Map<string, number>): [string, number] | null {
  let best: [string, number] | null = null;
  for (const entry of values.entries()) {
    if (!best || entry[1] > best[1]) best = entry;
  }
  return best;
}

function topKeys(values: Map<string, number>, limit: number): string[] {
  return Array.from(values.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key]) => key);
}

function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem === 0 ? `${hours} hr` : `${hours} hr ${rem} min`;
}

function insightId(kind: InsightKind, period: Insight['period'], evidence: InsightEvidence): string {
  const fingerprint = JSON.stringify({
    kind,
    periodStart: period.start.slice(0, 13),
    periodEnd: period.end.slice(0, 13),
    frameIds: evidence.frameIds?.slice().sort().slice(0, 8) ?? [],
    sessionIds: evidence.sessionIds?.slice().sort().slice(0, 8) ?? [],
    apps: evidence.apps?.slice().sort() ?? [],
    entities: evidence.entities?.slice().sort() ?? [],
  });
  return `ins_${createHash('sha256').update(fingerprint).digest('hex').slice(0, 24)}`;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function textOr(fallback: string, value: unknown, max: number): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : fallback;
}

function numberOr(fallback: number, value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function severityOr(fallback: InsightSeverity, value: unknown): InsightSeverity {
  return value === 'info' || value === 'low' || value === 'medium' || value === 'high'
    ? value
    : fallback;
}

/**
 * Pick the entity the candidate is "about", for co-occurrence
 * enrichment. We prefer the first non-app entity in evidence.entities
 * because that's where buildCandidates puts the resolved subject for
 * focus_opportunity / context_switching. Returns null when only
 * `apps/*` paths are present (no useful neighbourhood to surface) or
 * when no entity evidence exists at all.
 */
function pickSubjectEntity(candidate: InsightCandidate): string | null {
  const list = candidate.evidence.entities ?? [];
  for (const path of list) {
    if (typeof path !== 'string' || !path) continue;
    if (path.startsWith('apps/')) continue;
    return path;
  }
  return null;
}

/**
 * Turn a stable entity path into something a sentence can naturally
 * include. Drops the kind-prefix segment, replaces dashes/underscores
 * with spaces, and prefixes channels with `#` so chat references read
 * the way users say them out loud.
 *
 *   projects/cofounderos        -> "cofounderos"
 *   contacts/milan-lazic        -> "milan lazic"
 *   channels/postman-liblab-prs -> "#postman-liblab-prs"
 */
function humaniseEntityName(path: string): string {
  const slash = path.indexOf('/');
  if (slash === -1) return path;
  const kind = path.slice(0, slash);
  const tail = path.slice(slash + 1);
  if (kind === 'channels') {
    return `#${tail}`;
  }
  return tail.replace(/[-_]+/g, ' ');
}
