import type {
  IModelAdapter,
  ModelInfo,
  CompletionOptions,
  PluginFactory,
  Logger,
  ModelBootstrapHandler,
} from '@cofounderos/interfaces';
import { Ollama } from 'ollama';
import {
  installOllamaMacOS,
  installOllamaUnixLike,
  installOllamaWindows,
  isOllamaReachable,
  manualInstallHint,
  ollamaCommandExists,
  startOllamaDaemon,
  waitForOllama,
} from './bootstrap.js';

interface OllamaModelConfig {
  host?: string;
  model?: string;
  embedding_model?: string;
  vision_model?: string;
  keep_alive?: string | number;
  unload_after_idle_min?: number;
  /** Skip the auto-install + auto-pull bootstrap on first run. */
  auto_install?: boolean;
}

// Ollama itself binds to 127.0.0.1 by default. Using the same literal
// (rather than 'localhost') avoids surprises on hosts where 'localhost'
// resolves to ::1 first while Ollama is only listening on v4.
const DEFAULT_HOST = 'http://127.0.0.1:11434';
const DEFAULT_MODEL = 'gemma4:e4b';
const DEFAULT_EMBEDDING_MODEL = 'nomic-embed-text';
const DEFAULT_KEEP_ALIVE = '30s';
const DEFAULT_UNLOAD_AFTER_IDLE_MIN = 2;
const SERVER_READY_TIMEOUT_MS = 60_000;
const PULL_FAMILIES_VISION_OK = ['gemma3', 'gemma4', 'llava', 'llama4', 'qwen2-vl'];

// Per-request HTTP timeouts. Without these, a wedged ollama connection
// (server crash mid-request, OS-level keep-alive desync, etc.) deadlocks
// every caller forever — `EmbeddingWorker.drain` loops up to 10,000x
// awaiting a single fetch, so one stuck request hangs the whole reindex.
// `EMBED` is small (sub-second normally); `COMPLETE` accommodates the
// occasional 8B-param summarisation call on CPU/MPS.
const EMBED_TIMEOUT_MS = 60_000;
const COMPLETE_TIMEOUT_MS = 5 * 60_000;
const UNLOAD_TIMEOUT_MS = 10_000;

/**
 * `fetch` with an AbortSignal-backed timeout that surfaces a readable
 * error message rather than the generic "AbortError" from undici.
 * Returning a Response keeps the call sites identical.
 */
async function fetchWithTimeout(
  url: URL,
  init: RequestInit,
  timeoutMs: number,
  label: string,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') {
      throw new Error(
        `${label} timed out after ${Math.round(timeoutMs / 1000)}s (${url.toString()})`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

class OllamaAdapter implements IModelAdapter {
  private readonly logger: Logger;
  readonly host: string;
  readonly model: string;
  readonly embeddingModel: string;
  readonly visionModel: string;
  private keepAlive: string | number;
  private readonly defaultKeepAlive: string | number;
  private readonly unloadAfterIdleMs: number;
  private readonly autoInstall: boolean;
  private readonly client: Ollama;
  private readyPromise: Promise<void> | null = null;
  private unloadTimer: NodeJS.Timeout | null = null;

  constructor(config: OllamaModelConfig, logger: Logger) {
    this.logger = logger.child('model-ollama');
    this.host = config.host ?? DEFAULT_HOST;
    this.model = config.model ?? DEFAULT_MODEL;
    this.embeddingModel = config.embedding_model ?? DEFAULT_EMBEDDING_MODEL;
    this.visionModel = config.vision_model ?? this.model;
    this.keepAlive = config.keep_alive ?? DEFAULT_KEEP_ALIVE;
    this.defaultKeepAlive = this.keepAlive;
    this.unloadAfterIdleMs = Math.max(
      0,
      (config.unload_after_idle_min ?? DEFAULT_UNLOAD_AFTER_IDLE_MIN) * 60_000,
    );
    this.autoInstall = config.auto_install ?? true;
    this.client = new Ollama({ host: this.host });
  }

  getModelInfo(): ModelInfo {
    return {
      name: `ollama:${this.model}`,
      contextWindowTokens: 8192,
      isLocal: true,
      supportsVision: isVisionModelName(this.visionModel),
      costPerMillionTokens: 0,
    };
  }

  async isAvailable(): Promise<boolean> {
    if (!(await isOllamaReachable(this.host))) return false;
    return await this.modelPresent(this.model);
  }

  async complete(prompt: string, options: CompletionOptions = {}): Promise<string> {
    const messages: { role: 'system' | 'user'; content: string }[] = [];
    if (options.systemPrompt) {
      messages.push({ role: 'system', content: options.systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    const res = await this.client.chat({
      model: this.model,
      messages,
      stream: false,
      format: options.responseFormat === 'json' ? 'json' : undefined,
      keep_alive: this.keepAlive,
      options: {
        temperature: options.temperature ?? 0.2,
        num_predict: options.maxTokens ?? 1024,
      },
    });
    this.scheduleIdleUnload();
    return res.message.content;
  }

  /**
   * Streaming variant of {@link complete}. Emits each chunk as it arrives
   * via `onChunk` (used by the chat agent to surface live "typing"
   * progress in the UI) and returns the concatenated full text.
   */
  async completeStream(
    prompt: string,
    options: CompletionOptions,
    onChunk: (chunk: string) => void,
  ): Promise<string> {
    const messages: { role: 'system' | 'user'; content: string }[] = [];
    if (options.systemPrompt) {
      messages.push({ role: 'system', content: options.systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    const stream = await this.client.chat({
      model: this.model,
      messages,
      stream: true,
      format: options.responseFormat === 'json' ? 'json' : undefined,
      keep_alive: this.keepAlive,
      options: {
        temperature: options.temperature ?? 0.2,
        num_predict: options.maxTokens ?? 1024,
      },
    });

    let full = '';
    try {
      for await (const part of stream) {
        const text = part.message?.content ?? '';
        if (!text) continue;
        full += text;
        try {
          onChunk(text);
        } catch (err) {
          this.logger.debug('completeStream onChunk handler threw', { err: String(err) });
        }
      }
    } catch (err) {
      // Ollama's client throws "Did not receive done or success response
      // in stream." when the NDJSON body ends without a {done:true} chunk
      // — typically a daemon restart, dropped connection, or a model that
      // hit num_predict mid-token. If we already streamed *some* content,
      // surfacing that partial answer is far more useful than failing the
      // whole chat turn. Empty-stream cases still propagate so the caller
      // can fall back to a non-streaming retry or surface a real error.
      const message = err instanceof Error ? err.message : String(err);
      if (full.length > 0) {
        this.logger.warn('ollama stream ended without done; using partial response', {
          err: message,
          chars: full.length,
        });
        return full;
      }
      throw err;
    } finally {
      this.scheduleIdleUnload();
    }
    return full;
  }

  async completeWithVision(
    prompt: string,
    images: Buffer[],
    options: CompletionOptions = {},
  ): Promise<string> {
    const messages: { role: 'system' | 'user'; content: string; images?: string[] }[] = [];
    if (options.systemPrompt) {
      messages.push({ role: 'system', content: options.systemPrompt });
    }
    messages.push({
      role: 'user',
      content: prompt,
      images: images.map((b) => b.toString('base64')),
    });

    const res = await this.client.chat({
      model: this.visionModel,
      messages,
      stream: false,
      format: options.responseFormat === 'json' ? 'json' : undefined,
      keep_alive: this.keepAlive,
      options: {
        temperature: options.temperature ?? 0.2,
        num_predict: options.maxTokens ?? 1024,
      },
    });
    this.scheduleIdleUnload();
    return res.message.content;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    // Ollama's modern endpoint is /api/embed and accepts batched input.
    // The npm client version we use doesn't expose a stable typed wrapper
    // across releases, so call the local HTTP endpoint directly and keep
    // a fallback to the older /api/embeddings single-input endpoint.
    try {
      const res = await fetchWithTimeout(
        new URL('/api/embed', this.host),
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: this.embeddingModel,
            input: texts,
            keep_alive: this.keepAlive,
          }),
        },
        EMBED_TIMEOUT_MS,
        'ollama /api/embed',
      );
      if (!res.ok) {
        throw new Error(`Ollama /api/embed ${res.status}: ${await res.text()}`);
      }
      const body = await res.json() as {
        embeddings?: unknown;
      };
      if (!Array.isArray(body.embeddings)) {
        throw new Error('Ollama /api/embed returned no embeddings array');
      }
      const embeddings = body.embeddings.map((v) => parseEmbedding(v));
      this.scheduleIdleUnload();
      return embeddings;
    } catch (err) {
      this.logger.debug('batched embed failed; falling back to /api/embeddings', {
        err: String(err),
      });
      const out: number[][] = [];
      for (const text of texts) {
        const res = await fetchWithTimeout(
          new URL('/api/embeddings', this.host),
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              model: this.embeddingModel,
              prompt: text,
              keep_alive: this.keepAlive,
            }),
          },
          EMBED_TIMEOUT_MS,
          'ollama /api/embeddings',
        );
        if (!res.ok) {
          throw new Error(`Ollama /api/embeddings ${res.status}: ${await res.text()}`);
        }
        const body = await res.json() as { embedding?: unknown };
        out.push(parseEmbedding(body.embedding));
      }
      this.scheduleIdleUnload();
      return out;
    }
  }

  /**
   * Override `keep_alive` for the duration of a long-running task (e.g.
   * a full reindex). Without this, ollama's default 5-minute keep-alive
   * causes the model to evict between batches, paying a ~10s reload on
   * every burst of work. Pair with {@link resetKeepAlive} in a finally.
   *
   * Duck-typed call from the orchestrator (no IModelAdapter change).
   */
  setKeepAlive(value: string | number): void {
    this.keepAlive = value;
    this.logger.debug('keep_alive overridden', { value: String(value) });
  }

  resetKeepAlive(): void {
    this.keepAlive = this.defaultKeepAlive;
    this.logger.debug('keep_alive restored', { value: String(this.defaultKeepAlive) });
  }

  async unload(): Promise<void> {
    this.clearUnloadTimer();
    const generationModels = Array.from(new Set([this.model, this.visionModel]));
    await Promise.all([
      ...generationModels.map((model) => this.unloadGenerationModel(model)),
      this.unloadEmbeddingModel(this.embeddingModel),
    ]);
  }

  /**
   * Unload *only* the embedding model. Used between phases of a full
   * reindex: embeddings finish, but the indexer (chat) model is needed
   * immediately afterwards for page summarisation, so we don't want to
   * evict it from VRAM. Saves several seconds per pipeline run on Apple
   * Silicon where the chat model is multi-GB.
   *
   * Duck-typed call site (orchestrator, no IModelAdapter change).
   */
  async unloadEmbeddings(): Promise<void> {
    await this.unloadEmbeddingModel(this.embeddingModel);
  }

  /**
   * Idempotent first-run setup. Installs Ollama if missing, starts the
   * daemon if it isn't serving, downloads the configured model if it
   * isn't pulled yet. Memoised so concurrent callers share one bootstrap.
   */
  async ensureReady(
    onProgress?: ModelBootstrapHandler,
    opts?: { force?: boolean },
  ): Promise<void> {
    // Force-refresh path bypasses the memoised promise so callers (e.g.
    // `cofounderos model:update`) can request a fresh pull even after a
    // normal bootstrap has already resolved in this process.
    if (opts?.force) {
      const run = this.runBootstrap(onProgress ?? (() => {}), { force: true });
      this.readyPromise = run.catch((err) => {
        this.readyPromise = null;
        throw err;
      });
      return this.readyPromise;
    }
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.runBootstrap(onProgress ?? (() => {})).catch((err) => {
      this.readyPromise = null;
      throw err;
    });
    return this.readyPromise;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async runBootstrap(
    emit: ModelBootstrapHandler,
    opts: { force?: boolean } = {},
  ): Promise<void> {
    const force = opts.force === true;
    emit({ kind: 'check', message: `checking Ollama at ${this.host}` });

    // Fast path: server reachable and model present (skipped under force).
    if (await isOllamaReachable(this.host)) {
      if (
        !force &&
        (await this.modelPresent(this.model)) &&
        (await this.modelPresent(this.embeddingModel))
      ) {
        emit({ kind: 'ready', model: this.model });
        this.scheduleIdleUnload();
        return;
      }
      // Server up but model missing (or force-refresh) — skip install/start.
      await this.pullModel(emit, this.model, { force });
      await this.pullModel(emit, this.embeddingModel, { force });
      emit({ kind: 'ready', model: this.model });
      this.scheduleIdleUnload();
      return;
    }

    // Need install + start.
    if (!(await ollamaCommandExists())) {
      if (!this.autoInstall) {
        const reason =
          `Ollama is not installed and auto_install is disabled. ${manualInstallHint()}`;
        emit({ kind: 'install_failed', tool: 'ollama', reason });
        throw new Error(reason);
      }
      await this.installOllama(emit);
    }

    await this.startServer(emit);
    await this.pullModel(emit, this.model, { force });
    await this.pullModel(emit, this.embeddingModel, { force });
    emit({ kind: 'ready', model: this.model });
    this.scheduleIdleUnload();
  }

  private async installOllama(emit: ModelBootstrapHandler): Promise<void> {
    const tool = 'ollama';
    const platform = process.platform;
    emit({
      kind: 'install_started',
      tool,
      message: platform === 'win32'
        ? `Installing Ollama via winget. A UAC prompt may appear in a separate window.`
        : platform === 'darwin'
          ? `Installing Ollama.app without requiring a terminal password prompt.`
        : `Installing Ollama for the first time. You may be prompted for your password.`,
    });
    try {
      if (platform === 'win32') await installOllamaWindows(emit);
      else if (platform === 'darwin') await installOllamaMacOS(emit);
      else await installOllamaUnixLike(emit);
    } catch (err) {
      const reason = (err as Error).message;
      emit({ kind: 'install_failed', tool, reason });
      throw new Error(`Failed to install Ollama: ${reason}. ${manualInstallHint()}`);
    }
    emit({ kind: 'install_done', tool });
  }

  private async startServer(emit: ModelBootstrapHandler): Promise<void> {
    if (await isOllamaReachable(this.host)) {
      emit({ kind: 'server_ready', host: this.host });
      return;
    }
    emit({ kind: 'server_starting', host: this.host });
    try {
      await startOllamaDaemon();
    } catch (err) {
      // Some installers (macOS .app, Linux systemd) auto-start the daemon
      // and `ollama serve` will then fail with "address in use" — that's
      // fine, we just keep polling.
      this.logger.debug('startOllamaDaemon spawn issue (often benign)', { err: String(err) });
    }
    const ready = await waitForOllama(this.host, SERVER_READY_TIMEOUT_MS);
    if (!ready) {
      const reason = `daemon did not become reachable within ${SERVER_READY_TIMEOUT_MS / 1000}s`;
      emit({ kind: 'server_failed', host: this.host, reason });
      throw new Error(`Ollama server unreachable at ${this.host} (${reason}).`);
    }
    emit({ kind: 'server_ready', host: this.host });
  }

  private async pullModel(
    emit: ModelBootstrapHandler,
    model: string,
    opts: { force?: boolean } = {},
  ): Promise<void> {
    // Skip the pull when the model is already cached locally — unless the
    // caller is explicitly refreshing. Ollama's pull always re-resolves
    // the manifest from the registry, so a forced pull is what picks up
    // fresh weights published under the same floating tag.
    if (!opts.force && (await this.modelPresent(model))) return;

    emit({
      kind: 'pull_started',
      model,
      sizeHint: this.sizeHint(model),
    });
    try {
      const stream = await this.client.pull({ model, stream: true });
      let lastReportedAt = 0;
      for await (const part of stream as AsyncIterable<Record<string, unknown>>) {
        const status = String(part.status ?? '');
        const completed = typeof part.completed === 'number' ? part.completed : 0;
        const total = typeof part.total === 'number' ? part.total : 0;

        // Throttle to ~10Hz so the CLI bar redraws smoothly without spam.
        const now = Date.now();
        if (now - lastReportedAt < 100 && completed < total) continue;
        lastReportedAt = now;

        emit({ kind: 'pull_progress', model, status, completed, total });
      }
    } catch (err) {
      const reason = (err as Error).message;
      emit({ kind: 'pull_failed', model, reason });
      throw new Error(`Failed to pull ${model}: ${reason}`);
    }
    emit({ kind: 'pull_done', model });
  }

  private async modelPresent(model: string): Promise<boolean> {
    try {
      const list = await this.client.list();
      const wanted = model;
      const wantedFamily = wanted.split(':')[0];
      return list.models.some((m) => {
        if (m.name === wanted) return true;
        if (!wanted.includes(':') && m.name.startsWith(`${wantedFamily}:`)) return true;
        return false;
      });
    } catch {
      return false;
    }
  }

  private sizeHint(model: string): string {
    // Coarse heuristic so the CLI can warn the user before a 4GB download.
    const m = model.toLowerCase();
    if (m.includes('embed')) return '~300 MB';
    // Order matters: ':e2b' must be checked before ':2b' (and ':e4b'
    // before ':4b') because String.includes is a substring match.
    if (m.includes(':e2b')) return '~7.2 GB';
    if (m.includes(':e4b')) return '~9.6 GB';
    if (m.includes(':2b')) return '~1.6 GB';
    if (m.includes(':3b')) return '~2 GB';
    if (m.includes(':4b')) return '~3 GB';
    if (m.includes(':7b') || m.includes(':8b')) return '~4-5 GB';
    if (m.includes(':9b')) return '~5 GB';
    if (m.includes(':12b') || m.includes(':13b')) return '~8 GB';
    if (m.includes(':27b') || m.includes(':30b') || m.includes(':31b')) return '~17 GB';
    if (m.includes(':70b') || m.includes(':109b')) return '~40+ GB';
    return 'large download';
  }

  private scheduleIdleUnload(): void {
    this.clearUnloadTimer();
    if (this.unloadAfterIdleMs <= 0) return;
    this.unloadTimer = setTimeout(() => {
      void this.unload().catch((err) => {
        this.logger.debug('idle model unload failed', { err: String(err) });
      });
    }, this.unloadAfterIdleMs);
    this.unloadTimer.unref?.();
  }

  private clearUnloadTimer(): void {
    if (!this.unloadTimer) return;
    clearTimeout(this.unloadTimer);
    this.unloadTimer = null;
  }

  private async unloadGenerationModel(model: string): Promise<void> {
    try {
      const res = await fetchWithTimeout(
        new URL('/api/chat', this.host),
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: [],
            stream: false,
            keep_alive: 0,
          }),
        },
        UNLOAD_TIMEOUT_MS,
        'ollama unload (chat)',
      );
      if (!res.ok) {
        this.logger.debug('ollama model unload returned non-OK status', {
          model,
          status: res.status,
          body: await res.text(),
        });
      }
    } catch (err) {
      this.logger.debug('ollama model unload request failed', {
        model,
        err: String(err),
      });
    }
  }

  private async unloadEmbeddingModel(model: string): Promise<void> {
    try {
      const res = await fetchWithTimeout(
        new URL('/api/embed', this.host),
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model,
            input: '',
            keep_alive: 0,
          }),
        },
        UNLOAD_TIMEOUT_MS,
        'ollama unload (embed)',
      );
      if (!res.ok) {
        this.logger.debug('ollama embedding model unload returned non-OK status', {
          model,
          status: res.status,
          body: await res.text(),
        });
      }
    } catch (err) {
      this.logger.debug('ollama embedding model unload request failed', {
        model,
        err: String(err),
      });
    }
  }
}

const factory: PluginFactory<IModelAdapter> = (ctx) => {
  // No probing here — bootstrap (install + start + pull) happens lazily
  // when the orchestrator calls model.ensureReady(), so that inspection
  // commands like `cofounderos status` stay snappy and never trigger a
  // multi-GB download behind the user's back.
  return new OllamaAdapter((ctx.config as OllamaModelConfig) ?? {}, ctx.logger);
};

function parseEmbedding(value: unknown): number[] {
  if (!Array.isArray(value)) {
    throw new Error('embedding response was not an array');
  }
  const out = value.map((v) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error('embedding response contained a non-numeric value');
    }
    return v;
  });
  if (out.length === 0) throw new Error('embedding response was empty');
  return out;
}

function isVisionModelName(model: string): boolean {
  const family = model.split(':')[0]?.toLowerCase() ?? '';
  return PULL_FAMILIES_VISION_OK.some((p) => family.startsWith(p));
}

export default factory;
export { OllamaAdapter };
