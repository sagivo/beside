import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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
 *  - .txt/.md/.vtt/.srt: imported directly as transcript text.
 *  - .wav/.mp3/.m4a/...: transcribed with the OpenAI `whisper` CLI if
 *    installed. If the CLI is missing, files are moved to failed/ with
 *    a readable .error.txt sidecar.
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
  private readonly importSessionId = newSessionId();

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
    this.whisperModel = opts.whisperModel ?? 'tiny';
    this.whisperLanguage = opts.whisperLanguage;
    this.batchSize = opts.batchSize ?? 5;
    this.sensitiveKeywords = opts.sensitiveKeywords ?? [];
  }

  async tick(): Promise<AudioTranscriptWorkerResult> {
    if (!this.enabled) {
      return { processed: 0, transcribed: 0, imported: 0, failed: 0 };
    }
    await ensureDir(this.inboxPath);
    await ensureDir(this.processedPath);
    await ensureDir(this.failedPath);

    const entries = await fs.readdir(this.inboxPath, { withFileTypes: true }).catch(() => []);
    const files = entries
      .filter((e) => e.isFile())
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

    for (const file of files) {
      try {
        const ext = path.extname(file).toLowerCase();
        const direct = TRANSCRIPT_EXTENSIONS.has(ext);
        const text = direct
          ? await this.readTranscriptFile(file)
          : await this.transcribeAudioFile(file);
        const cleaned = redactPii(text.trim(), this.sensitiveKeywords);
        if (!cleaned) throw new Error('transcript was empty');
        const event = await this.buildEvent(file, cleaned, direct ? 'import' : 'whisper');
        await this.storage.write(event);
        await this.moveTo(file, this.processedPath);
        totals.processed += 1;
        if (direct) totals.imported += 1;
        else totals.transcribed += 1;
      } catch (err) {
        totals.failed += 1;
        this.logger.warn(`audio transcript failed for ${path.basename(file)}`, {
          err: String(err),
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

  async drain(): Promise<AudioTranscriptWorkerResult> {
    const total: AudioTranscriptWorkerResult = {
      processed: 0,
      transcribed: 0,
      imported: 0,
      failed: 0,
    };
    for (let i = 0; i < 10_000; i++) {
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

  private async readTranscriptFile(filePath: string): Promise<string> {
    const raw = await fs.readFile(filePath, 'utf8');
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.vtt') return stripVtt(raw);
    if (ext === '.srt') return stripSrt(raw);
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
    const timestamp = stat.mtime.toISOString();
    return {
      id: newEventId(new Date(timestamp)),
      timestamp,
      session_id: this.importSessionId,
      type: 'audio_transcript',
      app: 'Audio',
      app_bundle_id: 'cofounderos.audio',
      window_title: path.basename(sourcePath),
      url: null,
      content: transcript,
      // The processed source file is retained in capture.audio.processed_path,
      // but transcripts are text-first events and don't need markdown image
      // links or frame assets.
      asset_path: null,
      duration_ms: null,
      idle_before_ms: null,
      screen_index: 0,
      metadata: {
        source,
        original_filename: path.basename(sourcePath),
        whisper_model: source === 'whisper' ? this.whisperModel : null,
      },
      privacy_filtered: false,
      capture_plugin: 'audio-transcript-worker',
    };
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

function stripVtt(input: string): string {
  return input
    .split(/\r?\n/)
    .filter((line) => line.trim() && line.trim() !== 'WEBVTT')
    .filter((line) => !line.includes('-->'))
    .map((line) => line.replace(/<[^>]+>/g, '').trim())
    .join('\n');
}

function stripSrt(input: string): string {
  return input
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .filter((line) => !/^\d+$/.test(line.trim()))
    .filter((line) => !line.includes('-->'))
    .join('\n');
}

async function uniquePath(candidate: string): Promise<string> {
  const parsed = path.parse(candidate);
  for (let i = 0; i < 10_000; i++) {
    const suffix = i === 0 ? '' : `-${i}`;
    const p = path.join(parsed.dir, `${parsed.name}${suffix}${parsed.ext}`);
    try {
      await fs.access(p);
    } catch {
      return p;
    }
  }
  throw new Error(`could not find unique path for ${candidate}`);
}
