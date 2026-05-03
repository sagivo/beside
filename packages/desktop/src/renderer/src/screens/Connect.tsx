import * as React from 'react';
import {
  CheckCircle2,
  Copy,
  FolderOpen,
  Loader2,
  Plug,
  RefreshCcw,
  XCircle,
  Zap,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/sonner';
import { PageHeader } from '@/components/PageHeader';
import { cn } from '@/lib/utils';
import type { LoadedConfig, RuntimeOverview } from '@/global';

type TestState =
  | { status: 'idle' }
  | { status: 'pending' }
  | { status: 'ok'; latencyMs: number }
  | { status: 'fail'; reason: string };

export function Connect({
  overview,
  config,
  onRefresh,
}: {
  overview: RuntimeOverview | null;
  config: LoadedConfig | null;
  onRefresh: () => void;
}) {
  if (!overview || !config) {
    return (
      <div className="flex flex-col gap-6 pt-6">
        <PageHeader title="Connect AI" description="Loading…" />
        {Array.from({ length: 2 }).map((_, i) => (
          <Card key={i}>
            <CardHeader>
              <Skeleton className="h-5 w-56" />
              <Skeleton className="h-3 w-80 mt-2" />
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <Skeleton className="h-24 w-full rounded-md" />
              <Skeleton className="h-9 w-32" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  const mcpConfig = config.config.export.plugins.find((p) => p.name === 'mcp');
  const markdownConfig = config.config.export.plugins.find((p) => p.name === 'markdown');
  const mcpStatus = overview.exports.find((e) => e.name === 'mcp');
  const markdownStatus = overview.exports.find((e) => e.name === 'markdown');
  const host = typeof mcpConfig?.host === 'string' ? mcpConfig.host : '127.0.0.1';
  const port = typeof mcpConfig?.port === 'number' ? mcpConfig.port : 3456;
  const url = `http://${host}:${port}`;
  const snippet = JSON.stringify({ mcpServers: { cofounderos: { url } } }, null, 2);

  async function copySnippet() {
    await window.cofounderos.copyText(snippet);
    toast.success('MCP snippet copied', {
      description: 'Paste it into your AI app settings.',
    });
  }

  return (
    <ConnectScreen
      url={url}
      snippet={snippet}
      copySnippet={copySnippet}
      mcpRunning={!!mcpStatus?.running}
      markdownRunning={!!markdownStatus?.running}
      markdownPath={typeof markdownConfig?.path === 'string' ? markdownConfig.path : ''}
      onRefresh={onRefresh}
    />
  );
}

function ConnectScreen({
  url,
  snippet,
  copySnippet,
  mcpRunning,
  markdownRunning,
  markdownPath,
  onRefresh,
}: {
  url: string;
  snippet: string;
  copySnippet: () => Promise<void>;
  mcpRunning: boolean;
  markdownRunning: boolean;
  markdownPath: string;
  onRefresh: () => void;
}) {
  const [test, setTest] = React.useState<TestState>({ status: 'idle' });

  // Auto-clear successful test results after a few seconds so the badge
  // doesn't lie if the runtime later changes state. Failures stick around
  // until the user retries.
  React.useEffect(() => {
    if (test.status !== 'ok') return;
    const timer = window.setTimeout(() => setTest({ status: 'idle' }), 6000);
    return () => window.clearTimeout(timer);
  }, [test]);

  async function runPing() {
    setTest({ status: 'pending' });
    const started = performance.now();
    try {
      const response = await fetch(`${url}/health`, {
        signal: AbortSignal.timeout(2500),
      });
      const elapsed = Math.round(performance.now() - started);
      if (!response.ok) {
        setTest({
          status: 'fail',
          reason: `HTTP ${response.status} ${response.statusText || ''}`.trim(),
        });
        return;
      }
      setTest({ status: 'ok', latencyMs: elapsed });
    } catch (err) {
      const reason =
        err instanceof Error
          ? err.name === 'TimeoutError' || err.name === 'AbortError'
            ? `No response within 2.5s — is CofounderOS running?`
            : err.message
          : String(err);
      setTest({ status: 'fail', reason });
    }
  }

  return (
    <div className="flex flex-col gap-6 pt-6">
      <PageHeader
        title="Connect AI"
        description="Let your favorite AI app use your memory."
        actions={
          <Button variant="ghost" size="sm" onClick={onRefresh}>
            <RefreshCcw />
            Refresh
          </Button>
        }
      />

      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Plug className="size-4" />
                For Cursor, Claude & other AI apps
              </CardTitle>
              <CardDescription className="mt-1">
                Copy this snippet and paste it into the app's MCP settings. Your AI can then ask
                about anything you've worked on.
              </CardDescription>
            </div>
            <Badge variant={mcpRunning ? 'success' : 'muted'}>
              {mcpRunning ? 'Running' : 'Ready'}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <pre className="rounded-md border bg-muted/50 p-4 font-mono text-xs overflow-x-auto">
            {snippet}
          </pre>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => void copySnippet()}>
              <Copy />
              Copy snippet
            </Button>
            <Button
              variant="outline"
              onClick={() => void runPing()}
              disabled={test.status === 'pending'}
            >
              {test.status === 'pending' ? <Loader2 className="animate-spin" /> : <Zap />}
              Test connection
            </Button>
            <TestResult test={test} url={url} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2">
                <FolderOpen className="size-4" />
                Read your memory as files
              </CardTitle>
              <CardDescription className="mt-1">
                A friendly folder of daily journals you can open in Notion, Obsidian, or just
                Finder.
              </CardDescription>
            </div>
            <Badge variant={markdownRunning ? 'success' : 'muted'}>
              {markdownRunning ? 'Running' : 'Ready'}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <code className="rounded-md border bg-muted/50 px-3 py-2 font-mono text-xs text-muted-foreground">
            {markdownPath || '~/.cofounderOS/export/markdown'}
          </code>
          <div>
            <Button
              variant="outline"
              onClick={() => void window.cofounderos.openPath('markdown')}
            >
              <FolderOpen />
              Open folder
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function TestResult({ test, url }: { test: TestState; url: string }) {
  if (test.status === 'idle') {
    return (
      <span className="text-xs text-muted-foreground/80 font-mono truncate">
        {url}
      </span>
    );
  }
  if (test.status === 'pending') {
    return <span className="text-xs text-muted-foreground">Pinging…</span>;
  }
  if (test.status === 'ok') {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1.5 text-xs text-success font-medium',
          'animate-in fade-in-0',
        )}
      >
        <CheckCircle2 className="size-3.5" />
        Connected · {test.latencyMs}ms
      </span>
    );
  }
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-xs text-destructive font-medium',
        'animate-in fade-in-0',
      )}
      title={test.reason}
    >
      <XCircle className="size-3.5" />
      <span className="truncate max-w-[260px]">{test.reason}</span>
    </span>
  );
}
