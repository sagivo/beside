import type {
  IModelAdapter,
  ModelInfo,
  CompletionOptions,
  Logger,
  ModelBootstrapHandler,
} from '@cofounderos/interfaces';

/**
 * Deterministic, model-free fallback adapter. Selectable explicitly via
 * the `--offline` CLI flag (or accepted at the prompt when bootstrap of
 * the configured model plugin fails) so the indexing pipeline still
 * produces structured output without any LLM calls.
 *
 * Lives in the app rather than in a model plugin because it is the host's
 * "no-op last resort", not a user-selectable plugin: it never appears in
 * config.yaml and never goes through plugin discovery.
 */
export class OfflineFallbackAdapter implements IModelAdapter {
  private readonly logger: Logger;
  constructor(logger: Logger) {
    this.logger = logger.child('model-offline');
  }

  getModelInfo(): ModelInfo {
    return {
      name: 'offline:fallback',
      contextWindowTokens: 1_000_000,
      isLocal: true,
      supportsVision: false,
      costPerMillionTokens: 0,
    };
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async ensureReady(onProgress?: ModelBootstrapHandler): Promise<void> {
    onProgress?.({ kind: 'ready', model: 'offline:fallback' });
  }

  async complete(prompt: string, options: CompletionOptions = {}): Promise<string> {
    if (options.responseFormat === 'json') {
      return JSON.stringify({
        offline: true,
        notes: 'Configured model unavailable — no LLM-driven changes were made.',
      });
    }
    const last = prompt.split('\n').slice(-30).join('\n');
    this.logger.debug('offline complete()');
    return [
      '*(Offline fallback summary — install a model plugin for richer output.)*',
      '',
      last,
    ].join('\n');
  }

  async completeWithVision(
    prompt: string,
    _images: Buffer[],
    options: CompletionOptions = {},
  ): Promise<string> {
    return this.complete(prompt, options);
  }
}
