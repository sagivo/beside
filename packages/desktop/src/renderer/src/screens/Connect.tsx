import * as React from 'react';
import {
  CheckCircle2,
  Copy,
  FolderOpen,
  Loader2,
  Plug,
  RefreshCcw,
  Terminal,
  Wrench,
  XCircle,
  Zap,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/sonner';
import { PageHeader } from '@/components/PageHeader';
import { StatusPill } from '@/components/StatusPill';
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
  onRefresh: () => void | Promise<void>;
}) {
  if (!overview || !config) {
    return (
      <div className="flex flex-col gap-6 pt-6">
        <PageHeader title="Connect" description="Loading..." />
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

  const loadedConfig = config;
  const runtimeOverview = overview;
  const mcpConfig = loadedConfig.config.export.plugins.find((p) => p.name === 'mcp');
  const markdownConfig = loadedConfig.config.export.plugins.find((p) => p.name === 'markdown');
  const mcpStatus = runtimeOverview.exports.find((e) => e.name === 'mcp');
  const markdownStatus = runtimeOverview.exports.find((e) => e.name === 'markdown');
  const host = typeof mcpConfig?.host === 'string' ? mcpConfig.host : '127.0.0.1';
  const port = typeof mcpConfig?.port === 'number' ? mcpConfig.port : 3456;
  const url = `http://${host}:${port}`;
  const snippet = JSON.stringify({ mcpServers: { cofounderos: { url } } }, null, 2);
  const claudeCommand = `claude mcp add --transport http cofounderos ${url}`;
  const mcpEnabled = mcpConfig?.enabled !== false;

  async function copyText(label: string, text: string) {
    await window.cofounderos.copyText(text);
    toast.success(`${label} copied`);
  }

  async function enableMcp() {
    const plugins = [...loadedConfig.config.export.plugins];
    const idx = plugins.findIndex((p) => p.name === 'mcp');
    const nextMcp = {
      ...(idx >= 0 ? plugins[idx] : {}),
      name: 'mcp',
      enabled: true,
      host,
      port,
      transport: 'http' as const,
    };
    if (idx >= 0) plugins[idx] = nextMcp;
    else plugins.push(nextMcp);

    try {
      await window.cofounderos.saveConfigPatch({ export: { plugins } });
      if (runtimeOverview.status === 'running') {
        await window.cofounderos.startRuntime();
      }
      toast.success('MCP server enabled', {
        description: 'The local server is ready for AI apps.',
      });
      await onRefresh();
    } catch (err) {
      toast.error('Could not enable MCP', {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return (
    <ConnectScreen
      url={url}
      snippet={snippet}
      claudeCommand={claudeCommand}
      copyText={copyText}
      enableMcp={enableMcp}
      mcpEnabled={mcpEnabled}
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
  claudeCommand,
  copyText,
  enableMcp,
  mcpEnabled,
  mcpRunning,
  markdownRunning,
  markdownPath,
  onRefresh,
}: {
  url: string;
  snippet: string;
  claudeCommand: string;
  copyText: (label: string, text: string) => Promise<void>;
  enableMcp: () => Promise<void>;
  mcpEnabled: boolean;
  mcpRunning: boolean;
  markdownRunning: boolean;
  markdownPath: string;
  onRefresh: () => void | Promise<void>;
}) {
  const [test, setTest] = React.useState<TestState>({ status: 'idle' });
  const [enabling, setEnabling] = React.useState(false);

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
            ? 'No response within 2.5s. Is CofounderOS running?'
            : err.message
          : String(err);
      setTest({ status: 'fail', reason });
    }
  }

  async function onEnable() {
    setEnabling(true);
    try {
      await enableMcp();
    } finally {
      setEnabling(false);
    }
  }

  return (
    <div className="flex flex-col gap-6 pt-6">
      <PageHeader
        title="Connect"
        description="Wire CofounderOS into local AI apps over MCP."
        actions={
          <Button variant="ghost" size="sm" onClick={onRefresh}>
            <RefreshCcw />
            Refresh
          </Button>
        }
      />

      <Card className="overflow-hidden">
        <div className="border-b bg-gradient-brand-soft px-6 py-5 flex flex-wrap items-center gap-4">
          <span
            className="grid size-11 place-items-center rounded-xl text-white shadow-raised"
            style={{ backgroundImage: 'var(--gradient-brand)' }}
          >
            <Plug className="size-5" />
          </span>
          <div className="flex-1 min-w-[220px]">
            <h3 className="text-base font-semibold">Local MCP server</h3>
            <p className="text-sm text-muted-foreground mt-0.5">{url}</p>
          </div>
          <div className="flex items-center gap-2">
            {!mcpEnabled && <Badge variant="warning">Disabled</Badge>}
            <StatusPill tone={mcpRunning ? 'success' : 'muted'} pulse={mcpRunning}>
              {mcpRunning ? 'Running' : 'Ready'}
            </StatusPill>
          </div>
        </div>

        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            {!mcpEnabled && (
              <Button
                size="lg"
                onClick={() => void onEnable()}
                disabled={enabling}
                className="btn-brand"
              >
                {enabling ? <Loader2 className="animate-spin" /> : <Wrench />}
                Enable MCP
              </Button>
            )}
            <Button
              variant="outline"
              size="lg"
              onClick={() => void runPing()}
              disabled={test.status === 'pending'}
            >
              {test.status === 'pending' ? <Loader2 className="animate-spin" /> : <Zap />}
              Test connection
            </Button>
            <Button
              variant="ghost"
              size="lg"
              onClick={() => void window.cofounderos.openExternalUrl(url)}
            >
              <Plug />
              Open health URL
            </Button>
            <TestResult test={test} url={url} />
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <ConnectionRecipe
              title="Claude Desktop"
              description="Use the MCP JSON in Claude's developer settings."
              icon={<Plug className="size-4" />}
              button="Copy JSON"
              onCopy={() => copyText('Claude MCP JSON', snippet)}
            />
            <ConnectionRecipe
              title="Cursor"
              description="Paste this into Cursor's MCP configuration."
              icon={<Copy className="size-4" />}
              button="Copy JSON"
              onCopy={() => copyText('Cursor MCP JSON', snippet)}
            />
            <ConnectionRecipe
              title="Claude Code"
              description="Run this command in your terminal."
              icon={<Terminal className="size-4" />}
              button="Copy command"
              onCopy={() => copyText('Claude Code command', claudeCommand)}
            />
          </div>

          <details className="group rounded-lg border bg-muted/30">
            <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground">
              Show MCP JSON
            </summary>
            <pre className="border-t px-4 py-3 font-mono text-xs overflow-x-auto leading-relaxed">
              {snippet}
            </pre>
          </details>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-wrap items-center gap-4">
          <span className="grid size-11 place-items-center rounded-xl bg-muted text-muted-foreground">
            <FolderOpen className="size-5" />
          </span>
          <div className="flex-1 min-w-[220px]">
            <h3 className="font-semibold">Read your memory as files</h3>
            <p className="text-sm text-muted-foreground mt-0.5">
              Daily journals and index pages are exported as Markdown.
            </p>
            <code className="mt-2 inline-block rounded-md border bg-background px-2 py-1 font-mono text-[11px] text-muted-foreground">
              {markdownPath || '~/.cofounderOS/export/markdown'}
            </code>
          </div>
          <StatusPill tone={markdownRunning ? 'success' : 'muted'} pulse={markdownRunning}>
            {markdownRunning ? 'Running' : 'Ready'}
          </StatusPill>
          <Button
            variant="outline"
            onClick={() => void window.cofounderos.openPath('markdown')}
          >
            <FolderOpen />
            Open folder
          </Button>
          <Button variant="ghost" onClick={() => void window.cofounderos.openPath('config')}>
            <Wrench />
            Config
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function ConnectionRecipe({
  title,
  description,
  icon,
  button,
  onCopy,
}: {
  title: string;
  description: string;
  icon: React.ReactNode;
  button: string;
  onCopy: () => Promise<void>;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-background/60 p-4">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <span className="grid size-7 place-items-center rounded-md bg-primary/10 text-primary">
          {icon}
        </span>
        {title}
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed">{description}</p>
      <Button variant="outline" size="sm" onClick={() => void onCopy()}>
        <Copy />
        {button}
      </Button>
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
    return <span className="text-xs text-muted-foreground">Pinging...</span>;
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
