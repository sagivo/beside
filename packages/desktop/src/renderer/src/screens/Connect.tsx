import * as React from 'react';
import { Copy, FolderOpen, Plug, RefreshCcw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/sonner';
import { PageHeader } from '@/components/PageHeader';
import type { LoadedConfig, RuntimeOverview } from '@/global';

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
            <Badge variant={mcpStatus?.running ? 'success' : 'muted'}>
              {mcpStatus?.running ? 'Running' : 'Ready'}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <pre className="rounded-md border bg-muted/50 p-4 font-mono text-xs overflow-x-auto">
            {snippet}
          </pre>
          <div>
            <Button onClick={() => void copySnippet()}>
              <Copy />
              Copy snippet
            </Button>
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
            <Badge variant={markdownStatus?.running ? 'success' : 'muted'}>
              {markdownStatus?.running ? 'Running' : 'Ready'}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <code className="rounded-md border bg-muted/50 px-3 py-2 font-mono text-xs text-muted-foreground">
            {typeof markdownConfig?.path === 'string'
              ? markdownConfig.path
              : '~/.cofounderOS/export/markdown'}
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
