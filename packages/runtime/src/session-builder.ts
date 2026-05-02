import type {
  IStorage,
  Frame,
  ActivitySession,
  EntityKind,
  Logger,
} from '@cofounderos/interfaces';
import { newActivitySessionId, dayKey } from '@cofounderos/core';
import {
  isSupportingAppEntity,
  CODE_APPS,
  TERMINAL_APPS,
} from './entity-resolver.js';

/**
 * Entity kinds that the lift will fold supporting-app orphans into.
 * Restricted to `project` and `repo` deliberately:
 *
 * - A Slack channel or DM doesn't "own" Cursor work that happened
 *   nearby — we'd misattribute coding sessions to whoever sent the
 *   most recent message.
 * - A meeting / doc page is similarly an orthogonal context.
 *
 * Only project / repo entities map cleanly to "what code did the
 * user produce in this session", which is the question the lift is
 * answering.
 */
const LIFT_TARGET_KINDS: ReadonlySet<EntityKind> = new Set([
  'project',
  'repo',
]);

/** Apps whose dominance triggers the lift. Coding/terminal sessions only. */
const LIFT_TRIGGER_APPS: ReadonlySet<string> = new Set([
  ...CODE_APPS,
  ...TERMINAL_APPS,
]);

/**
 * Floor on the target's absolute attention. Prevents lifting on the
 * strength of one or two stray frames where the resolver got lucky.
 * 20s is roughly four 5-second screenshots in the same project.
 */
const LIFT_MIN_TARGET_MS = 20_000;

/**
 * SessionBuilder — turns the chronological stream of frames into
 * activity sessions, the user-visible unit of "what was I doing for
 * the last hour?".
 *
 * Definition: a session is a continuous run of frames with no gap
 * larger than `idle_threshold_ms` between adjacent frames. Sessions
 * never span midnight (a day boundary always closes the open session
 * and starts a new one), so daily journals can render them cleanly.
 *
 * Per session we compute:
 *   - duration_ms = ended_at - started_at
 *   - active_ms   = sum of inter-frame gaps that fell *under* the idle
 *                   threshold (≈ continuous focus time inside the
 *                   session — duration_ms minus brief idle stretches)
 *   - primary_entity / primary_app = highest-attention contributor by
 *                   accumulated active_ms
 *   - entities[] = all entities touched, sorted by attention desc
 *
 * The worker is incremental: it picks frames where
 * `activity_session_id IS NULL`, ordered ascending, and either extends
 * the most recent session (if its last frame is within the idle
 * threshold of the new one) or starts a new session. Sessions shorter
 * than `min_active_ms` are kept — losing them would create gaps in the
 * journal — but flagged via active_ms < threshold so consumers can
 * filter if desired.
 *
 * On `--full-reindex`, the orchestrator calls
 * `storage.clearAllSessions()` and then drains this worker, which
 * regroups every frame from scratch using the current config.
 */

export interface SessionBuilderOptions {
  /** Gap above this (ms) closes the current session. Default 5 min. */
  idleThresholdMs?: number;
  /**
   * Frames that have a `duration_ms` from a paired blur event use that
   * as their attention contribution. Frames without a duration get
   * this fallback (in ms). Default 5000 (5 sec) — roughly the screenshot
   * cadence in normal use.
   */
  fallbackFrameAttentionMs?: number;
  /**
   * Soft minimum on `active_ms` before a session is considered "real".
   * We persist all sessions regardless, but the SessionBuilder logs a
   * debug count of trivial ones for observability. Default 30000.
   */
  minActiveMs?: number;
  /** Frames per tick. Default 2000 — sessions are cheap to build. */
  batchSize?: number;
}

export interface SessionBuilderResult {
  framesProcessed: number;
  sessionsCreated: number;
  sessionsExtended: number;
}

/**
 * Internal accumulator for a session under construction. Distinct
 * shape from the persisted ActivitySession so we can mutate freely
 * without serialising on every frame.
 */
interface SessionAccumulator {
  id: string;
  startedAt: string;
  endedAt: string;
  day: string;
  frameIds: string[];
  /** Sum of attention contributions per entity path. */
  entityWeights: Map<string, { kind: EntityKind; ms: number }>;
  /** Sum of attention contributions per app — secondary classifier. */
  appWeights: Map<string, number>;
  activeMs: number;
  isExisting: boolean;
}

export class SessionBuilder {
  private readonly logger: Logger;
  private readonly idleThresholdMs: number;
  private readonly fallbackFrameAttentionMs: number;
  private readonly minActiveMs: number;
  private readonly batchSize: number;

  constructor(
    private readonly storage: IStorage,
    logger: Logger,
    opts: SessionBuilderOptions = {},
  ) {
    this.logger = logger.child('session-builder');
    this.idleThresholdMs = opts.idleThresholdMs ?? 5 * 60_000;
    this.fallbackFrameAttentionMs = opts.fallbackFrameAttentionMs ?? 5_000;
    this.minActiveMs = opts.minActiveMs ?? 30_000;
    this.batchSize = opts.batchSize ?? 2000;
  }

  async tick(): Promise<SessionBuilderResult> {
    const pending = await this.storage.listFramesNeedingSessionAssignment(
      this.batchSize,
    );
    if (pending.length === 0) {
      return { framesProcessed: 0, sessionsCreated: 0, sessionsExtended: 0 };
    }

    // Decide whether to extend the most recently persisted session or
    // open a new one. We extend only when the first pending frame falls
    // within idle_threshold of that session's ended_at AND on the same
    // day. This makes the worker idempotent across restarts.
    let acc: SessionAccumulator | null = null;
    let sessionsCreated = 0;
    let sessionsExtended = 0;

    const first = pending[0]!;
    const recentSessions = await this.storage.listSessions({
      day: first.day,
      limit: 1,
      order: 'recent',
    });
    const candidate = recentSessions[0];
    if (candidate) {
      const gap = Date.parse(first.timestamp) - Date.parse(candidate.ended_at);
      if (gap >= 0 && gap <= this.idleThresholdMs && candidate.day === first.day) {
        acc = await this.hydrateExistingSession(candidate);
        sessionsExtended += 1;
      }
    }

    let prevTs = acc ? Date.parse(acc.endedAt) : null;
    let prevEntityPath = acc ? this.lastEntityOf(acc) : null;

    for (const frame of pending) {
      const ts = Date.parse(frame.timestamp);
      const gap = prevTs == null ? null : ts - prevTs;
      const sameDay = acc ? acc.day === frame.day : true;
      const shouldClose =
        acc != null &&
        ((gap != null && gap > this.idleThresholdMs) || !sameDay);

      if (shouldClose && acc) {
        await this.persist(acc);
        acc = null;
      }
      if (!acc) {
        acc = this.newAccumulator(frame);
        sessionsCreated += 1;
      }

      // Attention contribution: the frame's measured duration when
      // available, otherwise the gap from the previous frame (capped at
      // the idle threshold so we don't double-count obvious AFK
      // periods), with a tiny floor so every frame contributes
      // something even back-to-back captures.
      const fallback = gap != null && gap <= this.idleThresholdMs
        ? Math.min(gap, this.idleThresholdMs)
        : this.fallbackFrameAttentionMs;
      const attention = frame.duration_ms ?? fallback;

      acc.frameIds.push(frame.id);
      acc.endedAt = frame.timestamp;
      if (gap != null && gap <= this.idleThresholdMs) {
        acc.activeMs += gap;
      }

      if (frame.entity_path && frame.entity_kind) {
        const cur = acc.entityWeights.get(frame.entity_path);
        if (cur) {
          cur.ms += attention;
        } else {
          acc.entityWeights.set(frame.entity_path, {
            kind: frame.entity_kind,
            ms: attention,
          });
        }
      }
      if (frame.app) {
        acc.appWeights.set(frame.app, (acc.appWeights.get(frame.app) ?? 0) + attention);
      }

      prevTs = ts;
      prevEntityPath = frame.entity_path ?? prevEntityPath;
    }

    if (acc) {
      await this.persist(acc);
    }

    const remaining = pending.length === this.batchSize ? '+' : '';
    this.logger.debug(
      `processed ${pending.length}${remaining} frames into ${sessionsCreated} new + ${sessionsExtended} extended sessions`,
    );

    return {
      framesProcessed: pending.length,
      sessionsCreated,
      sessionsExtended,
    };
  }

  /** Drain until no more pending frames remain. */
  async drain(): Promise<SessionBuilderResult> {
    const total: SessionBuilderResult = {
      framesProcessed: 0,
      sessionsCreated: 0,
      sessionsExtended: 0,
    };
    for (let i = 0; i < 10_000; i++) {
      const r = await this.tick();
      total.framesProcessed += r.framesProcessed;
      total.sessionsCreated += r.sessionsCreated;
      total.sessionsExtended += r.sessionsExtended;
      if (r.framesProcessed === 0) break;
      if (r.framesProcessed < this.batchSize) break;
    }
    return total;
  }

  private newAccumulator(frame: Frame): SessionAccumulator {
    const day = frame.day || dayKey(new Date(frame.timestamp));
    return {
      id: newActivitySessionId(new Date(frame.timestamp)),
      startedAt: frame.timestamp,
      endedAt: frame.timestamp,
      day,
      frameIds: [],
      entityWeights: new Map(),
      appWeights: new Map(),
      activeMs: 0,
      isExisting: false,
    };
  }

  /**
   * Hydrate a previously persisted session so we can keep extending it.
   * We re-read the session's frames so the new frame's attention math
   * picks up where it left off (per-entity weights etc.). For sessions
   * with thousands of frames this still costs only a single SQL query
   * + a small in-memory aggregation.
   */
  private async hydrateExistingSession(
    session: ActivitySession,
  ): Promise<SessionAccumulator> {
    const frames = await this.storage.getSessionFrames(session.id);
    const acc: SessionAccumulator = {
      id: session.id,
      startedAt: session.started_at,
      endedAt: session.ended_at,
      day: session.day,
      frameIds: frames.map((f) => f.id),
      entityWeights: new Map(),
      appWeights: new Map(),
      activeMs: session.active_ms,
      isExisting: true,
    };
    let prevTs: number | null = null;
    for (const f of frames) {
      const ts = Date.parse(f.timestamp);
      const gap = prevTs == null ? null : ts - prevTs;
      const fallback = gap != null && gap <= this.idleThresholdMs
        ? Math.min(gap, this.idleThresholdMs)
        : this.fallbackFrameAttentionMs;
      const attention = f.duration_ms ?? fallback;
      if (f.entity_path && f.entity_kind) {
        const cur = acc.entityWeights.get(f.entity_path);
        if (cur) cur.ms += attention;
        else acc.entityWeights.set(f.entity_path, { kind: f.entity_kind, ms: attention });
      }
      if (f.app) {
        acc.appWeights.set(f.app, (acc.appWeights.get(f.app) ?? 0) + attention);
      }
      prevTs = ts;
    }
    return acc;
  }

  private lastEntityOf(acc: SessionAccumulator): string | null {
    let best: { path: string; ms: number } | null = null;
    for (const [path, v] of acc.entityWeights) {
      if (!best || v.ms > best.ms) best = { path, ms: v.ms };
    }
    return best?.path ?? null;
  }

  private async persist(acc: SessionAccumulator): Promise<void> {
    if (acc.frameIds.length === 0) return;

    // Session-aware entity lifting: if a supporting app (Cursor, Warp,
    // …) has frames here that the per-frame resolver could only park
    // under `apps/<app>` AND the session is dominated by a real
    // non-app entity (project / repo / channel / …), reattribute
    // those orphans into the dominant entity. Updates `acc` in place
    // so the persisted session reflects the lifted state.
    await this.maybeLiftSupportingAppFrames(acc);

    const entityRanking = [...acc.entityWeights.entries()].sort(
      (a, b) => b[1].ms - a[1].ms,
    );
    const primaryEntity = entityRanking[0];
    const primaryApp = [...acc.appWeights.entries()].sort(
      (a, b) => b[1] - a[1],
    )[0];

    const session: ActivitySession = {
      id: acc.id,
      started_at: acc.startedAt,
      ended_at: acc.endedAt,
      day: acc.day,
      duration_ms: Math.max(
        0,
        Date.parse(acc.endedAt) - Date.parse(acc.startedAt),
      ),
      active_ms: acc.activeMs,
      frame_count: acc.frameIds.length,
      primary_entity_path: primaryEntity?.[0] ?? null,
      primary_entity_kind: primaryEntity?.[1].kind ?? null,
      primary_app: primaryApp?.[0] ?? null,
      entities: entityRanking.map(([path]) => path),
    };

    await this.storage.upsertSession(session);
    await this.storage.assignFramesToSession(acc.frameIds, acc.id);

    if (!acc.isExisting && acc.activeMs < this.minActiveMs) {
      this.logger.debug(
        `created trivial session ${acc.id} (${acc.frameIds.length} frames, ${acc.activeMs}ms active)`,
      );
    }
  }

  /**
   * If this session was *primarily* a coding / terminal session AND
   * already contains a project / repo entity that the per-frame
   * resolver was able to identify on its own, lift any supporting-app
   * orphans (e.g. `apps/cursor` frames whose window title was bare
   * `"Cursor"` with no project hint) into that project.
   *
   * Conditions for the lift to fire:
   *   (a) The session's primary app is a known code editor or
   *       terminal (LIFT_TRIGGER_APPS) — the user was mostly coding.
   *   (b) >= 1 supporting-app orphan exists in the session
   *       (otherwise there's nothing to move).
   *   (c) The session contains at least one project / repo entity
   *       (otherwise we have no informed guess about what the orphans
   *       belong to — leaving them on `apps/cursor` is honest).
   *   (d) The dominant project / repo passes a small absolute floor on
   *       attention (LIFT_MIN_TARGET_MS), so a 5-second tab into a
   *       project doesn't absorb an hour of unrelated editor work.
   *
   * No-op when any of these conditions fails — the resolver-supplied
   * `apps/<editor>` page remains the home for that work.
   */
  private async maybeLiftSupportingAppFrames(
    acc: SessionAccumulator,
  ): Promise<void> {
    // (a) primary app must be a code editor or terminal
    let primaryApp: string | null = null;
    let primaryAppMs = -1;
    for (const [app, ms] of acc.appWeights) {
      if (ms > primaryAppMs) {
        primaryAppMs = ms;
        primaryApp = app;
      }
    }
    if (!primaryApp || !LIFT_TRIGGER_APPS.has(primaryApp)) return;

    // (b) + (c) + (d) — find supporting orphans + dominant project / repo
    let target: { path: string; kind: EntityKind; ms: number } | null = null;
    const supportingOrphans: Array<{ path: string; ms: number }> = [];
    for (const [path, info] of acc.entityWeights) {
      if (LIFT_TARGET_KINDS.has(info.kind)) {
        if (!target || info.ms > target.ms) {
          target = { path, kind: info.kind, ms: info.ms };
        }
      } else if (info.kind === 'app' && isSupportingAppEntity(path)) {
        supportingOrphans.push({ path, ms: info.ms });
      }
    }
    if (!target || supportingOrphans.length === 0) return;
    if (target.ms < LIFT_MIN_TARGET_MS) return;

    // Resolve a stable title for the target. Use what we already have
    // in the entities table when possible — it preserves the
    // resolver-supplied human-readable form (e.g. "Cofounderos" for
    // `projects/cofounderos`). If the entity row doesn't exist yet
    // (brand-new session), fall back to a path-derived title.
    const existing = await this.storage.getEntity(target.path);
    const title = existing?.title ?? deriveFallbackTitle(target.path);

    const fromAppPaths = supportingOrphans.map((o) => o.path);
    const result = await this.storage.reattributeFrames({
      frameIds: acc.frameIds,
      fromAppPaths,
      target: { path: target.path, kind: target.kind, title },
    });
    if (result.moved === 0) return;

    // Reflect the lift in the in-memory accumulator so the session row
    // we're about to persist gets the correct primary_entity_path.
    let liftedMs = 0;
    for (const orphan of supportingOrphans) {
      liftedMs += orphan.ms;
      acc.entityWeights.delete(orphan.path);
    }
    const cur = acc.entityWeights.get(target.path);
    if (cur) {
      cur.ms += liftedMs;
    } else {
      acc.entityWeights.set(target.path, { kind: target.kind, ms: liftedMs });
    }

    this.logger.info(
      `lifted ${result.moved} frame(s) from ${fromAppPaths.join(', ')} → ${target.path} ` +
        `(session ${acc.id}, ${(liftedMs / 1000).toFixed(1)}s of attention)`,
    );
  }
}

/**
 * Derive a humane title from an entity path when nothing better is
 * available. Mirrors the storage adapter's pathToTitle helper but
 * lives here so the SessionBuilder doesn't have to import storage
 * internals.
 */
function deriveFallbackTitle(p: string): string {
  const last = p.split('/').pop() ?? p;
  return (
    last
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim() || p
  );
}
