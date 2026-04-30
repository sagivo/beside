import path from 'node:path';
import fs from 'node:fs/promises';
import type { IStorage, Logger } from '@cofounderos/interfaces';
import { redactPii } from './pii.js';

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
  setParameters(params: Record<string, string>): Promise<unknown>;
  terminate(): Promise<unknown>;
};

/**
 * Maximum width (in px) we feed to Tesseract. Retina captures come in at
 * 3024px wide on a 14" MBP — way more pixels than Tesseract needs to read
 * UI text, and the extra resolution actively hurts: hairline dividers and
 * 1-2px UI artifacts survive page segmentation as degenerate "line"
 * candidates and trigger Leptonica's `Image too small to scale!!` warnings.
 * Downscaling to ~logical resolution (1512px) eliminates those artifacts
 * and roughly halves OCR runtime with negligible recall loss.
 */
const OCR_MAX_WIDTH = 1600;

/**
 * Leptonica (the image library Tesseract bundles) writes diagnostic lines
 * like `Error in boxClipToRectangle: box outside rectangle` directly to the
 * process's native stderr via `fprintf`. They are non-fatal — Leptonica
 * recovers, OCR continues — but they bypass tesseract.js's `logger`
 * callback and `debug_file` parameter entirely, so the only place we can
 * suppress them is at the Node stderr boundary.
 *
 * We install a one-time, additive filter: any line that exactly matches a
 * known Leptonica chatter pattern is dropped; everything else (including
 * unfamiliar Leptonica messages we *do* want to see) passes through
 * untouched. The patch is idempotent and never replaces a previously
 * patched write, so multiple OcrWorker instances are safe.
 */
const LEPTONICA_NOISE = [
  /^Error in boxClipToRectangle: box outside rectangle\s*$/,
  /^Error in pixScanForForeground: invalid box\s*$/,
  /^Image too small to scale!!\s*\(less than 2x2\)\s*$/,
  /^Image too small to scale!!\s*$/,
];

let stderrFilterInstalled = false;
function installLeptonicaStderrFilter(): void {
  if (stderrFilterInstalled) return;
  stderrFilterInstalled = true;
  const original = process.stderr.write.bind(process.stderr);
  // We accept the same overloads as `process.stderr.write`. Buffers are
  // passed through verbatim — Leptonica writes plain ASCII strings, so the
  // Buffer path is effectively never our message and we don't want to
  // decode unrelated binary output.
  const filtered = ((
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ): boolean => {
    if (typeof chunk === 'string') {
      const lines = chunk.split('\n');
      const kept = lines.filter((line, idx) => {
        // Preserve a trailing empty string that comes from a terminating
        // newline so we don't accidentally collapse line boundaries.
        if (idx === lines.length - 1 && line === '') return true;
        return !LEPTONICA_NOISE.some((re) => re.test(line));
      });
      if (kept.length === 0) {
        if (typeof encodingOrCb === 'function') encodingOrCb();
        else if (typeof cb === 'function') cb();
        return true;
      }
      const out = kept.join('\n');
      if (out === chunk) {
        return original(chunk, encodingOrCb as BufferEncoding, cb);
      }
      return original(out, encodingOrCb as BufferEncoding, cb);
    }
    return original(chunk, encodingOrCb as BufferEncoding, cb);
  }) as typeof process.stderr.write;
  process.stderr.write = filtered;
}

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
        const input = await prepareForOcr(abs);
        const result = await worker.recognize(input);
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
        installLeptonicaStderrFilter();
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
        // PSM 11 = sparse text. Screenshots of UIs aren't paragraphs, they
        // are scattered labels, buttons, menus. PSM 11 produces far fewer
        // degenerate single-column "line" candidates than the default PSM 3,
        // which both improves recall on UI text and silences most of
        // Leptonica's "Image too small to scale!!" warnings.
        //
        // `debug_file` redirects Tesseract/Leptonica's native stderr chatter
        // (which the JS `logger` callback above cannot intercept) to /dev/null.
        try {
          await worker.setParameters({
            tessedit_pageseg_mode: '11',
            debug_file: '/dev/null',
          });
        } catch (err) {
          this.logger.debug('setParameters failed (continuing with defaults)', {
            err: String(err),
          });
        }
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
 * Downscale Retina-resolution screenshots before feeding them to Tesseract.
 *
 * macOS captures come in at native pixel density (e.g. 3024×1964 on a 14"
 * MBP) — that's 2× the logical resolution the UI was designed at. The
 * extra detail doesn't help OCR (text is heavily oversampled) but it
 * *does* hurt: hairline dividers, 1-2px window borders, scrollbars, and
 * focus rings survive page segmentation as 2-pixel-wide "line" candidates
 * and produce a flood of `Image too small to scale!!` warnings from
 * Leptonica. Downscaling collapses those artifacts to sub-pixel and
 * roughly halves recognition time. Falls back to the raw file path on
 * failure so a sharp glitch never blocks OCR.
 */
async function prepareForOcr(absPath: string): Promise<string | Buffer> {
  try {
    // Lazy import to keep `sharp` out of the cold-start path. The encode
    // happens once per frame and is dwarfed by tesseract's recognize().
    const sharp = (await import('sharp')).default;
    const img = sharp(absPath, { failOn: 'none' });
    const meta = await img.metadata();
    if (!meta.width || meta.width <= OCR_MAX_WIDTH) {
      return absPath;
    }
    return await img
      .resize({ width: OCR_MAX_WIDTH, withoutEnlargement: true })
      .png({ compressionLevel: 1 })
      .toBuffer();
  } catch {
    return absPath;
  }
}

// Re-export so existing callers of `import { redactPii } from './ocr-worker.js'`
// continue to work — the canonical home is now `./pii.ts`.
export { redactPii } from './pii.js';
