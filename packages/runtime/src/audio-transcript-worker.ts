import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import type { IStorage, Logger, RawEvent } from '@cofounderos/interfaces';
import { ensureDir, expandPath, newEventId, newSessionId } from '@cofounderos/core';
import { redactPii } from './pii.js';

const execFileP = promisify(execFile);

const AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.webm', '.mp4']);
const TRANSCRIPT_EXTENSIONS = new Set(['.txt', '.md', '.vtt', '.srt']);

export interface AudioTranscriptWorkerOptions {
  enabled?: boolean;
  inboxPath: string;
  processedPath: string;
  failedPath: string;
  whisperCommand?: string;
  whisperModel?: string;
  whisperLanguage?: string;
  batchSize?: number;
  sensitiveKeywords?: string[];
  /**
   * If true, delete audio source files after a successful transcription
   * instead of moving them into `processedPath`. Default true: the
   * transcript is the durable, PII-redacted artifact, so retaining the
   * raw audio indefinitely undoes our redaction story. Imported text
   * transcripts (.txt/.vtt/.srt) are always moved to `processedPath`
   * regardless — they ARE the source of truth.
   */
  deleteAudioAfterTranscribe?: boolean;
  /**
   * Reject audio files above this size (bytes) before invoking
   * whisper. Prevents a stray screen recording in the inbox from
   * burning the 30-minute whisper timeout. 0 disables. Default 500 MiB.
   */
  maxAudioBytes?: number;
}

export interface AudioTranscriptWorkerResult {
  processed: number;
  transcribed: number;
  imported: number;
  failed: number;
}

/**
 * AudioTranscriptWorker — V2 audio ingestion.
 *
 * This intentionally starts with a file-based inbox instead of live
 * system-audio capture. macOS system audio requires a native capture
 * agent or a virtual device; bolting that onto the Node poller would be
 * fragile. The inbox gives us the durable part now: audio/transcript
 * files become first-class `audio_transcript` RawEvents, then frames,
 * sessions, embeddings, and MCP search all work without special cases.
 *
 * Supported inputs:
 *  - .txt/.md/.vtt/.srt: imported directly as transcript text and
 *    moved to `processedPath` after import.
 *  - .wav/.mp3/.m4a/...: transcribed with the OpenAI `whisper` CLI if
 *    installed. The CLI is preflighted once and cached; if it is
 *    missing, audio files stay in the inbox (the worker logs once and
 *    then no-ops on audio until the binary appears). After a
 *    successful transcription the source audio is deleted by default
 *    — the redacted transcript is the durable artifact and retaining
 *    the raw audio would undo the PII redaction story.
 */
export class AudioTranscriptWorker {
  private readonly logger: Logger;
  private readonly enabled: boolean;
  private readonly inboxPath: string;
  private readonly processedPath: string;
  private readonly failedPath: string;
  private readonly whisperCommand: string;
  private readonly whisperModel: string;
  private readonly whisperLanguage: string | undefined;
  private readonly batchSize: number;
  private readonly sensitiveKeywords: string[];
  private readonly deleteAudioAfterTranscribe: boolean;
  private readonly maxAudioBytes: number;

  /** Re-entrancy guard: a slow whisper call must not let a second tick
   *  start a parallel one. */
  private running = false;

  /** Preflight state for the whisper CLI. We probe lazily on the first
   *  tick that actually needs it (so disabling capture_audio costs
   *  nothing) and cache the answer for the worker's lifetime. */
  private whisperAvailable: boolean | null = null;

  /** Best-effort ffprobe availability cache. Used only to populate
   *  RawEvent.duration_ms; missing ffprobe is not an error. */
  private ffprobeAvailable: boolean | null = null;

  constructor(
    private readonly storage: IStorage,
    logger: Logger,
    opts: AudioTranscriptWorkerOptions,
  ) {
    this.logger = logger.child('audio-transcript-worker');
    this.enabled = opts.enabled ?? false;
    this.inboxPath = expandPath(opts.inboxPath);
    this.processedPath = expandPath(opts.processedPath);
    this.failedPath = expandPath(opts.failedPath);
    this.whisperCommand = opts.whisperCommand ?? 'whisper';
    this.whisperModel = opts.whisperModel ?? 'base';
    this.whisperLanguage = opts.whisperLanguage;
    this.batchSize = opts.batchSize ?? 5;
    this.sensitiveKeywords = opts.sensitiveKeywords ?? [];
    this.deleteAudioAfterTranscribe = opts.deleteAudioAfterTranscribe ?? true;
    this.maxAudioBytes = opts.maxAudioBytes ?? 500 * 1024 * 1024;
  }

  async tick(): Promise<AudioTranscriptWorkerResult> {
    const empty: AudioTranscriptWorkerResult = {
      processed: 0,
      transcribed: 0,
      imported: 0,
      failed: 0,
    };
    if (!this.enabled) return empty;
    if (this.running) {
      // Previous tick still in flight (likely a slow whisper call).
      // Skipping is correct: the inbox is durable, the next scheduler
      // beat will pick up where this one left off.
      this.logger.debug('skipping tick — previous tick still running');
      return empty;
    }
    this.running = true;
    try {
      return await this.runTick();
    } finally {
      this.running = false;
    }
  }

  private async runTick(): Promise<AudioTranscriptWorkerResult> {
    await ensureDir(this.inboxPath);
    await ensureDir(this.processedPath);
    await ensureDir(this.failedPath);

    const entries = await fs.readdir(this.inboxPath, { withFileTypes: true }).catch(() => []);
    const files = entries
      .filter((e) => e.isFile())
      .filter((e) => !e.name.startsWith('.'))
      .map((e) => path.join(this.inboxPath, e.name))
      .filter((p) => this.isSupported(p))
      .sort()
      .slice(0, this.batchSize);

    const totals: AudioTranscriptWorkerResult = {
      processed: 0,
      transcribed: 0,
      imported: 0,
      failed: 0,
    };

    // Probe whisper once if any file in this batch needs it. If the
    // binary is missing we skip *audio* files this tick (leaving them
    // in the inbox for after the user installs whisper) but still
    // process direct text imports — those don't need a CLI.
    const hasAudio = files.some((f) => !TRANSCRIPT_EXTENSIONS.has(path.extname(f).toLowerCase()));
    const whisperOk = hasAudio ? await this.ensureWhisperAvailable() : true;

    for (const file of files) {
      const ext = path.extname(file).toLowerCase();
      const direct = TRANSCRIPT_EXTENSIONS.has(ext);
      if (!direct && !whisperOk) {
        // Don't mark as failed — leave in inbox so a later install of
        // whisper just works. The preflight already logged the cause.
        continue;
      }
      const startedMs = Date.now();
      try {
        if (!direct && this.maxAudioBytes > 0) {
          const { size } = await fs.stat(file);
          if (size > this.maxAudioBytes) {
            throw new Error(
              `audio file is ${formatBytes(size)} which exceeds capture.audio.max_audio_bytes (${formatBytes(this.maxAudioBytes)}). ` +
                `If this is a long recording you want transcribed, raise the limit or split the file.`,
            );
          }
        }
        const text = direct
          ? await this.readTranscriptFile(file)
          : await this.transcribeAudioFile(file);
        const cleaned = redactPii(text.trim(), this.sensitiveKeywords);
        if (!cleaned) throw new Error('transcript was empty');
        const event = await this.buildEvent(file, cleaned, direct ? 'import' : 'whisper');
        await this.storage.write(event);
        await this.disposeSource(file, direct);
        totals.processed += 1;
        if (direct) totals.imported += 1;
        else totals.transcribed += 1;
        // Per-file timing — useful when investigating "audio feels stuck"
        // since whisper is by far the slowest stage of the pipeline.
        this.logger.debug('audio transcript ok', {
          file: path.basename(file),
          source: direct ? 'import' : 'whisper',
          duration_ms: Date.now() - startedMs,
          chars: cleaned.length,
          model: direct ? null : this.whisperModel,
        });
      } catch (err) {
        totals.failed += 1;
        this.logger.warn(`audio transcript failed for ${path.basename(file)}`, {
          err: String(err),
          duration_ms: Date.now() - startedMs,
        });
        await this.writeFailure(file, err);
      }
    }

    if (totals.processed > 0 || totals.failed > 0) {
      this.logger.info(
        `audio transcripts: ${totals.processed} processed (${totals.imported} imported, ${totals.transcribed} transcribed), ${totals.failed} failed`,
      );
    }
    return totals;
  }

  /**
   * Drain the inbox by calling `tick()` repeatedly until either:
   *   - the tick reports no progress (inbox is empty or whisper is
   *     unavailable and we're stuck on audio), or
   *   - a batch came back partial (fewer than `batchSize` items
   *     touched), implying the queue is below the floor.
   *
   * The per-tick re-entrancy guard already serializes work; no
   * arbitrary iteration cap is needed beyond the natural termination
   * conditions above.
   */
  async drain(): Promise<AudioTranscriptWorkerResult> {
    const total: AudioTranscriptWorkerResult = {
      processed: 0,
      transcribed: 0,
      imported: 0,
      failed: 0,
    };
    while (true) {
      const r = await this.tick();
      total.processed += r.processed;
      total.transcribed += r.transcribed;
      total.imported += r.imported;
      total.failed += r.failed;
      if (r.processed + r.failed === 0) break;
      if (r.processed + r.failed < this.batchSize) break;
    }
    return total;
  }

  private isSupported(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return AUDIO_EXTENSIONS.has(ext) || TRANSCRIPT_EXTENSIONS.has(ext);
  }

  /**
   * One-shot preflight for the whisper CLI. Result is cached for the
   * worker lifetime so we don't fork a probe process on every tick. We
   * rely on `whisper --help` returning exit 0 quickly; missing binaries
   * surface as ENOENT, which we translate into a single high-signal
   * error log and a `false` return.
   */
  private async ensureWhisperAvailable(): Promise<boolean> {
    if (this.whisperAvailable !== null) return this.whisperAvailable;
    try {
      await execFileP(this.whisperCommand, ['--help'], {
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      });
      this.whisperAvailable = true;
    } catch (err) {
      this.whisperAvailable = false;
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') {
        this.logger.error(
          `whisper CLI not found at "${this.whisperCommand}" — audio files will stay in the inbox until it is installed (or capture.audio.whisper_command is repointed). Direct .txt/.vtt/.srt imports continue to work.`,
        );
      } else {
        this.logger.error(`whisper CLI preflight failed for "${this.whisperCommand}"`, {
          err: String(err),
        });
      }
    }
    return this.whisperAvailable;
  }

  /**
   * Dispose of a successfully-processed source file. Direct text
   * imports always go to `processedPath` — they ARE the transcript and
   * are useful to keep. Audio sources are deleted by default because
   * the (PII-redacted) transcript is the durable artifact; retaining
   * raw audio undoes our redaction story.
   */
  private async disposeSource(filePath: string, isDirectImport: boolean): Promise<void> {
    if (isDirectImport || !this.deleteAudioAfterTranscribe) {
      await this.moveTo(filePath, this.processedPath);
      return;
    }
    await fs.rm(filePath, { force: true });
  }

  private async readTranscriptFile(filePath: string): Promise<string> {
    const raw = await fs.readFile(filePath, 'utf8');
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.vtt') return stripSubtitles(raw, 'vtt');
    if (ext === '.srt') return stripSubtitles(raw, 'srt');
    return raw;
  }

  private async transcribeAudioFile(filePath: string): Promise<string> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cofounderos-whisper-'));
    const base = path.basename(filePath, path.extname(filePath));
    try {
      const args = [
        filePath,
        '--model',
        this.whisperModel,
        '--output_format',
        'txt',
        '--output_dir',
        tmpDir,
      ];
      if (this.whisperLanguage) {
        args.push('--language', this.whisperLanguage);
      }
      await execFileP(this.whisperCommand, args, {
        timeout: 30 * 60_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      const txt = path.join(tmpDir, `${base}.txt`);
      return await fs.readFile(txt, 'utf8');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async buildEvent(
    sourcePath: string,
    transcript: string,
    source: 'import' | 'whisper',
  ): Promise<RawEvent> {
    const stat = await fs.stat(sourcePath);
    const filename = path.basename(sourcePath);

    // Timestamp resolution order:
    //   1. Native chunker filename (`native-YYYY-MM-DD-HH-mm-ss-SSS-N.m4a`)
    //      — encodes the chunk *start*, which is what we want.
    //   2. mtime — for direct text imports and arbitrary user drops,
    //      this is the best we have.
    // Falling back to mtime is wrong for an *active* native chunk
    // (mtime ≈ end of chunk, off by chunk_seconds), so the filename
    // path is preferred whenever it parses.
    const startedAt = parseNativeChunkTimestamp(filename) ?? stat.mtime;
    const timestamp = startedAt.toISOString();

    // Duration: for audio, probe with ffprobe (best-effort); for text
    // imports we have nothing to probe. Null is preferable to a wrong
    // value — downstream consumers already handle null.
    const durationMs = source === 'whisper' ? await this.probeDurationMs(sourcePath) : null;

    return {
      id: newEventId(startedAt),
      timestamp,
      // Mint a fresh capture session per transcript. The real grouping
      // happens downstream via SessionBuilder + activity_session_id, so
      // sharing one id across the worker's lifetime would just collide
      // with unrelated audio files imported hours apart.
      session_id: newSessionId(),
      type: 'audio_transcript',
      app: 'Audio',
      app_bundle_id: 'cofounderos.audio',
      window_title: filename,
      url: null,
      content: transcript,
      asset_path: null,
      duration_ms: durationMs,
      idle_before_ms: null,
      screen_index: 0,
      metadata: {
        source,
        original_filename: filename,
        whisper_model: source === 'whisper' ? this.whisperModel : null,
      },
      privacy_filtered: false,
      capture_plugin: 'audio-transcript-worker',
    };
  }

  /**
   * Best-effort duration probe via ffprobe. Returns null if ffprobe is
   * absent or the file can't be parsed — duration is decorative
   * metadata, not load-bearing, so we never fail the transcript over it.
   */
  private async probeDurationMs(filePath: string): Promise<number | null> {
    if (this.ffprobeAvailable === false) return null;
    try {
      const { stdout } = await execFileP(
        'ffprobe',
        [
          '-v',
          'error',
          '-show_entries',
          'format=duration',
          '-of',
          'default=noprint_wrappers=1:nokey=1',
          filePath,
        ],
        { timeout: 10_000, maxBuffer: 1024 * 1024 },
      );
      this.ffprobeAvailable = true;
      const seconds = Number.parseFloat(stdout.trim());
      if (!Number.isFinite(seconds) || seconds <= 0) return null;
      return Math.round(seconds * 1000);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT' && this.ffprobeAvailable === null) {
        // First miss: log once at info level (this is optional tooling)
        // and remember not to try again this session.
        this.logger.info(
          'ffprobe not found — audio_transcript events will have duration_ms: null. Install ffmpeg to enable accurate durations.',
        );
        this.ffprobeAvailable = false;
      }
      return null;
    }
  }

  private async moveTo(filePath: string, dir: string): Promise<void> {
    await ensureDir(dir);
    const dest = await uniquePath(path.join(dir, path.basename(filePath)));
    await fs.rename(filePath, dest);
  }

  private async writeFailure(filePath: string, err: unknown): Promise<void> {
    await ensureDir(this.failedPath);
    const dest = await uniquePath(path.join(this.failedPath, path.basename(filePath)));
    await fs.rename(filePath, dest).catch(async () => {
      await fs.copyFile(filePath, dest);
      await fs.rm(filePath, { force: true });
    });
    await fs.writeFile(`${dest}.error.txt`, String(err), 'utf8');
  }
}

/**
 * Convert a subtitle file (VTT or SRT) to plain text while preserving
 * cue structure: each cue becomes a paragraph, separated by a blank
 * line. Speaker tags from VTT (`<v Alice>...`) are surfaced as a
 * `Alice: ` prefix so embeddings and search can attribute lines.
 *
 * The earlier implementation collapsed every line into a single
 * stream, which destroyed pause/turn information that downstream
 * search and chunking benefits from.
 */
function stripSubtitles(input: string, kind: 'vtt' | 'srt'): string {
  const cues: string[] = [];
  let current: string[] = [];
  let currentSpeaker: string | null = null;

  const flush = () => {
    if (current.length === 0) return;
    const body = current.join(' ').replace(/\s+/g, ' ').trim();
    if (body) {
      cues.push(currentSpeaker ? `${currentSpeaker}: ${body}` : body);
    }
    current = [];
    currentSpeaker = null;
  };

  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();
    // Blank line ends a cue.
    if (!line) {
      flush();
      continue;
    }
    // VTT preamble.
    if (kind === 'vtt' && (line === 'WEBVTT' || line.startsWith('NOTE') || line.startsWith('STYLE'))) {
      continue;
    }
    // Cue numbers (SRT) and standalone integer cue ids (VTT).
    if (/^\d+$/.test(line)) continue;
    // Timing line.
    if (line.includes('-->')) continue;
    // Capture the first VTT speaker tag in a cue, then strip all tags.
    if (kind === 'vtt' && currentSpeaker === null) {
      const speakerMatch = line.match(/<v(?:\s+[^>]*?)?\s+([^>]+?)>/);
      if (speakerMatch) currentSpeaker = speakerMatch[1].trim();
    }
    const cleaned = line.replace(/<[^>]+>/g, '').trim();
    if (cleaned) current.push(cleaned);
  }
  flush();
  return cues.join('\n\n');
}

/**
 * Parse the native chunker's filename convention:
 *   `native-YYYY-MM-DD-HH-mm-ss-SSS-N.m4a`
 * The Swift side emits these in *local* time (no timezone suffix), so
 * we construct the Date using local-time components to round-trip
 * correctly. Returns null for non-matching filenames (user drops,
 * Zoom recordings, etc.).
 */
function parseNativeChunkTimestamp(filename: string): Date | null {
  const m = filename.match(
    /^native-(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{3})-\d+\.[A-Za-z0-9]+$/,
  );
  if (!m) return null;
  const [, y, mo, d, h, mi, s, ms] = m;
  const date = new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
    Number(ms),
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

/**
 * Pick a path that doesn't currently exist. Try the requested name
 * first; on collision, append an 8-char random suffix. We deliberately
 * skip the classic "increment a counter" loop because it's O(n) per
 * collision and TOCTOU-racy if two ticks pick the same suffix between
 * `access` and `rename`. A random suffix is collision-free in
 * practice (1 in 2^32) and removes the loop entirely.
 */
async function uniquePath(candidate: string): Promise<string> {
  try {
    await fs.access(candidate);
  } catch {
    return candidate;
  }
  const parsed = path.parse(candidate);
  const suffix = randomBytes(4).toString('hex');
  return path.join(parsed.dir, `${parsed.name}-${suffix}${parsed.ext}`);
}
