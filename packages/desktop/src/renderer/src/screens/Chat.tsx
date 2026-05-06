import * as React from 'react';
import {
  ArrowUp,
  Brain,
  ChevronDown,
  Copy,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search as SearchIcon,
  Square,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Markdown } from '@/components/Markdown';
import {
  chatStore,
  useActiveConversationId,
  useConversations,
  type ChatConversation,
  type ChatMessage,
} from '@/lib/chat-store';
import { runChatTurn, cancelChatTurn } from '@/lib/chat-engine';
import { cn } from '@/lib/utils';

/**
 * AI chat surface. Two-pane layout in the spirit of ChatGPT:
 *
 *   - Left: conversation list, search, "new chat" button, hover actions
 *   - Right: message thread (user / assistant bubbles, collapsible
 *     reasoning, animated thinking indicator) + sticky composer
 *
 * For now this only owns the UI state. The composer fakes a streaming
 * response so the thinking / reasoning UI can be exercised end-to-end.
 * Replace `runFakeAssistant` with a real model call later.
 */
export function Chat() {
  const conversations = useConversations();
  const [activeId, setActiveId] = useActiveConversationId();

  const active = React.useMemo<ChatConversation | null>(() => {
    if (!activeId) return null;
    return conversations.find((c) => c.id === activeId) ?? null;
  }, [conversations, activeId]);

  // Default to the most recent conversation if nothing is selected and one exists.
  React.useEffect(() => {
    if (activeId || conversations.length === 0) return;
    setActiveId(conversations[0]!.id);
  }, [activeId, conversations, setActiveId]);

  function onNewChat() {
    const conv = chatStore.create();
    setActiveId(conv.id);
  }

  return (
    <div className="flex h-full min-h-0 w-full">
      <ConversationList
        conversations={conversations}
        activeId={activeId}
        onSelect={setActiveId}
        onNewChat={onNewChat}
      />
      <div className="flex-1 min-w-0 flex flex-col bg-background">
        {active ? (
          <ChatThread key={active.id} conversation={active} />
        ) : (
          <EmptyState onNewChat={onNewChat} />
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Sidebar (conversation list)
// ─────────────────────────────────────────────────────────────────────

function ConversationList({
  conversations,
  activeId,
  onSelect,
  onNewChat,
}: {
  conversations: ChatConversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
}) {
  const [filter, setFilter] = React.useState('');

  const filtered = React.useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((c) => c.title.toLowerCase().includes(q));
  }, [conversations, filter]);

  return (
    <aside className="w-72 shrink-0 border-r border-border bg-sidebar/40 flex flex-col">
      <div className="p-3 flex flex-col gap-2 border-b border-border">
        <Button onClick={onNewChat} className="w-full justify-start gap-2" variant="outline">
          <Plus className="size-4" />
          New chat
        </Button>
        <div className="relative">
          <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Search chats…"
            value={filter}
            onChange={(e) => setFilter(e.currentTarget.value)}
            className="pl-8 h-8 text-sm"
          />
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto py-2">
        {filtered.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-muted-foreground">
            {conversations.length === 0
              ? 'No chats yet. Start a new conversation to begin.'
              : 'No chats match your search.'}
          </div>
        ) : (
          <ul className="flex flex-col gap-0.5 px-2">
            {filtered.map((c) => (
              <ConversationItem
                key={c.id}
                conversation={c}
                active={c.id === activeId}
                onSelect={() => onSelect(c.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

function ConversationItem({
  conversation,
  active,
  onSelect,
}: {
  conversation: ChatConversation;
  active: boolean;
  onSelect: () => void;
}) {
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [renaming, setRenaming] = React.useState(false);
  const [draft, setDraft] = React.useState(conversation.title);

  React.useEffect(() => {
    setDraft(conversation.title);
  }, [conversation.title]);

  function commitRename() {
    setRenaming(false);
    if (draft.trim() && draft.trim() !== conversation.title) {
      chatStore.rename(conversation.id, draft);
    }
  }

  return (
    <li>
      <div
        className={cn(
          'group relative flex items-center gap-2 rounded-md px-2 py-1.5 text-sm cursor-pointer transition-colors',
          active
            ? 'bg-sidebar-accent text-sidebar-accent-foreground'
            : 'text-foreground/80 hover:bg-sidebar-accent/50',
        )}
        onClick={() => !renaming && onSelect()}
      >
        <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />
        {renaming ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.currentTarget.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitRename();
              } else if (e.key === 'Escape') {
                setRenaming(false);
                setDraft(conversation.title);
              }
            }}
            className="flex-1 min-w-0 bg-transparent outline-none border border-border rounded px-1 py-0.5 text-sm"
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="flex-1 min-w-0 truncate">{conversation.title}</span>
        )}

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((v) => !v);
          }}
          className={cn(
            'rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground',
            active || menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
          )}
          aria-label="Conversation menu"
        >
          <MoreHorizontal className="size-3.5" />
        </button>

        {menuOpen && (
          <ConversationItemMenu
            onClose={() => setMenuOpen(false)}
            onRename={() => {
              setMenuOpen(false);
              setRenaming(true);
            }}
            onDelete={() => {
              setMenuOpen(false);
              if (window.confirm(`Delete "${conversation.title}"?`)) {
                chatStore.remove(conversation.id);
              }
            }}
          />
        )}
      </div>
    </li>
  );
}

function ConversationItemMenu({
  onClose,
  onRename,
  onDelete,
}: {
  onClose: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [onClose]);
  return (
    <div
      ref={ref}
      className="absolute right-1 top-8 z-20 min-w-32 rounded-md border border-border bg-popover text-popover-foreground shadow-md py-1"
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        onClick={onRename}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-xs hover:bg-accent"
      >
        <Pencil className="size-3.5" />
        Rename
      </button>
      <button
        type="button"
        onClick={onDelete}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-xs text-destructive hover:bg-destructive/10"
      >
        <Trash2 className="size-3.5" />
        Delete
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Empty state (no conversation selected)
// ─────────────────────────────────────────────────────────────────────

function EmptyState({ onNewChat }: { onNewChat: () => void }) {
  const SUGGESTIONS = [
    'Summarize what I worked on yesterday',
    'Find the doc about onboarding I read last week',
    'What meetings did I have today?',
    'Draft a follow-up to the design review',
  ];
  return (
    <div className="flex-1 grid place-items-center px-6">
      <div className="flex flex-col items-center text-center gap-4 max-w-xl">
        <div className="size-12 rounded-full bg-primary/10 grid place-items-center">
          <MessageSquare className="size-5 text-primary" />
        </div>
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">How can I help?</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Chat with an AI agent grounded in your captured memory. Conversations stay on
            this device.
          </p>
        </div>
        <Button onClick={onNewChat} size="lg" className="gap-2">
          <Plus className="size-4" />
          Start a new chat
        </Button>
        <div className="grid w-full grid-cols-1 gap-2 sm:grid-cols-2 mt-4">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => {
                const conv = chatStore.create();
                chatStore.setActiveId(conv.id);
                queueMicrotask(() => sendUserMessage(conv.id, s));
              }}
              className="rounded-lg border border-border bg-card px-3 py-2.5 text-left text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
            >
              {s}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Thread (right side: messages + composer)
// ─────────────────────────────────────────────────────────────────────

function ChatThread({ conversation }: { conversation: ChatConversation }) {
  const scrollerRef = React.useRef<HTMLDivElement>(null);
  const lastCountRef = React.useRef(conversation.messages.length);
  const lastContentLenRef = React.useRef(
    conversation.messages[conversation.messages.length - 1]?.content.length ?? 0,
  );

  // Auto-scroll on new messages or while a streaming message grows. We
  // intentionally do not preserve the user's scroll position when they
  // scroll up mid-stream — keeping it simple for now.
  React.useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const last = conversation.messages[conversation.messages.length - 1];
    const lastLen = last?.content.length ?? 0;
    const grew = conversation.messages.length !== lastCountRef.current
      || lastLen !== lastContentLenRef.current;
    lastCountRef.current = conversation.messages.length;
    lastContentLenRef.current = lastLen;
    if (grew) el.scrollTop = el.scrollHeight;
  }, [conversation.messages]);

  const empty = conversation.messages.length === 0;

  return (
    <>
      <header className="border-b border-border px-6 py-3 flex items-center gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium truncate">{conversation.title}</div>
          <div className="text-[11px] text-muted-foreground">
            Local · {conversation.messages.length} message
            {conversation.messages.length === 1 ? '' : 's'}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <ModelPill />
        </div>
      </header>

      <div ref={scrollerRef} className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-6 py-8">
          {empty ? (
            <ThreadEmpty />
          ) : (
            <ul className="flex flex-col gap-6">
              {conversation.messages.map((m) => (
                <MessageBubble
                  key={m.id}
                  message={m}
                  conversationId={conversation.id}
                  onRegenerate={() => regenerateLastAssistant(conversation.id)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>

      <Composer conversationId={conversation.id} />
    </>
  );
}

function ThreadEmpty() {
  return (
    <div className="text-center text-sm text-muted-foreground py-12">
      <p>Send a message to get started. This chat is stored only on your device.</p>
    </div>
  );
}

function ModelPill() {
  return (
    <div className="flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1 text-[11px] text-muted-foreground">
      <span className="size-1.5 rounded-full bg-success" />
      Local model
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Message bubble (user / assistant + reasoning + thinking)
// ─────────────────────────────────────────────────────────────────────

function MessageBubble({
  message,
  conversationId,
  onRegenerate,
}: {
  message: ChatMessage;
  conversationId: string;
  onRegenerate: () => void;
}) {
  const isUser = message.role === 'user';

  return (
    <li className={cn('group flex gap-3', isUser ? 'justify-end' : 'justify-start')}>
      {!isUser && <AssistantAvatar />}
      <div
        className={cn(
          'flex flex-col gap-1.5 min-w-0',
          isUser ? 'max-w-[80%] items-end' : 'max-w-[85%] items-start',
        )}
      >
        {!isUser && message.reasoning && (
          <ReasoningDisclosure
            reasoning={message.reasoning}
            thinking={message.status === 'thinking'}
          />
        )}
        {message.status === 'thinking' && !message.content ? (
          <ThinkingIndicator />
        ) : (
          <div
            className={cn(
              'rounded-2xl px-4 py-2.5 text-sm leading-relaxed break-words',
              isUser
                ? 'bg-primary text-primary-foreground rounded-br-md'
                : 'bg-muted/60 text-foreground rounded-bl-md',
            )}
          >
            {isUser ? (
              <div className="whitespace-pre-wrap">{message.content}</div>
            ) : (
              <Markdown content={message.content || '…'} />
            )}
            {message.status === 'streaming' && <StreamingCaret />}
          </div>
        )}

        {message.status === 'error' && (
          <div className="text-xs text-destructive">
            Something went wrong generating this response.
          </div>
        )}

        <MessageActions
          message={message}
          conversationId={conversationId}
          onRegenerate={onRegenerate}
        />
      </div>
    </li>
  );
}

function AssistantAvatar() {
  return (
    <div className="size-7 shrink-0 rounded-full bg-primary/15 grid place-items-center text-primary">
      <Brain className="size-3.5" />
    </div>
  );
}

function StreamingCaret() {
  return (
    <span
      aria-hidden
      className="ml-0.5 inline-block h-3.5 w-1 translate-y-0.5 animate-pulse bg-current align-middle"
    />
  );
}

function ThinkingIndicator() {
  return (
    <div className="flex items-center gap-2 rounded-2xl bg-muted/60 px-4 py-2.5 text-xs text-muted-foreground">
      <span className="flex gap-1">
        <Dot delay={0} />
        <Dot delay={150} />
        <Dot delay={300} />
      </span>
      <span>Thinking…</span>
    </div>
  );
}

function Dot({ delay }: { delay: number }) {
  return (
    <span
      className="size-1.5 rounded-full bg-current animate-bounce"
      style={{ animationDelay: `${delay}ms` }}
    />
  );
}

function ReasoningDisclosure({
  reasoning,
  thinking,
}: {
  reasoning: string;
  thinking: boolean;
}) {
  // Open by default while the model is still thinking, collapsed once it lands.
  const [open, setOpen] = React.useState(thinking);
  React.useEffect(() => {
    if (thinking) setOpen(true);
  }, [thinking]);

  return (
    <div className="w-full rounded-lg border border-border bg-muted/30">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <Brain className="size-3.5" />
        <span>{thinking ? 'Reasoning…' : 'Reasoning'}</span>
        <ChevronDown
          className={cn(
            'ml-auto size-3.5 transition-transform',
            open ? 'rotate-180' : 'rotate-0',
          )}
        />
      </button>
      {open && (
        <div className="border-t border-border px-3 py-2 text-xs text-muted-foreground whitespace-pre-wrap leading-relaxed">
          {reasoning || 'Working through your question…'}
        </div>
      )}
    </div>
  );
}

function MessageActions({
  message,
  conversationId,
  onRegenerate,
}: {
  message: ChatMessage;
  conversationId: string;
  onRegenerate: () => void;
}) {
  const isUser = message.role === 'user';
  const transient = message.status === 'thinking' || message.status === 'streaming';
  if (transient) return null;

  async function copy() {
    try {
      await navigator.clipboard.writeText(message.content);
    } catch {
      /* ignore */
    }
  }

  return (
    <div
      className={cn(
        'flex items-center gap-1 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity',
        isUser ? 'justify-end' : 'justify-start',
      )}
    >
      <IconAction title="Copy" onClick={copy}>
        <Copy className="size-3.5" />
      </IconAction>
      {!isUser && (
        <IconAction title="Regenerate" onClick={onRegenerate}>
          <RefreshCw className="size-3.5" />
        </IconAction>
      )}
      <IconAction
        title="Delete message"
        onClick={() => chatStore.removeMessage(conversationId, message.id)}
      >
        <Trash2 className="size-3.5" />
      </IconAction>
    </div>
  );
}

function IconAction({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="rounded p-1 hover:bg-accent hover:text-foreground"
    >
      {children}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Composer
// ─────────────────────────────────────────────────────────────────────

function Composer({ conversationId }: { conversationId: string }) {
  const [value, setValue] = React.useState('');
  const taRef = React.useRef<HTMLTextAreaElement>(null);
  const isThinking = useIsAssistantWorking(conversationId);

  // Autosize the textarea to its content, capped so a long paste doesn't
  // eat the whole thread. The cap is roughly 8 lines.
  React.useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  function send() {
    const text = value.trim();
    if (!text || isThinking) return;
    setValue('');
    void sendUserMessage(conversationId, text);
  }

  function stop() {
    cancelAssistant(conversationId);
  }

  return (
    <div className="border-t border-border bg-background">
      <div className="mx-auto max-w-3xl px-6 py-4">
        <div className="flex items-end gap-2 rounded-2xl border border-border bg-card shadow-sm focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30 transition-shadow px-3 py-2">
          <textarea
            ref={taRef}
            value={value}
            onChange={(e) => setValue(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            placeholder="Message your agent…"
            rows={1}
            className="flex-1 resize-none bg-transparent text-sm leading-6 placeholder:text-muted-foreground outline-none py-1.5 max-h-[200px]"
          />
          {isThinking ? (
            <Button
              type="button"
              size="icon"
              variant="secondary"
              onClick={stop}
              title="Stop generating"
              className="rounded-full"
            >
              <Square className="size-3.5 fill-current" />
            </Button>
          ) : (
            <Button
              type="button"
              size="icon"
              onClick={send}
              disabled={!value.trim()}
              title="Send (Enter)"
              className="rounded-full"
            >
              <ArrowUp className="size-4" />
            </Button>
          )}
        </div>
        <div className="mt-2 text-center text-[11px] text-muted-foreground">
          Press Enter to send · Shift + Enter for newline · Chats stay on this device
        </div>
      </div>
    </div>
  );
}

function useIsAssistantWorking(conversationId: string): boolean {
  const conversations = useConversations();
  const conv = conversations.find((c) => c.id === conversationId);
  if (!conv) return false;
  return conv.messages.some(
    (m) => m.role === 'assistant' && (m.status === 'thinking' || m.status === 'streaming'),
  );
}

// ─────────────────────────────────────────────────────────────────────
// Real assistant — drives the local AI harness in the runtime process.
// ─────────────────────────────────────────────────────────────────────

const activeRuns = new Map<string, { messageId: string; cancel: () => void }>();

function sendUserMessage(conversationId: string, content: string): void {
  chatStore.appendMessage(conversationId, { role: 'user', content });
  startAssistantTurn(conversationId);
}

function regenerateLastAssistant(conversationId: string): void {
  const conv = chatStore.get(conversationId);
  if (!conv) return;
  const lastAssistantIdx = [...conv.messages].reverse().findIndex((m) => m.role === 'assistant');
  if (lastAssistantIdx >= 0) {
    const real = conv.messages.length - 1 - lastAssistantIdx;
    const target = conv.messages[real]!;
    chatStore.removeMessage(conversationId, target.id);
  }
  startAssistantTurn(conversationId);
}

function cancelAssistant(conversationId: string): void {
  const run = activeRuns.get(conversationId);
  if (!run) return;
  run.cancel();
  cancelChatTurn(run.messageId);
  activeRuns.delete(conversationId);
}

/**
 * Append a thinking assistant message and kick off a harness turn.
 * The renderer side of the harness streams content + reasoning into
 * that message in place; we just need to track it so Stop / unmount
 * can cancel cleanly.
 */
function startAssistantTurn(conversationId: string): void {
  const conv = chatStore.get(conversationId);
  if (!conv) return;
  const placeholder = chatStore.appendMessage(conversationId, {
    role: 'assistant',
    content: '',
    reasoning: '',
    status: 'thinking',
  });
  const history = conv.messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map<{ role: 'user' | 'assistant'; content: string }>((m) => ({ role: m.role, content: m.content }));
  // The history we send is everything *before* the placeholder; the
  // last user message is the question and is sent separately.
  const lastUser = [...conv.messages].reverse().find((m) => m.role === 'user');
  if (!lastUser) return;
  const trimmedHistory = history.slice(0, -1);

  const handle = runChatTurn({
    conversationId,
    message: lastUser.content,
    assistantMessageId: placeholder.id,
    history: trimmedHistory,
  });
  activeRuns.set(conversationId, { messageId: placeholder.id, cancel: handle.cancel });
  void handle.done.finally(() => {
    const tracked = activeRuns.get(conversationId);
    if (tracked && tracked.messageId === placeholder.id) {
      activeRuns.delete(conversationId);
    }
  });
}
