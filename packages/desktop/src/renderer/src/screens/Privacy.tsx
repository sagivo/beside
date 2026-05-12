import * as React from 'react';
import {
  AlertTriangle,
  Ban,
  Globe2,
  Loader2,
  LockKeyhole,
  Pause,
  Play,
  Plus,
  RefreshCcw,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/sonner';
import { PageHeader } from '@/components/PageHeader';
import { countByValue, parseLines, uniqueStrings } from '@/lib/collections';
import { formatBytes, formatNumber, localDayKey } from '@/lib/format';
import { domainFromUrl, normalizeDomainInput } from '@/lib/url';
import { cn } from '@/lib/utils';
import type { Frame, LoadedConfig, RuntimeOverview } from '@/global';

export function Privacy({
  config,
  overview,
  onRefresh,
  onSaved,
  onOverview,
  onStart,
  onPause,
  onResume,
}: {
  config: LoadedConfig | null;
  overview: RuntimeOverview | null;
  onRefresh: () => void | Promise<void>;
  onSaved: (config: LoadedConfig) => void;
  onOverview: (overview: RuntimeOverview) => void;
  onStart: () => Promise<void> | void;
  onPause: () => Promise<void> | void;
  onResume: () => Promise<void> | void;
}) {
  const [recentFrames, setRecentFrames] = React.useState<Frame[]>([]);
  const [loadingRecent, setLoadingRecent] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [appDraft, setAppDraft] = React.useState('');
  const [urlDraft, setUrlDraft] = React.useState('');
  const [keywordDraft, setKeywordDraft] = React.useState('');
  const [blurPasswordFields, setBlurPasswordFields] = React.useState(true);
  const [pauseOnScreenLock, setPauseOnScreenLock] = React.useState(true);
  const [purgeApp, setPurgeApp] = React.useState('');
  const [purgeDomain, setPurgeDomain] = React.useState('');

  React.useEffect(() => {
    if (!config) return;
    setAppDraft(config.config.capture.excluded_apps.join('\n'));
    setUrlDraft(config.config.capture.excluded_url_patterns.join('\n'));
    setKeywordDraft(config.config.capture.privacy.sensitive_keywords.join('\n'));
    setBlurPasswordFields(config.config.capture.privacy.blur_password_fields);
    setPauseOnScreenLock(config.config.capture.privacy.pause_on_screen_lock);
  }, [config]);

  const loadRecent = React.useCallback(async () => {
    setLoadingRecent(true);
    try {
      const today = localDayKey();
      const frames = await window.cofounderos.searchFrames({
        day: today,
        limit: 500,
      });
      setRecentFrames(frames);
    } catch {
      setRecentFrames([]);
    } finally {
      setLoadingRecent(false);
    }
  }, []);

  React.useEffect(() => {
    void loadRecent();
  }, [loadRecent]);

  if (!config) {
    return (
      <div className="flex flex-col gap-6 pt-6">
        <PageHeader title="Privacy" description="Loading privacy controls…" />
        <Card>
          <CardContent className="flex flex-col gap-4">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
          </CardContent>
        </Card>
      </div>
    );
  }

  const captureLive = !!overview?.capture.running && !overview.capture.paused;
  const capturePaused = !!overview?.capture.running && !!overview.capture.paused;
  const ignoredApps = parseLines(appDraft);
  const ignoredUrls = parseLines(urlDraft);
  const sensitiveKeywords = parseLines(keywordDraft);
  const recentApps = countByValue(
    recentFrames.map((frame) => frame.app).filter((v): v is string => Boolean(v)),
  ).filter((item) => !ignoredApps.includes(item.value));
  const recentDomains = countByValue(
    recentFrames.map((frame) => domainFromUrl(frame.url)).filter((v): v is string => Boolean(v)),
  ).filter((item) => !ignoredUrls.includes(item.value));

  async function savePrivacy(next?: {
    apps?: string[];
    urls?: string[];
    keywords?: string[];
    blur?: boolean;
    pauseLock?: boolean;
  }) {
    const apps = next?.apps ?? ignoredApps;
    const urls = next?.urls ?? ignoredUrls;
    const keywords = next?.keywords ?? sensitiveKeywords;
    const blur = next?.blur ?? blurPasswordFields;
    const pauseLock = next?.pauseLock ?? pauseOnScreenLock;

    setSaving(true);
    try {
      const wasRunning = overview?.status === 'running';
      const wasPaused = !!overview?.capture.paused;
      const saved = await window.cofounderos.saveConfigPatch({
        capture: {
          excluded_apps: apps,
          excluded_url_patterns: urls,
          privacy: {
            blur_password_fields: blur,
            pause_on_screen_lock: pauseLock,
            sensitive_keywords: keywords,
          },
        },
      });
      onSaved(saved);
      setAppDraft(apps.join('\n'));
      setUrlDraft(urls.join('\n'));
      setKeywordDraft(keywords.join('\n'));
      setBlurPasswordFields(blur);
      setPauseOnScreenLock(pauseLock);
      if (wasRunning) {
        let nextOverview = await window.cofounderos.startRuntime();
        if (wasPaused && !nextOverview.capture.paused) {
          nextOverview = await window.cofounderos.pauseCapture();
        }
        onOverview(nextOverview);
      }
      toast.success('Privacy controls saved', {
        description: wasRunning
          ? 'Capture restarted with the new rules.'
          : 'Rules apply next time capture starts.',
      });
    } catch (err) {
      toast.error('Could not save privacy controls', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  }

  async function deleteScope(scope: { app?: string; urlDomain?: string }) {
    setDeleting(true);
    try {
      const result = await window.cofounderos.deleteFrames(scope);
      toast.success('Memory deleted', {
        description: `Removed ${formatNumber(result.frames)} matching moments and ${result.assetPaths.length.toLocaleString()} screenshot asset${result.assetPaths.length === 1 ? '' : 's'}.`,
      });
      setPurgeApp('');
      setPurgeDomain('');
      await Promise.all([loadRecent(), onRefresh()]);
    } catch (err) {
      toast.error('Could not delete memory', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="flex flex-col gap-6 pt-6 pb-12">
      <PageHeader
        title="Privacy"
        description="Control what CofounderOS can remember, and remove what it already saved."
        actions={
          <Button variant="ghost" size="sm" onClick={onRefresh}>
            <RefreshCcw />
            Refresh
          </Button>
        }
      />

      <CaptureControl
        live={captureLive}
        paused={capturePaused}
        eventsToday={overview?.capture.eventsToday ?? 0}
        totalBytes={overview?.storage.totalAssetBytes ?? 0}
        onStart={onStart}
        onPause={onPause}
        onResume={onResume}
      />

      <Card>
        <CardContent className="flex flex-col gap-5">
          <SectionTitle
            icon={<Ban />}
            title="Ignore Rules"
            description="Apps and sites here are skipped at capture time."
          />
          <div className="grid gap-4 md:grid-cols-2">
            <ListEditor
              label="Ignored apps"
              value={appDraft}
              onChange={setAppDraft}
              placeholder="One app per line"
              suggestions={recentApps}
              onAddSuggestion={(value) => {
                const next = uniqueStrings([...ignoredApps, value]);
                void savePrivacy({ apps: next });
              }}
            />
            <ListEditor
              label="Ignored websites"
              value={urlDraft}
              onChange={setUrlDraft}
              placeholder="example.com"
              hint={
                <>
                  One rule per line. Use domains like <code>example.com</code>, subdomains like{' '}
                  <code>*.example.com</code>, or paths like <code>example.com/private/*</code>.
                </>
              }
              suggestions={recentDomains}
              onAddSuggestion={(value) => {
                const next = uniqueStrings([...ignoredUrls, value]);
                void savePrivacy({ urls: next });
              }}
            />
          </div>
          <div className="flex justify-end">
            <Button onClick={() => void savePrivacy()} disabled={saving}>
              {saving ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
              Save ignore rules
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-5">
          <SectionTitle
            icon={<LockKeyhole />}
            title="Sensitive Content"
            description="Skip obvious secrets before they become searchable memory."
          />
          <div className="flex flex-col gap-0 rounded-lg border">
            <ToggleRow
              title="Skip password fields"
              description="Avoid saving focused password inputs when the capture plugin can detect them."
              checked={blurPasswordFields}
              onChange={(v) => {
                setBlurPasswordFields(v);
                void savePrivacy({ blur: v });
              }}
            />
            <Separator />
            <ToggleRow
              title="Pause on screen lock"
              description="Stop capture when the desktop session is locked."
              checked={pauseOnScreenLock}
              onChange={(v) => {
                setPauseOnScreenLock(v);
                void savePrivacy({ pauseLock: v });
              }}
            />
          </div>
          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium">Sensitive words</label>
            <Textarea
              value={keywordDraft}
              onChange={(e) => setKeywordDraft(e.currentTarget.value)}
              placeholder={'password\napi_key\nsecret'}
              className="min-h-28"
            />
            <p className="text-xs text-muted-foreground">
              If visible text contains one of these words, the event is marked private and skipped.
            </p>
          </div>
          <div className="flex justify-end">
            <Button onClick={() => void savePrivacy()} disabled={saving}>
              {saving ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
              Save sensitive rules
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="border-destructive/30 bg-destructive/5">
        <CardContent className="flex flex-col gap-5">
          <SectionTitle
            icon={<AlertTriangle />}
            title="Delete Stored Memory"
            description="Permanently purge previous captures for one app or one website."
            danger
          />
          <div className="grid gap-4 md:grid-cols-2">
            <PurgeBox
              icon={<Ban className="size-4" />}
              title="Delete by app"
              value={purgeApp}
              onChange={setPurgeApp}
              placeholder="Slack"
              confirmLabel="Delete app memory"
              disabled={deleting || !purgeApp.trim()}
              onConfirm={() => deleteScope({ app: purgeApp.trim() })}
            />
            <PurgeBox
              icon={<Globe2 className="size-4" />}
              title="Delete by website"
              value={purgeDomain}
              onChange={(v) => setPurgeDomain(normalizeDomainInput(v))}
              placeholder="notion.so"
              confirmLabel="Delete site memory"
              disabled={deleting || !purgeDomain.trim()}
              onConfirm={() => deleteScope({ urlDomain: purgeDomain.trim() })}
            />
          </div>
          {loadingRecent && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              Reading recent apps and sites…
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function CaptureControl({
  live,
  paused,
  eventsToday,
  totalBytes,
  onStart,
  onPause,
  onResume,
}: {
  live: boolean;
  paused: boolean;
  eventsToday: number;
  totalBytes: number;
  onStart: () => Promise<void> | void;
  onPause: () => Promise<void> | void;
  onResume: () => Promise<void> | void;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="flex items-start gap-3">
          <div
            className={cn(
              'grid size-10 place-items-center rounded-lg',
              live
                ? 'bg-success/15 text-success'
                : paused
                  ? 'bg-warning/15 text-warning'
                  : 'bg-muted text-muted-foreground',
            )}
          >
            <ShieldCheck className="size-5" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-semibold">Capture Guard</h2>
              <Badge variant={live ? 'success' : paused ? 'warning' : 'muted'}>
                {live ? 'Capturing' : paused ? 'Paused' : 'Off'}
              </Badge>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {formatNumber(eventsToday)} moments today · {formatBytes(totalBytes)} stored locally
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {!live && !paused && (
            <Button onClick={() => void onStart()}>
              <Play />
              Start
            </Button>
          )}
          {live && (
            <Button variant="outline" onClick={() => void onPause()}>
              <Pause />
              Pause capture
            </Button>
          )}
          {paused && (
            <Button onClick={() => void onResume()}>
              <Play />
              Resume capture
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function SectionTitle({
  icon,
  title,
  description,
  danger,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  danger?: boolean;
}) {
  return (
    <div className="flex items-start gap-3">
      <div
        className={cn(
          'grid size-9 shrink-0 place-items-center rounded-lg [&>svg]:size-4',
          danger ? 'bg-destructive/15 text-destructive' : 'bg-primary/10 text-primary',
        )}
      >
        {icon}
      </div>
      <div>
        <h2 className={cn('font-semibold', danger && 'text-destructive')}>{title}</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

function ListEditor({
  label,
  value,
  onChange,
  placeholder,
  hint,
  suggestions,
  onAddSuggestion,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  hint?: React.ReactNode;
  suggestions: Array<{ value: string; count: number }>;
  onAddSuggestion: (value: string) => void;
}) {
  const items = parseLines(value);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <label className="text-sm font-medium">{label}</label>
        <span className="text-xs text-muted-foreground">{items.length} saved</span>
      </div>
      <Textarea
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        placeholder={placeholder}
        className="min-h-36"
      />
      {hint ? (
        <p className="text-xs leading-relaxed text-muted-foreground [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[11px]">
          {hint}
        </p>
      ) : null}
      {suggestions.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {suggestions.slice(0, 8).map((item) => (
            <button
              key={item.value}
              type="button"
              onClick={() => onAddSuggestion(item.value)}
              className="inline-flex items-center gap-1 rounded-full border bg-background px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
            >
              <Plus className="size-3" />
              {item.value}
              <span className="text-muted-foreground/60">{item.count}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ToggleRow({
  title,
  description,
  checked,
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div>
        <div className="text-sm font-medium">{title}</div>
        <div className="text-xs text-muted-foreground">{description}</div>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function PurgeBox({
  icon,
  title,
  value,
  onChange,
  placeholder,
  confirmLabel,
  disabled,
  onConfirm,
}: {
  icon: React.ReactNode;
  title: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  confirmLabel: string;
  disabled: boolean;
  onConfirm: () => Promise<void>;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-background/60 p-4">
      <div className="flex items-center gap-2 text-sm font-medium">
        {icon}
        {title}
      </div>
      <div className="relative">
        <Input
          value={value}
          onChange={(e) => onChange(e.currentTarget.value)}
          placeholder={placeholder}
          className="pr-8"
        />
        {value && (
          <button
            type="button"
            onClick={() => onChange('')}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            aria-label="Clear"
          >
            <X className="size-4" />
          </button>
        )}
      </div>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="destructive" disabled={disabled}>
            <Trash2 />
            {confirmLabel}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmLabel}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes matching captured moments, screenshots, raw events, and
              derived summaries from this device. There is no undo.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => void onConfirm()}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
