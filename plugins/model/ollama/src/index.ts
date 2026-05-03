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
  commandExists,
  installOllamaUnixLike,
  installOllamaWindows,
  isOllamaReachable,
  manualInstallHint,
  startOllamaDaemon,
  waitForOllama,
} from './bootstrap.js';

interface OllamaModelConfig {
  host?: string;
  model?: string;
  embedding_model?: string;
  vision_model?: string;
  /** Skip the auto-install + auto-pull bootstrap on first run. */
  auto_install?: boolean;
}

// Ollama itself binds to 127.0.0.1 by default. Using the same literal
// (rather than 'localhost') avoids surprises on hosts where 'localhost'
// resolves to ::1 first while Ollama is only listening on v4.
const DEFAULT_HOST = 'http://127.0.0.1:11434';
const DEFAULT_MODEL = 'gemma2:2b';
const DEFAULT_EMBEDDING_MODEL = 'nomic-embed-text';
const SERVER_READY_TIMEOUT_MS = 60_000;
const PULL_FAMILIES_VISION_OK = ['gemma2', 'gemma3', 'gemma4', 'llava', 'llama4', 'qwen2-vl'];

class OllamaAdapter implements IModelAdapter {
  private readonly logger: Logger;
  readonly host: string;
  readonly model: string;
  readonly embeddingModel: string;
  readonly visionModel: string;
  private readonly autoInstall: boolean;
  private readonly client: Ollama;
  private readyPromise: Promise<void> | null = null;

  constructor(config: OllamaModelConfig, logger: Logger) {
    this.logger = logger.child('model-ollama');
    this.host = config.host ?? DEFAULT_HOST;
    this.model = config.model ?? DEFAULT_MODEL;
    this.embeddingModel = config.embedding_model ?? DEFAULT_EMBEDDING_MODEL;
    this.visionModel = config.vision_model ?? this.model;
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
      options: {
        temperature: options.temperature ?? 0.2,
        num_predict: options.maxTokens ?? 1024,
      },
    });
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
      options: {
        temperature: options.temperature ?? 0.2,
        num_predict: options.maxTokens ?? 1024,
      },
    });
    return res.message.content;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    // Ollama's modern endpoint is /api/embed and accepts batched input.
    // The npm client version we use doesn't expose a stable typed wrapper
    // across releases, so call the local HTTP endpoint directly and keep
    // a fallback to the older /api/embeddings single-input endpoint.
    try {
      const res = await fetch(new URL('/api/embed', this.host), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.embeddingModel,
          input: texts,
        }),
      });
      if (!res.ok) {
        throw new Error(`Ollama /api/embed ${res.status}: ${await res.text()}`);
      }
      const body = await res.json() as {
        embeddings?: unknown;
      };
      if (!Array.isArray(body.embeddings)) {
        throw new Error('Ollama /api/embed returned no embeddings array');
      }
      return body.embeddings.map((v) => parseEmbedding(v));
    } catch (err) {
      this.logger.debug('batched embed failed; falling back to /api/embeddings', {
        err: String(err),
      });
      const out: number[][] = [];
      for (const text of texts) {
        const res = await fetch(new URL('/api/embeddings', this.host), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: this.embeddingModel,
            prompt: text,
          }),
        });
        if (!res.ok) {
          throw new Error(`Ollama /api/embeddings ${res.status}: ${await res.text()}`);
        }
        const body = await res.json() as { embedding?: unknown };
        out.push(parseEmbedding(body.embedding));
      }
      return out;
    }
  }

  /**
   * Idempotent first-run setup. Installs Ollama if missing, starts the
   * daemon if it isn't serving, downloads the configured model if it
   * isn't pulled yet. Memoised so concurrent callers share one bootstrap.
   */
  async ensureReady(onProgress?: ModelBootstrapHandler): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.runBootstrap(onProgress ?? (() => {})).catch((err) => {
      this.readyPromise = null; // allow retry
      throw err;
    });
    return this.readyPromise;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async runBootstrap(emit: ModelBootstrapHandler): Promise<void> {
    emit({ kind: 'check', message: `checking Ollama at ${this.host}` });

    // Fast path: server reachable and model present.
    if (await isOllamaReachable(this.host)) {
      if (await this.modelPresent(this.model) && await this.modelPresent(this.embeddingModel)) {
        emit({ kind: 'ready', model: this.model });
        return;
      }
      // Server up but model missing — skip install/start, jump to pull.
      await this.pullModel(emit, this.model);
      await this.pullModel(emit, this.embeddingModel);
      emit({ kind: 'ready', model: this.model });
      return;
    }

    // Need install + start.
    if (!(await commandExists('ollama'))) {
      if (!this.autoInstall) {
        const reason =
          `Ollama is not installed and auto_install is disabled. ${manualInstallHint()}`;
        emit({ kind: 'install_failed', tool: 'ollama', reason });
        throw new Error(reason);
      }
      await this.installOllama(emit);
    }

    await this.startServer(emit);
    await this.pullModel(emit, this.model);
    await this.pullModel(emit, this.embeddingModel);
    emit({ kind: 'ready', model: this.model });
  }

  private async installOllama(emit: ModelBootstrapHandler): Promise<void> {
    const tool = 'ollama';
    const isWindows = process.platform === 'win32';
    emit({
      kind: 'install_started',
      tool,
      message: isWindows
        ? `Installing Ollama via winget. A UAC prompt may appear in a separate window.`
        : `Installing Ollama for the first time. You may be prompted for your password.`,
    });
    try {
      if (isWindows) await installOllamaWindows(emit);
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

  private async pullModel(emit: ModelBootstrapHandler, model: string): Promise<void> {
    if (await this.modelPresent(model)) return;

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
    if (m.includes(':2b')) return '~1.6 GB';
    if (m.includes(':3b')) return '~2 GB';
    if (m.includes(':e4b') || m.includes(':4b')) return '~3 GB';
    if (m.includes(':7b') || m.includes(':8b')) return '~4-5 GB';
    if (m.includes(':9b')) return '~5 GB';
    if (m.includes(':12b') || m.includes(':13b')) return '~8 GB';
    if (m.includes(':27b') || m.includes(':30b') || m.includes(':31b')) return '~17 GB';
    if (m.includes(':70b') || m.includes(':109b')) return '~40+ GB';
    return 'large download';
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
