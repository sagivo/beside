import * as React from 'react';
import { Lightbulb, Loader2, RefreshCcw, Search, Sparkles, X } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { PageHeader } from '@/components/PageHeader';
import { formatLocalDateTime } from '@/lib/format';
import type { Insight, InsightAnswer } from '@/global';

const SUGGESTIONS = [
  'Where did my time go today?',
  'What tasks did I repeat?',
  'What should I follow up on?',
];

export function Insights({
  insights,
  onRefresh,
  onDismiss,
  onAsk,
  onOpenEvidence,
}: {
  insights: Insight[] | null;
  onRefresh: () => Promise<void>;
  onDismiss: (id: string) => Promise<void>;
  onAsk: (question: string) => Promise<InsightAnswer>;
  onOpenEvidence: (insight: Insight) => void;
}) {
  const [refreshing, setRefreshing] = React.useState(false);
  const [question, setQuestion] = React.useState('');
  const [asking, setAsking] = React.useState(false);
  const [answer, setAnswer] = React.useState<InsightAnswer | null>(null);
  const [error, setError] = React.useState<string | null>(null);

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

  async function ask(nextQuestion?: string) {
    const q = (nextQuestion ?? question).trim();
    if (!q) return;
    setQuestion(q);
    setAsking(true);
    setError(null);
    try {
      setAnswer(await onAsk(q));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAsking(false);
    }
  }

  const today = (insights ?? []).filter((insight) => isTodayInsight(insight));
  const opportunities = (insights ?? []).filter((insight) => (
    insight.kind === 'time_waste' ||
    insight.kind === 'repeated_task' ||
    insight.kind === 'context_switching' ||
    insight.kind === 'focus_opportunity'
  ));

  return (
    <div className="flex flex-col gap-6 pt-6">
      <PageHeader
        title="Insights"
        description="Ask your local memory what patterns, repeated work, and opportunities stand out."
        actions={
          <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={refreshing}>
            {refreshing ? <Loader2 className="animate-spin" /> : <RefreshCcw />}
            Refresh insights
          </Button>
        }
      />

      {error && (
        <Alert variant="warning">
          <Lightbulb />
          <AlertTitle>Insights need local AI</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="size-5 text-primary" />
            Query your activity
          </CardTitle>
          <CardDescription>
            Ask a specific question and Insights will gather local evidence before asking the model.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <Textarea
            value={question}
            onChange={(event) => setQuestion(event.currentTarget.value)}
            placeholder="What should I pay attention to from today?"
            className="min-h-24"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={asking || !question.trim()} onClick={() => void ask()}>
              {asking ? <Loader2 className="animate-spin" /> : <Search />}
              {asking ? 'Thinking...' : 'Ask Insights'}
            </Button>
            {SUGGESTIONS.map((suggestion) => (
              <Button
                key={suggestion}
                type="button"
                variant="outline"
                size="sm"
                disabled={asking}
                onClick={() => void ask(suggestion)}
              >
                {suggestion}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      {answer && (
        <Card>
          <CardHeader>
            <CardDescription>Answer</CardDescription>
            <CardTitle>{answer.question}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <p className="text-sm leading-relaxed text-muted-foreground">{answer.answer}</p>
            {answer.suggested_actions.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {answer.suggested_actions.map((action) => (
                  <Badge key={action} variant="secondary">{action}</Badge>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {!insights ? (
        <InsightSkeleton />
      ) : insights.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center py-12 text-center">
            <Lightbulb className="mb-3 size-9 text-muted-foreground/60" />
            <h3 className="font-medium">No insights yet</h3>
            <p className="mt-1 max-w-md text-sm text-muted-foreground">
              Start capture, set up local AI, then refresh insights after there are a few activity sessions.
            </p>
            <Button className="mt-4" onClick={() => void refresh()} disabled={refreshing}>
              {refreshing ? 'Generating...' : 'Generate insights'}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Tabs defaultValue="today" className="grid gap-4">
          <TabsList>
            <TabsTrigger value="today">Today</TabsTrigger>
            <TabsTrigger value="opportunities">Opportunities</TabsTrigger>
            <TabsTrigger value="all">All</TabsTrigger>
          </TabsList>
          <TabsContent value="today" className="grid gap-3">
            <InsightList
              insights={today.length > 0 ? today : insights}
              onDismiss={onDismiss}
              onOpenEvidence={onOpenEvidence}
            />
          </TabsContent>
          <TabsContent value="opportunities" className="grid gap-3">
            <InsightList
              insights={opportunities.length > 0 ? opportunities : insights}
              onDismiss={onDismiss}
              onOpenEvidence={onOpenEvidence}
            />
          </TabsContent>
          <TabsContent value="all" className="grid gap-3">
            <InsightList insights={insights} onDismiss={onDismiss} onOpenEvidence={onOpenEvidence} />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

function InsightList({
  insights,
  onDismiss,
  onOpenEvidence,
}: {
  insights: Insight[];
  onDismiss: (id: string) => Promise<void>;
  onOpenEvidence: (insight: Insight) => void;
}) {
  return (
    <>
      {insights.map((insight) => (
        <InsightCard
          key={insight.id}
          insight={insight}
          onDismiss={onDismiss}
          onOpenEvidence={onOpenEvidence}
        />
      ))}
    </>
  );
}

function InsightCard({
  insight,
  onDismiss,
  onOpenEvidence,
}: {
  insight: Insight;
  onDismiss: (id: string) => Promise<void>;
  onOpenEvidence: (insight: Insight) => void;
}) {
  const [dismissing, setDismissing] = React.useState(false);
  const hasEvidence = !!(
    insight.evidence.frameIds?.length ||
    insight.evidence.sessionIds?.length ||
    insight.evidence.apps?.length ||
    insight.evidence.entities?.length
  );
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Badge variant={severityVariant(insight.severity)}>{severityLabel(insight.severity)}</Badge>
              <Badge variant="outline">{kindLabel(insight.kind)}</Badge>
              <span className="text-xs text-muted-foreground">
                {insight.period.label} - updated {formatLocalDateTime(insight.updated_at)}
              </span>
            </div>
            <CardTitle>{insight.title}</CardTitle>
            <CardDescription className="mt-2">{insight.summary}</CardDescription>
          </div>
          <Button
            variant="ghost"
            size="sm"
            disabled={dismissing}
            onClick={async () => {
              setDismissing(true);
              try {
                await onDismiss(insight.id);
              } finally {
                setDismissing(false);
              }
            }}
          >
            <X />
            Dismiss
          </Button>
        </div>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="rounded-lg border bg-muted/30 p-3 text-sm">
          <span className="font-medium">Action: </span>
          <span className="text-muted-foreground">{insight.recommendation}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          {(insight.evidence.apps ?? []).slice(0, 4).map((app) => (
            <Badge key={`app:${app}`} variant="secondary">{app}</Badge>
          ))}
          {(insight.evidence.entities ?? []).slice(0, 4).map((entity) => (
            <Badge key={`entity:${entity}`} variant="muted">{entity}</Badge>
          ))}
          {typeof insight.evidence.metrics?.minutes === 'number' && (
            <Badge variant="outline">{insight.evidence.metrics.minutes} min</Badge>
          )}
          {typeof insight.evidence.metrics?.switchesPerHour === 'number' && (
            <Badge variant="outline">{insight.evidence.metrics.switchesPerHour} switches/hr</Badge>
          )}
        </div>
        {insight.evidence.snippets && insight.evidence.snippets.length > 0 && (
          <div className="grid gap-2">
            {insight.evidence.snippets.slice(0, 2).map((snippet, index) => (
              <blockquote
                key={`${snippet.frameId ?? snippet.sessionId ?? index}`}
                className="rounded-md border-l-2 border-primary/40 bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
              >
                <span className="font-medium text-foreground">{snippet.label}: </span>
                {snippet.text}
              </blockquote>
            ))}
          </div>
        )}
        {hasEvidence && (
          <div>
            <Button variant="outline" size="sm" onClick={() => onOpenEvidence(insight)}>
              Open evidence in Timeline
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function InsightSkeleton() {
  return (
    <div className="grid gap-3">
      {Array.from({ length: 3 }).map((_, index) => (
        <Card key={index}>
          <CardHeader>
            <Skeleton className="h-4 w-32" />
            <Skeleton className="mt-2 h-6 w-80" />
            <Skeleton className="mt-2 h-4 w-full max-w-xl" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-16 w-full" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function isTodayInsight(insight: Insight): boolean {
  const today = new Date().toISOString().slice(0, 10);
  return insight.period.end.slice(0, 10) === today || insight.period.label.toLowerCase().includes('24');
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
