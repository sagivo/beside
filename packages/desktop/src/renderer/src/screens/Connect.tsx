import * as React from 'react';
import { CheckCircle2, Copy, FolderOpen, Loader2, Plug, RefreshCcw, Terminal, Wrench, XCircle, Zap } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/sonner';
import { PageHeader } from '@/components/PageHeader';
import { StatusPill } from '@/components/StatusPill';
import { cn } from '@/lib/utils';
import type { LoadedConfig, RuntimeOverview } from '@/global';

type TestState = { status: 'idle' } | { status: 'pending' } | { status: 'ok'; latencyMs: number } | { status: 'fail'; reason: string };

export function Connect({ overview, config, onRefresh }: { overview: RuntimeOverview | null; config: LoadedConfig | null; onRefresh: () => void | Promise<void>; }) {
  if (!overview || !config) return (
    <div className="flex flex-col gap-6 pt-6"><PageHeader title="Connect" description="Loading..." />{[1, 2].map(i => <Card key={i}><CardContent className="flex flex-col gap-3"><Skeleton className="h-5 w-56" /><Skeleton className="h-3 w-80" /><Skeleton className="h-24 w-full rounded-md" /><Skeleton className="h-9 w-32" /></CardContent></Card>)}</div>
  );

  const mcpC = config.config.export.plugins.find(p => p.name === 'mcp'), mdC = config.config.export.plugins.find(p => p.name === 'markdown');
  const mcpS = overview.exports.find(e => e.name === 'mcp'), mdS = overview.exports.find(e => e.name === 'markdown');
  const host = typeof mcpC?.host === 'string' ? mcpC.host : '127.0.0.1', port = typeof mcpC?.port === 'number' ? mcpC.port : 3456, url = `http://${host}:${port}`;
  const snip = JSON.stringify({ mcpServers: { cofounderos: { url } } }, null, 2), clCmd = `claude mcp add --transport http cofounderos ${url}`;

  return <ConnectScreen url={url} snippet={snip} claudeCommand={clCmd} copyText={async (l: string, t: string) => { await window.cofounderos.copyText(t); toast.success(`${l} copied`); }} enableMcp={async () => {
    const p = [...config.config.export.plugins], i = p.findIndex(x => x.name === 'mcp'), n = { ...(i >= 0 ? p[i] : {}), name: 'mcp', enabled: true, host, port, transport: 'http' as const };
    i >= 0 ? p[i] = n : p.push(n);
    try { await window.cofounderos.saveConfigPatch({ export: { plugins: p } }); if (overview.status === 'running') await window.cofounderos.startRuntime(); toast.success('MCP server enabled'); await onRefresh(); } catch (err: any) { toast.error('Could not enable MCP', { description: err.message }); }
  }} mcpEnabled={mcpC?.enabled !== false} mcpRunning={!!mcpS?.running} markdownRunning={!!mdS?.running} markdownPath={typeof mdC?.path === 'string' ? mdC.path : ''} onRefresh={onRefresh} />;
}

function ConnectScreen({ url, snippet, claudeCommand, copyText, enableMcp, mcpEnabled, mcpRunning, markdownRunning, markdownPath, onRefresh }: any) {
  const [test, setTest] = React.useState<TestState>({ status: 'idle' }), [enabling, setEnabling] = React.useState(false);
  React.useEffect(() => { if (test.status === 'ok') { const t = window.setTimeout(() => setTest({ status: 'idle' }), 6000); return () => window.clearTimeout(t); } }, [test]);

  const ping = async () => {
    setTest({ status: 'pending' }); const s = performance.now();
    try { const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2500) }); if (!r.ok) return setTest({ status: 'fail', reason: `HTTP ${r.status}` }); setTest({ status: 'ok', latencyMs: Math.round(performance.now() - s) }); }
    catch (e: any) { setTest({ status: 'fail', reason: ['TimeoutError', 'AbortError'].includes(e.name) ? 'Timeout' : e.message }); }
  };

  return (
    <div className="flex flex-col gap-6 pt-6">
      <PageHeader title="Connect" description="Wire CofounderOS into local AI apps over MCP." actions={<Button variant="ghost" size="sm" onClick={onRefresh}><RefreshCcw />Refresh</Button>} />

      <Card className="overflow-hidden">
        <div className="border-b bg-gradient-brand-soft px-6 py-5 flex flex-wrap items-center gap-4">
          <span className="grid size-11 place-items-center rounded-xl text-white shadow-raised" style={{ backgroundImage: 'var(--gradient-brand)' }}><Plug className="size-5" /></span>
          <div className="flex-1 min-w-[220px]"><h3 className="text-base font-semibold">Local MCP server</h3><p className="text-sm text-muted-foreground mt-0.5">{url}</p></div>
          <div className="flex items-center gap-2">{!mcpEnabled && <Badge variant="warning">Disabled</Badge>}<StatusPill tone={mcpRunning ? 'success' : 'muted'} pulse={mcpRunning}>{mcpRunning ? 'Running' : 'Not running'}</StatusPill></div>
        </div>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            {!mcpEnabled && <Button size="lg" onClick={async () => { setEnabling(true); try { await enableMcp(); } finally { setEnabling(false); } }} disabled={enabling} className="btn-brand">{enabling ? <Loader2 className="animate-spin" /> : <Wrench />}Enable MCP</Button>}
            <Button variant="outline" size="lg" onClick={ping} disabled={test.status === 'pending'}>{test.status === 'pending' ? <Loader2 className="animate-spin" /> : <Zap />}Test connection</Button>
            <Button variant="ghost" size="lg" onClick={() => window.cofounderos.openExternalUrl(`${url}/health`)}><Plug />Open health URL</Button>
            {test.status === 'idle' ? <span className="text-xs text-muted-foreground/80 font-mono truncate">{`${url}/health`}</span> : test.status === 'pending' ? <span className="text-xs text-muted-foreground">Pinging...</span> : test.status === 'ok' ? <span className="inline-flex items-center gap-1.5 text-xs text-success font-medium animate-in fade-in-0"><CheckCircle2 className="size-3.5" />Connected · {test.latencyMs}ms</span> : <span className="inline-flex items-center gap-1.5 text-xs text-destructive font-medium animate-in fade-in-0" title={test.reason}><XCircle className="size-3.5" /><span className="truncate max-w-[260px]">{test.reason}</span></span>}
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <div className="flex flex-col gap-3 rounded-lg border bg-background/60 p-4"><div className="flex items-center gap-2 text-sm font-semibold"><span className="grid size-7 place-items-center rounded-md bg-primary/10 text-primary"><Plug className="size-4" /></span>Claude Desktop</div><p className="text-xs text-muted-foreground">Use the MCP JSON in Claude's developer settings.</p><Button variant="outline" size="sm" onClick={() => copyText('Claude MCP JSON', snippet)}><Copy />Copy JSON</Button></div>
            <div className="flex flex-col gap-3 rounded-lg border bg-background/60 p-4"><div className="flex items-center gap-2 text-sm font-semibold"><span className="grid size-7 place-items-center rounded-md bg-primary/10 text-primary"><Copy className="size-4" /></span>Cursor</div><p className="text-xs text-muted-foreground">Paste this into Cursor's MCP configuration.</p><Button variant="outline" size="sm" onClick={() => copyText('Cursor MCP JSON', snippet)}><Copy />Copy JSON</Button></div>
            <div className="flex flex-col gap-3 rounded-lg border bg-background/60 p-4"><div className="flex items-center gap-2 text-sm font-semibold"><span className="grid size-7 place-items-center rounded-md bg-primary/10 text-primary"><Terminal className="size-4" /></span>Claude Code</div><p className="text-xs text-muted-foreground">Run this command in your terminal.</p><Button variant="outline" size="sm" onClick={() => copyText('Claude Code command', claudeCommand)}><Copy />Copy command</Button></div>
          </div>
          <details className="group rounded-lg border bg-muted/30"><summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground">Show MCP JSON</summary><pre className="border-t px-4 py-3 font-mono text-xs overflow-x-auto leading-relaxed">{snippet}</pre></details>
        </CardContent>
      </Card>

      <Card><CardContent className="flex flex-wrap items-center gap-4">
        <span className="grid size-11 place-items-center rounded-xl bg-muted text-muted-foreground"><FolderOpen className="size-5" /></span>
        <div className="flex-1 min-w-[220px]"><h3 className="font-semibold">Read your memory as files</h3><p className="text-sm text-muted-foreground mt-0.5">Daily journals and index pages are exported as Markdown.</p><code className="mt-2 inline-block rounded-md border bg-background px-2 py-1 font-mono text-[11px] text-muted-foreground">{markdownPath || '~/.cofounderOS/export/markdown'}</code></div>
        <StatusPill tone={markdownRunning ? 'success' : 'muted'} pulse={markdownRunning}>{markdownRunning ? 'Running' : 'Not running'}</StatusPill>
        <Button variant="outline" onClick={() => window.cofounderos.openPath('markdown')}><FolderOpen />Open folder</Button><Button variant="ghost" onClick={() => window.cofounderos.openPath('config')}><Wrench />Config</Button>
      </CardContent></Card>
    </div>
  );
}
