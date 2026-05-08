import type {
  IStorage,
  RawEvent,
  Frame,
  Logger,
} from '@cofounderos/interfaces';
import { dayKey } from '@cofounderos/core';
import { redactPii } from './pii.js';

/**
 * FrameBuilder — turns raw events into searchable `Frame` rows.
 *
 * A frame is the atomic retrieval unit: one moment in time joining a
 * screenshot (when present) with the surrounding window/url metadata.
 * Two construction rules:
 *
 *   1. Every `screenshot` event becomes a frame, augmented with any
 *      `window_focus` / `window_blur` / `url_change` from the same session
 *      within ±400ms.
 *
 *   2. `window_focus` / `url_change` events that have no nearby screenshot
 *      become a "text-only" frame — important when capture is excluded
 *      from a window (no screenshot) but we still want to know it was
 *      visited.
 *
 * Raw events are immutable; the builder marks them via `storage.markFramed`
 * so subsequent passes are incremental. A `--full-reindex` clears those
 * marks (handled by the orchestrator) so frames can be rebuilt at will.
 */

const FRAME_PAIR_WINDOW_MS = 400;
/** Drop frames whose only signal is an unknown app — they're capture failures. */
const DROP_UNKNOWN_FRAMES = true;
/** Drop pure focus flickers shorter than this when no screenshot accompanies. */
const MIN_TEXT_ONLY_GAP_MS = 1500;

const FRAMABLE_TYPES = new Set([
  'screenshot',
  'window_focus',
  'window_blur',
  'url_change',
  'audio_transcript',
]);

export interface FrameBuilderResult {
  framesCreated: number;
  eventsProcessed: number;
  eventsDropped: number;
}

export interface FrameBuilderOptions {
  /** Per-tick batch size. Default 500. */
  batchSize?: number;
  /** Sensitive keywords used to redact AX text. Mirror of OCR worker config. */
  sensitiveKeywords?: string[];
}

export class FrameBuilder {
  private readonly logger: Logger;
  private readonly batchSize: number;
  private readonly sensitiveKeywords: string[];

  constructor(
    private readonly storage: IStorage,
    logger: Logger,
    opts: FrameBuilderOptions = {},
  ) {
    this.logger = logger.child('frame-builder');
    this.batchSize = opts.batchSize ?? 500;
    this.sensitiveKeywords = opts.sensitiveKeywords ?? [];
  }

  /**
   * Run a single pass: fetch unframed events, materialise frames, mark
   * the raw events as framed. Returns counters for observability.
   */
  async tick(): Promise<FrameBuilderResult> {
    const events = await this.storage.readEvents({
      unframed_only: true,
      limit: this.batchSize,
    });
    if (events.length === 0) {
      return { framesCreated: 0, eventsProcessed: 0, eventsDropped: 0 };
    }

    const candidates = events.filter((e) => FRAMABLE_TYPES.has(e.type));
    const nonFramable = events.length - candidates.length;

    candidates.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    const consumedEventIds = new Set<string>();
    const frames: Frame[] = [];

    // Pass 1 — anchor on screenshots, attach proximate metadata events.
    // candidates is sorted by timestamp; use binary search to find the
    // ±FRAME_PAIR_WINDOW_MS window instead of scanning all candidates.
    const screenshots = candidates.filter((e) => e.type === 'screenshot');
    const candidateMs = candidates.map((e) => Date.parse(e.timestamp));
    for (const shot of screenshots) {
      const shotMs = Date.parse(shot.timestamp);
      const lo = shotMs - FRAME_PAIR_WINDOW_MS;
      const hi = shotMs + FRAME_PAIR_WINDOW_MS;
      const start = lowerBound(candidateMs, lo);
      const related: RawEvent[] = [];
      for (let i = start; i < candidates.length && candidateMs[i]! <= hi; i++) {
        const e = candidates[i]!;
        if (consumedEventIds.has(e.id)) continue;
        if (e.id === shot.id) continue;
        if (e.session_id !== shot.session_id) continue;
        if (e.type === 'screenshot') continue;
        related.push(e);
      }
      const frame = buildFrame(shot, related, this.sensitiveKeywords);
      if (DROP_UNKNOWN_FRAMES && isUnknown(frame)) continue;
      frames.push(frame);
      consumedEventIds.add(shot.id);
      for (const r of related) consumedEventIds.add(r.id);
    }

    // Pass 2 — orphan focus/url/audio events become text-only frames. Group
    // consecutive same-(app,url,title) events so a tab switch + immediate
    // focus event don't produce two adjacent identical frames.
    const orphans = candidates
      .filter((e) => !consumedEventIds.has(e.id))
      .filter((e) => e.type === 'window_focus' || e.type === 'url_change' || e.type === 'audio_transcript');

    let group: RawEvent[] = [];
    const flushGroup = (): void => {
      if (group.length === 0) return;
      const head = group[0]!;
      const tail = group[group.length - 1]!;
      const gap = Date.parse(tail.timestamp) - Date.parse(head.timestamp);
      // Ignore brief, contentless flickers from rapid window switching.
      if (group.length === 1 && gap === 0 && isUnknownEvent(head)) {
        for (const e of group) consumedEventIds.add(e.id);
        group = [];
        return;
      }
      const frame = buildTextOnlyFrame(group);
      if (!(DROP_UNKNOWN_FRAMES && isUnknown(frame))) {
        // Suppress text-only frames that vanished within a flicker window.
        if (gap >= MIN_TEXT_ONLY_GAP_MS || group.length > 1 || frame.url || frame.text_source === 'audio') {
          frames.push(frame);
        }
      }
      for (const e of group) consumedEventIds.add(e.id);
      group = [];
    };

    for (const ev of orphans) {
      const last = group[group.length - 1];
      const sameTarget =
        last &&
        last.app === ev.app &&
        last.window_title === ev.window_title &&
        last.url === ev.url;
      if (sameTarget) {
        group.push(ev);
      } else {
        flushGroup();
        group.push(ev);
      }
    }
    flushGroup();

    // Window_blur events provide duration; attach to the most recent frame
    // in the same session if it doesn't already have one.
    const blurs = candidates.filter((e) => e.type === 'window_blur');
    for (const blur of blurs) {
      if (consumedEventIds.has(blur.id)) continue;
      const blurMs = Date.parse(blur.timestamp);
      // Find the most recent frame from the same app/session before this blur.
      let best: Frame | null = null;
      let bestDt = Infinity;
      for (const f of frames) {
        if (f.session_id !== blur.session_id) continue;
        if (f.app !== blur.app) continue;
        const dt = blurMs - Date.parse(f.timestamp);
        if (dt < 0 || dt > 60_000) continue;
        if (dt < bestDt) {
          best = f;
          bestDt = dt;
        }
      }
      if (best && best.duration_ms == null && blur.duration_ms != null) {
        best.duration_ms = blur.duration_ms;
        best.source_event_ids.push(blur.id);
      }
      consumedEventIds.add(blur.id);
    }

    // Persist.
    for (const frame of frames) {
      await this.storage.upsertFrame(frame);
    }
    // Mark every framable event we examined — including dropped ones —
    // so we don't reconsider them on the next pass. Non-framable types
    // (idle/app_launch/etc.) are also marked so they fall out of the
    // unframed queue forever.
    const allMarked = events.map((e) => e.id);
    await this.storage.markFramed(allMarked);

    const dropped = candidates.length - consumedEventIds.size;
    if (frames.length > 0 || dropped > 0) {
      this.logger.debug(
        `built ${frames.length} frames from ${candidates.length} events ` +
          `(${dropped} dropped, ${nonFramable} non-framable bypassed)`,
      );
    }
    return {
      framesCreated: frames.length,
      eventsProcessed: events.length,
      eventsDropped: dropped + nonFramable,
    };
  }

  /** Drain the unframed queue. Used by `--full-reindex`. */
  async drain(): Promise<FrameBuilderResult> {
    const totals: FrameBuilderResult = {
      framesCreated: 0,
      eventsProcessed: 0,
      eventsDropped: 0,
    };
    for (let i = 0; i < 10_000; i++) {
      const r = await this.tick();
      totals.framesCreated += r.framesCreated;
      totals.eventsProcessed += r.eventsProcessed;
      totals.eventsDropped += r.eventsDropped;
      if (r.eventsProcessed === 0) break;
      if (r.eventsProcessed < this.batchSize) break;
    }
    return totals;
  }
}

function buildFrame(
  anchor: RawEvent,
  related: RawEvent[],
  sensitiveKeywords: string[],
): Frame {
  // Prefer non-null url / window_title from related events when the
  // screenshot itself was missing them (common: screenshot fires on
  // perceptual content change without a fresh focus event).
  const url = anchor.url ?? firstNonNull(related, (e) => e.url);
  const windowTitle =
    anchor.window_title || firstNonNull(related, (e) => e.window_title) || '';
  const meta = normaliseEventMetadata(anchor.metadata ?? {});
  const sourceEventIds = [anchor.id, ...related.map((e) => e.id)];

  // Capture-time AX text wins over later OCR. We redact PII here exactly
  // like the OCR worker does — same scrub, same keyword list — so the
  // FTS index is never poisoned by raw secrets regardless of which path
  // produced the text.
  //
  // When the native helper has run Apple Vision OCR at capture time
  // (`metadata.vision_text`), we treat it the same way the Tesseract
  // worker would have written its result: merge with AX text via the
  // same line-dedupe rule, mark `text_source` accordingly, and skip
  // the Tesseract worker entirely (it only picks frames whose
  // `text_source` is null).
  let text: string | null = null;
  let textSource: Frame['text_source'] = null;
  const axText = typeof meta.ax_text === 'string' && meta.ax_text.length >= 8
    ? redactPii(meta.ax_text, sensitiveKeywords)
    : null;
  const visionText = typeof meta.vision_text === 'string' && meta.vision_text.length >= 8
    ? redactPii(meta.vision_text, sensitiveKeywords)
    : null;
  if (visionText && axText) {
    text = mergeFrameVisualText(visionText, axText);
    textSource = 'ocr_accessibility';
  } else if (visionText) {
    text = visionText;
    textSource = 'ocr';
  } else if (axText) {
    text = axText;
    textSource = 'accessibility';
  }

  return {
    id: `frm_${anchor.id.slice(4)}`,
    timestamp: anchor.timestamp,
    day: dayKey(new Date(anchor.timestamp)),
    monitor: anchor.screen_index ?? 0,
    app: anchor.app ?? '',
    app_bundle_id: anchor.app_bundle_id ?? '',
    window_title: windowTitle,
    url,
    text,
    text_source: textSource,
    asset_path: anchor.asset_path,
    perceptual_hash: typeof meta.perceptual_hash === 'string'
      ? (meta.perceptual_hash as string)
      : null,
    trigger: typeof meta.trigger === 'string' ? (meta.trigger as string) : 'screenshot',
    session_id: anchor.session_id,
    duration_ms: null,
    entity_path: null,
    entity_kind: null,
    activity_session_id: null,
    meeting_id: null,
    source_event_ids: sourceEventIds,
  };
}

function buildTextOnlyFrame(group: RawEvent[]): Frame {
  // The first event sets the timestamp; later events fill in late-arriving
  // url / window_title metadata.
  const head = group[0]!;
  const url = firstNonNull(group, (e) => e.url);
  const windowTitle = firstNonNull(group, (e) => e.window_title) ?? '';
  const audioText = group
    .filter((e) => e.type === 'audio_transcript' && e.content)
    .map((e) => e.content)
    .join('\n\n')
    .trim();
  const isAudio = audioText.length > 0;
  return {
    id: `frm_${head.id.slice(4)}`,
    timestamp: head.timestamp,
    day: dayKey(new Date(head.timestamp)),
    monitor: head.screen_index ?? 0,
    app: head.app ?? '',
    app_bundle_id: head.app_bundle_id ?? '',
    window_title: windowTitle,
    url,
    text: isAudio ? audioText : null,
    text_source: isAudio ? 'audio' : 'none',
    asset_path: null,
    perceptual_hash: null,
    trigger: head.type === 'audio_transcript'
      ? 'audio'
      : head.type === 'url_change'
        ? 'url'
        : 'focus',
    session_id: head.session_id,
    duration_ms: null,
    entity_path: null,
    entity_kind: null,
    activity_session_id: null,
    meeting_id: null,
    source_event_ids: group.map((e) => e.id),
  };
}

/**
 * Line-level dedupe across two visual-text sources, exactly mirroring
 * `mergeVisualText` in ocr-worker.ts. Used when the native helper
 * supplies both Vision OCR and Accessibility text at capture time —
 * we merge here so the Tesseract worker doesn't have to fire later.
 */
function mergeFrameVisualText(ocrText: string, accessibilityText: string): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const block of [ocrText, accessibilityText]) {
    for (const rawLine of block.split(/\r?\n/)) {
      const line = rawLine.replace(/\s+/g, ' ').trim();
      if (!line) continue;
      const key = line.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(line);
    }
  }
  return lines.join('\n').trim();
}

function normaliseEventMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const nested = metadata.metadata;
  if (!isRecord(nested)) return metadata;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (key !== 'metadata') out[key] = value;
  }
  return { ...out, ...nested };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function firstNonNull<T, R>(arr: T[], pick: (t: T) => R | null | undefined): R | null {
  for (const item of arr) {
    const v = pick(item);
    if (v != null) return v;
  }
  return null;
}

function isUnknown(frame: Frame): boolean {
  return (
    (frame.app === 'unknown' || !frame.app) &&
    (frame.window_title === 'unknown' || !frame.window_title) &&
    !frame.url
  );
}

function isUnknownEvent(e: RawEvent): boolean {
  return (
    (e.app === 'unknown' || !e.app) &&
    (e.window_title === 'unknown' || !e.window_title) &&
    !e.url
  );
}

/** Binary search: index of first element >= target in a sorted numeric array. */
function lowerBound(arr: number[], target: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
