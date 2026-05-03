import type {
  CompletionOptions,
  IModelAdapter,
  Logger,
  ModelInfo,
  PluginFactory,
} from '@cofounderos/interfaces';

interface OpenAIModelConfig {
  api_key?: string;
  base_url?: string;
  model?: string;
  vision_model?: string;
  embedding_model?: string;
}

interface ChatMessage {
  role: 'system' | 'user';
  content: string | Array<
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } }
  >;
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';

class OpenAIAdapter implements IModelAdapter {
  private readonly logger: Logger;
  private readonly apiKey: string | null;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly visionModel: string;
  private readonly embeddingModel: string;

  constructor(config: OpenAIModelConfig, logger: Logger) {
    this.logger = logger.child('model-openai');
    this.apiKey = config.api_key ?? process.env.OPENAI_API_KEY ?? null;
    this.baseUrl = (config.base_url ?? process.env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL)
      .replace(/\/+$/, '');
    this.model = config.model ?? process.env.OPENAI_MODEL ?? DEFAULT_MODEL;
    this.visionModel = config.vision_model ?? this.model;
    this.embeddingModel =
      config.embedding_model ?? process.env.OPENAI_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL;
  }

  getModelInfo(): ModelInfo {
    return {
      name: `openai:${this.model}`,
      contextWindowTokens: 128_000,
      isLocal: false,
      supportsVision: true,
      costPerMillionTokens: 0,
    };
  }

  async isAvailable(): Promise<boolean> {
    if (!this.apiKey) return false;
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: this.headers(),
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async complete(prompt: string, options: CompletionOptions = {}): Promise<string> {
    const messages: ChatMessage[] = [];
    if (options.systemPrompt) {
      messages.push({ role: 'system', content: options.systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });
    return await this.chat(this.model, messages, options);
  }

  async completeWithVision(
    prompt: string,
    images: Buffer[],
    options: CompletionOptions = {},
  ): Promise<string> {
    const messages: ChatMessage[] = [];
    if (options.systemPrompt) {
      messages.push({ role: 'system', content: options.systemPrompt });
    }
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        ...images.map((image) => ({
          type: 'image_url' as const,
          image_url: {
            url: `data:${detectImageMime(image)};base64,${image.toString('base64')}`,
          },
        })),
      ],
    });
    return await this.chat(this.visionModel, messages, options);
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const body = await this.request<{
      data?: Array<{ embedding?: unknown; index?: number }>;
    }>('/embeddings', {
      model: this.embeddingModel,
      input: texts,
    });
    const rows = body.data ?? [];
    const ordered = [...rows].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return ordered.map((row) => parseEmbedding(row.embedding));
  }

  private async chat(
    model: string,
    messages: ChatMessage[],
    options: CompletionOptions,
  ): Promise<string> {
    const body = await this.request<{
      choices?: Array<{ message?: { content?: string | null } }>;
    }>('/chat/completions', {
      model,
      messages,
      temperature: options.temperature ?? 0.2,
      max_tokens: options.maxTokens ?? 1024,
      response_format: options.responseFormat === 'json'
        ? { type: 'json_object' }
        : undefined,
    });
    const content = body.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('OpenAI response had no message content');
    }
    return content;
  }

  private async request<T>(path: string, body: Record<string, unknown>): Promise<T> {
    if (!this.apiKey) {
      throw new Error('OpenAI API key missing. Set index.model.openai.api_key or OPENAI_API_KEY.');
    }
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(dropUndefined(body)),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      this.logger.debug('OpenAI request failed', { path, status: res.status, text });
      throw new Error(`OpenAI ${path} failed: HTTP ${res.status}${text ? `: ${text}` : ''}`);
    }
    return await res.json() as T;
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
    };
  }
}

function dropUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
}

function parseEmbedding(value: unknown): number[] {
  if (!Array.isArray(value)) throw new Error('embedding response was not an array');
  const out = value.map((v) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error('embedding response contained non-numeric value');
    }
    return v;
  });
  if (out.length === 0) throw new Error('embedding response was empty');
  return out;
}

function detectImageMime(image: Buffer): string {
  if (image.length >= 12 && image.subarray(0, 4).toString('hex') === '52494646' && image.subarray(8, 12).toString() === 'WEBP') {
    return 'image/webp';
  }
  if (image.length >= 3 && image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff) {
    return 'image/jpeg';
  }
  if (image.length >= 8 && image.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') {
    return 'image/png';
  }
  return 'image/png';
}

const factory: PluginFactory<IModelAdapter> = (ctx) => {
  return new OpenAIAdapter((ctx.config as OpenAIModelConfig) ?? {}, ctx.logger);
};

export default factory;
export { OpenAIAdapter };
