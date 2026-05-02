import * as React from 'react';
import { Check, Copy, FolderOpen, RefreshCcw, Sparkles } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { PageHeader } from '@/components/PageHeader';

export function Help({
  logs,
  onRestartOnboarding,
}: {
  logs: string;
  onRestartOnboarding: () => void;
}) {
  const [copied, setCopied] = React.useState(false);

  async function copyDiagnostics() {
    const [overview, checks, _config] = await Promise.all([
      window.cofounderos.getOverview(),
      window.cofounderos.runDoctor(),
      window.cofounderos.readConfig(),
    ]);
    const text = [
      '# CofounderOS Diagnostics',
      `Generated: ${new Date().toISOString()}`,
      '',
      `Status: ${overview.status}`,
      `Capture: ${overview.capture.running ? (overview.capture.paused ? 'paused' : 'running') : 'stopped'}`,
      `Today: ${overview.capture.eventsToday} events`,
      `Model: ${overview.model.name} (${overview.model.ready ? 'ready' : 'not ready'})`,
      '',
      '## Checks',
      ...checks.map((c) => `- [${c.status}] ${c.area}: ${c.message}`),
      '',
      '## Logs',
      logs || '(none)',
    ].join('\n');
    await window.cofounderos.copyText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="flex flex-col gap-6 pt-6">
      <PageHeader title="Help" description="Need a hand? You're in the right place." />

      {copied && (
        <Alert variant="success">
          <Check />
          <AlertTitle>Diagnostics copied to clipboard</AlertTitle>
          <AlertDescription>Paste it into a support thread or save it for later.</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardContent className="flex flex-col gap-0">
          <Row
            title="Copy diagnostics"
            description="Send this to support and we'll figure things out together."
            action={
              <Button onClick={() => void copyDiagnostics()}>
                <Copy />
                Copy
              </Button>
            }
          />
          <Separator className="my-4" />
          <Row
            title="Open data folder"
            description="See all your memories on disk."
            action={
              <Button
                variant="outline"
                onClick={() => void window.cofounderos.openPath('data')}
              >
                <FolderOpen />
                Open
              </Button>
            }
          />
          <Separator className="my-4" />
          <Row
            title="Open config file"
            description="For advanced tweaking."
            action={
              <Button
                variant="outline"
                onClick={() => void window.cofounderos.openPath('config')}
              >
                <FolderOpen />
                Open
              </Button>
            }
          />
          <Separator className="my-4" />
          <Row
            title="Replay onboarding"
            description="Walk through the welcome tour again."
            action={
              <Button variant="outline" onClick={onRestartOnboarding}>
                <Sparkles />
                Replay
              </Button>
            }
          />
        </CardContent>
      </Card>

      <section>
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide mb-3">
          Recent activity
        </h3>
        <Card>
          <CardContent>
            <pre className="font-mono text-xs leading-relaxed text-muted-foreground max-h-80 overflow-auto whitespace-pre-wrap break-words">
              {logs || '(no recent activity)'}
            </pre>
            <Separator className="my-4" />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => window.cofounderos.getOverview().catch(() => null)}
            >
              <RefreshCcw />
              Refresh status
            </Button>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

function Row({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-4">
      <div className="flex-1 min-w-[260px]">
        <h4 className="font-medium">{title}</h4>
        <p className="text-sm text-muted-foreground mt-0.5">{description}</p>
      </div>
      <div>{action}</div>
    </div>
  );
}
