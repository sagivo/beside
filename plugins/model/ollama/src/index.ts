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
  isOllamaReachable,
  manualInstallHint,
  startOllamaDaemon,
  waitForOllama,
} from './bootstrap.js';

interface OllamaModelConfig {
  host?: string;
  model?: string;
  vision_model?: string;
  /** Skip the auto-install + auto-pull bootstrap on first run. */
  auto_install?: boolean;
}

const DEFAULT_HOST = 'http://localhost:11434';
const DEFAULT_MODEL = 'gemma2:2b';
const SERVER_READY_TIMEOUT_MS = 60_000;
const PULL_FAMILIES_VISION_OK = ['gemma2', 'gemma3', 'gemma4', 'llava', 'llama4', 'qwen2-vl'];

class OllamaAdapter implements IModelAdapter {
  private readonly logger: Logger;
  readonly host: string;
  readonly model: string;
  readonly visionModel: string;
  private readonly autoInstall: boolean;
  private readonly client: Ollama;
  private readyPromise: Promise<void> | null = null;

  constructor(config: OllamaModelConfig, logger: Logger) {
    this.logger = logger.child('model-ollama');
    this.host = config.host ?? DEFAULT_HOST;
    this.model = config.model ?? DEFAULT_MODEL;
    this.visionModel = config.vision_model ?? this.model;
    this.autoInstall = config.auto_install ?? true;
    this.client = new Ollama({ host: this.host });
  }

  getModelInfo(): ModelInfo {
    const family = this.model.split(':')[0]?.toLowerCase() ?? '';
    return {
      name: `ollama:${this.model}`,
      contextWindowTokens: 8192,
      isLocal: true,
      supportsVision: PULL_FAMILIES_VISION_OK.some((p) => family.startsWith(p)),
      costPerMillionTokens: 0,
    };
  }

  async isAvailable(): Promise<boolean> {
    if (!(await isOllamaReachable(this.host))) return false;
    return await this.modelPresent();
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
      if (await this.modelPresent()) {
        emit({ kind: 'ready', model: this.model });
        return;
      }
      // Server up but model missing — skip install/start, jump to pull.
      await this.pullModel(emit);
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
    await this.pullModel(emit);
    emit({ kind: 'ready', model: this.model });
  }

  private async installOllama(emit: ModelBootstrapHandler): Promise<void> {
    const tool = 'ollama';
    if (process.platform === 'win32') {
      const reason = manualInstallHint();
      emit({ kind: 'install_failed', tool, reason });
      throw new Error(reason);
    }
    emit({
      kind: 'install_started',
      tool,
      message: `Installing Ollama for the first time. You may be prompted for your password.`,
    });
    try {
      await installOllamaUnixLike(emit);
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

  private async pullModel(emit: ModelBootstrapHandler): Promise<void> {
    if (await this.modelPresent()) return;

    emit({
      kind: 'pull_started',
      model: this.model,
      sizeHint: this.sizeHint(),
    });
    try {
      const stream = await this.client.pull({ model: this.model, stream: true });
      let lastReportedAt = 0;
      for await (const part of stream as AsyncIterable<Record<string, unknown>>) {
        const status = String(part.status ?? '');
        const completed = typeof part.completed === 'number' ? part.completed : 0;
        const total = typeof part.total === 'number' ? part.total : 0;

        // Throttle to ~10Hz so the CLI bar redraws smoothly without spam.
        const now = Date.now();
        if (now - lastReportedAt < 100 && completed < total) continue;
        lastReportedAt = now;

        emit({ kind: 'pull_progress', model: this.model, status, completed, total });
      }
    } catch (err) {
      const reason = (err as Error).message;
      emit({ kind: 'pull_failed', model: this.model, reason });
      throw new Error(`Failed to pull ${this.model}: ${reason}`);
    }
    emit({ kind: 'pull_done', model: this.model });
  }

  private async modelPresent(): Promise<boolean> {
    try {
      const list = await this.client.list();
      const wanted = this.model;
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

  private sizeHint(): string {
    // Coarse heuristic so the CLI can warn the user before a 4GB download.
    const m = this.model.toLowerCase();
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

export default factory;
export { OllamaAdapter };
