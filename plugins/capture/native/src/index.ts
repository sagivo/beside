import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import type {
  ICapture,
  CaptureStatus,
  CaptureConfig,
  RawEvent,
  RawEventHandler,
  PluginFactory,
  Logger,
} from '@cofounderos/interfaces';
import { expandPath } from '@cofounderos/core';
import { dHash, hashDiff } from './perceptual-hash.js';

interface NativeCaptureConfig {
  helper_path?: string;
  fixture?: boolean;
  restart_on_crash?: boolean;
  poll_interval_ms?: number;
  focus_settle_delay_ms?: number;
  screenshot_diff_threshold?: number;
  idle_threshold_sec?: number;
  screenshot_format?: 'webp' | 'jpeg';
  screenshot_quality?: number;
  screenshot_max_dim?: number;
  content_change_min_interval_ms?: number;
  jpeg_quality?: number;
  excluded_apps?: string[];
  excluded_url_patterns?: string[];
  capture_audio?: boolean;
  whisper_model?: string;
  audio?: {
    inbox_path?: string;
    processed_path?: string;
    failed_path?: string;
    tick_interval_sec?: number;
    batch_size?: number;
    whisper_command?: string;
    whisper_language?: string;
    live_recording?: {
      enabled?: boolean;
      chunk_seconds?: number;
      format?: 'm4a';
      sample_rate?: number;
      channels?: number;
      activation?: 'other_process_input';
      poll_interval_sec?: number;
    };
  };
  raw_root?: string;
  privacy?: {
    blur_password_fields?: boolean;
    pause_on_screen_lock?: boolean;
    sensitive_keywords?: string[];
  };
  multi_screen?: boolean;
  screens?: number[];
  capture_mode?: 'all' | 'active';
}

type HelperMessage =
  | { kind: 'ready'; platform?: string; arch?: string; capabilities?: string[] }
  | { kind: 'event'; event: RawEvent }
  | { kind: 'status'; cpuPercent?: number; memoryMB?: number; storageBytesToday?: number }
  | { kind: 'error'; code?: string; message: string; fatal?: boolean }
  | { kind: 'log'; level?: 'debug' | 'info' | 'warn' | 'error'; message: string; data?: unknown };

class NativeCapture implements ICapture {
  private readonly logger: Logger;
  private readonly config: Required<
    Omit<NativeCaptureConfig, 'helper_path' | 'screens' | 'privacy'>
  > & {
    helper_path?: string;
    screens?: number[];
    privacy: NonNullable<NativeCaptureConfig['privacy']>;
  };
  private readonly handlers = new Set<RawEventHandler>();
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = '';
  private running = false;
  private paused = false;
  private stopping = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private eventsToday = 0;
  private storageBytesToday = 0;
  private cpuPercent = 0;
  private memoryMB = 0;
  private readonly lastHashByScreen = new Map<number, string>();

  constructor(config: NativeCaptureConfig, logger: Logger) {
    this.logger = logger.child('capture-native');
    const format = config.screenshot_format ?? 'webp';
    const quality = config.screenshot_quality
      ?? (format === 'webp' ? 55 : config.jpeg_quality ?? 80);
    this.config = {
      helper_path: config.helper_path ? expandPath(config.helper_path) : undefined,
      fixture: config.fixture ?? process.env.COFOUNDEROS_CAPTURE_FIXTURE === '1',
      restart_on_crash: config.restart_on_crash ?? true,
      poll_interval_ms: config.poll_interval_ms ?? 1500,
      focus_settle_delay_ms: config.focus_settle_delay_ms ?? 900,
      screenshot_diff_threshold: config.screenshot_diff_threshold ?? 0.1,
      idle_threshold_sec: config.idle_threshold_sec ?? 60,
      screenshot_format: format,
      screenshot_quality: quality,
      screenshot_max_dim: config.screenshot_max_dim ?? 1280,
      content_change_min_interval_ms: config.content_change_min_interval_ms ?? 20_000,
      jpeg_quality: format === 'jpeg' ? quality : 80,
      excluded_apps: config.excluded_apps ?? [],
      excluded_url_patterns: config.excluded_url_patterns ?? [],
      capture_audio: config.capture_audio ?? false,
      whisper_model: config.whisper_model ?? 'base',
      audio: {
        inbox_path: expandPath(config.audio?.inbox_path ?? '~/.cofounderOS/raw/audio/inbox'),
        processed_path: expandPath(config.audio?.processed_path ?? '~/.cofounderOS/raw/audio/processed'),
        failed_path: expandPath(config.audio?.failed_path ?? '~/.cofounderOS/raw/audio/failed'),
        tick_interval_sec: config.audio?.tick_interval_sec ?? 60,
        batch_size: config.audio?.batch_size ?? 5,
        whisper_command: config.audio?.whisper_command ?? 'whisper',
        whisper_language: config.audio?.whisper_language,
        live_recording: {
          enabled: config.audio?.live_recording?.enabled ?? false,
          chunk_seconds: config.audio?.live_recording?.chunk_seconds ?? 300,
          format: config.audio?.live_recording?.format ?? 'm4a',
          sample_rate: config.audio?.live_recording?.sample_rate ?? 16_000,
          channels: config.audio?.live_recording?.channels ?? 1,
        },
      },
      raw_root: expandPath(config.raw_root ?? '~/.cofounderOS'),
      privacy: config.privacy ?? {
        blur_password_fields: true,
        pause_on_screen_lock: true,
        sensitive_keywords: ['password', 'api_key', 'secret'],
      },
      multi_screen: config.multi_screen ?? false,
      screens: config.screens,
      capture_mode: config.capture_mode ?? 'active',
    };
  }

  onEvent(handler: RawEventHandler): void {
    this.handlers.add(handler);
  }

  getStatus(): CaptureStatus {
    return {
      running: this.running,
      paused: this.paused,
      eventsToday: this.eventsToday,
      storageBytesToday: this.storageBytesToday,
      cpuPercent: this.cpuPercent,
      memoryMB: this.memoryMB || Math.round(process.memoryUsage().rss / (1024 * 1024)),
    };
  }

  getConfig(): CaptureConfig {
    return {
      pluginName: 'native',
      poll_interval_ms: this.config.poll_interval_ms,
      focus_settle_delay_ms: this.config.focus_settle_delay_ms,
      screenshot_diff_threshold: this.config.screenshot_diff_threshold,
      idle_threshold_sec: this.config.idle_threshold_sec,
      screenshot_format: this.config.screenshot_format,
      screenshot_quality: this.config.screenshot_quality,
      screenshot_max_dim: this.config.screenshot_max_dim,
      content_change_min_interval_ms: this.config.content_change_min_interval_ms,
      jpeg_quality: this.config.jpeg_quality,
      excluded_apps: this.config.excluded_apps,
      excluded_url_patterns: this.config.excluded_url_patterns,
      capture_audio: this.config.capture_audio,
      privacy: {
        blur_password_fields: this.config.privacy.blur_password_fields ?? true,
        pause_on_screen_lock: this.config.privacy.pause_on_screen_lock ?? true,
        sensitive_keywords: this.config.privacy.sensitive_keywords ?? [],
      },
      raw_root: this.config.raw_root,
    };
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.stopping = false;
    this.spawnHelper();
    this.running = true;
    this.paused = false;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.running = false;
    this.paused = false;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    this.child = null;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
        resolve();
      }, 1500);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.stdin.write(JSON.stringify({ kind: 'stop' }) + '\n');
      child.stdin.end();
    });
  }

  async pause(): Promise<void> {
    this.paused = true;
    this.send({ kind: 'pause' });
  }

  async resume(): Promise<void> {
    this.paused = false;
    this.send({ kind: 'resume' });
  }

  private spawnHelper(): void {
    const helper = this.resolveHelperPath();
    const args = ['--config-json', JSON.stringify(this.helperConfig())];
    if (this.config.fixture) args.push('--fixture');

    this.logger.info(`starting native capture helper: ${helper}`);
    const child = spawn(helper, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        COFOUNDEROS_RAW_ROOT: this.config.raw_root,
      },
    });
    this.child = child;
    this.stdoutBuffer = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/).filter(Boolean)) {
        this.logger.debug(`[native stderr] ${line}`);
      }
    });
    child.on('error', (err) => {
      this.logger.error('native capture helper failed to start', { err: String(err) });
    });
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = null;
      if (this.stopping) return;
      this.running = false;
      this.logger.warn(`native capture helper exited (code=${code}, signal=${signal})`);
      if (this.config.restart_on_crash) {
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          if (!this.stopping) {
            this.spawnHelper();
            this.running = true;
          }
        }, 2000);
      }
    });
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    while (true) {
      const idx = this.stdoutBuffer.indexOf('\n');
      if (idx === -1) break;
      const line = this.stdoutBuffer.slice(0, idx).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1);
      if (!line) continue;
      this.handleLine(line).catch((err) => {
        this.logger.warn('native message handling failed', { err: String(err), line });
      });
    }
  }

  private async handleLine(line: string): Promise<void> {
    let msg: HelperMessage;
    try {
      msg = JSON.parse(line) as HelperMessage;
    } catch (err) {
      this.logger.warn('native helper emitted invalid JSON', { err: String(err), line });
      return;
    }

    switch (msg.kind) {
      case 'ready':
        this.logger.info(
          `native helper ready (${msg.platform ?? process.platform}/${msg.arch ?? process.arch})`,
          { capabilities: msg.capabilities ?? [] },
        );
        break;
      case 'event':
        {
          const event = await this.prepareEvent(msg.event);
          if (event) await this.emit(event);
        }
        break;
      case 'status':
        if (typeof msg.cpuPercent === 'number') this.cpuPercent = msg.cpuPercent;
        if (typeof msg.memoryMB === 'number') this.memoryMB = msg.memoryMB;
        if (typeof msg.storageBytesToday === 'number') {
          this.storageBytesToday = msg.storageBytesToday;
        }
        break;
      case 'error':
        this.logger[msg.fatal ? 'error' : 'warn'](msg.message, {
          code: msg.code,
          fatal: msg.fatal,
        });
        break;
      case 'log':
        this.logger[msg.level ?? 'info'](msg.message, { data: msg.data });
        break;
    }
  }

  private async emit(event: RawEvent): Promise<void> {
    this.eventsToday += 1;
    if (typeof event.metadata?.bytes === 'number') {
      this.storageBytesToday += event.metadata.bytes;
    }
    for (const handler of this.handlers) {
      await handler(event);
    }
  }

  private async prepareEvent(event: RawEvent): Promise<RawEvent | null> {
    if (event.type !== 'screenshot' || !event.asset_path) return event;
    try {
      return await this.postProcessScreenshot(event);
    } catch (err) {
      this.logger.warn('native screenshot post-processing failed; emitting original asset', {
        err: String(err),
        asset_path: event.asset_path,
      });
      return event;
    }
  }

  private async postProcessScreenshot(event: RawEvent): Promise<RawEvent | null> {
    if (!event.asset_path) return event;
    const originalAbs = path.isAbsolute(event.asset_path)
      ? event.asset_path
      : path.join(this.config.raw_root, event.asset_path);
    const input = await fs.readFile(originalAbs);
    const phash = await dHash(input);
    const previous = this.lastHashByScreen.get(event.screen_index);
    const diff = hashDiff(previous ?? null, phash);
    const trigger = typeof event.metadata?.trigger === 'string' ? event.metadata.trigger : null;

    let output: Buffer = Buffer.from(input);
    let assetPath = event.asset_path;
    let actualFormat = inferFormat(assetPath);
    if (this.config.screenshot_format === 'webp') {
      output = Buffer.from(await sharp(input)
        .resize({
          width: this.config.screenshot_max_dim,
          height: this.config.screenshot_max_dim,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: this.config.screenshot_quality })
        .toBuffer());
      const nextAssetPath = replaceExtension(assetPath, '.webp');
      const nextAbs = path.isAbsolute(nextAssetPath)
        ? nextAssetPath
        : path.join(this.config.raw_root, nextAssetPath);
      await fs.writeFile(nextAbs, output);
      if (nextAbs !== originalAbs) {
        await fs.rm(originalAbs, { force: true });
      }
      assetPath = nextAssetPath;
      actualFormat = 'webp';
    } else {
      output = Buffer.from(await sharp(input)
        .resize({
          width: this.config.screenshot_max_dim,
          height: this.config.screenshot_max_dim,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality: this.config.screenshot_quality })
        .toBuffer());
      await fs.writeFile(originalAbs, output);
      actualFormat = 'jpeg';
    }

    if (trigger === 'content_change' && diff < this.config.screenshot_diff_threshold) {
      const finalAbs = path.isAbsolute(assetPath)
        ? assetPath
        : path.join(this.config.raw_root, assetPath);
      await fs.rm(finalAbs, { force: true });
      this.logger.debug(
        `skip native content_change screenshot (diff ${diff.toFixed(3)} < ${this.config.screenshot_diff_threshold})`,
      );
      return null;
    }

    this.lastHashByScreen.set(event.screen_index, phash);

    return {
      ...event,
      asset_path: assetPath,
      metadata: {
        ...event.metadata,
        perceptual_hash: phash,
        hash_diff_from_previous: diff,
        bytes: output.byteLength,
        postprocessed_by: 'capture-native-shim',
        requested_format: this.config.screenshot_format,
        actual_format: actualFormat,
      },
    };
  }

  private send(msg: Record<string, unknown>): void {
    if (!this.child || this.child.stdin.destroyed) return;
    this.child.stdin.write(JSON.stringify(msg) + '\n');
  }

  private helperConfig(): Record<string, unknown> {
    return {
      ...this.config,
      privacy: this.config.privacy,
    };
  }

  private resolveHelperPath(): string {
    if (this.config.helper_path) return this.config.helper_path;
    const here = path.dirname(fileURLToPath(import.meta.url));
    const exe = process.platform === 'win32' ? 'cofounderos-capture.exe' : 'cofounderos-capture';
    const platformArch = `${process.platform}-${process.arch}`;
    return path.resolve(here, 'native', platformArch, exe);
  }
}

const factory: PluginFactory<ICapture> = (ctx) => {
  return new NativeCapture((ctx.config as NativeCaptureConfig) ?? {}, ctx.logger);
};

function replaceExtension(assetPath: string, ext: string): string {
  const parsed = path.parse(assetPath);
  return path.join(parsed.dir, `${parsed.name}${ext}`);
}

function inferFormat(assetPath: string): 'jpeg' | 'webp' {
  return assetPath.toLowerCase().endsWith('.webp') ? 'webp' : 'jpeg';
}

export default factory;
export { NativeCapture };
