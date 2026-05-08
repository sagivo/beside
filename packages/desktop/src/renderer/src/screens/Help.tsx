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
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { toast } from '@/components/ui/sonner';
import { PageHeader } from '@/components/PageHeader';
import { CHANGELOG, markChangelogSeen } from '@/lib/changelog';

/**
 * Help screen — redesigned to lead with a calm "About" hero, then a tight
 * actions list, with the noisy raw runtime log tucked behind a disclosure.
 *
 * Goal: a non-technical user reads "Need a hand?" → finds *one* obvious
 * action ("Copy diagnostics"), and never has to look at the green-text log
 * unless they want to. Power users can still expand it in one click.
 */
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

      <AboutCard />

      {CHANGELOG.length > 0 && (
        <section>
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-[0.1em] mb-3">
            What's new
          </h3>
          <Card>
            <CardContent className="flex flex-col gap-0">
              {CHANGELOG.slice(0, 3).map((entry, i) => (
                <React.Fragment key={entry.id}>
                  {i > 0 && <Separator className="my-4" />}
                  <ChangelogEntry entry={entry} highlight={i === 0} />
                </React.Fragment>
              ))}
            </CardContent>
          </Card>
        </section>
      )}

      <section>
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-[0.1em] mb-3">
          Tools
        </h3>
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
              description="For advanced tweaking. Most settings live in the Settings tab."
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
      </section>

      <details className="group rounded-xl border bg-card">
        <summary className="cursor-pointer select-none flex items-center justify-between gap-3 px-4 py-3 text-sm font-medium text-muted-foreground hover:text-foreground">
          <span>Recent activity log</span>
          <span className="text-[11px] text-muted-foreground/70">
            For troubleshooting
          </span>
        </summary>
        <div className="border-t px-4 py-3">
          <pre className="font-mono text-[11px] leading-relaxed text-muted-foreground max-h-72 overflow-auto whitespace-pre-wrap break-words">
            {logs || '(no recent activity)'}
          </pre>
          <Separator className="my-3" />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => window.cofounderos.getOverview().catch(() => null)}
          >
            <RefreshCcw />
            Refresh status
          </Button>
        </div>
      </details>
    </div>
  );
}

function ChangelogEntry({
  entry,
  highlight,
}: {
  entry: (typeof CHANGELOG)[number];
  highlight: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="font-semibold flex items-center gap-2">
          {highlight && <Sparkles className="size-3.5 text-primary" />}
          {entry.title}
        </h4>
        <div className="flex items-center gap-2">
          <Badge variant="muted" className="text-[10px] font-mono">
            {entry.version}
          </Badge>
          <span className="text-[11px] text-muted-foreground">{entry.date}</span>
        </div>
      </div>
      <ul className="flex flex-col gap-1 text-sm">
        {entry.items.map((item, j) => (
          <li key={j} className="flex gap-2">
            <span className="text-muted-foreground/60 mt-0.5">·</span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AboutCard() {
  const [platform, setPlatform] = React.useState<string>('');

  React.useEffect(() => {
    const ua = navigator.userAgent;
    const platformLabel = navigator.platform || '';
    let arch = '';
    const archMatch = ua.match(/(Mac OS X|Windows NT|Linux)\s+([^);]+)/);
    if (archMatch) arch = archMatch[2]!.trim();
    setPlatform([platformLabel, arch].filter(Boolean).join(' · '));
  }, []);

  return (
    <Card className="overflow-hidden">
      <div
        className="bg-gradient-brand-soft px-6 py-5 flex flex-wrap items-center gap-4 border-b"
      >
        <BrandMark className="size-12" />
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-baseline gap-2">
            <h3 className="text-xl font-semibold tracking-tight">CofounderOS</h3>
            <Badge variant="muted" className="font-mono">
              v{__APP_VERSION__}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            Your local memory, on this device. Open source — every line is yours to
            read.
          </p>
          {platform ? (
            <p className="text-[11px] text-muted-foreground/70 mt-1.5 font-mono">
              {platform}
            </p>
          ) : null}
        </div>
      </div>
      <CardContent className="flex flex-col gap-4">
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
    <div className="flex items-center gap-2 rounded-lg border bg-background px-3 py-2 text-sm">
      <span className="text-primary [&>svg]:size-4">{icon}</span>
      <span className="font-medium">{label}</span>
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
