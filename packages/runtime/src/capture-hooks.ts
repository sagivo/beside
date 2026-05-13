import { createHash } from 'node:crypto';
import type {
  CaptureHookContext,
  CaptureHookDefinition,
  CaptureHookHandler,
  CaptureHookInput,
  CaptureHookMatcher,
  CaptureHookScreenInput,
  CaptureHookAudioInput,
  HookRecord,
  HookRecordQuery,
  IHookPlugin,
  IHookStorageNamespace,
  IModelAdapter,
  IStorage,
  Logger,
  RawEvent,
} from '@beside/interfaces';
import type { BesideConfig, RawEventBus } from '@beside/core';

const SCREEN_INPUT_KINDS: ReadonlyArray<'screen' | 'audio'> = ['screen'];

export interface CaptureHookEngineOptions {
  bus: RawEventBus;
  storage: IStorage;
  model: IModelAdapter;
  logger: Logger;
  config: BesideConfig;
  dataDir: string;
}

interface RegisteredHook {
  pluginName: string;
  definition: CaptureHookDefinition;
  handler?: CaptureHookHandler;
}

interface QueueJob {
  hook: RegisteredHook;
  input: CaptureHookInput;
  catchup?: boolean;
}

export interface CaptureHookDiagnostics {
  hookId: string;
  pluginName: string;
  hasHandler: boolean;
  matched: number;
  throttled: number;
  ran: number;
  stored: number;
  failed: number;
  skipped: number;
  lastMatchedAt: string | null;
  lastStoredAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  lastSkipReason: string | null;
  lastSkipAt: string | null;
  enabled: boolean;
}

interface HookStats {
  matched: number;
  throttled: number;
  ran: number;
  stored: number;
  failed: number;
  skipped: number;
  lastMatchedAt: string | null;
  lastStoredAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  lastSkipReason: string | null;
  lastSkipAt: string | null;
}

function emptyStats(): HookStats {
  return {
    matched: 0,
    throttled: 0,
    ran: 0,
    stored: 0,
    failed: 0,
    skipped: 0,
    lastMatchedAt: null,
    lastStoredAt: null,
    lastError: null,
    lastErrorAt: null,
    lastSkipReason: null,
    lastSkipAt: null,
  };
}

/**
 * CaptureHookEngine — post-capture extensibility layer.
 *
 * Subscribes to the raw event bus, builds a `CaptureHookInput` envelope
 * with raw screenshot bytes + OCR text (for screen events) or raw audio
 * bytes + transcript (for audio events), and dispatches matching events
 * to registered hooks. Hook handlers run in a small async worker queue
 * so a slow LLM call never blocks the capture pipeline.
 */
export class CaptureHookEngine {
  private readonly bus: RawEventBus;
  private readonly storage: IStorage;
  private readonly model: IModelAdapter;
  private readonly logger: Logger;
  private readonly config: BesideConfig;
  private readonly hooks: RegisteredHook[] = [];
  private unsubscribe: (() => void) | null = null;
  private readonly throttleState = new Map<string, number>();
  private readonly listeners = new Set<(hookId: string) => void>();
  private readonly queue: QueueJob[] = [];
  private running = false;
  private stopped = false;
  private readonly maxImageBytes: number;
  private readonly maxPromptChars: number;
  private readonly catchupLookbackMs: number;
  private readonly catchupEventsLimit: number;
  private readonly catchupRunsPerHook: number;
  private readonly stats = new Map<string, HookStats>();

  constructor(opts: CaptureHookEngineOptions) {
    this.bus = opts.bus;
    this.storage = opts.storage;
    this.model = opts.model;
    this.logger = opts.logger.child('capture-hooks');
    this.config = opts.config;
    this.maxImageBytes = opts.config.hooks?.max_image_bytes ?? 2 * 1024 * 1024;
    this.maxPromptChars = opts.config.hooks?.max_prompt_chars ?? 14_000;
    const hooksConfig = opts.config.hooks as
      | (BesideConfig['hooks'] & {
          catchup_lookback_hours?: number;
          catchup_events_limit?: number;
          catchup_runs_per_hook?: number;
        })
      | undefined;
    this.catchupLookbackMs = Math.max(
      0,
      (hooksConfig?.catchup_lookback_hours ?? 12) * 60 * 60 * 1000,
    );
    this.catchupEventsLimit = Math.max(0, hooksConfig?.catchup_events_limit ?? 500);
    this.catchupRunsPerHook = Math.max(0, hooksConfig?.catchup_runs_per_hook ?? 30);
  }

  /** Register a hook plugin and its definitions. */
  async register(plugin: IHookPlugin): Promise<void> {
    const defs = await Promise.resolve(plugin.definitions()).catch((err) => {
      this.logger.warn('hook plugin failed to provide definitions', {
        plugin: plugin.name,
        err: String(err),
      });
      return [] as CaptureHookDefinition[];
    });
    for (const def of defs) {
      this.hooks.push({
        pluginName: plugin.name,
        definition: def,
        handler: plugin.handle?.bind(plugin),
      });
      this.stats.set(def.id, emptyStats());
      this.logger.info('registered hook', {
        plugin: plugin.name,
        id: def.id,
        hasHandler: typeof plugin.handle === 'function',
      });
    }
  }

  /** Register a config-defined hook with no custom handler (uses the LLM fallback). */
  registerDefinition(def: CaptureHookDefinition): void {
    this.hooks.push({ pluginName: 'config', definition: def });
    this.stats.set(def.id, emptyStats());
    this.logger.info('registered config hook', { id: def.id });
  }

  /** Per-hook diagnostic counters. Updated as the engine processes events. */
  getDiagnostics(): CaptureHookDiagnostics[] {
    return this.hooks.map((h) => {
      const s = this.stats.get(h.definition.id) ?? emptyStats();
      return {
        hookId: h.definition.id,
        pluginName: h.pluginName,
        hasHandler: typeof h.handler === 'function',
        matched: s.matched,
        throttled: s.throttled,
        ran: s.ran,
        stored: s.stored,
        failed: s.failed,
        skipped: s.skipped,
        lastMatchedAt: s.lastMatchedAt,
        lastStoredAt: s.lastStoredAt,
        lastError: s.lastError,
        lastErrorAt: s.lastErrorAt,
        lastSkipReason: s.lastSkipReason,
        lastSkipAt: s.lastSkipAt,
        enabled: true,
      };
    });
  }

  private bumpStat(
    hookId: string,
    mutate: (s: HookStats) => void,
  ): void {
    const s = this.stats.get(hookId) ?? emptyStats();
    mutate(s);
    this.stats.set(hookId, s);
  }

  private recordSkip(hookId: string, reason: string): void {
    this.bumpStat(hookId, (s) => {
      s.skipped += 1;
      s.lastSkipReason = reason;
      s.lastSkipAt = new Date().toISOString();
    });
    this.logger.info('hook skipped', { hookId, reason });
  }

  /** List all registered hook definitions. */
  listDefinitions(): CaptureHookDefinition[] {
    return this.hooks.map((h) => h.definition);
  }

  onUpdate(listener: (hookId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.unsubscribe || this.stopped) return;
    this.logger.info('starting capture hook engine', {
      hooks: this.hooks.length,
      hookIds: this.hooks.map((h) => h.definition.id),
    });
    this.unsubscribe = this.bus.on((event) => {
      void this.onEvent(event);
    });
    void this.catchUpRecentCaptures();
  }

  stop(): void {
    this.stopped = true;
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.queue.length = 0;
  }

  /** Read records for a hook (used by runtime APIs that the renderer hits). */
  async queryRecords(hookId: string, query: HookRecordQuery = {}): Promise<HookRecord[]> {
    if (typeof this.storage.hookList !== 'function') return [];
    return await this.storage.hookList(hookId, query);
  }

  /** Allow the renderer to mutate a record in a hook namespace via the runtime bridge. */
  async mutateRecord(
    hookId: string,
    mutation: {
      collection: string;
      id: string;
      data: unknown;
      evidenceEventIds?: string[];
      contentHash?: string | null;
    },
  ): Promise<HookRecord | null> {
    if (!this.hooks.some((h) => h.definition.id === hookId)) {
      throw new Error(`Unknown hook: ${hookId}`);
    }
    if (mutation.data === null) {
      if (typeof this.storage.hookDelete === 'function') {
        await this.storage.hookDelete(hookId, mutation.collection, mutation.id);
      }
      this.notify(hookId);
      return null;
    }
    if (typeof this.storage.hookPut !== 'function') return null;
    const record = await this.storage.hookPut(hookId, mutation);
    this.notify(hookId);
    return record;
  }

  // ---------------------------------------------------------------------
  // Event processing
  // ---------------------------------------------------------------------

  private async onEvent(event: RawEvent): Promise<void> {
    if (this.stopped) return;
    if (event.type !== 'screenshot' && event.type !== 'audio_transcript') return;

    const matching = this.hooks.filter((h) =>
      this.matchesEvent(h.definition, event),
    );
    if (matching.length === 0) return;

    let input: CaptureHookInput | null = null;
    try {
      input = await this.buildInput(event);
    } catch (err) {
      this.logger.debug('failed to build hook input', { err: String(err), eventId: event.id });
      return;
    }
    if (!input) return;

    for (const hook of matching) {
      if (!this.matchesInput(hook.definition, input)) continue;
      const throttleKey = this.throttleKeyFor(hook.definition, input);
      const now = Date.now();
      const throttleMs =
        hook.definition.throttleMs ?? this.config.hooks?.throttle_ms_default ?? 60_000;
      const last = this.throttleState.get(throttleKey) ?? 0;
      this.bumpStat(hook.definition.id, (s) => {
        s.matched += 1;
        s.lastMatchedAt = new Date().toISOString();
      });
      if (now - last < throttleMs) {
        this.bumpStat(hook.definition.id, (s) => {
          s.throttled += 1;
        });
        this.logger.debug('hook throttled', {
          hookId: hook.definition.id,
          waitMs: throttleMs - (now - last),
        });
        continue;
      }
      this.throttleState.set(throttleKey, now);

      this.logger.info('hook matched capture', {
        hookId: hook.definition.id,
        kind: input.kind,
        app: input.app,
        url: input.kind === 'screen' ? input.url : null,
        textLen: input.kind === 'screen' ? input.ocrText.length : input.transcript.length,
      });
      this.enqueue({ hook, input });
    }
  }

  private enqueue(job: QueueJob): void {
    this.queue.push(job);
    void this.pump();
  }

  private async catchUpRecentCaptures(): Promise<void> {
    if (this.catchupLookbackMs <= 0 || this.catchupEventsLimit <= 0 || this.catchupRunsPerHook <= 0) {
      return;
    }
    const from = new Date(Date.now() - this.catchupLookbackMs).toISOString();
    let events: RawEvent[] = [];
    try {
      events = await this.storage.readEvents({
        from,
        types: ['screenshot', 'audio_transcript'],
        limit: this.catchupEventsLimit,
      });
    } catch (err) {
      this.logger.debug('hook catch-up failed to read recent events', { err: String(err) });
      return;
    }

    const enqueuedByHook = new Map<string, number>();
    for (const event of events.reverse()) {
      if (this.stopped) return;
      const matching = this.hooks.filter((h) => this.matchesEvent(h.definition, event));
      if (matching.length === 0) continue;

      let input: CaptureHookInput | null = null;
      try {
        input = await this.buildInput(event);
      } catch (err) {
        this.logger.debug('failed to build hook catch-up input', {
          err: String(err),
          eventId: event.id,
        });
        continue;
      }
      if (!input) continue;

      for (const hook of matching) {
        const count = enqueuedByHook.get(hook.definition.id) ?? 0;
        if (count >= this.catchupRunsPerHook) continue;
        if (!this.matchesInput(hook.definition, input)) continue;
        const throttleKey = this.throttleKeyFor(hook.definition, input);
        if (this.throttleState.has(throttleKey)) continue;
        this.throttleState.set(throttleKey, Date.now());
        enqueuedByHook.set(hook.definition.id, count + 1);
        this.bumpStat(hook.definition.id, (s) => {
          s.matched += 1;
          s.lastMatchedAt = new Date().toISOString();
        });
        this.enqueue({ hook, input, catchup: true });
      }
    }
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length && !this.stopped) {
        const job = this.queue.shift()!;
        try {
          await this.runJob(job);
        } catch (err) {
          this.logger.warn('hook job failed', {
            hookId: job.hook.definition.id,
            err: String(err),
          });
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async runJob(job: QueueJob): Promise<void> {
    const { hook, input } = job;
    const namespace = this.namespaceFor(hook.definition.id);
    const ctx: CaptureHookContext = {
      hookId: hook.definition.id,
      storage: namespace,
      model: this.model,
      logger: this.logger.child(hook.definition.id),
      config: { catchup: job.catchup === true },
      readAsset: (assetPath: string) => this.storage.readAsset(assetPath),
      skip: (reason: string) => this.recordSkip(hook.definition.id, reason),
    };

    this.bumpStat(hook.definition.id, (s) => {
      s.ran += 1;
    });
    this.logger.info('hook running', {
      hookId: hook.definition.id,
      kind: input.kind,
      hasHandler: typeof hook.handler === 'function',
    });

    try {
      if (hook.handler) {
        await hook.handler(input, ctx);
      } else {
        await this.runDefaultLlmHandler(hook.definition, input, ctx);
      }
      this.notify(hook.definition.id);
    } catch (err) {
      this.bumpStat(hook.definition.id, (s) => {
        s.failed += 1;
        s.lastError = err instanceof Error ? err.message : String(err);
        s.lastErrorAt = new Date().toISOString();
      });
      this.logger.warn('hook handler threw', {
        hookId: hook.definition.id,
        err: String(err),
      });
    }
  }

  private async runDefaultLlmHandler(
    definition: CaptureHookDefinition,
    input: CaptureHookInput,
    ctx: CaptureHookContext,
  ): Promise<void> {
    const ready = await this.model.isAvailable().catch(() => false);
    if (!ready) {
      this.recordSkip(definition.id, 'model unavailable');
      return;
    }
    const prompt = buildDefaultPrompt(definition, input, this.maxPromptChars);
    const systemPrompt =
      definition.systemPrompt ??
      'You analyze a single captured screen or audio moment and return strict JSON. Output only the JSON object, no prose.';

    const modelInfo = this.model.getModelInfo();
    const useVision =
      input.kind === 'screen' &&
      definition.needsVision !== false &&
      !!input.imageBytes &&
      modelInfo.supportsVision;

    let raw = '';
    try {
      if (useVision) {
        raw = await this.model.completeWithVision(
          prompt,
          [(input as CaptureHookScreenInput).imageBytes!],
          { systemPrompt, temperature: 0.2, maxTokens: 1200, responseFormat: 'json' },
        );
      } else {
        raw = await this.model.complete(prompt, {
          systemPrompt,
          temperature: 0.2,
          maxTokens: 1200,
          responseFormat: 'json',
        });
      }
    } catch (err) {
      this.bumpStat(definition.id, (s) => {
        s.failed += 1;
        s.lastError = err instanceof Error ? err.message : String(err);
        s.lastErrorAt = new Date().toISOString();
      });
      this.logger.warn('hook llm call failed', {
        hookId: definition.id,
        useVision,
        err: String(err),
      });
      return;
    }

    this.logger.info('hook llm responded', {
      hookId: definition.id,
      useVision,
      bytes: raw.length,
    });

    const parsed = safeParseJsonObject(raw);
    if (!parsed) {
      const sample = raw.trim().slice(0, 120).replace(/\s+/g, ' ');
      this.recordSkip(
        definition.id,
        `LLM response was not parseable JSON (got: ${sample || 'empty'}…)`,
      );
      this.logger.warn('hook llm returned non-JSON', {
        hookId: definition.id,
        sample: raw.slice(0, 200),
      });
      return;
    }
    if (Object.keys(parsed).length === 0) {
      this.recordSkip(definition.id, 'LLM returned empty JSON object');
      return;
    }

    const collection = definition.outputCollection ?? 'records';
    const contentHash = sha1(JSON.stringify(parsed));
    const recordId = `${input.event.id}_${contentHash.slice(0, 10)}`;
    await ctx.storage.put({
      collection,
      id: recordId,
      data: parsed,
      evidenceEventIds: [input.event.id, ...(input.frameId ? [input.frameId] : [])],
      contentHash,
    });
    // ctx.storage.put already increments `stored` and logs success.
  }

  // ---------------------------------------------------------------------
  // Matching / filtering
  // ---------------------------------------------------------------------

  private matchesEvent(definition: CaptureHookDefinition, event: RawEvent): boolean {
    const inputKinds = definition.match.inputKinds ?? SCREEN_INPUT_KINDS;
    if (event.type === 'screenshot' && !inputKinds.includes('screen')) return false;
    if (event.type === 'audio_transcript' && !inputKinds.includes('audio')) return false;

    const m = definition.match;

    // Surface-identifying matchers are OR'd: a hook fires when ANY of
    // the configured matchers identifies the surface (e.g. Apple Calendar
    // matches `apps` while Google Calendar in Chrome matches `urlHosts`).
    // If a hook supplies NO surface matchers, it accepts every capture
    // of the right `inputKinds`.
    const hasSurfaceMatchers =
      !!m.apps?.length ||
      !!m.appBundleIds?.length ||
      !!m.windowTitles?.length ||
      !!m.urlHosts?.length ||
      !!m.urlPatterns?.length;

    if (hasSurfaceMatchers) {
      const surfaceHit =
        (m.apps?.length ? anyIncludes(event.app, m.apps) : false) ||
        (m.appBundleIds?.length ? anyIncludes(event.app_bundle_id, m.appBundleIds) : false) ||
        (m.windowTitles?.length ? anyIncludes(event.window_title, m.windowTitles) : false) ||
        (m.urlHosts?.length ? urlHostMatches(event.url, m.urlHosts) : false) ||
        (m.urlPatterns?.length ? urlPatternMatches(event.url, m.urlPatterns) : false);
      if (!surfaceHit) return false;
    }

    // textIncludes runs in matchesInput() once we have OCR / transcript text.
    return true;
  }

  private matchesInput(definition: CaptureHookDefinition, input: CaptureHookInput): boolean {
    const m = definition.match;
    if (m.textIncludes?.length) {
      const text =
        input.kind === 'screen' ? input.ocrText : input.transcript;
      if (!text) return false;
      const lower = text.toLowerCase();
      if (!m.textIncludes.some((needle) => lower.includes(needle.toLowerCase()))) return false;
    }
    return true;
  }

  private throttleKeyFor(definition: CaptureHookDefinition, input: CaptureHookInput): string {
    const surfaceText = input.kind === 'screen' ? input.ocrText : input.transcript;
    const surfaceTextHash = sha1(surfaceText ?? '').slice(0, 12);
    const url = input.kind === 'screen' ? input.url ?? '' : '';
    return `${definition.id}|${input.app}|${input.windowTitle}|${url}|${surfaceTextHash}`;
  }

  // ---------------------------------------------------------------------
  // Input building
  // ---------------------------------------------------------------------

  private async buildInput(event: RawEvent): Promise<CaptureHookInput | null> {
    if (event.type === 'screenshot') {
      return await this.buildScreenInput(event);
    }
    if (event.type === 'audio_transcript') {
      return this.buildAudioInput(event);
    }
    return null;
  }

  private async buildScreenInput(event: RawEvent): Promise<CaptureHookScreenInput> {
    let imageBytes: Buffer | null = null;
    if (event.asset_path) {
      try {
        const buf = await this.storage.readAsset(event.asset_path);
        if (buf.byteLength <= this.maxImageBytes) imageBytes = buf;
      } catch (err) {
        this.logger.debug('asset read failed', {
          assetPath: event.asset_path,
          err: String(err),
        });
      }
    }

    // Pull OCR/AX text from the frame the screenshot event was rolled up into,
    // if any. Frame ids are derived from screenshot event ids by the frame
    // builder (`evt_...` -> `frm_...`); `getFrameContext` expects that frame id,
    // not the raw event id.
    let ocrText = '';
    let textSource: import('@beside/interfaces').FrameTextSource | null = null;
    let frameId: string | null = null;
    try {
      const derivedFrameId = event.id.startsWith('evt_')
        ? `frm_${event.id.slice(4)}`
        : event.id;
      const ctx = await this.storage.getFrameContext(derivedFrameId, 0, 0).catch(() => null);
      const frame = ctx?.anchor;
      if (frame) {
        frameId = frame.id;
        ocrText = (frame.text ?? '').trim();
        textSource = frame.text_source ?? null;
      }
    } catch {
      // Frame not built yet — that's fine.
    }
    if (!ocrText && typeof event.content === 'string') ocrText = event.content.trim();

    return {
      kind: 'screen',
      event,
      imageBytes,
      assetPath: event.asset_path,
      ocrText,
      textSource,
      app: event.app ?? '',
      appBundleId: event.app_bundle_id ?? '',
      windowTitle: event.window_title ?? '',
      url: event.url,
      frameId,
    };
  }

  private buildAudioInput(event: RawEvent): CaptureHookAudioInput {
    const meta = (event.metadata ?? {}) as Record<string, unknown>;
    const transcript = pickString(event.content, meta.text, meta.transcript) ?? '';
    const startedAt = pickString(meta.started_at, event.timestamp) ?? event.timestamp;
    const endedAt = pickString(meta.ended_at) ?? null;
    const durationMs = typeof event.duration_ms === 'number' ? event.duration_ms : null;

    return {
      kind: 'audio',
      event,
      audioBytes: null,
      audioAssetPath: event.asset_path,
      transcript,
      startedAt,
      endedAt,
      durationMs,
      app: event.app ?? '',
      windowTitle: event.window_title ?? '',
      url: event.url,
      frameId: null,
    };
  }

  // ---------------------------------------------------------------------
  // Per-hook storage namespace
  // ---------------------------------------------------------------------

  private namespaceFor(hookId: string): IHookStorageNamespace {
    const storage = this.storage;
    const bumpStored = () =>
      this.bumpStat(hookId, (s) => {
        s.stored += 1;
        s.lastStoredAt = new Date().toISOString();
      });
    const log = this.logger.child(hookId);
    return {
      hookId,
      async put(rec) {
        if (typeof storage.hookPut !== 'function') throw new Error('hook storage unavailable');
        const result = await storage.hookPut(hookId, rec);
        bumpStored();
        log.info('hook stored record', { collection: rec.collection, recordId: rec.id });
        return result;
      },
      async get(collection, id) {
        if (typeof storage.hookGet !== 'function') return null;
        return await storage.hookGet(hookId, collection, id);
      },
      async delete(collection, id) {
        if (typeof storage.hookDelete !== 'function') return;
        await storage.hookDelete(hookId, collection, id);
      },
      async list(query) {
        if (typeof storage.hookList !== 'function') return [];
        return await storage.hookList(hookId, query);
      },
      async clear(collection) {
        if (typeof storage.hookClear !== 'function') return { removed: 0 };
        return await storage.hookClear(hookId, collection);
      },
    };
  }

  private notify(hookId: string): void {
    for (const cb of this.listeners) {
      try {
        cb(hookId);
      } catch {
        /* ignored */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildDefaultPrompt(
  definition: CaptureHookDefinition,
  input: CaptureHookInput,
  maxChars: number,
): string {
  const head = definition.promptTemplate?.trim() ||
    'Analyze this captured moment and extract any actionable items as strict JSON.';
  const body =
    input.kind === 'screen'
      ? [
          `App: ${input.app}`,
          input.windowTitle ? `Window: ${input.windowTitle}` : '',
          input.url ? `URL: ${input.url}` : '',
          input.ocrText ? `OCR/Accessibility text:\n${input.ocrText}` : 'OCR text unavailable.',
        ].filter(Boolean).join('\n')
      : [
          `App: ${input.app}`,
          input.windowTitle ? `Window: ${input.windowTitle}` : '',
          input.startedAt ? `Started: ${input.startedAt}` : '',
          input.durationMs ? `Duration ms: ${input.durationMs}` : '',
          input.transcript ? `Transcript:\n${input.transcript}` : 'Transcript empty.',
        ].filter(Boolean).join('\n');
  const composed = `${head}\n\n${body}\n\nReturn STRICT JSON only.`;
  return composed.length > maxChars
    ? `${composed.slice(0, Math.max(0, maxChars - 3))}...`
    : composed;
}

function safeParseJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first < 0 || last <= first) return null;
  try {
    const parsed = JSON.parse(trimmed.slice(first, last + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function anyIncludes(haystack: string | null | undefined, needles: string[]): boolean {
  if (!haystack) return false;
  const lower = haystack.toLowerCase();
  return needles.some((needle) => {
    const n = needle.toLowerCase();
    if (n.startsWith('/') && n.endsWith('/') && n.length > 2) {
      try {
        return new RegExp(needle.slice(1, -1), 'i').test(haystack);
      } catch {
        return lower.includes(n);
      }
    }
    return lower.includes(n);
  });
}

function safeHost(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

function urlHostMatches(url: string | null, hosts: string[]): boolean {
  const host = safeHost(url);
  if (!host) return false;
  return hosts.some((needle) => {
    const n = needle.toLowerCase();
    return host === n || host.endsWith(`.${n}`) || host.includes(n);
  });
}

function urlPatternMatches(url: string | null, patterns: string[]): boolean {
  if (!url) return false;
  return patterns.some((p) => {
    try {
      return new RegExp(p, 'i').test(url);
    } catch {
      return false;
    }
  });
}

function pickString(...candidates: unknown[]): string | null {
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return null;
}

function sha1(value: string): string {
  return createHash('sha1').update(value).digest('hex');
}
