/**
 * Curated list of locally-runnable Ollama models surfaced in onboarding
 * and Settings. The list is intentionally short — the goal is to give a
 * new user one obvious good default plus a couple of escape hatches for
 * different hardware budgets, not to enumerate every model on the
 * registry. Power users can paste any `family:tag` value into the
 * "Custom" field instead.
 *
 * Update this list when Google / Mistral / Meta ship a faster or
 * higher-quality model under the same size budget. The first entry
 * (badge: 'Recommended') drives the default selection in onboarding.
 */
export interface ModelChoice {
  /** Ollama tag, e.g. "gemma4:e2b". */
  id: string;
  /** Human display name. */
  name: string;
  vendor: string;
  /** Approximate download size for the default quantization. */
  size: string;
  bytes: number;
  description: string;
  /** Optional pill in the picker (e.g. "Recommended", "Latest"). */
  badge?: string;
  /** Whether the model accepts image input via the `images:` field. */
  vision?: boolean;
}

export const MODEL_CHOICES: ModelChoice[] = [
  {
    id: 'gemma4:e4b',
    name: 'Gemma 4 · E4B',
    vendor: 'Google',
    size: '~9.6 GB',
    bytes: 9.6 * 1024 ** 3,
    description:
      'Latest Gemma 4 default. 8B params with vision + audio, 128K context, and strong reasoning.',
    badge: 'Recommended',
    vision: true,
  },
  {
    id: 'gemma4:e2b',
    name: 'Gemma 4 · E2B',
    vendor: 'Google',
    size: '~7.2 GB',
    bytes: 7.2 * 1024 ** 3,
    description:
      'Fastest Gemma 4 variant — optimized for edge/mobile when you want lower latency.',
    vision: true,
  },
  {
    id: 'gemma3:4b',
    name: 'Gemma 3 · 4B',
    vendor: 'Google',
    size: '~3.3 GB',
    bytes: 3.3 * 1024 ** 3,
    description: 'Previous-generation Gemma. Smaller download if disk is tight.',
    vision: true,
  },
  {
    id: 'llama3.2:3b',
    name: 'Llama 3.2 · 3B',
    vendor: 'Meta',
    size: '~2 GB',
    bytes: 2 * 1024 ** 3,
    description: 'Strong reasoner from Meta. Text-only; good fallback when vision is not needed.',
  },
  {
    id: 'qwen2.5:7b',
    name: 'Qwen 2.5 · 7B',
    vendor: 'Alibaba',
    size: '~4.4 GB',
    bytes: 4.4 * 1024 ** 3,
    description: 'Higher-quality reasoning at a moderate footprint. Great for power users.',
  },
];

export const DEFAULT_MODEL_ID = MODEL_CHOICES[0]!.id;

/** Lookup helper that's robust to missing entries (custom tags). */
export function findModelChoice(id: string | null | undefined): ModelChoice | null {
  if (!id) return null;
  return MODEL_CHOICES.find((m) => m.id === id) ?? null;
}

/**
 * Returns true when an Ollama tag looks well-formed enough to attempt a
 * pull. Intentionally permissive — Ollama itself is the source of truth
 * for valid tags; we just guard against obvious typos like a missing
 * `:tag` segment or whitespace.
 */
export function isPlausibleOllamaTag(tag: string): boolean {
  const trimmed = tag.trim();
  if (!trimmed) return false;
  // Allow `family:tag`, `namespace/family:tag`, or bare `family` (which
  // resolves to `:latest` server-side). Disallow whitespace.
  if (/\s/.test(trimmed)) return false;
  return /^[a-zA-Z0-9._/-]+(:[a-zA-Z0-9._-]+)?$/.test(trimmed);
}
