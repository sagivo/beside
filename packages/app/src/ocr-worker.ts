import path from 'node:path';
import fs from 'node:fs/promises';
import type { IStorage, Logger } from '@cofounderos/interfaces';

/**
 * OCR worker — runs in the background, picks frames whose `text` is
 * still `null`, runs Tesseract over the screenshot, redacts PII, writes
 * the text back via `storage.setFrameText`.
 *
 * Tesseract.js is a pure-WASM build with no system dependency, which
 * matches our "ships out of the box" promise. It costs ~1-3s per frame
 * on a modern Mac and ~12MB of one-time language-data download. The
 * worker is therefore throttled (small batches, sleeps between) and can
 * be paused / disabled via config.
 *
 * Design notes:
 *  - Lazy-loads tesseract.js so the package's startup cost is unchanged
 *    until OCR actually runs.
 *  - Reuses a single Tesseract worker across ticks (worker creation is
 *    expensive — ~2s — and would dominate runtime if recreated).
 *  - Never blocks indexing or capture: failures are logged and the frame
 *    is left for the next tick.
 */

interface OcrWorkerOptions {
  /** Frames per tick. Each frame ≈ 1–3s on Apple Silicon. Default 3. */
  batchSize?: number;
  /** Skip OCR entirely (still wires up the worker for tests). */
  enabled?: boolean;
  /** Storage root (absolute) — used to resolve relative `asset_path`. */
  storageRoot: string;
  /** Substrings whose presence causes a *line* to be redacted. */
  sensitiveKeywords?: string[];
}

export interface OcrWorkerResult {
  processed: number;
  failed: number;
  remaining: number;
}

// Minimal subset of the tesseract.js Worker we actually use. We model
// terminate() as `Promise<unknown>` so the real type's `Promise<ConfigResult>`
// satisfies it without forcing us to import tesseract.js at type-check time.
type TesseractWorker = {
  recognize(image: string | Buffer): Promise<{ data: { text: string } }>;
  terminate(): Promise<unknown>;
};

export class OcrWorker {
  private readonly logger: Logger;
  private readonly batchSize: number;
  private readonly enabled: boolean;
  private readonly storageRoot: string;
  private readonly sensitiveKeywords: string[];

  private workerPromise: Promise<TesseractWorker | null> | null = null;
  private terminating = false;
  private startupLogged = false;

  constructor(
    private readonly storage: IStorage,
    logger: Logger,
    opts: OcrWorkerOptions,
  ) {
    this.logger = logger.child('ocr-worker');
    this.batchSize = opts.batchSize ?? 3;
    this.enabled = opts.enabled ?? true;
    this.storageRoot = opts.storageRoot;
    this.sensitiveKeywords = opts.sensitiveKeywords ?? [];
  }

  /** One pass: process up to `batchSize` pending frames. */
  async tick(): Promise<OcrWorkerResult> {
    if (!this.enabled || this.terminating) {
      return { processed: 0, failed: 0, remaining: 0 };
    }
    const tasks = await this.storage.listFramesNeedingOcr(this.batchSize);
    if (tasks.length === 0) {
      return { processed: 0, failed: 0, remaining: 0 };
    }
    const worker = await this.getWorker();
    if (!worker) {
      // Tesseract failed to load; disable until restart so we don't
      // log an error every 30s for the rest of the session.
      this.logger.warn('OCR worker disabled (tesseract.js unavailable)');
      return { processed: 0, failed: tasks.length, remaining: tasks.length };
    }

    let processed = 0;
    let failed = 0;
    for (const task of tasks) {
      if (this.terminating) break;
      try {
        const abs = path.isAbsolute(task.asset_path)
          ? task.asset_path
          : path.join(this.storageRoot, task.asset_path);
        // Confirm the file still exists; old screenshots may have been
        // vacuumed away.
        try {
          await fs.access(abs);
        } catch {
          await this.storage.setFrameText(task.id, '', 'ocr');
          continue;
        }
        const result = await worker.recognize(abs);
        const raw = (result.data.text ?? '').trim();
        const cleaned = redactPii(raw, this.sensitiveKeywords);
        await this.storage.setFrameText(task.id, cleaned, 'ocr');
        processed += 1;
      } catch (err) {
        failed += 1;
        this.logger.debug(`ocr failed for frame ${task.id}`, { err: String(err) });
        // Mark with empty text so we don't retry forever on a corrupt file.
        try {
          await this.storage.setFrameText(task.id, '', 'ocr');
        } catch {
          // ignore
        }
      }
    }
    if (processed > 0) {
      this.logger.debug(`ocr: ${processed} processed, ${failed} failed`);
    }
    return {
      processed,
      failed,
      remaining: Math.max(0, tasks.length - processed),
    };
  }

  async stop(): Promise<void> {
    this.terminating = true;
    const w = await this.workerPromise;
    if (w) {
      try {
        await w.terminate();
      } catch (err) {
        this.logger.debug('worker terminate failed', { err: String(err) });
      }
    }
    this.workerPromise = null;
  }

  private async getWorker(): Promise<TesseractWorker | null> {
    if (this.workerPromise) return this.workerPromise;
    this.workerPromise = (async (): Promise<TesseractWorker | null> => {
      try {
        if (!this.startupLogged) {
          this.logger.info(
            'starting OCR worker (first run downloads ~12MB of language data; subsequent runs are cached)',
          );
          this.startupLogged = true;
        }
        // Lazy import — keeps tesseract.js out of the cold-start path.
        // Cast through `unknown` because tesseract.js's published types
        // are wide and we only use a narrow slice (recognize + terminate).
        const ts = (await import('tesseract.js')) as unknown as {
          createWorker: (
            lang?: string,
            oem?: number,
            opts?: Record<string, unknown>,
          ) => Promise<TesseractWorker>;
        };
        const worker = await ts.createWorker('eng', 1, {
          // Quiet down tesseract.js — its default logger spams every page.
          logger: () => undefined,
        });
        return worker;
      } catch (err) {
        this.logger.warn('failed to initialise tesseract.js', { err: String(err) });
        return null;
      }
    })();
    return this.workerPromise;
  }
}

/**
 * Light-touch PII redaction applied to OCR text before it lands in the
 * frame_text FTS table. We err on the side of preserving meaning:
 *  - Email addresses → [REDACTED_EMAIL]
 *  - 13–19 digit sequences (cards) → [REDACTED_CARD]
 *  - Lines containing any configured sensitive keyword → [REDACTED_LINE]
 *
 * Bigger / smarter PII detection (NER, spaCy) is V2.
 */
export function redactPii(text: string, sensitiveKeywords: string[]): string {
  if (!text) return text;
  let out = text;
  // Emails.
  out = out.replace(
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    '[REDACTED_EMAIL]',
  );
  // Credit-card-like sequences (13–19 digits with optional separators).
  out = out.replace(/\b(?:\d[ -]?){13,19}\b/g, (m) => {
    // Reject if it has too many separators or non-digit-heavy content.
    const digits = m.replace(/[^\d]/g, '');
    if (digits.length < 13 || digits.length > 19) return m;
    return '[REDACTED_CARD]';
  });
  // Sensitive-keyword line scrub. Case-insensitive, whole line replaced.
  if (sensitiveKeywords.length > 0) {
    const escaped = sensitiveKeywords
      .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .filter((k) => k.length > 0);
    if (escaped.length > 0) {
      const pattern = new RegExp(`^.*(?:${escaped.join('|')}).*$`, 'gim');
      out = out.replace(pattern, '[REDACTED_LINE]');
    }
  }
  return out;
}
