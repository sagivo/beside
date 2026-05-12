import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import type { Frame, IStorage, Logger, MeetingPlatform, RawEvent } from '@beside/interfaces';
import { ensureDir, expandPath, newEventId, newSessionId } from '@beside/core';
import { redactPii } from './pii.js';

const execFileP = promisify(execFile);
const AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.webm', '.mp4']);
const TRANSCRIPT_EXTENSIONS = new Set(['.txt', '.md', '.vtt', '.srt']);

export interface AudioTranscriptWorkerOptions {
  enabled?: boolean; inboxPath: string; processedPath: string; failedPath: string;
  whisperCommand?: string; whisperModel?: string; whisperLanguage?: string; batchSize?: number;
  sensitiveKeywords?: string[]; deleteAudioAfterTranscribe?: boolean;
  maxAudioBytes?: number; minAudioBytesPerSec?: number; minAudioRateCheckMs?: number;
}

export interface AudioTranscriptWorkerResult { processed: number; transcribed: number; imported: number; failed: number; silent: number; }

class SilentAudioError extends Error {
  constructor(message = 'transcript was empty') { super(message); this.name = 'SilentAudioError'; }
}

interface ExtractedTurn { offset_ms: number; end_ms: number; speaker: string | null; text: string; source: 'whisper' | 'vtt' | 'srt' | 'import'; }
interface TranscribeResult { text: string; turns: ExtractedTurn[]; }
interface RecordingContextCandidate { source: 'nearby_screen'; confidence: number; reason: string; observed_at: string; frame_id: string; app: string; window_title: string; url: string | null; entity_path: string | null; entity_kind: string | null; meeting_id: string | null; platform: MeetingPlatform | null; title: string | null; meeting_url: string | null; }

export class AudioTranscriptWorker {
  private readonly logger: Logger;
  private readonly enabled: boolean; private readonly inboxPath: string; private readonly processedPath: string; private readonly failedPath: string;
  private readonly whisperCommand: string; private readonly whisperModel: string; private readonly whisperLanguage: string | undefined; private readonly batchSize: number;
  private readonly sensitiveKeywords: string[]; private readonly deleteAudioAfterTranscribe: boolean; private readonly maxAudioBytes: number; private readonly minAudioBytesPerSec: number; private readonly minAudioRateCheckMs: number;
  private running = false; private whisperAvailable: boolean | null = null; private ffprobeAvailable: boolean | null = null;

  constructor(private readonly storage: IStorage, logger: Logger, opts: AudioTranscriptWorkerOptions) {
    this.logger = logger.child('audio-transcript-worker');
    this.enabled = opts.enabled ?? false; this.inboxPath = expandPath(opts.inboxPath); this.processedPath = expandPath(opts.processedPath); this.failedPath = expandPath(opts.failedPath);
    this.whisperCommand = opts.whisperCommand ?? 'whisper'; this.whisperModel = opts.whisperModel ?? 'base'; this.whisperLanguage = opts.whisperLanguage;
    this.batchSize = opts.batchSize ?? 5; this.sensitiveKeywords = opts.sensitiveKeywords ?? []; this.deleteAudioAfterTranscribe = opts.deleteAudioAfterTranscribe ?? true;
    this.maxAudioBytes = opts.maxAudioBytes ?? 524288000; this.minAudioBytesPerSec = opts.minAudioBytesPerSec ?? 4096; this.minAudioRateCheckMs = opts.minAudioRateCheckMs ?? 5000;
  }

  async tick(): Promise<AudioTranscriptWorkerResult> {
    const empty = { processed: 0, transcribed: 0, imported: 0, failed: 0, silent: 0 };
    if (!this.enabled || this.running) return empty;
    this.running = true;
    try { return await this.runTick(); } finally { this.running = false; }
  }

  private async runTick(): Promise<AudioTranscriptWorkerResult> {
    await ensureDir(this.inboxPath); await ensureDir(this.processedPath); await ensureDir(this.failedPath);
    const files = (await fs.readdir(this.inboxPath, { withFileTypes: true }).catch(() => [])).filter(e => e.isFile() && !e.name.startsWith('.')).map(e => path.join(this.inboxPath, e.name)).filter(p => AUDIO_EXTENSIONS.has(path.extname(p).toLowerCase()) || TRANSCRIPT_EXTENSIONS.has(path.extname(p).toLowerCase())).sort().slice(0, this.batchSize);
    const t: AudioTranscriptWorkerResult = { processed: 0, transcribed: 0, imported: 0, failed: 0, silent: 0 };
    const hasAudio = files.some(f => !TRANSCRIPT_EXTENSIONS.has(path.extname(f).toLowerCase())), wOk = hasAudio ? await this.ensureWhisperAvailable() : true;

    for (const f of files) {
      const ext = path.extname(f).toLowerCase(), d = TRANSCRIPT_EXTENSIONS.has(ext);
      if (!d && !wOk) continue;
      const sMs = Date.now();
      try {
        if (!d && this.maxAudioBytes > 0 && (await fs.stat(f)).size > this.maxAudioBytes) throw new Error(`exceeds max_audio_bytes`);
        if (!d && this.minAudioBytesPerSec > 0) {
          const dur = await this.probeDurationMs(f);
          if (dur && dur >= this.minAudioRateCheckMs && (await fs.stat(f)).size / (dur / 1000) < this.minAudioBytesPerSec) throw new SilentAudioError('below silence floor');
        }
        const r = d ? await this.readTranscriptFile(f) : await this.transcribeAudioFile(f);
        const c = redactPii(r.text.trim(), this.sensitiveKeywords);
        if (!c) throw d ? new Error('empty transcript') : new SilentAudioError();
        const ev = await this.buildEvent(f, c, d ? 'import' : 'whisper', r.turns.map(t => ({ ...t, text: redactPii(t.text.trim(), this.sensitiveKeywords) })).filter(t => t.text.length > 0));
        await this.storage.write(ev); await this.disposeSource(f, d);
        t.processed++; d ? t.imported++ : t.transcribed++;
      } catch (err: any) {
        if (err instanceof SilentAudioError) { t.silent++; try { await fs.rm(f, { force: true }); } catch (e) { t.failed++; t.silent--; await this.writeFailure(f, e); } continue; }
        t.failed++; await this.writeFailure(f, err);
      }
    }
    return t;
  }

  async drain(): Promise<AudioTranscriptWorkerResult> {
    const tot = { processed: 0, transcribed: 0, imported: 0, failed: 0, silent: 0 };
    while (true) {
      const r = await this.tick();
      tot.processed += r.processed; tot.transcribed += r.transcribed; tot.imported += r.imported; tot.failed += r.failed; tot.silent += r.silent;
      if (r.processed + r.failed + r.silent < this.batchSize) break;
    }
    return tot;
  }

  private async ensureWhisperAvailable(): Promise<boolean> {
    if (this.whisperAvailable !== null) return this.whisperAvailable;
    try { await execFileP(this.whisperCommand, ['--help'], { timeout: 10000 }); return this.whisperAvailable = true; }
    catch { return this.whisperAvailable = false; }
  }

  private async disposeSource(fp: string, direct: boolean) {
    if (direct || !this.deleteAudioAfterTranscribe) return fs.rename(fp, await uniquePath(path.join(this.processedPath, path.basename(fp))));
    await fs.rm(fp, { force: true });
  }

  private async readTranscriptFile(fp: string): Promise<TranscribeResult> {
    const r = await fs.readFile(fp, 'utf8'), e = path.extname(fp).toLowerCase();
    return e === '.vtt' ? parseSubtitles(r, 'vtt') : e === '.srt' ? parseSubtitles(r, 'srt') : { text: r, turns: [] };
  }

  private async transcribeAudioFile(fp: string): Promise<TranscribeResult> {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'beside-whisper-'));
    try {
      const args = [fp, '--model', this.whisperModel, '--output_format', 'all', '--output_dir', tmp];
      if (this.whisperLanguage) args.push('--language', this.whisperLanguage);
      await execFileP(this.whisperCommand, args, { timeout: 1800000 });
      return { text: await fs.readFile(path.join(tmp, `${path.basename(fp, path.extname(fp))}.txt`), 'utf8'), turns: await fs.readFile(path.join(tmp, `${path.basename(fp, path.extname(fp))}.json`), 'utf8').then(parseWhisperJson).catch(() => []) };
    } finally { await fs.rm(tmp, { recursive: true, force: true }).catch(() => {}); }
  }

  private async buildEvent(sp: string, t: string, src: 'import'|'whisper', turns: ExtractedTurn[]): Promise<RawEvent> {
    const st = await fs.stat(sp), fn = path.basename(sp), sa = parseNativeChunkTimestamp(fn) ?? st.mtime, dur = src === 'whisper' ? await this.probeDurationMs(sp) : null, ctx = src === 'whisper' ? await this.findRecordingContext(sa, dur) : null;
    return { id: newEventId(sa), timestamp: sa.toISOString(), session_id: newSessionId(), type: 'audio_transcript', app: 'Audio', app_bundle_id: 'beside.audio', window_title: fn, url: null, content: t, asset_path: null, duration_ms: dur, idle_before_ms: null, screen_index: 0, metadata: { source: src, original_filename: fn, whisper_model: src === 'whisper' ? this.whisperModel : null, duration_ms: dur, turns: turns.length ? turns : undefined, recording_context: ctx ?? undefined }, privacy_filtered: false, capture_plugin: 'audio-transcript-worker' };
  }

  private async findRecordingContext(sa: Date, dur: number | null): Promise<RecordingContextCandidate | null> {
    const ms = sa.getTime();
    const cands = (await this.storage.searchFrames({ from: new Date(ms - 600000).toISOString(), to: new Date(ms + Math.max(dur ?? 0, 120000) + 120000).toISOString(), limit: 120 }).catch(() => [])).filter(f => f.text_source !== 'audio').map(f => scoreRecordingContextFrame(f, ms)).filter(c => c && c.confidence >= 45).sort((a, b) => b!.confidence - a!.confidence);
    return cands[0] || null;
  }

  private async probeDurationMs(fp: string): Promise<number | null> {
    if (this.ffprobeAvailable === false) return null;
    try { const { stdout } = await execFileP('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', fp], { timeout: 10000 }); this.ffprobeAvailable = true; const s = parseFloat(stdout.trim()); return s > 0 ? Math.round(s * 1000) : null; }
    catch { this.ffprobeAvailable = false; return null; }
  }

  private async writeFailure(fp: string, err: unknown) {
    await ensureDir(this.failedPath); const dest = await uniquePath(path.join(this.failedPath, path.basename(fp)));
    await fs.rename(fp, dest).catch(async () => { await fs.copyFile(fp, dest); await fs.rm(fp, { force: true }); });
    await fs.writeFile(`${dest}.error.txt`, String(err), 'utf8');
  }
}

function scoreRecordingContextFrame(f: Frame, aMs: number): RecordingContextCandidate | null {
  const h = [f.app, f.window_title, f.url, f.text].filter(Boolean).join('\n'), p = inferRecordingPlatform(h, f), u = extractMeetingUrl(h), t = extractRecordingTitle(h, f, p);
  let c = Math.max(0, 25 - Math.floor(Math.abs(Date.parse(f.timestamp) - aMs) / 60000));
  if (f.entity_kind === 'meeting') c += 65; if (u) c += 45; if (/(?:^|\n)\s*(?:(?:Google\s+)?Meet|Zoom(?:\s+Meeting)?|(?:Microsoft\s+)?Teams|Webex|Whereby|Around)\s*[-–—]\s*.{3,80}/i.test(h)) c += 40; if (p) c += 18; if (/calendar/i.test(f.app) || /google calendar|meetings\s+calls/i.test(h)) c += 38; if (/\b(join now|leave call|present now|raise hand)\b/i.test(h)) c += 22;
  return c < 35 ? null : { source: 'nearby_screen', confidence: c, reason: 'nearby_screen', observed_at: f.timestamp, frame_id: f.id, app: f.app, window_title: f.window_title, url: f.url, entity_path: f.entity_path, entity_kind: f.entity_kind, meeting_id: f.meeting_id, platform: p, title: t, meeting_url: u };
}

function inferRecordingPlatform(h: string, f: Frame): MeetingPlatform | null {
  const a = f.app ?? '';
  if (/\bzoom\b/i.test(a) || /zoom\.us/i.test(h)) return 'zoom';
  if (/google meet/i.test(a) || /meet\.google\.com/i.test(h) || /(?:^|\n)\s*(?:Google\s+)?Meet\s*[-–—]/i.test(h)) return 'meet';
  if (/microsoft teams/i.test(a) || /teams\.microsoft\.com/i.test(h) || /(?:^|\n)\s*(?:Microsoft\s+)?Teams\s*[-–—]/i.test(h)) return 'teams';
  if (/webex/i.test(a) || /\bwebex\.com\b/i.test(h)) return 'webex';
  if (/whereby/i.test(a) || /\bwhereby\.com\b/i.test(h)) return 'whereby';
  if (/around/i.test(a) || /\baround\.co\b/i.test(h)) return 'around';
  return null;
}

function extractMeetingUrl(h: string) { const m = h.match(/\bhttps?:\/\/(?:[\w.-]+\.)?(?:meet\.google\.com|zoom\.us|teams\.microsoft\.com)\/(?:j|my|wc|l\/meetup-join|_\\#\/meetup|\w{3}-\w{4}-\w{3})\b[\S]*/i); return m ? (m[0].startsWith('http') ? m[0] : `https://${m[0]}`) : null; }

function extractRecordingTitle(h: string, f: Frame, p: MeetingPlatform | null) {
  const l = h.split(/\r?\n/).map(x => x.replace(/^[\s•*·-]+/, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  for (const x of l) { const m = x.match(/^(?:(?:Google\s+)?Meet|Zoom(?:\s+Meeting)?|(?:Microsoft\s+)?Teams|Webex|Whereby|Around)\s*[-–—]\s*(.{3,80})$/i); if (m?.[1]) return cleanRecordingTitle(m[1]); }
  for (let i = 1; i < l.length; i++) if (/^now$/i.test(l[i]!)) return cleanRecordingTitle(l[i - 1]);
  for (let i = 0; i < l.length - 1; i++) if (/^(?:\d{1,2}:\d{2}\s*(?:AM|PM)?|\d{1,2}\s*(?:AM|PM))$/i.test(l[i]!)) return cleanRecordingTitle(l[i + 1]);
  const wt = cleanRecordingTitle(f.window_title); return wt && !/^(google meet|meet|zoom|zoom meeting|microsoft teams|teams|calendar|google chrome|profile|meeting|video call)$/i.test(wt) ? wt : null;
}

function cleanRecordingTitle(v?: string | null) { return v ? v.replace(/\s+[—–-]\s+(Google Chrome|Chrome|Mozilla Firefox|Firefox|Safari|Brave|Arc|Edge).*$/i, '').replace(/\s+/g, ' ').trim() || null : null; }

function parseSubtitles(i: string, k: 'vtt'|'srt'): TranscribeResult {
  const ts: ExtractedTurn[] = [], ps: string[] = []; let cl: string[] = [], cs: string | null = null, csm: number | null = null, cem: number | null = null;
  const f = () => { if (!cl.length) return; const b = cl.join(' ').replace(/\s+/g, ' ').trim(); if (b) { ps.push(cs ? `${cs}: ${b}` : b); if (csm !== null) ts.push({ offset_ms: csm, end_ms: cem ?? csm, speaker: cs, text: b, source: k }); } cl = []; cs = null; csm = null; cem = null; };
  for (const r of i.split(/\r?\n/)) {
    const l = r.trim(); if (!l) { f(); continue; }
    if (k === 'vtt' && (l === 'WEBVTT' || /^(NOTE|STYLE)/.test(l))) continue;
    if (/^\d+$/.test(l)) continue;
    const m = l.match(/(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[.,](\d{3})/);
    if (m) { csm = Number(m[1])*3600000 + Number(m[2])*60000 + Number(m[3])*1000 + Number(m[4]); cem = Number(m[5])*3600000 + Number(m[6])*60000 + Number(m[7])*1000 + Number(m[8]); continue; }
    if (k === 'vtt' && !cs) { const sm = l.match(/<v(?:\s+[^>]*?)?\s+([^>]+?)>/); if (sm) cs = sm[1]!.trim(); }
    const c = l.replace(/<[^>]+>/g, '').trim(); if (c) cl.push(c);
  }
  f(); return { text: ps.join('\n\n'), turns: ts };
}

function parseWhisperJson(r: string): ExtractedTurn[] {
  try { return ((JSON.parse(r) as any).segments || []).filter((s: any) => typeof s.start === 'number' && s.text).map((s: any) => ({ offset_ms: Math.round(s.start * 1000), end_ms: Math.round((s.end ?? s.start) * 1000), speaker: null, text: s.text.trim(), source: 'whisper' })); } catch { return []; }
}

function parseNativeChunkTimestamp(f: string): Date | null {
  const m = f.match(/^native-(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{3})/);
  if (!m) return null; const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), Number(m[7]));
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatBytes(b: number) { return b < 1024 ? `${b} B` : b < 1048576 ? `${(b/1024).toFixed(1)} KiB` : b < 1073741824 ? `${(b/1048576).toFixed(1)} MiB` : `${(b/1073741824).toFixed(2)} GiB`; }
async function uniquePath(c: string) { try { await fs.access(c); const p = path.parse(c); return path.join(p.dir, `${p.name}-${randomBytes(4).toString('hex')}${p.ext}`); } catch { return c; } }
