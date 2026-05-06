import { chatStore, type ChatMessage } from '@/lib/chat-store';
import type { ChatStreamEvent } from '@/global';

/**
 * Renderer-side glue for the local AI harness. One module, fire-and-
 * forget. The harness streams events over the `cofounderos:chat-event`
 * IPC push channel; we route them to the matching assistant message
 * in `chatStore` by `turnId` (which is the assistant message id).
 *
 * Lifecycle:
 *   1. The first send registers a single global listener on the IPC
 *      bridge. It survives subsequent sends/cancellations.
 *   2. Each `runChatTurn` starts a turn, registers a per-turn handler
 *      in the local routing map, and returns a cancel function the UI
 *      can call when the user hits Stop.
 *   3. On the terminal `done` / `error` event the turn is removed from
 *      the routing map and any remaining transient state on the
 *      message is finalized.
 *
 * If the renderer reloads while a turn is in flight, the in-flight
 * `runChatTurn` promise is dropped on the floor — the harness keeps
 * running in the runtime subprocess but its events stop being routed.
 * That's acceptable; the next user action recreates the listener.
 */

type TurnHandler = (event: ChatStreamEvent) => void;
const turnHandlers = new Map<string, TurnHandler>();

let listenerInstalled = false;

function ensureListener(): void {
  if (listenerInstalled) return;
  const onChatEvent = window.cofounderos?.onChatEvent;
  if (!onChatEvent) return;
  onChatEvent((event) => {
    if (!event || typeof event !== 'object') return;
    const handler = turnHandlers.get((event as { turnId: string }).turnId);
    if (handler) handler(event);
  });
  listenerInstalled = true;
}

interface RunOptions {
  conversationId: string;
  message: string;
  /** Existing assistant message id created up-front by the caller. */
  assistantMessageId: string;
  /** Conversation history including the user's just-sent message. */
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export interface ChatTurnHandle {
  cancel: () => void;
  done: Promise<void>;
}

export function runChatTurn(opts: RunOptions): ChatTurnHandle {
  ensureListener();

  const { conversationId, message, assistantMessageId, history } = opts;
  let contentSoFar = '';
  let reasoningSoFar = '';
  // Buffer state updates so a flood of streaming token events doesn't
  // hammer localStorage. We coalesce into a single store write per
  // animation frame.
  let pendingPatch: Partial<ChatMessage> | null = null;
  let scheduled = false;

  const flush = (): void => {
    if (!pendingPatch) {
      scheduled = false;
      return;
    }
    const patch = pendingPatch;
    pendingPatch = null;
    scheduled = false;
    chatStore.updateMessage(conversationId, assistantMessageId, patch);
  };
  const schedule = (patch: Partial<ChatMessage>): void => {
    pendingPatch = { ...(pendingPatch ?? {}), ...patch };
    if (scheduled) return;
    scheduled = true;
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(flush);
    } else {
      queueMicrotask(flush);
    }
  };
  const flushSync = (extra?: Partial<ChatMessage>): void => {
    if (extra) pendingPatch = { ...(pendingPatch ?? {}), ...extra };
    flush();
  };

  const appendReasoning = (line: string): void => {
    reasoningSoFar += (reasoningSoFar ? '\n' : '') + line;
    schedule({ reasoning: reasoningSoFar });
  };

  const handler: TurnHandler = (event) => {
    switch (event.kind) {
      case 'phase':
        appendReasoning(`\u25B8 Phase: ${event.phase}`);
        return;
      case 'reasoning':
        appendReasoning(event.text);
        return;
      case 'intent':
        appendReasoning(
          `Intent: ${event.intent} \u00B7 anchor ${event.anchor.label} (${event.anchor.day})`,
        );
        return;
      case 'tool-call':
        appendReasoning(`\u2192 ${event.tool}(${formatArgs(event.args)})`);
        return;
      case 'tool-result':
        appendReasoning(`\u2190 ${event.tool}: ${event.summary}`);
        return;
      case 'content':
        contentSoFar += event.delta;
        schedule({ content: contentSoFar, status: 'streaming' });
        return;
      case 'done':
        flushSync({ content: contentSoFar, status: 'done' });
        turnHandlers.delete(assistantMessageId);
        return;
      case 'error':
        flushSync({
          content: contentSoFar || `**Error:** ${event.message}`,
          status: 'error',
        });
        turnHandlers.delete(assistantMessageId);
        return;
    }
  };
  turnHandlers.set(assistantMessageId, handler);

  // Mark the assistant message as "thinking" until the first content
  // delta lands. The Chat UI uses this to render the bouncing dots.
  chatStore.updateMessage(conversationId, assistantMessageId, {
    status: 'thinking',
    reasoning: '',
    content: '',
  });

  const startApi = window.cofounderos?.startChat;
  if (!startApi) {
    const message = 'Chat engine is unavailable: the desktop bridge isn\'t ready.';
    chatStore.updateMessage(conversationId, assistantMessageId, {
      status: 'error',
      content: message,
    });
    turnHandlers.delete(assistantMessageId);
    return { cancel: () => undefined, done: Promise.resolve() };
  }

  const done = startApi({
    turnId: assistantMessageId,
    conversationId,
    message,
    history,
  })
    .then(() => undefined)
    .catch((err) => {
      flushSync({
        status: 'error',
        content: contentSoFar || `**Error:** ${err instanceof Error ? err.message : String(err)}`,
      });
      turnHandlers.delete(assistantMessageId);
    });

  const cancel = (): void => {
    turnHandlers.delete(assistantMessageId);
    flushSync({ status: 'done', content: contentSoFar || '_(cancelled)_' });
    void window.cofounderos?.cancelChat?.(assistantMessageId);
  };

  return { cancel, done };
}

export function cancelChatTurn(turnId: string): void {
  turnHandlers.delete(turnId);
  void window.cofounderos?.cancelChat?.(turnId);
}

function formatArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args).slice(0, 3);
  if (entries.length === 0) return '';
  return entries
    .map(([k, v]) => {
      if (typeof v === 'string') return `${k}: "${truncate(v, 30)}"`;
      if (v == null) return `${k}: null`;
      if (typeof v === 'number' || typeof v === 'boolean') return `${k}: ${v}`;
      return `${k}: …`;
    })
    .join(', ');
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
