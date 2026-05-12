import type { ActivitySession, Frame } from '@cofounderos/interfaces';

/**
 * One turn of an AI chat conversation. The harness accepts the user's
 * latest message plus the prior history (so the LLM can follow up on
 * the previous answer) and emits a stream of typed events back to the
 * caller.
 *
 * The history mirrors what's stored locally in the renderer's
 * `chat-store` — minus the transient `status` field.
 */
export interface ChatTurnHistoryItem {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatTurnInput {
  /**
   * Stable id for this turn — usually the assistant message id created
   * by the renderer. Used to tag every emitted event so the renderer
   * can route them to the right bubble, and to address cancellations.
   */
  turnId: string;
  conversationId: string;
  message: string;
  history: ChatTurnHistoryItem[];
}

/**
 * Coarse classification used by the routing tree. `general` is the
 * fallback for queries that don't map cleanly to one of the documented
 * intents — those still get an LLM reply, just without targeted tool
 * calls.
 */
export type ChatIntent =
  | 'day_overview'
  | 'calendar_check'
  | 'open_loops'
  | 'recall_preference'
  | 'recall_event'
  | 'project_status'
  | 'people_context'
  | 'time_audit'
  | 'topic_deep_dive'
  | 'general';

/** Time anchor for the question — defaults to "today" if none specified. */
export interface DateAnchor {
  /** YYYY-MM-DD in the user's local timezone. */
  day: string;
  /** Human label echoed back to the model: "today", "yesterday", "May 5". */
  label: string;
  /** UTC ISO bounds covering this local-date day, for storage queries. */
  fromIso: string;
  toIso: string;
}

/**
 * Compact, model-friendly snapshots of tool results. Kept intentionally
 * smaller than the raw IStorage payloads so we don't blow the local
 * model's context window. Each tool returns one of these.
 */
export interface CompactSession {
  id: string;
  started_at: string;
  ended_at: string;
  active_min: number;
  primary_entity: string | null;
  primary_app: string | null;
  frames: number;
}

export interface CompactFrame {
  id: string;
  timestamp: string;
  app: string;
  window_title: string;
  url: string | null;
  excerpt: string | null;
  entity_path: string | null;
  asset_path: string | null;
  /**
   * True when the OCR excerpt was too short / symbol-heavy / chrome-y
   * to trust verbatim. Set by the noise filter; the answer-side prompt
   * never quotes garbled excerpts and the harness will try to verify
   * via `get_frame_context` when it can.
   */
  garbled?: boolean;
}

export interface DayActivitySummaryResult {
  day: string;
  totals: { active_min: number; sessions: number; frames: number };
  top_apps: Array<{ app: string; minutes: number; frames: number }>;
  top_entities: Array<{ path: string; minutes: number; frames: number }>;
  sessions: CompactSession[];
  calendar_candidates: CompactFrame[];
  open_loop_candidates: CompactFrame[];
}

export interface CalendarCheckResult {
  day: string;
  candidates: CompactFrame[];
}

export interface OpenLoopsResult {
  day: string;
  candidates: CompactFrame[];
}

export interface SearchResultBlock {
  query: string;
  matches: CompactFrame[];
}

export interface IndexSearchResultBlock {
  query: string;
  matches: Array<{
    path: string;
    title: string;
    excerpt: string;
    lastUpdated: string;
    sourceEventCount: number;
    score: number;
  }>;
}

export interface FrameContextResult {
  frameId: string;
  before: CompactFrame[];
  anchor: CompactFrame;
  after: CompactFrame[];
}

export interface SessionDetailResult {
  session: CompactSession;
  frames: CompactFrame[];
}

export interface EntitySummaryResult {
  path: string;
  title: string;
  kind: string;
  totalFocusedMin: number;
  frameCount: number;
  recentFrames: CompactFrame[];
  neighbours: Array<{ path: string; title: string; kind: string; sharedSessions: number }>;
  timeline: Array<{ bucket: string; minutes: number; frames: number }>;
}

export interface EntityListResult {
  query: string;
  entities: Array<{ path: string; title: string; kind: string; lastSeen: string; frames: number }>;
}

export interface PeopleSynthesisResult {
  query: string;
  brief: string;
  usedVision: boolean;
  imageCount: number;
}

/**
 * Discriminated tagged-union of every event the harness can emit
 * during a turn. The renderer renders each event differently:
 *   - `phase`     → label inside the "Reasoning" disclosure
 *   - `tool-call` → "Calling X…" line in reasoning
 *   - `tool-result` → terse "found N items" line in reasoning
 *   - `reasoning`  → freeform reasoning text from the planner
 *   - `content`    → token delta to append to the visible answer
 *   - `done`       → marks the assistant message complete
 *   - `error`      → terminal error, message becomes red
 */
export type ChatStreamEvent =
  | { kind: 'phase'; turnId: string; phase: 'classify' | 'plan' | 'execute' | 'compose' }
  | { kind: 'reasoning'; turnId: string; text: string }
  | { kind: 'intent'; turnId: string; intent: ChatIntent; anchor: DateAnchor }
  | {
      kind: 'tool-call';
      turnId: string;
      tool: string;
      args: Record<string, unknown>;
      callId: string;
    }
  | {
      kind: 'tool-result';
      turnId: string;
      callId: string;
      tool: string;
      summary: string;
    }
  | { kind: 'content'; turnId: string; delta: string }
  | { kind: 'done'; turnId: string }
  | { kind: 'error'; turnId: string; message: string };

export type ChatStreamHandler = (event: ChatStreamEvent) => void;

// Internal-only: the raw collected tool-result payloads, indexed by
// callId, fed into the final-answer prompt builder. Not emitted on the
// wire — the renderer never sees this.
export interface CollectedToolResults {
  day_overview?: DayActivitySummaryResult;
  calendar_check?: CalendarCheckResult;
  open_loops?: OpenLoopsResult;
  searches: SearchResultBlock[];
  index_searches: IndexSearchResultBlock[];
  frame_contexts: FrameContextResult[];
  session_details: SessionDetailResult[];
  entity_summaries: EntitySummaryResult[];
  entity_lookups: EntityListResult[];
  people_synthesis?: PeopleSynthesisResult;
  /** Free-form notes the planner wants to feed the model (e.g. "no calendar frames found today"). */
  notes: string[];
}

/** Convenience aliases re-exported so callers don't reach into @cofounderos/interfaces. */
export type { ActivitySession, Frame };
