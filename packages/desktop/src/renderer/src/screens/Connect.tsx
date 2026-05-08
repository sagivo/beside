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
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
        <PageHeader title="Connect" description="Loading…" />
        {Array.from({ length: 2 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="flex flex-col gap-3">
              <Skeleton className="h-5 w-56" />
              <Skeleton className="h-3 w-80" />
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
    toast.success('Connection snippet copied', {
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
        title="Connect"
        description="Let your favorite AI app — Claude, Cursor, ChatGPT desktop — read your memory."
        actions={
          <Button variant="ghost" size="sm" onClick={onRefresh}>
            <RefreshCcw />
            Refresh
          </Button>
        }
      />

      {/* Primary card: the AI connection. Big copy CTA, status pill on top. */}
      <Card className="overflow-hidden">
        <div
          className="border-b bg-gradient-brand-soft px-6 py-5 flex flex-wrap items-center gap-4"
        >
          <span
            className="grid size-11 place-items-center rounded-xl text-white shadow-raised"
            style={{ backgroundImage: 'var(--gradient-brand)' }}
          >
            <Plug className="size-5" />
          </span>
          <div className="flex-1 min-w-[220px]">
            <h3 className="text-base font-semibold">For your AI apps</h3>
            <p className="text-sm text-muted-foreground mt-0.5">
              Copy the snippet below into the app's connection settings. Done.
            </p>
          </div>
          <StatusPill running={mcpRunning} />
        </div>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="lg" onClick={() => void copySnippet()} className="btn-brand">
              <Copy />
              Copy snippet
            </Button>
            <Button
              variant="outline"
              size="lg"
              onClick={() => void runPing()}
              disabled={test.status === 'pending'}
            >
              {test.status === 'pending' ? <Loader2 className="animate-spin" /> : <Zap />}
              Test connection
            </Button>
            <TestResult test={test} url={url} />
          </div>

          <details className="group rounded-lg border bg-muted/30">
            <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground">
              Show snippet
            </summary>
            <pre className="border-t px-4 py-3 font-mono text-xs overflow-x-auto leading-relaxed">
              {snippet}
            </pre>
          </details>
        </CardContent>
      </Card>

      {/* Secondary card: the Markdown export. Less prominent — most users don't open this. */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-4">
          <span className="grid size-11 place-items-center rounded-xl bg-muted text-muted-foreground">
            <FolderOpen className="size-5" />
          </span>
          <div className="flex-1 min-w-[220px]">
            <h3 className="font-semibold">Read your memory as files</h3>
            <p className="text-sm text-muted-foreground mt-0.5">
              A friendly folder of daily journals you can open in Notion, Obsidian, or
              Finder.
            </p>
            <code className="mt-2 inline-block rounded-md border bg-background px-2 py-1 font-mono text-[11px] text-muted-foreground">
              {markdownPath || '~/.cofounderOS/export/markdown'}
            </code>
          </div>
          <StatusPill running={markdownRunning} />
          <Button
            variant="outline"
            onClick={() => void window.cofounderos.openPath('markdown')}
          >
            <FolderOpen />
            Open folder
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function StatusPill({ running }: { running: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium',
        running
          ? 'bg-success/15 text-success'
          : 'bg-muted text-muted-foreground',
      )}
    >
      <span
        className={cn(
          'size-1.5 rounded-full',
          running ? 'bg-success animate-pulse' : 'bg-muted-foreground/60',
        )}
      />
      {running ? 'Running' : 'Ready'}
    </span>
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
