import * as React from 'react';
import {
  ArrowUp,
  Brain,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileSearch,
  ListChecks,
  MessageSquarePlus,
  MoreHorizontal,
  Pencil,
  Pin,
  RotateCcw,
  Search,
  Sparkles,
  SquareActivity,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Markdown } from '@/components/Markdown';
import { cn } from '@/lib/utils';
import type { ChatStreamEvent } from '@/global';
import mascotRecallUrl from '@/assets/mascot-recall.png';

interface ReasoningStep {
  kind: 'thought';
  text: string;
  partId?: string;
}
interface ToolCallStep {
  kind: 'tool';
  callId: string;
  tool: string;
  status: 'running' | 'done' | 'error';
  durationMs?: number;
  args: Record<string, unknown>;
  result?: string;
}
type AgentStep = ReasoningStep | ToolCallStep;

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string; // ISO
  steps?: AgentStep[];
  thoughtForMs?: number;
  startedAtMs?: number;
  pending?: boolean;
}

interface Conversation {
  id: string;
  title: string;
  lastMessageAt: string; // ISO
  preview: string;
  pinned?: boolean;
  messages: Message[];
}

const STARTERS = [
  { icon: CalendarDays, text: 'What did I do today?' },
  { icon: SquareActivity, text: 'Summarize my meetings this week' },
  { icon: FileSearch, text: 'Find pages I visited about pricing' },
  { icon: Brain, text: 'What was I working on yesterday afternoon?' },
  { icon: Pencil, text: 'Draft a status update from today\'s work' },
  { icon: ListChecks, text: 'What did Tanya ask me to do last week?' },
];

// -------------------------------------------------------------------------

export function Ai() {
  const initialConversations = React.useMemo(() => [createConversation()], []);
  const [conversations, setConversations] =
    React.useState<Conversation[]>(initialConversations);
  const [activeId, setActiveId] = React.useState<string>(initialConversations[0]!.id);
  const [draft, setDraft] = React.useState('');

  const active = conversations.find((c) => c.id === activeId) ?? null;
  const activeBusy = active?.messages.some((m) => m.pending) ?? false;

  React.useEffect(() => {
    if (conversations.some((c) => c.id === activeId)) return;
    if (conversations[0]) setActiveId(conversations[0].id);
  }, [activeId, conversations]);

  React.useEffect(() => {
    const unsubscribe = window.beside?.onChatStream?.((event) => {
      applyChatEvent(event, setConversations);
    });
    return () => unsubscribe?.();
  }, []);

  const startNewConversation = () => {
    const fresh = createConversation();
    setConversations((prev) => [fresh, ...prev]);
    setActiveId(fresh.id);
    setDraft('');
  };

  const deleteConversation = (id: string) => {
    setConversations((prev) => {
      const next = prev.filter((c) => c.id !== id);
      if (id === activeId && next[0]) setActiveId(next[0].id);
      return next;
    });
  };

  const sendDraft = (text?: string) => {
    const value = (text ?? draft).trim();
    if (!value || !active || activeBusy) return;
    const now = new Date().toISOString();
    const turnId = `m-a-${Date.now()}`;
    const history = active.messages
      .filter((m) => !m.pending && m.content.trim())
      .slice(-12)
      .map((m) => ({ role: m.role, content: m.content }));
    const userMsg: Message = {
      id: `m-${Date.now()}`,
      role: 'user',
      content: value,
      createdAt: now,
    };
    const assistantMsg: Message = {
      id: turnId,
      role: 'assistant',
      content: '',
      createdAt: now,
      pending: true,
      startedAtMs: Date.now(),
      steps: [],
    };
    setConversations((prev) =>
      prev.map((c) =>
        c.id === active.id
          ? {
              ...c,
              title:
                c.messages.length === 0
                  ? value.slice(0, 60)
                  : c.title,
              preview: value,
              lastMessageAt: new Date().toISOString(),
              messages: [...c.messages, userMsg, assistantMsg],
            }
          : c,
      ),
    );
    setDraft('');
    void window.beside.chatTurn({
      turnId,
      conversationId: active.id,
      message: value,
      history,
    }).catch((err: any) => {
      applyChatEvent({ kind: 'error', turnId, message: err?.message || String(err) }, setConversations);
    });
  };

  return (
    <div className="-mx-8 flex h-[calc(100vh-2rem)] overflow-hidden">
      <ConversationList
        conversations={conversations}
        activeId={activeId}
        onSelect={setActiveId}
        onNew={startNewConversation}
        onDelete={deleteConversation}
      />
      <div className="flex flex-1 flex-col overflow-hidden border-l border-border bg-background">
        {active ? (
          <ChatPane
            key={active.id}
            conversation={active}
            draft={draft}
            onDraftChange={setDraft}
            onSend={sendDraft}
            onStarter={(text) => sendDraft(text)}
            busy={activeBusy}
          />
        ) : (
          <div className="grid flex-1 place-items-center text-sm text-muted-foreground">
            Pick a conversation or start a new one.
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------- Conversation list -------------------------------------

function ConversationList({
  conversations,
  activeId,
  onSelect,
  onNew,
  onDelete,
}: {
  conversations: Conversation[];
  activeId: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}) {
  const [query, setQuery] = React.useState('');
  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        c.preview.toLowerCase().includes(q),
    );
  }, [conversations, query]);

  const groups = React.useMemo(() => groupByRecency(filtered), [filtered]);

  return (
    <aside className="flex w-64 shrink-0 flex-col bg-muted/20">
      <div className="px-3 pt-6 pb-3">
        <Button
          onClick={onNew}
          variant="outline"
          className="w-full justify-start gap-2"
        >
          <MessageSquarePlus className="size-4" />
          New conversation
        </Button>
      </div>
      <div className="px-3 pb-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            placeholder="Search chats..."
            className="h-8 w-full rounded-md border border-border bg-background/60 pl-8 pr-2 text-[13px] outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-3">
        {groups.map((g) => (
          <div key={g.label} className="mt-3 first:mt-1">
            <div className="px-2 pb-1 text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground/70">
              {g.label}
            </div>
            <div className="flex flex-col gap-0.5">
              {g.items.map((c) => (
                <ConversationItem
                  key={c.id}
                  conversation={c}
                  active={c.id === activeId}
                  onClick={() => onSelect(c.id)}
                  onDelete={() => onDelete(c.id)}
                />
              ))}
            </div>
          </div>
        ))}
        {groups.length === 0 && (
          <div className="px-2 pt-6 text-center text-xs text-muted-foreground">
            No chats match "{query}".
          </div>
        )}
      </div>
    </aside>
  );
}

function ConversationItem({
  conversation,
  active,
  onClick,
  onDelete,
}: {
  conversation: Conversation;
  active: boolean;
  onClick: () => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = React.useState(false);
  return (
    <div
      className={cn(
        'group relative flex items-center rounded-md text-[13px] transition-colors',
        active
          ? 'bg-sidebar-accent text-sidebar-accent-foreground'
          : 'text-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground',
      )}
    >
      <button
        type="button"
        onClick={onClick}
        title={conversation.title}
        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
      >
        {conversation.pinned && (
          <Pin className="size-3 shrink-0 text-primary" />
        )}
        <span className="min-w-0 flex-1 truncate">{conversation.title}</span>
        <span className="shrink-0 text-[10px] text-muted-foreground/70">
          {formatRelativeTime(conversation.lastMessageAt, { short: true })}
        </span>
      </button>
      <div className="relative pr-1">
        <button
          type="button"
          aria-label="Conversation options"
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((v) => !v);
          }}
          className={cn(
            'grid size-6 place-items-center rounded text-muted-foreground transition-opacity hover:bg-background hover:text-foreground',
            active || menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
          )}
        >
          <MoreHorizontal className="size-3.5" />
        </button>
        {menuOpen && (
          <>
            <div
              className="fixed inset-0 z-10"
              onClick={() => setMenuOpen(false)}
            />
            <div className="absolute right-0 top-7 z-20 w-36 overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md">
              <MenuItem icon={<Pencil className="size-3.5" />} label="Rename" onClick={() => setMenuOpen(false)} />
              <MenuItem
                icon={<Trash2 className="size-3.5" />}
                label="Delete"
                onClick={() => {
                  setMenuOpen(false);
                  onDelete();
                }}
                destructive
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  destructive,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] hover:bg-accent',
        destructive && 'text-destructive hover:bg-destructive/10',
      )}
    >
      {icon}
      {label}
    </button>
  );
}

// ------------------------- Chat pane ------------------------------------

function ChatPane({
  conversation,
  draft,
  onDraftChange,
  onSend,
  onStarter,
  busy,
}: {
  conversation: Conversation;
  draft: string;
  onDraftChange: (next: string) => void;
  onSend: () => void;
  onStarter: (text: string) => void;
  busy: boolean;
}) {
  const scrollerRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [conversation.id, conversation.messages.length]);

  const isEmpty = conversation.messages.length === 0;
  const lastMessage = conversation.messages[conversation.messages.length - 1];
  const awaitingAssistant = lastMessage?.role === 'user';
  const count = conversation.messages.length;

  return (
    <>
      <header className="flex items-center justify-between gap-3 border-b border-border px-6 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {conversation.pinned && (
              <Pin className="size-3.5 shrink-0 text-primary" />
            )}
            <div className="truncate text-sm font-semibold">{conversation.title}</div>
          </div>
          {!isEmpty && (
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              {count} message{count === 1 ? '' : 's'} - updated{' '}
              {formatRelativeTime(conversation.lastMessageAt)}
            </div>
          )}
        </div>
      </header>

      <div ref={scrollerRef} className="flex-1 overflow-y-auto">
        {isEmpty ? (
          <EmptyState onPick={onStarter} />
        ) : (
          <div className="mx-auto flex min-h-full max-w-3xl flex-col justify-end gap-6 px-6 py-8">
            {conversation.messages.map((m) => (
              <MessageView key={m.id} message={m} />
            ))}
            {awaitingAssistant && <ThinkingBubble />}
          </div>
        )}
      </div>

      <Composer draft={draft} onDraftChange={onDraftChange} onSend={onSend} busy={busy} />
    </>
  );
}

function ThinkingBubble() {
  return (
    <div className="flex gap-3">
      <div className="grid size-7 shrink-0 place-items-center rounded-full bg-gradient-brand-soft">
        <Sparkles className="size-3.5 animate-pulse" />
      </div>
      <ThinkingDots />
    </div>
  );
}

function ThinkingDots() {
  return (
    <div className="inline-flex items-center gap-1.5 rounded-2xl rounded-tl-md bg-card px-4 py-3 shadow-xs">
      <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/50 [animation-delay:-300ms]" />
      <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/50 [animation-delay:-150ms]" />
      <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/50" />
      <span className="ml-1 text-[11px] text-muted-foreground">Thinking...</span>
    </div>
  );
}

function StreamingCaret() {
  return (
    <span
      aria-hidden
      className="ml-0.5 inline-block h-[1em] w-[2px] translate-y-[2px] animate-pulse bg-primary align-middle"
    />
  );
}

function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="mx-auto flex max-w-3xl flex-col items-center gap-8 px-6 pt-12 pb-12 text-center">
      <div className="flex flex-col items-center gap-4">
        <div className="relative grid place-items-center">
          <div
            aria-hidden
            className="absolute size-40 rounded-full bg-gradient-brand-soft blur-3xl opacity-90"
          />
          <img
            src={mascotRecallUrl}
            alt=""
            aria-hidden
            className="relative size-28 select-none object-contain drop-shadow-[0_14px_28px_rgba(107,108,240,0.35)] mascot-bob"
            draggable={false}
          />
        </div>
        <h2 className="text-2xl font-semibold tracking-tight">
          Ask your memory anything
        </h2>
        <p className="max-w-md text-sm text-muted-foreground">
          Beside has been watching alongside you. Ask about today, last week, or
          anything you saw on screen. It can search, summarize, and pull up
          context.
        </p>
      </div>
      <div className="grid w-full grid-cols-1 gap-2 sm:grid-cols-2">
        {STARTERS.map((s) => (
          <StarterButton key={s.text} starter={s} onPick={onPick} />
        ))}
      </div>
    </div>
  );
}

function StarterButton({
  starter,
  onPick,
}: {
  starter: { icon: LucideIcon; text: string };
  onPick: (text: string) => void;
}) {
  const Icon = starter.icon;
  return (
    <button
      type="button"
      onClick={() => onPick(starter.text)}
      className="group flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-left text-sm transition-all hover:border-primary/40 hover:bg-accent/50 hover:shadow-sm"
    >
      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
        <Icon className="size-4" />
      </span>
      <span className="flex-1">{starter.text}</span>
      <ChevronRight className="size-4 shrink-0 opacity-0 transition-opacity group-hover:opacity-60" />
    </button>
  );
}

// ----------------- Message rendering ------------------------------------

function MessageView({ message }: { message: Message }) {
  if (message.role === 'user') {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="max-w-[78%] rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm text-primary-foreground shadow-xs">
          {message.content.split('\n').map((line, i) => (
            <p key={i} className="leading-relaxed first:mt-0 last:mb-0">
              {line || '\u00a0'}
            </p>
          ))}
        </div>
        <span
          className="pr-1 text-[10px] text-muted-foreground/70"
          title={new Date(message.createdAt).toLocaleString()}
        >
          {formatClockTime(message.createdAt)}
        </span>
      </div>
    );
  }
  return <AssistantMessage message={message} />;
}

function AssistantMessage({ message }: { message: Message }) {
  const hasSteps = (message.steps?.length ?? 0) > 0;
  const showThinkingBubble = message.pending && !hasSteps && !message.content;
  return (
    <div className="flex gap-3">
      <div className="grid size-7 shrink-0 place-items-center rounded-full bg-gradient-brand-soft">
        <Sparkles
          className={cn('size-3.5', message.pending && 'animate-pulse')}
        />
      </div>
      <div className="flex-1 min-w-0">
        {hasSteps && (
          <ReasoningBlock
            steps={message.steps!}
            totalMs={message.thoughtForMs}
            pending={message.pending}
          />
        )}
        {showThinkingBubble && <ThinkingDots />}
        {message.content && (
          <div className="rounded-2xl rounded-tl-md bg-card px-4 py-3 text-sm shadow-xs">
            <Markdown content={message.content} />
            {message.pending && <StreamingCaret />}
          </div>
        )}
        <div className="mt-1.5 flex items-center gap-1.5 pl-1 text-muted-foreground">
          {!message.pending && (
            <>
              <IconAction icon={<Copy className="size-3.5" />} label="Copy" />
              <IconAction icon={<RotateCcw className="size-3.5" />} label="Regenerate" />
              <IconAction icon={<ThumbsUp className="size-3.5" />} label="Good answer" />
              <IconAction icon={<ThumbsDown className="size-3.5" />} label="Bad answer" />
            </>
          )}
          <span
            className="ml-auto pr-1 text-[10px] text-muted-foreground/70"
            title={new Date(message.createdAt).toLocaleString()}
          >
            {formatClockTime(message.createdAt)}
          </span>
        </div>
      </div>
    </div>
  );
}

function IconAction({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className="grid size-7 place-items-center rounded-md text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
    >
      {icon}
    </button>
  );
}

function ReasoningBlock({
  steps,
  totalMs,
  pending,
}: {
  steps: AgentStep[];
  totalMs?: number;
  pending?: boolean;
}) {
  // Auto-expand while pending so the user can watch the model reason in
  // real time. Once the turn finishes, collapse to get out of the way —
  // the user can re-open with the chevron. Completed messages from
  // earlier in the session start collapsed.
  const [open, setOpen] = React.useState(pending ?? false);
  const wasPendingRef = React.useRef(pending ?? false);
  React.useEffect(() => {
    if (wasPendingRef.current && !pending) setOpen(false);
    wasPendingRef.current = pending ?? false;
  }, [pending]);

  const seconds = totalMs != null ? (totalMs / 1000).toFixed(1) : null;
  const summary = (() => {
    const tools = steps.filter((s): s is ToolCallStep => s.kind === 'tool');
    const thoughts = steps.filter((s): s is ReasoningStep => s.kind === 'thought');
    if (pending) {
      if (tools.some((t) => t.status === 'running')) return 'Checking sources...';
      if (thoughts.length) return 'Thinking...';
      return 'Working...';
    }
    if (tools.length && thoughts.length) {
      return `Checked ${tools.length} source${tools.length === 1 ? '' : 's'}${seconds ? ` in ${seconds}s` : ''}`;
    }
    if (tools.length) {
      return `Used ${tools.length} source${tools.length === 1 ? '' : 's'}${seconds ? ` in ${seconds}s` : ''}`;
    }
    return `Reasoning${seconds ? ` for ${seconds}s` : ''}`;
  })();

  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
          pending && 'text-foreground',
        )}
      >
        <Brain className={cn('size-3.5', pending && 'animate-pulse text-primary')} />
        <span>{summary}</span>
        <ChevronDown
          className={cn('size-3.5 transition-transform', open && 'rotate-180')}
        />
      </button>
      {open && (
        <div className="mt-2 ml-1 flex flex-col gap-2 border-l-2 border-border pl-3">
          {steps.map((step, i) =>
            step.kind === 'thought' ? (
              <ThoughtBlock key={i} text={step.text} />
            ) : (
              <ToolCallBlock key={i} step={step} />
            ),
          )}
        </div>
      )}
    </div>
  );
}

function ThoughtBlock({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 text-[13px] leading-relaxed text-muted-foreground">
      <span className="mt-1 size-1.5 shrink-0 rounded-full bg-muted-foreground/40" />
      <p className="italic">{text}</p>
    </div>
  );
}

function ToolCallBlock({ step }: { step: ToolCallStep }) {
  const [open, setOpen] = React.useState(false);
  const statusBadge = (() => {
    if (step.status === 'running')
      return (
        <span className="inline-flex items-center gap-1 text-amber-500">
          <span className="size-1.5 animate-pulse rounded-full bg-amber-500" />
          Running
        </span>
      );
    if (step.status === 'error')
      return <span className="text-destructive">Failed</span>;
    return (
      <span className="inline-flex items-center gap-1 text-emerald-500">
        <Check className="size-3" />
        {step.durationMs != null ? `${step.durationMs}ms` : 'Done'}
      </span>
    );
  })();

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-muted/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px]"
      >
        <Wrench className="size-3.5 text-muted-foreground" />
        <span className="font-mono text-foreground">{step.tool}</span>
        <span className="ml-auto flex items-center gap-2 text-muted-foreground">
          {statusBadge}
          <ChevronDown
            className={cn(
              'size-3.5 text-muted-foreground transition-transform',
              open && 'rotate-180',
            )}
          />
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-2 border-t border-border bg-background/40 px-3 py-2 text-[12px]">
          <div>
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
              Arguments
            </div>
            <pre className="overflow-x-auto rounded bg-muted/60 px-2 py-1.5 font-mono text-[11px] leading-relaxed">
              {JSON.stringify(step.args, null, 2)}
            </pre>
          </div>
          {step.result && (
            <div>
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
                Result
              </div>
              <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-muted/60 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
                {step.result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ----------------- Composer ---------------------------------------------

function Composer({
  draft,
  onDraftChange,
  onSend,
  busy,
}: {
  draft: string;
  onDraftChange: (next: string) => void;
  onSend: () => void;
  busy: boolean;
}) {
  const taRef = React.useRef<HTMLTextAreaElement | null>(null);

  // Autosize the textarea up to a soft cap.
  React.useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [draft]);

  const submit = () => {
    if (!draft.trim() || busy) return;
    onSend();
  };

  return (
    <div className="border-t border-border bg-background px-6 pb-5 pt-3">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-end gap-2 rounded-2xl border border-border bg-card px-3 py-2 shadow-xs transition-all focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30">
          <textarea
            ref={taRef}
            value={draft}
            onChange={(e) => onDraftChange(e.currentTarget.value)}
            disabled={busy}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Ask your memory..."
            rows={1}
            className="block max-h-[200px] flex-1 resize-none bg-transparent px-1 py-1.5 text-sm outline-none placeholder:text-muted-foreground"
          />
          <button
            type="button"
            onClick={submit}
            disabled={!draft.trim() || busy}
            aria-label="Send"
            className={cn(
              'grid size-8 shrink-0 place-items-center rounded-full transition-all',
              draft.trim() && !busy
                ? 'bg-primary text-primary-foreground hover:bg-primary/90 cursor-pointer'
                : 'bg-muted text-muted-foreground/50',
            )}
          >
            <ArrowUp className="size-4" />
          </button>
        </div>
        <p className="mt-2 text-center text-[11px] text-muted-foreground/70">
          Press <kbd className="rounded border bg-muted/60 px-1 font-mono text-[10px]">Enter</kbd> to send, <kbd className="rounded border bg-muted/60 px-1 font-mono text-[10px]">Shift+Enter</kbd> for a new line.
        </p>
      </div>
    </div>
  );
}

// --------------- helpers ------------------------------------------------

function createConversation(): Conversation {
  const now = new Date().toISOString();
  return {
    id: `c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: 'New conversation',
    lastMessageAt: now,
    preview: '',
    messages: [],
  };
}

function applyChatEvent(
  event: ChatStreamEvent,
  setConversations: React.Dispatch<React.SetStateAction<Conversation[]>>,
): void {
  setConversations((prev) =>
    prev.map((conversation) => {
      if (!conversation.messages.some((message) => message.id === event.turnId)) return conversation;
      let preview = conversation.preview;
      const messages = conversation.messages.map((message) => {
        if (message.id !== event.turnId) return message;
        const next = applyEventToMessage(message, event);
        if (next.role === 'assistant' && next.content.trim()) preview = next.content.trim().slice(0, 120);
        return next;
      });
      return { ...conversation, messages, preview, lastMessageAt: new Date().toISOString() };
    }),
  );
}

function applyEventToMessage(message: Message, event: ChatStreamEvent): Message {
  switch (event.kind) {
    case 'phase':
      return message;
    case 'reasoning':
      return appendThought(message, event.text, event.partId);
    case 'tool-call':
      return upsertTool(message, {
        kind: 'tool',
        callId: event.callId,
        tool: event.tool,
        status: 'running',
        args: event.args,
      });
    case 'tool-result':
      return finishTool(message, event.callId, event.summary);
    case 'content':
      return { ...message, content: `${message.content}${event.delta}` };
    case 'content-reset':
      return { ...message, content: '' };
    case 'done':
      return {
        ...message,
        pending: false,
        thoughtForMs: message.startedAtMs ? Date.now() - message.startedAtMs : message.thoughtForMs,
      };
    case 'error':
      return {
        ...message,
        pending: false,
        content: message.content || `I hit an issue while asking the local harness:\n\n${event.message}`,
        steps: [
          ...(message.steps ?? []),
          { kind: 'thought', text: `Harness error: ${event.message}` },
        ],
        thoughtForMs: message.startedAtMs ? Date.now() - message.startedAtMs : message.thoughtForMs,
      };
    default:
      return message;
  }
}

function appendThought(message: Message, text: string, partId?: string): Message {
  if (!text.trim()) return message;
  const steps = message.steps ?? [];
  // If we have a partId, the harness is streaming this same reasoning
  // chunk in place — replace the matching step's text instead of pushing
  // a new bullet for every token.
  if (partId) {
    const idx = steps.findIndex((s) => s.kind === 'thought' && s.partId === partId);
    if (idx !== -1) {
      const next = steps.slice();
      next[idx] = { kind: 'thought', text, partId };
      return { ...message, steps: next };
    }
    return { ...message, steps: [...steps, { kind: 'thought', text, partId }] };
  }
  const last = steps[steps.length - 1];
  if (last?.kind === 'thought' && last.text === text) return message;
  return { ...message, steps: [...steps, { kind: 'thought', text }] };
}

function upsertTool(message: Message, step: ToolCallStep): Message {
  const steps = message.steps ?? [];
  const index = steps.findIndex((s) => s.kind === 'tool' && s.callId === step.callId);
  if (index === -1) return { ...message, steps: [...steps, step] };
  return {
    ...message,
    steps: steps.map((s, i) => (i === index ? { ...step, result: s.kind === 'tool' ? s.result : undefined } : s)),
  };
}

function finishTool(message: Message, callId: string, result: string): Message {
  const steps = message.steps ?? [];
  return {
    ...message,
    steps: steps.map((step) => {
      if (step.kind !== 'tool' || step.callId !== callId) return step;
      return { ...step, status: 'done', result };
    }),
  };
}

function formatClockTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatRelativeTime(
  iso: string,
  opts: { short?: boolean } = {},
): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const diff = Date.now() - d.getTime();
  const m = Math.round(diff / 60_000);
  if (m < 1) return opts.short ? 'now' : 'just now';
  if (m < 60) return opts.short ? `${m}m` : `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return opts.short ? `${h}h` : `${h}h ago`;
  const days = Math.round(h / 24);
  if (days < 7) return opts.short ? `${days}d` : `${days}d ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function groupByRecency(items: Conversation[]) {
  const buckets: { label: string; items: Conversation[] }[] = [
    { label: 'Pinned', items: [] },
    { label: 'Today', items: [] },
    { label: 'Previous 7 days', items: [] },
    { label: 'Older', items: [] },
  ];
  const now = Date.now();
  const dayMs = 86_400_000;
  for (const c of items) {
    const age = now - new Date(c.lastMessageAt).getTime();
    if (c.pinned) buckets[0]!.items.push(c);
    else if (age < dayMs) buckets[1]!.items.push(c);
    else if (age < 7 * dayMs) buckets[2]!.items.push(c);
    else buckets[3]!.items.push(c);
  }
  return buckets.filter((b) => b.items.length > 0);
}
