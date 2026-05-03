import * as React from 'react';
import {
  AlertTriangle,
  ArrowUp,
  Bot,
  Brain,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  Compass,
  Lightbulb,
  Loader2,
  MessageSquarePlus,
  PanelRightClose,
  PanelRightOpen,
  RefreshCcw,
  Sparkles,
  Trash2,
  User,
  Wrench,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Markdown } from '@/components/Markdown';
import { formatLocalDateTime } from '@/lib/format';
import { useInsightChats, type InsightChatSession } from '@/lib/insights-chat';
import { cn } from '@/lib/utils';
import type { AgentTraceStep, ChatMessage, Insight, InsightEvidence } from '@/global';

const SUGGESTIONS: Array<{ icon: React.ReactNode; label: string; prompt: string }> = [
  {
    icon: <Compass className="size-4" />,
    label: 'Where did my time go today?',
    prompt: 'Where did most of my time go today, and what tradeoffs do I see across apps and projects?',
  },
  {
    icon: <Sparkles className="size-4" />,
    label: 'Find repeated tasks',
    prompt: 'Are there repeating tasks or contexts I returned to this week that I could automate or batch?',
  },
  {
    icon: <Lightbulb className="size-4" />,
    label: 'Suggest deep-work blocks',
    prompt: 'Looking at my recent focus patterns, when should I block deep-work time tomorrow and on what?',
  },
  {
    icon: <Bot className="size-4" />,
    label: 'Surface follow-ups',
    prompt: 'List meetings, docs, or messages that look unresolved and need a follow-up from me.',
  },
];

export function Insights({
  insights,
  onRefresh,
  onDismiss,
  onOpenEvidence,
}: {
  insights: Insight[] | null;
  onRefresh: () => Promise<void>;
  onDismiss: (id: string) => Promise<void>;
  onOpenEvidence: (insight: Insight) => void;
}) {
  const chats = useInsightChats();
  const [pendingTurn, setPendingTurn] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  const [evidenceOpen, setEvidenceOpen] = React.useState(false);
  const [liveTrace, setLiveTrace] = React.useState<AgentTraceStep[]>([]);
  const activeTurnRef = React.useRef<{ sessionId: string; turnId: string } | null>(null);

  React.useEffect(() => {
    const unsubscribe = window.cofounderos.onAgentStep?.((payload) => {
      const active = activeTurnRef.current;
      if (!active || payload?.turnId !== active.turnId || !payload?.step) return;
      const incoming = payload.step;
      setLiveTrace((prev) => {
        const idx = prev.findIndex((existing) => existing.id === incoming.id);
        if (idx === -1) return [...prev, incoming];
        const merged = [...prev];
        merged[idx] = incoming;
        return merged;
      });
    });
    return () => {
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, []);

  const runTurn = React.useCallback(
    async (sessionId: string) => {
      const target = chats.sessions.find((session) => session.id === sessionId);
      if (!target || target.messages.length === 0) return;
      const last = target.messages[target.messages.length - 1];
      if (last && last.role !== 'user') return;
      const turnId =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `turn_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      activeTurnRef.current = { sessionId, turnId };
      setPendingTurn(sessionId);
      setLiveTrace([]);
      setError(null);
      try {
        const result = await window.cofounderos.chatInsights({
          messages: target.messages,
          insightId: target.insightId,
          refreshEvidence: target.messages.filter((message) => message.role === 'user').length <= 1,
          turnId,
        });
        chats.appendMessage(sessionId, result.message, result.evidence);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (activeTurnRef.current?.turnId === turnId) {
          activeTurnRef.current = null;
        }
        setPendingTurn((prev) => (prev === sessionId ? null : prev));
        setLiveTrace([]);
      }
    },
    [chats],
  );

  const lastTriggeredRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!chats.activeSession) return;
    const session = chats.activeSession;
    const last = session.messages[session.messages.length - 1];
    if (!last || last.role !== 'user') return;
    if (pendingTurn === session.id) return;
    const fingerprint = `${session.id}:${session.messages.length}`;
    if (lastTriggeredRef.current === fingerprint) return;
    lastTriggeredRef.current = fingerprint;
    void runTurn(session.id);
  }, [chats.activeSession, pendingTurn, runTurn]);

  async function refresh() {
    setRefreshing(true);
    setError(null);
    try {
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  }

  function startBlankChat(seedPrompt?: string) {
    const session = chats.startEmptySession(seedPrompt ? truncateTitle(seedPrompt) : 'New chat');
    if (seedPrompt) {
      chats.appendMessage(session.id, {
        role: 'user',
        content: seedPrompt,
        createdAt: new Date().toISOString(),
      });
    }
  }

  function startChatFromInsight(insight: Insight) {
    chats.startSessionFromInsight(insight);
  }

  function sendInActiveChat(content: string) {
    if (!chats.activeSession) {
      startBlankChat(content);
      return;
    }
    const session = chats.activeSession;
    const isFirstUserMessage = !session.messages.some((message) => message.role === 'user');
    if (isFirstUserMessage && session.title === 'New chat') {
      chats.renameSession(session.id, truncateTitle(content));
    }
    chats.appendMessage(session.id, {
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
    });
  }

  return (
    <div className="flex h-full min-h-0 w-full">
      <ChatRail
        chats={chats}
        insights={insights}
        refreshing={refreshing}
        onRefreshInsights={() => void refresh()}
        onNewChat={() => startBlankChat()}
        onPickInsight={startChatFromInsight}
        onDismissInsight={onDismiss}
        onOpenEvidence={onOpenEvidence}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <ChatCanvas
          session={chats.activeSession}
          isThinking={chats.activeSession ? pendingTurn === chats.activeSession.id : false}
          liveTrace={chats.activeSession && pendingTurn === chats.activeSession.id ? liveTrace : []}
          error={error}
          onSend={sendInActiveChat}
          onPickSuggestion={(prompt) => startBlankChat(prompt)}
          evidenceOpen={evidenceOpen}
          onToggleEvidence={() => setEvidenceOpen((prev) => !prev)}
          hasEvidence={!!chats.activeSession?.evidence && hasEvidenceContent(chats.activeSession.evidence)}
        />
      </div>
      {evidenceOpen && chats.activeSession?.evidence && (
        <EvidencePanel
          evidence={chats.activeSession.evidence}
          onClose={() => setEvidenceOpen(false)}
        />
      )}
    </div>
  );
}

function ChatRail({
  chats,
  insights,
  refreshing,
  onRefreshInsights,
  onNewChat,
  onPickInsight,
  onDismissInsight,
  onOpenEvidence,
}: {
  chats: ReturnType<typeof useInsightChats>;
  insights: Insight[] | null;
  refreshing: boolean;
  onRefreshInsights: () => void;
  onNewChat: () => void;
  onPickInsight: (insight: Insight) => void;
  onDismissInsight: (id: string) => Promise<void>;
  onOpenEvidence: (insight: Insight) => void;
}) {
  return (
    <aside className="flex h-full w-80 shrink-0 flex-col border-r border-border bg-sidebar/40">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div>
          <div className="text-sm font-semibold">Insights</div>
          <div className="text-xs text-muted-foreground">Chat with your local memory</div>
        </div>
        <Button size="sm" onClick={onNewChat}>
          <MessageSquarePlus />
          New chat
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <RailSection title="Chats" empty="No conversations yet. Start one to begin.">
          {chats.sessions.length > 0 && (
            <ul className="space-y-0.5">
              {chats.sessions.map((session) => (
                <RailRow
                  key={session.id}
                  active={session.id === chats.activeId}
                  onSelect={() => chats.setActiveId(session.id)}
                  onRemove={() => chats.removeSession(session.id)}
                  primary={session.title}
                  secondary={
                    session.insightId
                      ? `Seeded · ${formatLocalDateTime(session.updatedAt)}`
                      : formatLocalDateTime(session.updatedAt)
                  }
                />
              ))}
            </ul>
          )}
        </RailSection>

        <RailSection
          title="Insights"
          action={
            <Button variant="ghost" size="sm" onClick={onRefreshInsights} disabled={refreshing}>
              {refreshing ? <Loader2 className="animate-spin" /> : <RefreshCcw />}
            </Button>
          }
          empty="Insights show up here once activity has been captured."
        >
          {insights && insights.length > 0 && (
            <ul className="space-y-1">
              {insights.slice(0, 12).map((insight) => (
                <InsightRailRow
                  key={insight.id}
                  insight={insight}
                  onPick={() => onPickInsight(insight)}
                  onDismiss={() => void onDismissInsight(insight.id)}
                  onOpenEvidence={() => onOpenEvidence(insight)}
                />
              ))}
            </ul>
          )}
        </RailSection>
      </div>

      <div className="border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
        Conversations stay on this device.
      </div>
    </aside>
  );
}

function RailSection({
  title,
  action,
  empty,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  empty: string;
  children: React.ReactNode;
}) {
  return (
    <section className="px-2 py-3">
      <div className="flex items-center justify-between px-2 pb-1">
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {title}
        </div>
        {action}
      </div>
      {React.Children.count(children) === 0 ? null : children}
      {React.Children.count(children) === 0 || (Array.isArray(children) && children.length === 0) ? (
        <div className="px-2 pt-2 text-xs text-muted-foreground">{empty}</div>
      ) : null}
    </section>
  );
}

function RailRow({
  active,
  onSelect,
  onRemove,
  primary,
  secondary,
}: {
  active: boolean;
  onSelect: () => void;
  onRemove?: () => void;
  primary: string;
  secondary?: string;
}) {
  return (
    <li>
      <div
        className={cn(
          'group flex items-start gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
          active ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
        )}
      >
        <button
          type="button"
          onClick={onSelect}
          className="min-w-0 flex-1 text-left"
        >
          <div className="truncate font-medium leading-tight">{primary}</div>
          {secondary && (
            <div className="truncate text-[11px] text-muted-foreground">{secondary}</div>
          )}
        </button>
        {onRemove && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onRemove();
            }}
            className="opacity-0 transition-opacity group-hover:opacity-100"
            title="Delete chat"
          >
            <X className="size-3.5 text-muted-foreground" />
          </button>
        )}
      </div>
    </li>
  );
}

function InsightRailRow({
  insight,
  onPick,
  onDismiss,
  onOpenEvidence,
}: {
  insight: Insight;
  onPick: () => void;
  onDismiss: () => void;
  onOpenEvidence: () => void;
}) {
  const [showActions, setShowActions] = React.useState(false);
  return (
    <li
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
      className="rounded-md border border-transparent px-2 py-2 text-sm transition-colors hover:border-border hover:bg-accent/40"
    >
      <button
        type="button"
        onClick={onPick}
        className="block w-full text-left"
        title="Discuss this insight with the AI"
      >
        <div className="flex items-center gap-2">
          <Badge variant={severityVariant(insight.severity)} className="shrink-0">
            {severityLabel(insight.severity)}
          </Badge>
          <span className="truncate text-xs text-muted-foreground">
            {kindLabel(insight.kind)}
          </span>
        </div>
        <div className="mt-1 line-clamp-2 text-sm font-medium leading-snug">
          {insight.title}
        </div>
        <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
          {insight.summary}
        </div>
      </button>
      <div
        className={cn(
          'mt-2 flex items-center gap-2 transition-opacity',
          showActions ? 'opacity-100' : 'opacity-0',
        )}
      >
        <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={onOpenEvidence}>
          Evidence
        </Button>
        <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={onDismiss}>
          <Trash2 className="size-3" />
          Dismiss
        </Button>
      </div>
    </li>
  );
}

function ChatCanvas({
  session,
  isThinking,
  liveTrace,
  error,
  onSend,
  onPickSuggestion,
  evidenceOpen,
  onToggleEvidence,
  hasEvidence,
}: {
  session: InsightChatSession | null;
  isThinking: boolean;
  liveTrace: AgentTraceStep[];
  error: string | null;
  onSend: (content: string) => void;
  onPickSuggestion: (prompt: string) => void;
  evidenceOpen: boolean;
  onToggleEvidence: () => void;
  hasEvidence: boolean;
}) {
  const [draft, setDraft] = React.useState('');
  const composerRef = React.useRef<HTMLTextAreaElement>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [session?.id, session?.messages.length, isThinking]);

  React.useEffect(() => {
    requestAnimationFrame(() => composerRef.current?.focus());
  }, [session?.id]);

  function submit() {
    const value = draft.trim();
    if (!value || isThinking) return;
    setDraft('');
    onSend(value);
    requestAnimationFrame(() => composerRef.current?.focus());
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-border px-6 py-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">
            {session?.title ?? 'CofounderOS Insights'}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {session
              ? session.insightId
                ? 'Grounded in a captured insight'
                : 'Free chat with your local AI'
              : 'Pick an insight or start a new chat'}
          </div>
        </div>
        {hasEvidence && (
          <Button variant="ghost" size="sm" onClick={onToggleEvidence}>
            {evidenceOpen ? <PanelRightClose /> : <PanelRightOpen />}
            {evidenceOpen ? 'Hide evidence' : 'Show evidence'}
          </Button>
        )}
      </div>

      {error && (
        <div className="border-b border-border bg-warning/10 px-6 py-2 text-xs text-warning">
          {error}
        </div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-6">
        {!session || session.messages.length === 0 ? (
          <EmptyChatHero onPickSuggestion={onPickSuggestion} />
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-6">
            {session.messages.map((message, index) => (
              <ChatBubble key={`${session.id}:${index}`} message={message} />
            ))}
            {isThinking && (
              <AssistantTrace steps={liveTrace} streaming pendingThought={liveTrace.length === 0} />
            )}
          </div>
        )}
      </div>

      <div className="border-t border-border bg-background/95 px-6 py-4 backdrop-blur">
        <div className="mx-auto max-w-3xl">
          <div className="flex items-end gap-2 rounded-2xl border border-border bg-card p-2 shadow-sm focus-within:ring-2 focus-within:ring-ring/40">
            <Textarea
              ref={composerRef}
              autoFocus
              value={draft}
              onChange={(event) => setDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  submit();
                }
              }}
              placeholder="Message CofounderOS..."
              className="max-h-48 min-h-12 flex-1 resize-none border-0 bg-transparent px-3 py-2 text-sm shadow-none focus-visible:ring-0"
            />
            <Button
              size="icon"
              className="h-9 w-9 shrink-0 rounded-full"
              onClick={submit}
              disabled={!draft.trim() || isThinking}
              title="Send (Enter)"
            >
              {isThinking ? <Loader2 className="animate-spin" /> : <ArrowUp />}
            </Button>
          </div>
          <div className="mt-2 px-2 text-[11px] text-muted-foreground">
            Enter to send · Shift+Enter for newline · Conversations stay on this device.
          </div>
        </div>
      </div>
    </div>
  );
}

function EmptyChatHero({ onPickSuggestion }: { onPickSuggestion: (prompt: string) => void }) {
  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col items-center justify-center gap-8 py-10 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Bot className="size-6" />
      </div>
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">What do you want to understand?</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Ask the local AI about your captured activity, or pick an insight on the left to dig in.
        </p>
      </div>
      <div className="grid w-full grid-cols-1 gap-2 sm:grid-cols-2">
        {SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion.label}
            type="button"
            onClick={() => onPickSuggestion(suggestion.prompt)}
            className="flex items-start gap-3 rounded-xl border border-border bg-card px-4 py-3 text-left text-sm transition-colors hover:border-primary/40 hover:bg-accent/40"
          >
            <span className="mt-0.5 text-muted-foreground">{suggestion.icon}</span>
            <span>
              <span className="block font-medium leading-tight">{suggestion.label}</span>
              <span className="mt-1 block line-clamp-2 text-xs text-muted-foreground">
                {suggestion.prompt}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function ChatBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  const hasToolTrace = message.trace?.some((step) => step.kind === 'tool') ?? false;
  if (isUser) {
    return (
      <div className="flex w-full gap-3 flex-row-reverse">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-full border border-primary/30 bg-primary/10 text-primary">
          <User className="size-4" />
        </div>
        <div className="max-w-[75ch] rounded-2xl rounded-tr-sm bg-primary px-4 py-3 text-sm leading-relaxed text-primary-foreground shadow-sm">
          <div className="whitespace-pre-wrap">{message.content}</div>
        </div>
      </div>
    );
  }
  return (
    <div className="flex w-full flex-col gap-2">
      {message.trace && hasToolTrace ? (
        <AssistantTrace steps={message.trace} streaming={false} pendingThought={false} />
      ) : null}
      <div className="flex w-full gap-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-foreground">
          <Bot className="size-4" />
        </div>
        <div className="max-w-[75ch] rounded-2xl rounded-tl-sm border border-border/60 bg-card px-4 py-3 text-sm leading-relaxed text-foreground shadow-sm">
          <Markdown content={message.content} />
        </div>
      </div>
    </div>
  );
}

function AssistantTrace({
  steps,
  streaming,
  pendingThought,
}: {
  steps: AgentTraceStep[];
  streaming: boolean;
  pendingThought: boolean;
}) {
  const [open, setOpen] = React.useState(streaming);
  React.useEffect(() => {
    if (streaming) setOpen(true);
  }, [streaming]);

  const visibleSteps = coalesceTraceSteps(steps).filter((step) => step.kind === 'tool');
  const toolSteps = visibleSteps.filter((step) => step.kind === 'tool');
  const runningTool = toolSteps.find((step) => step.kind === 'tool' && step.status === 'running') as
    | (AgentTraceStep & { kind: 'tool' })
    | undefined;
  const completedTools = toolSteps.filter(
    (step) => step.kind === 'tool' && step.status !== 'running',
  ).length;
  const totalTools = toolSteps.length;

  const headline = streaming
    ? runningTool
      ? `Calling \`${runningTool.tool}\``
      : pendingThought
        ? 'Thinking…'
        : totalTools > 0
          ? `Used ${totalTools} ${totalTools === 1 ? 'tool' : 'tools'}`
          : 'Thinking…'
    : totalTools > 0
      ? `Used ${totalTools} ${totalTools === 1 ? 'tool' : 'tools'}`
      : 'Reasoning';

  return (
    <div className="ml-11 max-w-[75ch] rounded-xl border border-border/60 bg-muted/30">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/60"
        aria-expanded={open}
      >
        {streaming ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
        ) : (
          <Brain className="size-3.5 shrink-0 text-primary" />
        )}
        <span className="flex-1 truncate font-medium text-foreground/80">{headline}</span>
        {totalTools > 0 && (
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {completedTools}/{totalTools}
          </span>
        )}
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
      </button>
      {open && (
        <div className="flex flex-col gap-2 border-t border-border/60 px-3 py-3">
          {visibleSteps.length === 0 ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Dots />
              <span>Planning the next step…</span>
            </div>
          ) : (
            visibleSteps.map((step) => (
              <ToolStepCard key={`${step.id}:${step.status}`} step={step} />
            ))
          )}
          {streaming && visibleSteps.length > 0 && !runningTool && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Dots />
              <span>Planning the next step…</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ToolStepCard({
  step,
}: {
  step: Extract<AgentTraceStep, { kind: 'tool' }>;
}) {
  const [open, setOpen] = React.useState(false);
  const StatusIcon =
    step.status === 'running'
      ? Loader2
      : step.status === 'error'
        ? AlertTriangle
        : CheckCircle2;
  const statusClass =
    step.status === 'running'
      ? 'text-primary animate-spin'
      : step.status === 'error'
        ? 'text-destructive'
        : 'text-success';
  const argsString = compactArgs(step.args);
  return (
    <div className="rounded-md border border-border/70 bg-background/60">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-muted/40"
        aria-expanded={open}
      >
        <Wrench className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="font-mono text-[11px] font-medium text-foreground">{step.tool}</span>
        {step.source === 'agent' && (
          <Badge variant="outline" className="px-1 py-0 text-[9px] uppercase">
            local
          </Badge>
        )}
        <span className="ml-1 truncate text-muted-foreground">{argsString}</span>
        <span className="ml-auto flex items-center gap-1 text-muted-foreground">
          {step.summary && step.status !== 'running' ? (
            <span className="text-[10px]">{step.summary}</span>
          ) : null}
          <StatusIcon className={cn('size-3.5 shrink-0', statusClass)} />
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </span>
      </button>
      {open && (
        <div className="border-t border-border/60 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Arguments</div>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-sm bg-muted/40 px-2 py-1 font-mono text-[11px] text-foreground">
            {JSON.stringify(step.args ?? {}, null, 2)}
          </pre>
          {step.observation && (
            <>
              <div className="mt-2 text-[10px] uppercase tracking-wide text-muted-foreground">
                Result
              </div>
              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-sm bg-muted/40 px-2 py-1 font-mono text-[11px] text-foreground">
                {step.observation}
              </pre>
            </>
          )}
          {step.status === 'running' && (
            <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              <span>Running…</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function coalesceTraceSteps(steps: AgentTraceStep[]): AgentTraceStep[] {
  const coalesced: AgentTraceStep[] = [];
  const indexById = new Map<string, number>();
  for (const step of steps) {
    const existingIdx = indexById.get(step.id);
    if (existingIdx === undefined) {
      indexById.set(step.id, coalesced.length);
      coalesced.push(step);
    } else {
      coalesced[existingIdx] = step;
    }
  }
  return coalesced;
}

function Dots() {
  return (
    <span className="inline-flex items-center gap-1">
      <Dot delay="0ms" />
      <Dot delay="150ms" />
      <Dot delay="300ms" />
    </span>
  );
}

function Dot({ delay }: { delay: string }) {
  return (
    <span
      className="inline-block size-1.5 animate-bounce rounded-full bg-muted-foreground"
      style={{ animationDelay: delay }}
    />
  );
}

function compactArgs(args: Record<string, unknown> | undefined): string {
  if (!args) return '';
  try {
    const json = JSON.stringify(args);
    if (json === '{}') return '';
    return json.length > 60 ? `${json.slice(0, 57)}…` : json;
  } catch {
    return '';
  }
}

function EvidencePanel({
  evidence,
  onClose,
}: {
  evidence: InsightEvidence;
  onClose: () => void;
}) {
  return (
    <aside className="flex h-full w-80 shrink-0 flex-col border-l border-border bg-sidebar/40">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div>
          <div className="text-sm font-semibold">Evidence</div>
          <div className="text-xs text-muted-foreground">What this answer is based on</div>
        </div>
        <Button size="icon" variant="ghost" className="size-7" onClick={onClose} title="Close">
          <X />
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {evidence.metrics && Object.keys(evidence.metrics).length > 0 && (
          <EvidenceBlock title="Metrics">
            <ul className="space-y-1 text-xs">
              {Object.entries(evidence.metrics).map(([key, value]) => (
                <li key={key} className="flex justify-between gap-3">
                  <span className="truncate text-muted-foreground">{key}</span>
                  <span className="text-foreground">{String(value)}</span>
                </li>
              ))}
            </ul>
          </EvidenceBlock>
        )}
        {evidence.apps && evidence.apps.length > 0 && (
          <EvidenceBlock title="Apps">
            <div className="flex flex-wrap gap-1.5">
              {evidence.apps.map((app) => (
                <Badge key={`app:${app}`} variant="secondary">{app}</Badge>
              ))}
            </div>
          </EvidenceBlock>
        )}
        {evidence.entities && evidence.entities.length > 0 && (
          <EvidenceBlock title="Entities">
            <div className="flex flex-wrap gap-1.5">
              {evidence.entities.map((entity) => (
                <Badge key={`entity:${entity}`} variant="muted">{entity}</Badge>
              ))}
            </div>
          </EvidenceBlock>
        )}
        {evidence.snippets && evidence.snippets.length > 0 && (
          <EvidenceBlock title="Snippets">
            <div className="space-y-2">
              {evidence.snippets.slice(0, 6).map((snippet, index) => (
                <blockquote
                  key={`${snippet.frameId ?? snippet.sessionId ?? index}`}
                  className="rounded-md border-l-2 border-primary/40 bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
                >
                  <div className="font-medium text-foreground">{snippet.label}</div>
                  <div className="mt-1 line-clamp-3">{snippet.text}</div>
                </blockquote>
              ))}
            </div>
          </EvidenceBlock>
        )}
        {!hasEvidenceContent(evidence) && (
          <div className="text-xs text-muted-foreground">
            No structured evidence was attached to this turn.
          </div>
        )}
      </div>
    </aside>
  );
}

function EvidenceBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-5">
      <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      {children}
    </section>
  );
}

function hasEvidenceContent(evidence: InsightEvidence): boolean {
  return !!(
    evidence.frameIds?.length ||
    evidence.sessionIds?.length ||
    evidence.apps?.length ||
    evidence.entities?.length ||
    evidence.snippets?.length ||
    (evidence.metrics && Object.keys(evidence.metrics).length > 0)
  );
}

function severityVariant(severity: Insight['severity']): React.ComponentProps<typeof Badge>['variant'] {
  if (severity === 'high') return 'destructive';
  if (severity === 'medium') return 'warning';
  if (severity === 'low') return 'secondary';
  return 'success';
}

function severityLabel(severity: Insight['severity']): string {
  if (severity === 'info') return 'Insight';
  return severity[0]!.toUpperCase() + severity.slice(1);
}

function kindLabel(kind: Insight['kind']): string {
  return kind
    .split('_')
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(' ');
}

function truncateTitle(value: string, max = 60): string {
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed || 'New chat';
}
