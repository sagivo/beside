import * as React from 'react';
import {
  Code2,
  Copy,
  Eye,
  ExternalLink,
  FolderOpen,
  Lock,
  RefreshCcw,
  Sparkles,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { BrandMark } from '@/components/BrandMark';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { toast } from '@/components/ui/sonner';
import { PageHeader } from '@/components/PageHeader';
import { CHANGELOG, markChangelogSeen } from '@/lib/changelog';

export function Help({
  logs,
  onRestartOnboarding,
}: {
  logs: string;
  onRestartOnboarding: () => void;
}) {
  React.useEffect(() => {
    markChangelogSeen();
  }, []);

  async function copyDiagnostics() {
    try {
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
      toast.success('Diagnostics copied to clipboard', {
        description: 'Paste it into a support thread or save it for later.',
      });
    } catch (err) {
      toast.error('Could not gather diagnostics', {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return (
    <div className="flex flex-col gap-6 pt-6">
      <PageHeader title="Help" description="Need a hand? You're in the right place." />

      {CHANGELOG.length > 0 && (
        <section>
          <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide mb-3">
            What's new
          </h3>
          <div className="flex flex-col gap-3">
            {CHANGELOG.slice(0, 3).map((entry, i) => (
              <Card key={entry.id}>
                <CardHeader>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <CardTitle className="flex items-center gap-2">
                        {i === 0 && <Sparkles className="size-4 text-primary" />}
                        {entry.title}
                      </CardTitle>
                      <CardDescription className="mt-1 flex flex-wrap items-center gap-2">
                        <Badge variant="muted">{entry.version}</Badge>
                        <span className="text-xs">{entry.date}</span>
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <ul className="flex flex-col gap-1.5 text-sm">
                    {entry.items.map((item, j) => (
                      <li key={j} className="flex gap-2">
                        <span className="text-muted-foreground/60 mt-1">·</span>
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
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

      <AboutCard />
    </div>
  );
}

function AboutCard() {
  const [platform, setPlatform] = React.useState<string>('');

  React.useEffect(() => {
    // Surface a friendly platform string. Reads navigator (always
    // available in Electron renderer) so we don't need a new IPC channel
    // just for this.
    const ua = navigator.userAgent;
    const platformLabel = navigator.platform || '';
    let arch = '';
    const archMatch = ua.match(/(Mac OS X|Windows NT|Linux)\s+([^);]+)/);
    if (archMatch) arch = archMatch[2]!.trim();
    setPlatform([platformLabel, arch].filter(Boolean).join(' · '));
  }, []);

  return (
    <Card>
      <CardContent className="flex flex-col gap-5">
        <div className="flex items-start gap-4">
          <BrandMark className="size-10" />
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-baseline gap-2">
              <h3 className="text-lg font-semibold tracking-tight">CofounderOS</h3>
              <Badge variant="muted" className="font-mono">
                v{__APP_VERSION__}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              Your local memory, on this device. Open source — every line is yours to read.
            </p>
            {platform ? (
              <p className="text-xs text-muted-foreground/80 mt-2 font-mono">{platform}</p>
            ) : null}
          </div>
        </div>

        <div className="grid gap-2 sm:grid-cols-3">
          <AboutPill icon={<Lock />} label="Local by default" />
          <AboutPill icon={<Eye />} label="Only you can see it" />
          <AboutPill icon={<Sparkles />} label="No telemetry" />
        </div>

        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" asChild>
            <a
              href="https://github.com/cofounderos/cofounderos"
              target="_blank"
              rel="noopener noreferrer"
            >
              <Code2 />
              Source code
              <ExternalLink className="size-3 opacity-60" />
            </a>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <a
              href="https://github.com/cofounderos/cofounderos/blob/main/README.md"
              target="_blank"
              rel="noopener noreferrer"
            >
              Read the docs
              <ExternalLink className="size-3 opacity-60" />
            </a>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function AboutPill({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm">
      <span className="text-primary [&>svg]:size-4">{icon}</span>
      <span>{label}</span>
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
