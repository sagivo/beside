import path from 'node:path';
import fs from 'node:fs/promises';
import type { FrameTextSource, IStorage, Logger } from '@cofounderos/interfaces';
import { redactPii } from './pii.js';

interface OcrWorkerOptions { batchSize?: number; enabled?: boolean; storageRoot: string; sensitiveKeywords?: string[]; skipWhenAxTextChars?: number; }
export interface OcrWorkerResult { processed: number; failed: number; remaining: number; }
type TesseractWorker = { recognize(image: string | Buffer): Promise<{ data: { text: string } }>; setParameters(params: Record<string, string>): Promise<unknown>; terminate(): Promise<unknown>; };

const OCR_WORKING_MAX_DIM = 2000;
const LEPTONICA_NOISE = [/^Error in boxClipToRectangle:/, /^Error in pixScanForForeground:/, /^Image too small to scale!!/];
let stderrFilterInstalled = false;

function installLeptonicaStderrFilter(): void {
  if (stderrFilterInstalled) return; stderrFilterInstalled = true;
  const o = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((c: string | Uint8Array, e?: BufferEncoding | ((err?: Error | null) => void), cb?: (err?: Error | null) => void) => {
    const t = typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    const out = t.split('\n').filter((l, i, a) => (i === a.length - 1 && l === '') || !LEPTONICA_NOISE.some(re => re.test(l))).join('\n');
    if (out === t) return o(c, e as BufferEncoding, cb);
    const d = typeof e === 'function' ? e : cb;
    if (!out.length) { if (d) d(); return true; }
    return o(out, d);
  }) as any;
}

export class OcrWorker {
  private readonly logger: Logger;
  private readonly batchSize: number;
  private readonly enabled: boolean;
  private readonly storageRoot: string;
  private readonly sensitiveKeywords: string[];
  private readonly skipWhenAxTextChars: number;
  private workerPromise: Promise<TesseractWorker | null> | null = null;
  private terminating = false;
  private lastTesseractUseAt: number | null = null;

  constructor(private readonly storage: IStorage, logger: Logger, opts: OcrWorkerOptions) {
    this.logger = logger.child('ocr-worker');
    this.batchSize = opts.batchSize ?? 3; this.enabled = opts.enabled ?? true; this.storageRoot = opts.storageRoot;
    this.sensitiveKeywords = opts.sensitiveKeywords ?? []; this.skipWhenAxTextChars = Math.max(0, opts.skipWhenAxTextChars ?? 400);
    if (this.enabled) installLeptonicaStderrFilter();
  }

  async tick(): Promise<OcrWorkerResult> {
    if (!this.enabled || this.terminating) return { processed: 0, failed: 0, remaining: 0 };
    await this.maybeEvictIdleTesseractWorker();
    const tasks = await this.storage.listFramesNeedingOcr(this.batchSize);
    if (!tasks.length) return { processed: 0, failed: 0, remaining: 0 };

    let processed = 0, failed = 0; const rem: typeof tasks = [];
    for (const t of tasks) {
      if (this.terminating) break;
      const exT = (t.existing_text ?? '').trim();
      if (this.skipWhenAxTextChars > 0 && t.existing_source === 'accessibility' && exT.length >= this.skipWhenAxTextChars) {
        try { await this.storage.setFrameText(t.id, exT, 'ocr_accessibility'); processed++; continue; } catch {}
      }
      if (t.perceptual_hash && this.storage.findOcrTextByPerceptualHash) {
        try {
          const c = await this.storage.findOcrTextByPerceptualHash(t.perceptual_hash, t.id);
          if (c?.text) { await this.storage.setFrameText(t.id, mergeVisualText(c.text, exT), exT && t.existing_source === 'accessibility' ? 'ocr_accessibility' : c.source); processed++; continue; }
        } catch {}
      }
      rem.push(t);
    }

    if (!rem.length) return { processed, failed: 0, remaining: 0 };

    const w = await this.getWorker();
    if (!w) { this.logger.warn('tesseract unavailable'); return { processed, failed: rem.length, remaining: rem.length }; }

    for (const t of rem) {
      if (this.terminating) break;
      const exT = (t.existing_text ?? '').trim(), src = exT && t.existing_source === 'accessibility' ? 'ocr_accessibility' : 'ocr';
      try {
        const abs = path.isAbsolute(t.asset_path) ? t.asset_path : path.join(this.storageRoot, t.asset_path);
        try { await fs.access(abs); } catch { await this.storage.setFrameText(t.id, exT, src); processed++; continue; }
        const i = await prepareForOcr(abs);
        if (!i) { await this.storage.setFrameText(t.id, exT, src); processed++; continue; }
        const res = await w.recognize(i); this.lastTesseractUseAt = Date.now();
        await this.storage.setFrameText(t.id, mergeVisualText(redactPii((res.data.text ?? '').trim(), this.sensitiveKeywords), exT), src);
        processed++;
      } catch (err) { failed++; try { await this.storage.setFrameText(t.id, exT, src); } catch {} }
    }
    return { processed, failed, remaining: Math.max(0, tasks.length - processed) };
  }

  async drain(maxTicks = 1000): Promise<OcrWorkerResult> {
    const tot = { processed: 0, failed: 0, remaining: 0 };
    for (let i = 0; i < maxTicks; i++) { const r = await this.tick(); tot.processed += r.processed; tot.failed += r.failed; tot.remaining = r.remaining; if (!r.processed || r.processed + r.failed < this.batchSize) break; }
    return tot;
  }

  async stop(): Promise<void> { this.terminating = true; const w = await this.workerPromise; if (w) try { await w.terminate(); } catch {} this.workerPromise = null; }

  private async maybeEvictIdleTesseractWorker(): Promise<void> {
    if (!this.workerPromise || !this.lastTesseractUseAt || Date.now() - this.lastTesseractUseAt < 600000) return;
    const p = this.workerPromise; this.workerPromise = null; this.lastTesseractUseAt = null;
    try { const w = await p; if (w) await w.terminate(); } catch {}
  }

  private async getWorker(): Promise<TesseractWorker | null> {
    if (this.workerPromise) return this.workerPromise;
    this.workerPromise = (async () => {
      try {
        installLeptonicaStderrFilter();
        const ts = (await import('tesseract.js')) as any, w = await ts.createWorker('eng', 1, { logger: () => {} });
        try { await w.setParameters({ tessedit_pageseg_mode: '11', debug_file: '/dev/null' }); } catch {}
        return w;
      } catch { return null; }
    })();
    return this.workerPromise;
  }
}

function mergeVisualText(o: string, a: string): string {
  const l: string[] = [], s = new Set<string>();
  for (const b of [o, a]) for (const r of b.split(/\r?\n/)) { const c = r.replace(/\s+/g, ' ').trim(); if (c && !s.has(c.toLowerCase())) { s.add(c.toLowerCase()); l.push(c); } }
  return l.join('\n').trim();
}

async function prepareForOcr(abs: string): Promise<string | Buffer | null> {
  try {
    const sharp = (await import('sharp')).default, img = sharp(abs, { failOn: 'none' }), meta = await img.metadata();
    if (!meta.width || !meta.height || meta.width < 64 || meta.height < 64) return null;
    let pipe = img.resize({ width: OCR_WORKING_MAX_DIM, height: OCR_WORKING_MAX_DIM, fit: 'inside' }).grayscale().normalise();
    if (((await img.clone().resize({ width: 64, height: 64, fit: 'inside' }).grayscale().stats()).channels[0]?.mean ?? 255) < 128) pipe = pipe.negate({ alpha: false });
    return await pipe.png({ compressionLevel: 0 }).toBuffer();
  } catch { return abs; }
}

export { redactPii } from './pii.js';
