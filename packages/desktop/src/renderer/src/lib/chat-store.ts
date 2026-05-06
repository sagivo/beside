import * as React from 'react';

/**
 * Local-only chat persistence.
 *
 * All AI conversations live in localStorage on this device. There is no
 * network sync. The schema is intentionally tiny so we can iterate on
 * the surrounding logic (model calls, tool use, reasoning streaming)
 * without breaking stored history.
 */

export type ChatRole = 'user' | 'assistant';

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  /**
   * Assistant-only. The free-form chain-of-thought / scratchpad the
   * model produced before the final answer. Rendered behind a
   * collapsible "Reasoning" disclosure, mirroring ChatGPT.
   */
  reasoning?: string;
  /**
   * Assistant-only transient state. `thinking` shows the animated
   * indicator, `streaming` shows the partial answer, `done` is the
   * normal terminal state, `error` shows a retry affordance.
   */
  status?: 'thinking' | 'streaming' | 'done' | 'error';
  createdAt: number;
};

export type ChatConversation = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
};

const STORAGE_KEY = 'cofounderos:chat:conversations:v1';
const ACTIVE_KEY = 'cofounderos:chat:active:v1';

function genId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    (v.role === 'user' || v.role === 'assistant') &&
    typeof v.content === 'string' &&
    typeof v.createdAt === 'number'
  );
}

function isConversation(value: unknown): value is ChatConversation {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.title === 'string' &&
    typeof v.createdAt === 'number' &&
    typeof v.updatedAt === 'number' &&
    Array.isArray(v.messages) &&
    v.messages.every(isMessage)
  );
}

function readAll(): ChatConversation[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isConversation);
  } catch {
    return [];
  }
}

function writeAll(items: ChatConversation[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    window.dispatchEvent(new CustomEvent('cofounderos:chat:changed'));
  } catch {
    /* ignore quota / serialization errors – chat is best-effort local state */
  }
}

function readActiveId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

function writeActiveId(id: string | null): void {
  try {
    if (id) localStorage.setItem(ACTIVE_KEY, id);
    else localStorage.removeItem(ACTIVE_KEY);
    window.dispatchEvent(new CustomEvent('cofounderos:chat:active-changed'));
  } catch {
    /* ignore */
  }
}

export const chatStore = {
  list(): ChatConversation[] {
    return readAll().sort((a, b) => b.updatedAt - a.updatedAt);
  },
  get(id: string): ChatConversation | null {
    return readAll().find((c) => c.id === id) ?? null;
  },
  create(initial?: Partial<Pick<ChatConversation, 'title'>>): ChatConversation {
    const now = Date.now();
    const conv: ChatConversation = {
      id: genId(),
      title: initial?.title?.trim() || 'New chat',
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    const all = readAll();
    all.push(conv);
    writeAll(all);
    return conv;
  },
  rename(id: string, title: string): void {
    const all = readAll();
    const idx = all.findIndex((c) => c.id === id);
    if (idx < 0) return;
    all[idx] = { ...all[idx]!, title: title.trim() || 'Untitled', updatedAt: Date.now() };
    writeAll(all);
  },
  remove(id: string): void {
    const all = readAll().filter((c) => c.id !== id);
    writeAll(all);
    if (readActiveId() === id) writeActiveId(null);
  },
  clearAll(): void {
    writeAll([]);
    writeActiveId(null);
  },
  appendMessage(id: string, message: Omit<ChatMessage, 'id' | 'createdAt'> & Partial<Pick<ChatMessage, 'id' | 'createdAt'>>): ChatMessage {
    const all = readAll();
    const idx = all.findIndex((c) => c.id === id);
    if (idx < 0) throw new Error(`Conversation ${id} not found`);
    const msg: ChatMessage = {
      id: message.id ?? genId(),
      createdAt: message.createdAt ?? Date.now(),
      role: message.role,
      content: message.content,
      reasoning: message.reasoning,
      status: message.status,
    };
    const conv = all[idx]!;
    const next: ChatConversation = {
      ...conv,
      messages: [...conv.messages, msg],
      updatedAt: Date.now(),
      title: conv.title === 'New chat' && msg.role === 'user' ? deriveTitle(msg.content) : conv.title,
    };
    all[idx] = next;
    writeAll(all);
    return msg;
  },
  updateMessage(conversationId: string, messageId: string, patch: Partial<Omit<ChatMessage, 'id'>>): void {
    const all = readAll();
    const idx = all.findIndex((c) => c.id === conversationId);
    if (idx < 0) return;
    const conv = all[idx]!;
    const messages = conv.messages.map((m) => (m.id === messageId ? { ...m, ...patch } : m));
    all[idx] = { ...conv, messages, updatedAt: Date.now() };
    writeAll(all);
  },
  removeMessage(conversationId: string, messageId: string): void {
    const all = readAll();
    const idx = all.findIndex((c) => c.id === conversationId);
    if (idx < 0) return;
    const conv = all[idx]!;
    all[idx] = {
      ...conv,
      messages: conv.messages.filter((m) => m.id !== messageId),
      updatedAt: Date.now(),
    };
    writeAll(all);
  },
  getActiveId(): string | null {
    return readActiveId();
  },
  setActiveId(id: string | null): void {
    writeActiveId(id);
  },
};

/**
 * Derive a short topical title from a user's first message. We don't
 * call the model here — generation needs to feel instant the moment the
 * user hits Send — so we use a few cheap heuristics:
 *
 *   1. Strip conversational filler at the head ("hey", "can you",
 *      "please help me with", "i was wondering if you could", …) so the
 *      title starts with the actual subject.
 *   2. Take only the first sentence/line; multi-paragraph prompts are
 *      almost always preceded by the topic in their opening clause.
 *   3. Drop trailing punctuation, collapse whitespace, and Title-Case
 *      the result so it looks like a heading instead of a chat line.
 *   4. Cap to ~50 chars with an ellipsis to keep the sidebar tidy.
 *
 * If, after stripping, nothing topical remains (e.g. a bare "hi"), we
 * fall back to the cleaned-up original text so the user still sees
 * something recognizable rather than a blank "New chat".
 */
function deriveTitle(text: string): string {
  const original = text.replace(/\s+/g, ' ').trim();
  if (!original) return 'New chat';

  const firstSentence = original.split(/(?<=[.!?])\s+|\n+/)[0]!.trim() || original;

  const FILLER_PREFIXES: RegExp[] = [
    /^(hey|hi|hello|yo|ok(ay)?|so|well|um+|uh+)[,!.\s]+/i,
    /^(please|pls|kindly)\s+/i,
    /^(could|can|would|will)\s+(you|u|ya)\s+(please\s+)?/i,
    /^(i\s+(was\s+)?wonder(ing)?\s+if\s+(you\s+)?(could|can|would)\s+)/i,
    /^(i\s+(would|'?d)\s+like\s+(you\s+)?to\s+)/i,
    /^(i\s+want\s+(you\s+)?to\s+)/i,
    /^(i\s+need\s+(you\s+)?to\s+)/i,
    /^(let'?s\s+)/i,
    /^(help\s+me\s+(to\s+)?)/i,
    /^(tell\s+me\s+(about\s+)?)/i,
    /^(show\s+me\s+(the\s+|a\s+)?)/i,
    /^(give\s+me\s+(a\s+|the\s+)?)/i,
    /^(write\s+(me\s+)?(a\s+|an\s+|the\s+)?)/i,
    /^(generate\s+(me\s+)?(a\s+|an\s+|the\s+)?)/i,
    /^(create\s+(me\s+)?(a\s+|an\s+|the\s+)?)/i,
    /^(make\s+(me\s+)?(a\s+|an\s+|the\s+)?)/i,
    /^(explain\s+(to\s+me\s+)?)/i,
    /^(what'?s\s+|whats\s+|what\s+is\s+|what\s+are\s+)/i,
    /^(how\s+(do|does|can|would|should)\s+(i|you|we)\s+)/i,
  ];

  let stripped = firstSentence;
  for (let i = 0; i < 3; i += 1) {
    const before = stripped;
    for (const re of FILLER_PREFIXES) stripped = stripped.replace(re, '');
    stripped = stripped.trim();
    if (stripped === before) break;
  }
  stripped = stripped.replace(/[.!?,;:\s]+$/g, '').trim();

  const candidate = stripped.length >= 3 ? stripped : firstSentence.replace(/[.!?,;:\s]+$/g, '');
  if (!candidate) return 'New chat';

  const titleCased = toTitleCase(candidate);
  const MAX = 50;
  return titleCased.length > MAX ? `${titleCased.slice(0, MAX - 1).trimEnd()}…` : titleCased;
}

const TITLE_LOWERCASE = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into', 'nor',
  'of', 'on', 'or', 'per', 'the', 'to', 'vs', 'via', 'with',
]);

function toTitleCase(text: string): string {
  const words = text.split(/(\s+)/);
  let wordIndex = 0;
  return words
    .map((token) => {
      if (/^\s+$/.test(token)) return token;
      const isFirst = wordIndex === 0;
      wordIndex += 1;
      if (!isFirst && TITLE_LOWERCASE.has(token.toLowerCase())) {
        return token.toLowerCase();
      }
      // Preserve already-uppercase tokens (acronyms like API, MCP, LLM).
      if (token.length > 1 && token === token.toUpperCase() && /[A-Z]/.test(token)) {
        return token;
      }
      return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
    })
    .join('');
}

/**
 * Subscribes to mutations from the store. Updates fire on every
 * write within the same renderer process, plus on cross-tab `storage`
 * events (mostly defensive — the desktop shell is single-window).
 */
export function useConversations(): ChatConversation[] {
  const [items, setItems] = React.useState<ChatConversation[]>(() => chatStore.list());
  React.useEffect(() => {
    const refresh = () => setItems(chatStore.list());
    window.addEventListener('cofounderos:chat:changed', refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener('cofounderos:chat:changed', refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);
  return items;
}

export function useActiveConversationId(): [string | null, (id: string | null) => void] {
  const [id, setId] = React.useState<string | null>(() => chatStore.getActiveId());
  React.useEffect(() => {
    const refresh = () => setId(chatStore.getActiveId());
    window.addEventListener('cofounderos:chat:active-changed', refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener('cofounderos:chat:active-changed', refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);
  const set = React.useCallback((next: string | null) => {
    chatStore.setActiveId(next);
    setId(next);
  }, []);
  return [id, set];
}
