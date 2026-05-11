import type {
  IStorage,
  Frame,
  Logger,
  Meeting,
  MeetingPlatform,
  MeetingTurn,
  MeetingTurnSource,
} from '@cofounderos/interfaces';
import { createHash } from 'node:crypto';

/**
 * MeetingBuilder — turns the chronological stream of meeting-kind frames
 * into `Meeting` rows fused with overlapping audio_transcript frames.
 *
 * Definition: a meeting is a maximal time-contiguous run of frames with
 * the same `entity_path` (kind=meeting) whose adjacent frames are no
 * more than `meetingIdleMs` apart. When a run closes, the builder also
 * pulls in every `audio_transcript` frame whose timestamp falls inside
 * `[started_at, ended_at + audioGraceMs]` — that's how the audio side
 * of the fusion is materialised.
 *
 * Why a separate concept from ActivitySession:
 *  - Two meetings inside the same activity session must produce two
 *    separate summaries.
 *  - A user mostly listening to a Zoom while reading docs would not
 *    have Zoom as their session's primary entity, but the meeting is
 *    still a real thing to summarise.
 *
 * The worker is incremental: it pulls frames where
 * `entity_kind='meeting' AND meeting_id IS NULL`, ordered ASC. For each
 * pending meeting frame, it either extends an existing open meeting
 * (same entity_path AND last frame within `meetingIdleMs`) or opens a
 * new one. Audio attachment runs at close time so a long audio chunk
 * arriving slightly late still finds its meeting.
 *
 * On `--full-reindex`, the orchestrator calls
 * `storage.clearAllMeetings()` and then drains this worker, which
 * regroups every meeting frame from scratch using the current config.
 */

export interface MeetingBuilderOptions {
  /** Gap above this (ms) closes the current meeting. Default 90s. */
  meetingIdleMs?: number;
  /** Below this duration (ms) the meeting is flagged short and skipped for summary. Default 3 min. */
  minDurationMs?: number;
  /** Audio frames whose timestamp falls within `ended_at + audioGraceMs` are attached. Default 60s. */
  audioGraceMs?: number;
  /** Pending meeting frames per tick. Default 1000 — meetings are cheap to build. */
  batchSize?: number;
}

export interface MeetingBuilderResult {
  framesProcessed: number;
  meetingsCreated: number;
  meetingsExtended: number;
  audioFramesAttached: number;
  turnsBuilt: number;
}

interface MeetingAccumulator {
  id: string;
  entityPath: string;
  startedAt: string;
  endedAt: string;
  day: string;
  /** Screenshot/meeting frames in chronological order. */
  screenFrames: Frame[];
  titleHint?: string | null;
  platformHint?: MeetingPlatform | null;
  isExisting: boolean;
}

interface RecordingContextMeta {
  confidence: number;
  frame_id: string | null;
  platform: MeetingPlatform | null;
  title: string | null;
  meeting_url: string | null;
  entity_path: string | null;
  entity_kind: string | null;
}

interface ScheduledMeetingWindow {
  startedAt: string;
  endedAt: string;
  title: string | null;
  sourceFrameId: string | null;
}

const METADATA_PLATFORM_HINTS: Array<{ test: (f: Frame) => boolean; platform: MeetingPlatform }> = [
  { test: (f) => /\bzoom\b/i.test(f.app) || /zoom\.us/i.test(meetingMetadataHaystack(f)), platform: 'zoom' },
  { test: (f) => /google meet/i.test(f.app) || /meet\.google\.com/i.test(meetingMetadataHaystack(f)), platform: 'meet' },
  { test: (f) => /microsoft teams/i.test(f.app) || /teams\.microsoft\.com/i.test(meetingMetadataHaystack(f)), platform: 'teams' },
  { test: (f) => /webex/i.test(f.app) || /webex\.com/i.test(meetingMetadataHaystack(f)), platform: 'webex' },
  { test: (f) => /whereby/i.test(f.app) || /whereby\.com/i.test(meetingMetadataHaystack(f)), platform: 'whereby' },
  { test: (f) => /around/i.test(f.app) || /around\.co/i.test(meetingMetadataHaystack(f)), platform: 'around' },
];

const TEXT_PLATFORM_HINTS: Array<{ test: (f: Frame) => boolean; platform: MeetingPlatform }> = [
  { test: (f) => /(?:^|\n)[\s•*·-]*(?:google\s+)?meet\s*[-–—]/i.test(f.text ?? '') || /\bmeet\.google\.com\/(?!landing\b)[a-z]{3}-[a-z]{4}-[a-z]{3}\b/i.test(f.text ?? ''), platform: 'meet' },
  { test: (f) => /(?:^|\n)[\s•*·-]*zoom(?:\s+meeting)?\s*[-–—]/i.test(f.text ?? '') || /\bzoom\.us\/(?:j|my|wc)\//i.test(f.text ?? ''), platform: 'zoom' },
  { test: (f) => /(?:^|\n)[\s•*·-]*(?:microsoft\s+)?teams\s*[-–—]/i.test(f.text ?? '') || /\bteams\.microsoft\.com\/(?:l\/meetup-join|_\#\/meetup)\b/i.test(f.text ?? ''), platform: 'teams' },
  { test: (f) => /\bwebex\.com\b/i.test(f.text ?? ''), platform: 'webex' },
  { test: (f) => /\bwhereby\.com\b/i.test(f.text ?? ''), platform: 'whereby' },
  { test: (f) => /\baround\.co\b/i.test(f.text ?? ''), platform: 'around' },
];

function inferPlatform(frames: Frame[]): MeetingPlatform {
  for (const hints of [METADATA_PLATFORM_HINTS, TEXT_PLATFORM_HINTS]) {
    for (const f of frames) {
      for (const hint of hints) {
        if (hint.test(f)) return hint.platform;
      }
    }
  }
  return 'other';
}

function meetingMetadataHaystack(frame: Frame): string {
  return [
    frame.app,
    frame.window_title,
    frame.url,
  ].filter(Boolean).join('\n');
}

// Patterns stripped from window titles to find the meeting topic.
// Order matters: more specific patterns first.
const TITLE_STRIP_RE = [
  // "Topic - Zoom Meeting", "Topic | Zoom", "Topic – Zoom"
  /\s*[-|–—]\s*(zoom\s*meeting|zoom|google\s*meet|meet|microsoft\s*teams|teams|webex|whereby|around)\s*$/i,
  // "Zoom Meeting - Topic", "Zoom - Topic"
  /^(zoom\s*meeting|zoom|google\s*meet|meet|microsoft\s*teams|teams|webex|whereby|around)\s*[-|–—]\s*/i,
  // " - Video call", " - Google Meet"
  /\s*[-|–—]\s*(video\s*call|audio\s*call|screen\s*share)\s*$/i,
];

// Titles that are entirely generic with no meeting topic content.
const GENERIC_TITLE_RE = /^(zoom(\s+(meeting|workplace|us))?(\s+40\s+minutes)?|google\s*meet|meet|microsoft\s*teams|teams|webex|whereby|around|video\s*call|audio\s*call|meeting|untitled\s*meeting|you have ended the meeting|google chrome|chrome|profile)$/i;
const TITLE_NOISE_SEGMENT_RE = /^(camera and microphone recording|microphone recording|audio playing|screen share|presenting|high memory usage\b.*|\d+(?:\.\d+)?\s*(?:kb|mb|gb)|google chrome|chrome|sagiv \(your chrome\)|profile)$/i;

function extractTopicFromTitle(raw: string): string | null {
  let s = raw.replace(/\s+/g, ' ').trim();
  for (const re of TITLE_STRIP_RE) {
    s = s.replace(re, '').trim();
  }
  const parts = s
    .split(/\s+[-–—]\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !TITLE_NOISE_SEGMENT_RE.test(part));
  s = parts.length > 0 ? parts.join(' - ') : '';
  if (!s || s.length < 3 || GENERIC_TITLE_RE.test(s)) return null;
  return s;
}

/**
 * Infer a human-readable meeting title from captured window titles.
 * Picks the most frequently occurring non-generic topic string.
 */
function inferTitle(screens: Frame[]): string | null {
  const freq = new Map<string, number>();
  for (const f of screens) {
    const candidates = [
      f.window_title,
      ...extractMeetingTitleHints(f.text),
    ];
    for (const rawCandidate of candidates) {
      const raw = (rawCandidate ?? '').replace(/\s+/g, ' ').trim();
      if (!raw) continue;
      const topic = extractTopicFromTitle(raw);
      if (!topic) continue;
      freq.set(topic, (freq.get(topic) ?? 0) + 1);
    }
  }
  if (freq.size === 0) return null;
  // Return the most common topic (ties: first seen wins due to insertion order).
  let best: string | null = null;
  let bestCount = 0;
  for (const [topic, count] of freq) {
    if (count > bestCount) {
      best = topic;
      bestCount = count;
    }
  }
  return best;
}

function extractMeetingTitleHints(text: string | null): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/^[\s•*·-]+/, '').replace(/\s+/g, ' ').trim();
    if (!line) continue;
    if (/^(?:(?:Google\s+)?Meet|Zoom(?:\s+Meeting)?|(?:Microsoft\s+)?Teams|Webex|Whereby|Around)\s*[-–—]\s*.{3,80}$/i.test(line)) {
      out.push(line);
    }
  }
  return out;
}

/**
 * Build a deterministic id for a meeting given its entity_path + start
 * timestamp. We don't reuse newActivitySessionId() because we want
 * meeting ids to be derivable from the (entity_path, start) pair —
 * makes incremental builds idempotent across restarts (a missed
 * `meeting_id` assignment can be retried without producing duplicate
 * rows).
 */
function meetingIdFor(entityPath: string, startedAt: string): string {
  const hash = createHash('sha1')
    .update(entityPath)
    .update('|')
    .update(startedAt)
    .digest('hex')
    .slice(0, 12);
  const ts = new Date(startedAt).getTime().toString(36);
  return `mtg_${ts}_${hash}`;
}

export class MeetingBuilder {
  private readonly logger: Logger;
  private readonly meetingIdleMs: number;
  private readonly minDurationMs: number;
  private readonly audioGraceMs: number;
  private readonly batchSize: number;

  constructor(
    private readonly storage: IStorage,
    logger: Logger,
    opts: MeetingBuilderOptions = {},
  ) {
    this.logger = logger.child('meeting-builder');
    this.meetingIdleMs = opts.meetingIdleMs ?? 5 * 60_000;
    this.minDurationMs = opts.minDurationMs ?? 3 * 60_000;
    this.audioGraceMs = opts.audioGraceMs ?? 60_000;
    this.batchSize = opts.batchSize ?? 1000;
  }

  async tick(): Promise<MeetingBuilderResult> {
    const empty: MeetingBuilderResult = {
      framesProcessed: 0,
      meetingsCreated: 0,
      meetingsExtended: 0,
      audioFramesAttached: 0,
      turnsBuilt: 0,
    };
    const pending = await this.storage.listFramesNeedingMeetingAssignment(this.batchSize);

    // Open accumulators keyed by entity_path. We may see two interleaving
    // meeting entities in a single batch (rare — a user has Zoom and
    // Meet both open at once); keeping per-entity state lets us extend
    // each independently.
    const open = new Map<string, MeetingAccumulator>();
    let meetingsCreated = 0;
    let meetingsExtended = 0;

    const flush = async (acc: MeetingAccumulator): Promise<void> => {
      const result = await this.persist(acc);
      empty.audioFramesAttached += result.audioFramesAttached;
      empty.turnsBuilt += result.turnsBuilt;
    };

    for (const frame of pending) {
      const entityPath = frame.entity_path;
      if (!entityPath) continue;
      const ts = Date.parse(frame.timestamp);
      let acc = open.get(entityPath);

      // Close any other entity's accumulator if the new frame is past
      // its idle threshold — we drain in time order, so a frame whose
      // timestamp is well past another entity's end means that meeting
      // is over.
      for (const [otherPath, otherAcc] of open) {
        if (otherPath === entityPath) continue;
        if (ts - Date.parse(otherAcc.endedAt) > this.meetingIdleMs) {
          await flush(otherAcc);
          open.delete(otherPath);
        }
      }

      if (acc) {
        const gap = ts - Date.parse(acc.endedAt);
        if (gap > this.meetingIdleMs) {
          // Same entity, but the gap is too big — close + open a new one.
          await flush(acc);
          open.delete(entityPath);
          acc = undefined;
        }
      }

      if (!acc) {
        // Try to extend a previously persisted meeting whose ended_at is
        // within the idle threshold of this frame. Mirrors SessionBuilder's
        // restart-idempotence trick.
        const existing = await this.findExtensibleMeeting(entityPath, frame.timestamp);
        if (existing) {
          acc = {
            id: existing.id,
            entityPath,
            startedAt: existing.started_at,
            endedAt: existing.ended_at,
            day: existing.day,
            screenFrames: await this.storage.getMeetingFrames(existing.id),
            titleHint: existing.title,
            platformHint: existing.platform,
            isExisting: true,
          };
          // Drop already-attached audio frames; we'll re-attach below.
          acc.screenFrames = acc.screenFrames.filter((f) => f.entity_kind === 'meeting');
          meetingsExtended += 1;
        } else {
          acc = {
            id: meetingIdFor(entityPath, frame.timestamp),
            entityPath,
            startedAt: frame.timestamp,
            endedAt: frame.timestamp,
            day: frame.day,
            screenFrames: [],
            titleHint: null,
            platformHint: null,
            isExisting: false,
          };
          meetingsCreated += 1;
        }
        open.set(entityPath, acc);
      }

      acc.screenFrames.push(frame);
      acc.endedAt = frame.timestamp;
    }

    // Flush any still-open accumulators. A meeting whose tail straggles
    // past this batch will be picked up again next tick because its
    // frames still have `meeting_id IS NULL` from the partial flush —
    // but persist() always writes meeting_id back, so subsequent ticks
    // see them as already-assigned and don't double-process.
    for (const acc of open.values()) {
      await flush(acc);
    }

    const contextualAudio = await this.persistContextualAudioMeetings();

    return {
      framesProcessed: pending.length + contextualAudio.audioFramesProcessed,
      meetingsCreated: meetingsCreated + contextualAudio.meetingsCreated,
      meetingsExtended: meetingsExtended + contextualAudio.meetingsExtended,
      audioFramesAttached: empty.audioFramesAttached + contextualAudio.audioFramesAttached,
      turnsBuilt: empty.turnsBuilt + contextualAudio.turnsBuilt,
    };
  }

  async drain(): Promise<MeetingBuilderResult> {
    const total: MeetingBuilderResult = {
      framesProcessed: 0,
      meetingsCreated: 0,
      meetingsExtended: 0,
      audioFramesAttached: 0,
      turnsBuilt: 0,
    };
    for (let i = 0; i < 10_000; i++) {
      const r = await this.tick();
      total.framesProcessed += r.framesProcessed;
      total.meetingsCreated += r.meetingsCreated;
      total.meetingsExtended += r.meetingsExtended;
      total.audioFramesAttached += r.audioFramesAttached;
      total.turnsBuilt += r.turnsBuilt;
      if (r.framesProcessed === 0) break;
      if (r.framesProcessed < this.batchSize) break;
    }
    return total;
  }

  /**
   * Find a previously persisted meeting for `entityPath` whose
   * `ended_at` is within the idle threshold of the next observed
   * frame. Used to extend across worker restarts and across batches.
   */
  private async findExtensibleMeeting(
    entityPath: string,
    nextFrameTs: string,
  ): Promise<Meeting | null> {
    const list = await this.storage.listMeetings({
      // No platform filter — the entity_path uniquely identifies the meeting.
      day: nextFrameTs.slice(0, 10),
      limit: 200,
      order: 'recent',
    });
    const cutoff = Date.parse(nextFrameTs) - this.meetingIdleMs;
    for (const m of list) {
      if (m.entity_path !== entityPath) continue;
      if (Date.parse(m.ended_at) >= cutoff) return m;
    }
    return null;
  }

  private async persistContextualAudioMeetings(): Promise<{
    audioFramesProcessed: number;
    meetingsCreated: number;
    meetingsExtended: number;
    audioFramesAttached: number;
    turnsBuilt: number;
  }> {
    const result = {
      audioFramesProcessed: 0,
      meetingsCreated: 0,
      meetingsExtended: 0,
      audioFramesAttached: 0,
      turnsBuilt: 0,
    };
    const audioFrames = await this.storage.searchFrames({
      textSource: 'audio',
      limit: this.batchSize,
    }).catch(() => []);
    const unassigned = audioFrames
      .filter((f) => !f.meeting_id)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    for (const audio of unassigned) {
      const meta = await this.readAudioMetadata(audio);
      const context = parseRecordingContext(meta?.recording_context);
      if (!context || context.confidence < 45) continue;

      const entityPath = entityPathFromRecordingContext(context, audio.day);
      if (!entityPath) continue;

      const durationMs = audioDurationMs(audio, meta);
      const audioEnd = new Date(Date.parse(audio.timestamp) + Math.max(durationMs, 60_000)).toISOString();
      const existing = await this.findExtensibleMeeting(entityPath, audio.timestamp);
      const contextFrames = await this.findContextFramesForAudio(audio, context, audioEnd);

      const acc: MeetingAccumulator = existing
        ? {
            id: existing.id,
            entityPath,
            startedAt: existing.started_at,
            endedAt: maxIso(existing.ended_at, audioEnd),
            day: existing.day,
            screenFrames: dedupeFrames([
              ...(await this.storage.getMeetingFrames(existing.id)).filter((f) => f.text_source !== 'audio'),
              ...contextFrames,
            ]),
            titleHint: existing.title ?? context.title,
            platformHint: existing.platform !== 'other' ? existing.platform : context.platform,
            isExisting: true,
          }
        : {
            id: meetingIdFor(entityPath, audio.timestamp),
            entityPath,
            startedAt: audio.timestamp,
            endedAt: audioEnd,
            day: audio.day,
            screenFrames: contextFrames,
            titleHint: context.title,
            platformHint: context.platform,
            isExisting: false,
          };

      const persisted = await this.persist(acc);
      result.audioFramesProcessed += 1;
      result.audioFramesAttached += persisted.audioFramesAttached;
      result.turnsBuilt += persisted.turnsBuilt;
      if (existing) result.meetingsExtended += 1;
      else result.meetingsCreated += 1;
    }

    return result;
  }

  private async findContextFramesForAudio(
    audio: Frame,
    context: RecordingContextMeta,
    audioEnd: string,
  ): Promise<Frame[]> {
    const startMs = Date.parse(audio.timestamp);
    const frames = await this.storage.searchFrames({
      from: new Date(startMs - 10 * 60_000).toISOString(),
      to: new Date(Date.parse(audioEnd) + 2 * 60_000).toISOString(),
      limit: 80,
    }).catch(() => []);
    const relevant = frames
      .filter((f) => f.text_source !== 'audio')
      .filter((f) => isContextFrameRelevant(f, context))
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return dedupeFrames(relevant).slice(-16);
  }

  private async persist(
    acc: MeetingAccumulator,
  ): Promise<{ audioFramesAttached: number; turnsBuilt: number }> {
    // Sort screens & build the ordered visual list once (cheap; small N).
    const screens = acc.screenFrames.slice().sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const inferredTitle = acc.titleHint ?? inferTitle(screens);
    const scheduledWindow = await this.findScheduledWindow(acc, screens, inferredTitle);
    const startedAt = scheduledWindow?.startedAt ?? acc.startedAt;
    const endedAt = scheduledWindow
      ? maxIso(scheduledWindow.endedAt, acc.endedAt)
      : acc.endedAt;
    const durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));
    const platform = acc.platformHint ?? inferPlatform(screens);

    // Find audio frames whose timestamp overlaps the meeting window
    // (with a grace tail so a chunk arriving a few seconds after we
    // last saw the meeting window is still pulled in).
    const audioWindowEnd = new Date(Date.parse(endedAt) + this.audioGraceMs).toISOString();
    const audioFrames = await this.storage.listAudioFramesInRange(startedAt, audioWindowEnd);

    if (screens.length === 0 && audioFrames.length === 0) {
      return { audioFramesAttached: 0, turnsBuilt: 0 };
    }

    // Build turns by extracting per-utterance breakdowns from each
    // audio frame's source raw event metadata when present, otherwise
    // fall back to splitting the bulk text proportional to duration.
    const turns: Array<Omit<MeetingTurn, 'id' | 'meeting_id'>> = [];
    let transcriptChars = 0;
    for (const audio of audioFrames) {
      const audioMeta = await this.readAudioMetadata(audio);
      const audioTurns = extractTurnsFromAudioFrame(audio, audioMeta);
      transcriptChars += (audio.text ?? '').length;
      for (const t of audioTurns) {
        turns.push({
          ...t,
          visual_frame_id: pickVisualFrameId(screens, t.t_start),
        });
      }
    }
    turns.sort((a, b) => a.t_start.localeCompare(b.t_start));

    const attendees = collectAttendees(turns);
    const links = collectLinks(audioFrames, screens);

    const meetingFrameIds = [
      ...screens.map((f) => f.id),
      ...audioFrames.map((f) => f.id),
    ];
    const screenshotCount = screens.filter((f) => f.asset_path).length;

    // Content hash drives summary staleness — a re-tick that doesn't
    // change inputs leaves summary_status alone.
    const contentHash = createHash('sha1')
      .update(turns.map((t) => `${t.t_start}|${t.text}`).join('||'))
      .update('||')
      .update(screens.map((f) => `${f.timestamp}|${f.asset_path ?? ''}`).join('||'))
      .digest('hex')
      .slice(0, 16);

    const meeting: Meeting = {
      id: acc.id,
      entity_path: acc.entityPath,
      title: inferredTitle ?? scheduledWindow?.title ?? null,
      platform,
      started_at: startedAt,
      ended_at: endedAt,
      day: acc.day,
      duration_ms: durationMs,
      frame_count: meetingFrameIds.length,
      screenshot_count: screenshotCount,
      audio_chunk_count: audioFrames.length,
      transcript_chars: transcriptChars,
      content_hash: contentHash,
      summary_status: durationMs < this.minDurationMs && audioFrames.length === 0
        ? 'skipped_short'
        : 'pending',
      summary_md: null,
      summary_json: null,
      attendees,
      links,
      failure_reason: null,
      updated_at: new Date().toISOString(),
    };

    await this.storage.upsertMeeting(meeting);
    await this.storage.assignFramesToMeeting(meetingFrameIds, meeting.id);
    if (turns.length > 0) {
      await this.storage.setMeetingTurns(meeting.id, turns);
    }

    if (!acc.isExisting) {
      this.logger.info(
        `meeting ${meeting.id} (${meeting.entity_path}, ${platform}, ${Math.round(durationMs / 60_000)} min, ` +
          `${screens.length} screens, ${audioFrames.length} audio, ${turns.length} turns)`,
      );
    } else {
      this.logger.debug(
        `extended meeting ${meeting.id} → ${screens.length} screens, ${audioFrames.length} audio, ${turns.length} turns`,
      );
    }

    return {
      audioFramesAttached: audioFrames.length,
      turnsBuilt: turns.length,
    };
  }

  /**
   * Best-effort metadata read for an audio_transcript frame. The frame
   * row drops the original RawEvent metadata, so we look up the source
   * event(s) by id and merge their `metadata` blobs. Returns null when
   * no source event is reachable (e.g. the raw event was vacuumed
   * before us — rare; transcripts vacuum slowly because they're small).
   *
   * NB: the local storage adapter currently double-wraps event
   * metadata via `extra_json` (writes `{metadata: {...}}`, reads
   * the whole object back as `metadata`). We flatten that here so
   * upstream consumers see `metadata.turns` rather than
   * `metadata.metadata.turns`.
   */
  private async readAudioMetadata(frame: Frame): Promise<Record<string, unknown> | null> {
    if (!frame.source_event_ids || frame.source_event_ids.length === 0) {
      return null;
    }
    try {
      const events = await this.storage.readEvents({
        ids: frame.source_event_ids,
        types: ['audio_transcript'],
        limit: frame.source_event_ids.length,
      });
      let merged: Record<string, unknown> | null = null;
      for (const ev of events) {
        const m = ev.metadata as Record<string, unknown> | undefined;
        if (!m || typeof m !== 'object') continue;
        const flattened = flattenEventMetadata(m);
        merged = { ...(merged ?? {}), ...flattened };
      }
      return merged;
    } catch {
      return null;
    }
  }

  private async findScheduledWindow(
    acc: MeetingAccumulator,
    screens: Frame[],
    title: string | null,
  ): Promise<ScheduledMeetingWindow | null> {
    const startMs = Date.parse(acc.startedAt);
    const endMs = Date.parse(acc.endedAt);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;

    const frames = await this.storage.searchFrames({
      from: new Date(startMs - 2 * 60 * 60_000).toISOString(),
      to: new Date(Math.max(startMs, endMs) + 2 * 60 * 60_000).toISOString(),
      limit: 300,
    }).catch(() => []);
    const candidates = dedupeFrames([...screens, ...frames])
      .filter((f) => f.text_source !== 'audio')
      .filter((f) => f.text || f.window_title || f.url);

    let best: { window: ScheduledMeetingWindow; score: number } | null = null;
    for (const frame of candidates) {
      for (const window of extractScheduledWindowsFromFrame(frame)) {
        const score = scoreScheduledWindow(window, acc, title);
        if (score <= 0) continue;
        if (!best || score > best.score) {
          best = { window, score };
        }
      }
    }
    return best?.window ?? null;
  }
}

/**
 * Unwrap the storage adapter's nested `metadata.metadata` shape so
 * `extracTurnsFromAudioFrame` can read fields uniformly. Mirrors
 * `normaliseEventMetadata` in runtime.ts.
 */
function flattenEventMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const nested =
    metadata.metadata && typeof metadata.metadata === 'object'
      ? (metadata.metadata as Record<string, unknown>)
      : {};
  const topLevel = Object.fromEntries(
    Object.entries(metadata).filter(([key]) => key !== 'metadata'),
  );
  return { ...nested, ...topLevel };
}

function parseRecordingContext(raw: unknown): RecordingContextMeta | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const confidence = typeof obj.confidence === 'number' ? obj.confidence : 0;
  const platform = isMeetingPlatform(obj.platform) ? obj.platform : null;
  return {
    confidence,
    frame_id: typeof obj.frame_id === 'string' ? obj.frame_id : null,
    platform,
    title: typeof obj.title === 'string' && obj.title.trim() ? obj.title.trim() : null,
    meeting_url: typeof obj.meeting_url === 'string' && obj.meeting_url.trim() ? obj.meeting_url.trim() : null,
    entity_path: typeof obj.entity_path === 'string' && obj.entity_path.trim() ? obj.entity_path.trim() : null,
    entity_kind: typeof obj.entity_kind === 'string' && obj.entity_kind.trim() ? obj.entity_kind.trim() : null,
  };
}

function isMeetingPlatform(value: unknown): value is MeetingPlatform {
  return value === 'zoom' ||
    value === 'meet' ||
    value === 'teams' ||
    value === 'webex' ||
    value === 'whereby' ||
    value === 'around' ||
    value === 'other';
}

function entityPathFromRecordingContext(context: RecordingContextMeta, day: string): string | null {
  if (context.entity_kind === 'meeting' && context.entity_path) return context.entity_path;
  const title = context.title ?? titleFromMeetingUrl(context.meeting_url) ?? context.platform ?? 'meeting';
  const slug = slugifyMeetingTitle(title);
  return slug ? `meetings/${day}-${slug}` : null;
}

function titleFromMeetingUrl(url: string | null): string | null {
  if (!url) return null;
  if (/meet\.google\.com/i.test(url)) return 'Google Meet';
  if (/zoom\.us/i.test(url)) return 'Zoom';
  if (/teams\.microsoft\.com/i.test(url)) return 'Microsoft Teams';
  return null;
}

function slugifyMeetingTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function audioDurationMs(audio: Frame, meta: Record<string, unknown> | null): number {
  if (typeof audio.duration_ms === 'number' && audio.duration_ms > 0) return audio.duration_ms;
  if (typeof meta?.duration_ms === 'number' && meta.duration_ms > 0) return meta.duration_ms;
  return Math.max(60_000, Math.round((audio.text ?? '').length * 80));
}

function maxIso(a: string, b: string): string {
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

function dedupeFrames(frames: Frame[]): Frame[] {
  const seen = new Set<string>();
  const out: Frame[] = [];
  for (const frame of frames) {
    if (seen.has(frame.id)) continue;
    seen.add(frame.id);
    out.push(frame);
  }
  return out;
}

function isContextFrameRelevant(frame: Frame, context: RecordingContextMeta): boolean {
  if (context.frame_id && frame.id === context.frame_id) return true;
  if (frame.entity_kind === 'meeting') return true;
  if (context.entity_path && frame.entity_path === context.entity_path) return true;
  const haystack = [
    frame.app,
    frame.window_title,
    frame.url,
    frame.text,
  ].filter(Boolean).join('\n');
  if (context.meeting_url && haystack.includes(stripProtocol(context.meeting_url))) return true;
  if (context.title && haystack.toLowerCase().includes(context.title.toLowerCase())) return true;
  if (context.platform === 'meet' && /meet\.google\.com|google meet/i.test(haystack)) return true;
  if (context.platform === 'zoom' && /zoom(?:\.us|\s+meeting)?/i.test(haystack)) return true;
  if (context.platform === 'teams' && /teams\.microsoft\.com|microsoft teams/i.test(haystack)) return true;
  return false;
}

function stripProtocol(url: string): string {
  return url.replace(/^https?:\/\//i, '');
}

const SCHEDULED_MEETING_LINE_RE =
  /^\s*(?<title>.+?)\.\s*Starts on (?<startDate>[A-Za-z]+ \d{1,2}, \d{4}) at (?<startTime>\d{1,2}(?::\d{2})?\s*(?:AM|PM)) and ends (?:on (?<endDate>[A-Za-z]+ \d{1,2}, \d{4}) at |at )(?<endTime>\d{1,2}(?::\d{2})?\s*(?:AM|PM))/i;
const SCHEDULED_MEETING_TEXT_RE =
  /(?<title>[A-Za-z0-9][^.\n]{2,120}?)\.\s*Starts on (?<startDate>[A-Za-z]+ \d{1,2}, \d{4}) at (?<startTime>\d{1,2}(?::\d{2})?\s*(?:AM|PM)) and ends (?:on (?<endDate>[A-Za-z]+ \d{1,2}, \d{4}) at |at )(?<endTime>\d{1,2}(?::\d{2})?\s*(?:AM|PM))/gi;

const MONTH_INDEX: Record<string, number> = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
};

function extractScheduledWindowsFromFrame(frame: Frame): ScheduledMeetingWindow[] {
  const text = frame.text;
  if (!text || !/\bStarts on\b/i.test(text) || !/\bends\b/i.test(text)) return [];

  const out: ScheduledMeetingWindow[] = [];
  const seen = new Set<string>();
  const pushMatch = (groups: Record<string, string | undefined>): void => {
    const title = cleanScheduledTitle(groups.title);
    const startDate = groups.startDate;
    const startTime = groups.startTime;
    const endTime = groups.endTime;
    if (!title || !startDate || !startTime || !endTime) return;

    const startedAt = parseLocalDateTime(startDate, startTime);
    const endedAt = parseLocalDateTime(groups.endDate ?? startDate, endTime);
    if (!startedAt || !endedAt) return;
    const endMs = Date.parse(endedAt);
    const startMs = Date.parse(startedAt);
    const normalisedEnd = endMs <= startMs
      ? new Date(endMs + 24 * 60 * 60_000).toISOString()
      : endedAt;
    const key = `${title.toLowerCase()}|${startedAt}|${normalisedEnd}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      title,
      startedAt,
      endedAt: normalisedEnd,
      sourceFrameId: frame.id,
    });
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+/g, ' ').trim();
    const match = line.match(SCHEDULED_MEETING_LINE_RE);
    if (match?.groups) pushMatch(match.groups);
  }

  const flattened = text.replace(/\s+/g, ' ').trim();
  for (const match of flattened.matchAll(SCHEDULED_MEETING_TEXT_RE)) {
    if (match.groups) pushMatch(match.groups);
  }

  return out;
}

function scoreScheduledWindow(
  window: ScheduledMeetingWindow,
  acc: MeetingAccumulator,
  title: string | null,
): number {
  const startMs = Date.parse(window.startedAt);
  const endMs = Date.parse(window.endedAt);
  const observedStartMs = Date.parse(acc.startedAt);
  const observedEndMs = Date.parse(acc.endedAt);
  if (
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs) ||
    !Number.isFinite(observedStartMs) ||
    !Number.isFinite(observedEndMs) ||
    endMs <= startMs
  ) {
    return 0;
  }
  if (!scheduledTitleMatches(window.title, title, acc.entityPath)) return 0;

  const toleranceMs = 15 * 60_000;
  const overlapsObserved =
    startMs <= observedEndMs + toleranceMs &&
    endMs >= observedStartMs - toleranceMs;
  const startsNearObserved = Math.abs(startMs - observedStartMs) <= 45 * 60_000;
  if (!overlapsObserved && !startsNearObserved) return 0;

  let score = 70;
  if (overlapsObserved) score += 40;
  if (startMs <= observedStartMs && endMs >= observedEndMs) score += 20;
  if (window.sourceFrameId) score += 5;
  return score;
}

function scheduledTitleMatches(
  scheduledTitle: string | null,
  inferredTitle: string | null,
  entityPath: string,
): boolean {
  const scheduled = normaliseTitleForMatch(scheduledTitle);
  if (!scheduled) return false;
  const candidates = [
    inferredTitle,
    entityPath.replace(/^meetings\/\d{4}-\d{2}-\d{2}-/, '').replace(/-/g, ' '),
  ]
    .map(normaliseTitleForMatch)
    .filter(Boolean);

  for (const candidate of candidates) {
    if (scheduled === candidate) return true;
    if (scheduled.length >= 8 && candidate.length >= 8) {
      if (scheduled.includes(candidate) || candidate.includes(scheduled)) return true;
    }
  }
  return false;
}

function normaliseTitleForMatch(value: string | null | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function cleanScheduledTitle(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = value
    .replace(/^[\s•*·\-:|,;.]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length < 3 || cleaned.length > 120) return null;
  return cleaned;
}

function parseLocalDateTime(dateLabel: string, timeLabel: string): string | null {
  const date = dateLabel.match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  const time = timeLabel.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (!date || !time) return null;

  const month = MONTH_INDEX[date[1]!.toLowerCase()];
  if (month === undefined) return null;

  let hour = Number(time[1]);
  const minute = Number(time[2] ?? '0');
  const ampm = time[3]!.toLowerCase();
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return null;
  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;

  const parsed = new Date(Number(date[3]), month, Number(date[2]), hour, minute, 0, 0);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * Pull per-utterance turns out of an audio_transcript frame. The
 * AudioTranscriptWorker may write per-cue turn data into the source
 * RawEvent's `metadata.turns` (VTT/SRT cues, whisper word-stamped
 * JSON); when present, those rows are authoritative. Otherwise we
 * fall back to splitting the bulk transcript by sentence and
 * distributing them evenly across the audio chunk's duration — coarse
 * but useful for keeping the alignment sortable.
 */
function extractTurnsFromAudioFrame(
  frame: Frame,
  meta: Record<string, unknown> | null,
): Array<Omit<MeetingTurn, 'id' | 'meeting_id' | 'visual_frame_id'>> {
  const out: Array<Omit<MeetingTurn, 'id' | 'meeting_id' | 'visual_frame_id'>> = [];
  const explicit = Array.isArray(meta?.turns) ? (meta.turns as unknown[]) : null;
  const text = (frame.text ?? '').trim();
  const startMs = Date.parse(frame.timestamp);
  // Transcript turn metadata may carry a chunk_duration_ms when ffprobe
  // succeeded; otherwise we estimate ~ (chars / 12) seconds, which is a
  // reasonable English-prose proxy when nothing better is available.
  const durationMs =
    typeof meta?.duration_ms === 'number' && meta.duration_ms > 0
      ? meta.duration_ms
      : Math.max(2000, Math.round(text.length * 80));

  if (explicit && explicit.length > 0) {
    for (const t of explicit) {
      const turn = parseExplicitTurn(t, startMs, durationMs);
      if (turn) out.push(turn);
    }
    if (out.length > 0) return out;
  }

  if (!text) return out;
  // Split by paragraph (already done by VTT/SRT importer) or sentence
  // boundary as a fallback. Each chunk gets a proportional time slice.
  const sentences = splitIntoSentences(text);
  const slice = durationMs / Math.max(1, sentences.length);
  for (let i = 0; i < sentences.length; i++) {
    const utteranceMs = startMs + Math.round(i * slice);
    const utteranceEndMs = startMs + Math.round((i + 1) * slice);
    out.push({
      t_start: new Date(utteranceMs).toISOString(),
      t_end: new Date(utteranceEndMs).toISOString(),
      speaker: null,
      text: sentences[i]!,
      source: pickFallbackSource(meta),
    });
  }
  return out;
}

function pickFallbackSource(meta: Record<string, unknown> | null): MeetingTurnSource {
  const src = meta?.source;
  if (src === 'whisper' || src === 'import' || src === 'vtt' || src === 'srt') return src;
  return 'whisper';
}

function parseExplicitTurn(
  raw: unknown,
  audioStartMs: number,
  audioDurationMs: number,
): Omit<MeetingTurn, 'id' | 'meeting_id' | 'visual_frame_id'> | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const text = typeof obj.text === 'string' ? obj.text.trim() : '';
  if (!text) return null;
  // Accept either absolute ISO timestamps (`t_start`) or offsets in ms
  // / seconds from the chunk start (`offset_ms`, `start`).
  const t_start = resolveTimestamp(
    obj.t_start ?? obj.start_iso,
    obj.offset_ms ?? obj.start_ms,
    obj.start,
    audioStartMs,
  );
  if (!t_start) return null;
  const t_end =
    resolveTimestamp(
      obj.t_end ?? obj.end_iso,
      obj.end_ms,
      obj.end,
      audioStartMs,
    ) ??
    new Date(
      Date.parse(t_start) + Math.max(2000, Math.min(audioDurationMs, text.length * 80)),
    ).toISOString();
  const speaker =
    typeof obj.speaker === 'string' && obj.speaker.trim()
      ? obj.speaker.trim()
      : null;
  const source: MeetingTurnSource =
    obj.source === 'vtt' || obj.source === 'srt' || obj.source === 'whisper' || obj.source === 'import'
      ? obj.source
      : 'whisper';
  return { t_start, t_end, speaker, text, source };
}

function resolveTimestamp(
  iso: unknown,
  offsetMs: unknown,
  offsetSec: unknown,
  audioStartMs: number,
): string | null {
  if (typeof iso === 'string' && iso.length >= 19) {
    const parsed = Date.parse(iso);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  if (typeof offsetMs === 'number' && Number.isFinite(offsetMs)) {
    return new Date(audioStartMs + offsetMs).toISOString();
  }
  if (typeof offsetSec === 'number' && Number.isFinite(offsetSec)) {
    return new Date(audioStartMs + offsetSec * 1000).toISOString();
  }
  return null;
}

/**
 * Split a chunk of transcript into roughly sentence-shaped utterances.
 * The bulk transcripts are already paragraph-formatted by VTT import,
 * so we first try paragraph boundaries; below that, sentence boundaries.
 */
function splitIntoSentences(text: string): string[] {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length >= 4) return paragraphs;
  // Sentence split: end-of-sentence punctuation followed by whitespace +
  // capital letter (ASCII proxy; OK for the common case).
  const sentences = text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z(])/)
    .map((s) => s.trim())
    .filter(Boolean);
  // Don't fragment too aggressively — collapse to ~30s chunks at 12 chars/sec.
  if (sentences.length >= 12) {
    const merged: string[] = [];
    let cur = '';
    for (const s of sentences) {
      if ((cur + ' ' + s).length > 360) {
        if (cur) merged.push(cur);
        cur = s;
      } else {
        cur = cur ? `${cur} ${s}` : s;
      }
    }
    if (cur) merged.push(cur);
    return merged;
  }
  return sentences.length > 0 ? sentences : [text];
}

/**
 * Pick the screenshot frame on screen at `tsIso`. Last screenshot
 * whose timestamp is <= ts wins; pre-meeting timestamps fall through
 * to the first frame to avoid null alignment for the very first turn.
 */
function pickVisualFrameId(screens: Frame[], tsIso: string): string | null {
  if (screens.length === 0) return null;
  const t = Date.parse(tsIso);
  let chosen: string | null = screens[0]!.id;
  for (const s of screens) {
    if (Date.parse(s.timestamp) <= t) chosen = s.id;
    else break;
  }
  return chosen;
}

function collectAttendees(
  turns: Array<Omit<MeetingTurn, 'id' | 'meeting_id'>>,
): string[] {
  const seen = new Set<string>();
  for (const t of turns) {
    if (t.speaker && !seen.has(t.speaker)) seen.add(t.speaker);
  }
  return [...seen];
}

const URL_RE = /https?:\/\/[^\s<>"')]+/g;

function collectLinks(audioFrames: Frame[], screens: Frame[]): string[] {
  const seen = new Set<string>();
  const push = (url: string | null | undefined): void => {
    if (!url) return;
    const cleaned = url.replace(/[).,;]+$/g, '');
    if (!seen.has(cleaned)) seen.add(cleaned);
  };
  for (const f of screens) push(f.url);
  for (const f of audioFrames) {
    const text = f.text ?? '';
    const matches = text.match(URL_RE);
    if (matches) for (const m of matches) push(m);
  }
  for (const f of screens) {
    const text = f.text ?? '';
    const matches = text.match(URL_RE);
    if (matches) for (const m of matches) push(m);
  }
  return [...seen].slice(0, 50);
}
