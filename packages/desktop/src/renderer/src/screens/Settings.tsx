import * as React from 'react';
import {
  AlertTriangle,
  Check,
  FolderOpen,
  Loader2,
  Mic,
  Monitor,
  Moon,
  Power,
  RefreshCw,
  Save,
  Shield,
  Sun,
  Trash2,
  X,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/sonner';
import { PageHeader } from '@/components/PageHeader';
import { formatBytes } from '@/lib/format';
import { useTheme, type ThemePreference } from '@/lib/theme';
import { cn } from '@/lib/utils';
import type { LoadedConfig, MicPermission, WhisperProbe } from '@/global';

interface SettingsDraft {
  blurPasswordFields: boolean;
  pauseOnScreenLock: boolean;
  sensitiveKeywords: string;
  excludedApps: string;
  excludedUrlPatterns: string;
  maxSizeGb: number;
  retentionDays: number;
  compressAfterDays: number;
  deleteAfterDays: number;
  ollamaModel: string;
  ollamaHost: string;
  ollamaAutoInstall: boolean;
  markdownPath: string;
  mcpPort: number;
  // Audio
  captureAudio: boolean;
  whisperModel: string;
  liveRecordingEnabled: boolean;
  chunkSeconds: number;
  deleteAudioAfterTranscribe: boolean;
}

export function Settings({
  config,
  onSaved,
}: {
  config: LoadedConfig | null;
  onSaved: (config: LoadedConfig) => void;
}) {
  const [draft, setDraft] = React.useState<SettingsDraft | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [startAtLogin, setStartAtLogin] = React.useState<boolean | null>(null);
  const { preference: themePreference, setPreference: setThemePreference } = useTheme();

  React.useEffect(() => {
    if (config) setDraft(settingsDraftFromConfig(config));
  }, [config]);

  React.useEffect(() => {
    void window.cofounderos
      .getStartAtLogin()
      .then(setStartAtLogin)
      .catch(() => setStartAtLogin(false));
  }, []);

  if (!config || !draft) {
    return (
      <div className="flex flex-col gap-6 pt-6">
        <PageHeader title="Settings" description="Loading…" />
        <Skeleton className="h-9 w-72" />
        <Card>
          <CardContent className="flex flex-col gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center justify-between gap-4">
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-3 w-72" />
                </div>
                <Skeleton className="h-5 w-9 rounded-full" />
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    );
  }

  const loadedConfig = config;
  const currentDraft = draft;

  const set = <K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) => {
    setDraft({ ...currentDraft, [key]: value });
  };
  const baseline = settingsDraftFromConfig(loadedConfig);
  const hasUnsavedChanges = JSON.stringify(draft) !== JSON.stringify(baseline);

  async function save(opts: { restart?: boolean } = {}) {
    if (!hasUnsavedChanges) return;
    setSaving(true);
    try {
      const next = await window.cofounderos.saveConfigPatch(configPatchFromDraft(currentDraft));
      onSaved(next);
      if (opts.restart) {
        try {
          await window.cofounderos.stopRuntime();
          await window.cofounderos.startRuntime();
          toast.success('Settings saved & runtime restarted');
        } catch (err) {
          toast.error('Saved, but restart failed', {
            description: err instanceof Error ? err.message : String(err),
          });
        }
      } else {
        toast.success('Settings saved', {
          description: 'Some changes apply on next start.',
        });
      }
    } catch (err) {
      toast.error('Could not save settings', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  }

  async function toggleStartAtLogin(enabled: boolean) {
    setStartAtLogin(enabled);
    const actual = await window.cofounderos.setStartAtLogin(enabled);
    setStartAtLogin(actual);
  }

  function resetDraft() {
    setDraft(settingsDraftFromConfig(loadedConfig));
  }

  return (
    <div className="flex flex-col gap-6 pt-6 pb-24">
      <PageHeader
        title="Settings"
        description="Make CofounderOS work the way you like."
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void window.cofounderos.openPath('config')}
            >
              <FolderOpen />
              Open config
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void window.cofounderos.openPath('data')}
            >
              <FolderOpen />
              Open data folder
            </Button>
          </>
        }
      />

      <Tabs defaultValue="general" className="flex flex-col gap-4">
        <TabsList className="self-start">
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="privacy">Privacy</TabsTrigger>
          <TabsTrigger value="storage">Storage</TabsTrigger>
          <TabsTrigger value="ai">AI</TabsTrigger>
          <TabsTrigger value="audio">Audio</TabsTrigger>
          <TabsTrigger value="advanced">Advanced</TabsTrigger>
        </TabsList>

        <TabsContent value="general">
          <Card>
            <CardContent className="flex flex-col gap-0">
              <ToggleRow
                title="Open at startup"
                description="CofounderOS opens quietly in the background when you sign in."
                checked={Boolean(startAtLogin)}
                onChange={(v) => void toggleStartAtLogin(v)}
              />
              <Separator className="my-4" />
              <div className="flex flex-col gap-3">
                <div>
                  <h4 className="font-medium">Appearance</h4>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    Match your system, or pick a fixed theme.
                  </p>
                </div>
                <ThemePicker value={themePreference} onChange={setThemePreference} />
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="privacy" className="flex flex-col gap-4">
          <Card>
            <CardContent className="flex flex-col gap-0">
              <ToggleRow
                title="Blur password fields"
                description="Skip password boxes so they're never captured."
                checked={draft.blurPasswordFields}
                onChange={(v) => set('blurPasswordFields', v)}
              />
              <Separator className="my-4" />
              <ToggleRow
                title="Pause when screen is locked"
                description="Stop capturing when you step away from your computer."
                checked={draft.pauseOnScreenLock}
                onChange={(v) => set('pauseOnScreenLock', v)}
              />
              <Separator className="my-4" />
              <Field label="Words to skip" hint="Anything containing these words won't be saved.">
                <Textarea
                  rows={4}
                  value={draft.sensitiveKeywords}
                  onChange={(e) => set('sensitiveKeywords', e.currentTarget.value)}
                  placeholder="One per line — e.g. salary, passport"
                />
              </Field>
            </CardContent>
          </Card>

          <DangerZone />
        </TabsContent>

        <TabsContent value="storage">
          <Card>
            <CardContent>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Maximum space (GB)">
                  <Input
                    type="number"
                    min="1"
                    value={draft.maxSizeGb}
                    onChange={(e) => set('maxSizeGb', Number(e.currentTarget.value))}
                  />
                </Field>
                <Field label="Keep memories for (days)">
                  <Input
                    type="number"
                    min="0"
                    value={draft.retentionDays}
                    onChange={(e) => set('retentionDays', Number(e.currentTarget.value))}
                  />
                </Field>
                <Field label="Compress old screenshots after (days)">
                  <Input
                    type="number"
                    min="0"
                    value={draft.compressAfterDays}
                    onChange={(e) => set('compressAfterDays', Number(e.currentTarget.value))}
                  />
                </Field>
                <Field
                  label="Delete old screenshots after (days)"
                  hint="0 means never delete. Text stays searchable."
                >
                  <Input
                    type="number"
                    min="0"
                    value={draft.deleteAfterDays}
                    onChange={(e) => set('deleteAfterDays', Number(e.currentTarget.value))}
                  />
                </Field>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="ai">
          <Card>
            <CardContent className="flex flex-col gap-0">
              <ToggleRow
                title="Auto-install AI tools when needed"
                description="Lets us set up the local model for you."
                checked={draft.ollamaAutoInstall}
                onChange={(v) => set('ollamaAutoInstall', v)}
              />
              <Separator className="my-4" />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Model">
                  <Input
                    value={draft.ollamaModel}
                    onChange={(e) => set('ollamaModel', e.currentTarget.value)}
                  />
                </Field>
                <Field label="Host">
                  <Input
                    value={draft.ollamaHost}
                    onChange={(e) => set('ollamaHost', e.currentTarget.value)}
                  />
                </Field>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="audio">
          <AudioSettings
            captureAudio={draft.captureAudio}
            liveRecordingEnabled={draft.liveRecordingEnabled}
            whisperModel={draft.whisperModel}
            chunkSeconds={draft.chunkSeconds}
            deleteAudioAfterTranscribe={draft.deleteAudioAfterTranscribe}
            set={set}
          />
        </TabsContent>

        <TabsContent value="advanced">
          <Card>
            <CardContent className="flex flex-col gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Apps to ignore">
                  <Textarea
                    rows={4}
                    value={draft.excludedApps}
                    onChange={(e) => set('excludedApps', e.currentTarget.value)}
                    placeholder="One app name per line"
                  />
                </Field>
                <Field label="URLs to ignore">
                  <Textarea
                    rows={4}
                    value={draft.excludedUrlPatterns}
                    onChange={(e) => set('excludedUrlPatterns', e.currentTarget.value)}
                    placeholder="One pattern per line"
                  />
                </Field>
                <Field label="Folder for daily journals">
                  <Input
                    value={draft.markdownPath}
                    onChange={(e) => set('markdownPath', e.currentTarget.value)}
                  />
                </Field>
                <Field label="AI connection port">
                  <Input
                    type="number"
                    min="1"
                    value={draft.mcpPort}
                    onChange={(e) => set('mcpPort', Number(e.currentTarget.value))}
                  />
                </Field>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <SaveBar
        hasUnsavedChanges={hasUnsavedChanges}
        saving={saving}
        onSave={() => void save()}
        onSaveAndRestart={() => void save({ restart: true })}
        onReset={resetDraft}
      />
    </div>
  );
}

const WHISPER_MODELS: Array<{ id: string; label: string; size: string; quality: string }> = [
  { id: 'tiny', label: 'tiny', size: '~75 MB', quality: 'Fastest, lower quality' },
  { id: 'base', label: 'base', size: '~150 MB', quality: 'Recommended' },
  { id: 'small', label: 'small', size: '~500 MB', quality: 'Better, slower' },
  { id: 'medium', label: 'medium', size: '~1.5 GB', quality: 'Best, much slower' },
];

function AudioSettings({
  captureAudio,
  liveRecordingEnabled,
  whisperModel,
  chunkSeconds,
  deleteAudioAfterTranscribe,
  set,
}: {
  captureAudio: boolean;
  liveRecordingEnabled: boolean;
  whisperModel: string;
  chunkSeconds: number;
  deleteAudioAfterTranscribe: boolean;
  set: <K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) => void;
}) {
  const [whisper, setWhisper] = React.useState<WhisperProbe | null>(null);
  const [ffprobe, setFfprobe] = React.useState<{ available: boolean; path?: string } | null>(null);
  const [mic, setMic] = React.useState<MicPermission | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);

  const refreshProbes = React.useCallback(async () => {
    setRefreshing(true);
    try {
      const [w, f, m] = await Promise.all([
        window.cofounderos.probeWhisper(),
        window.cofounderos.probeFfprobe(),
        window.cofounderos.probeMicPermission(),
      ]);
      setWhisper(w);
      setFfprobe(f);
      setMic(m);
    } catch {
      /* ignore */
    } finally {
      setRefreshing(false);
    }
  }, []);

  React.useEffect(() => {
    void refreshProbes();
  }, [refreshProbes]);

  async function handleRequestMic() {
    const after = await window.cofounderos.requestMicPermission();
    setMic(after);
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardContent className="flex flex-col gap-0">
          <ToggleRow
            title="Capture audio from microphone"
            description="When another app is using the microphone, record short chunks and transcribe them locally with Whisper. Off by default."
            checked={captureAudio}
            onChange={(v) => {
              set('captureAudio', v);
              set('liveRecordingEnabled', v);
            }}
          />
          {captureAudio && (
            <>
              <Separator className="my-4" />
              <div className="flex flex-col gap-3">
                <div>
                  <h4 className="font-medium">Whisper model</h4>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    Trade-off between transcription quality and speed.
                  </p>
                </div>
                <RadioGroup
                  value={whisperModel}
                  onValueChange={(v) => set('whisperModel', v)}
                  className="grid gap-2 sm:grid-cols-2"
                >
                  {WHISPER_MODELS.map((m) => (
                    <Label
                      key={m.id}
                      htmlFor={`wm-${m.id}`}
                      className={cn(
                        'flex cursor-pointer items-start gap-3 rounded-md border bg-card p-3 text-sm font-normal transition-colors',
                        whisperModel === m.id
                          ? 'border-primary ring-2 ring-primary/20'
                          : 'hover:bg-accent/40',
                      )}
                    >
                      <RadioGroupItem
                        value={m.id}
                        id={`wm-${m.id}`}
                        className="mt-0.5"
                      />
                      <div className="min-w-0">
                        <div className="font-medium">{m.label}</div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {m.size} · {m.quality}
                        </div>
                      </div>
                    </Label>
                  ))}
                </RadioGroup>
              </div>
              <Separator className="my-4" />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Chunk length (seconds)"
                  hint="Shorter chunks = faster feedback during calls, more Whisper invocations."
                >
                  <Input
                    type="number"
                    min="10"
                    value={chunkSeconds}
                    onChange={(e) => set('chunkSeconds', Number(e.currentTarget.value))}
                  />
                </Field>
              </div>
              <Separator className="my-4" />
              <ToggleRow
                title="Delete audio after transcribing"
                description="Recommended. The redacted transcript stays; the raw audio file is removed so credentials and other PII don't linger on disk."
                checked={deleteAudioAfterTranscribe}
                onChange={(v) => set('deleteAudioAfterTranscribe', v)}
              />
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <div className="size-8 shrink-0 grid place-items-center rounded-md bg-primary/10 text-primary">
                <Mic className="size-4" />
              </div>
              <div>
                <h4 className="font-medium">Status</h4>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Conditional audio capture needs Whisper installed and microphone permission.
                </p>
              </div>
            </div>
            <Button size="sm" variant="outline" onClick={() => void refreshProbes()} disabled={refreshing}>
              {refreshing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              Re-check
            </Button>
          </div>

          <div className="flex flex-col gap-2">
            <SettingsStatusRow
              label="Whisper"
              status={whisper === null ? 'pending' : whisper.available ? 'ok' : 'missing'}
              detail={
                whisper === null
                  ? 'Checking…'
                  : whisper.available
                    ? whisper.path ?? 'installed'
                    : 'Not found on PATH. Install instructions below.'
              }
            />
            <SettingsStatusRow
              label="ffprobe (for accurate durations)"
              status={ffprobe === null ? 'pending' : ffprobe.available ? 'ok' : 'optional-missing'}
              detail={
                ffprobe === null
                  ? 'Checking…'
                  : ffprobe.available
                    ? ffprobe.path ?? 'installed'
                    : 'Optional. Without ffprobe, audio events have no duration_ms. Install with `brew install ffmpeg`.'
              }
            />
            {mic && mic.status !== 'unsupported' && (
              <SettingsStatusRow
                label="Microphone permission"
                status={
                  mic.status === 'granted'
                    ? 'ok'
                    : mic.status === 'denied' || mic.status === 'restricted'
                      ? 'missing'
                      : 'pending'
                }
                detail={
                  mic.status === 'granted'
                    ? 'Granted'
                    : mic.status === 'denied'
                      ? 'Denied. Open System Settings → Privacy & Security → Microphone and enable CofounderOS.'
                      : mic.status === 'restricted'
                        ? "Restricted by a profile or parental control."
                        : 'Not yet asked. Click Request below to prompt.'
                }
                action={
                  mic.status === 'not-determined'
                    ? { label: 'Request', onClick: () => void handleRequestMic() }
                    : undefined
                }
              />
            )}
          </div>

          {whisper && !whisper.available && (
            <WhisperOneClickInstall onInstalled={() => void refreshProbes()} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SettingsStatusRow({
  label,
  status,
  detail,
  action,
}: {
  label: string;
  status: 'ok' | 'missing' | 'optional-missing' | 'pending';
  detail?: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="flex items-start gap-3 rounded-md border bg-muted/30 p-3">
      <div className="mt-0.5">
        {status === 'ok' ? (
          <Check className="size-4 text-success" />
        ) : status === 'missing' ? (
          <X className="size-4 text-destructive" />
        ) : status === 'optional-missing' ? (
          <Shield className="size-4 text-muted-foreground" />
        ) : (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {detail && <div className="text-xs text-muted-foreground mt-0.5 break-words">{detail}</div>}
      </div>
      {action && (
        <Button size="sm" variant="outline" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  );
}

function WhisperOneClickInstall({ onInstalled }: { onInstalled: () => void }) {
  const [installer, setInstaller] = React.useState<
    'brew' | 'pipx' | 'pip3' | 'pip' | null | undefined
  >(undefined);
  const [state, setState] = React.useState<'idle' | 'running' | 'failed' | 'finished'>(
    'idle',
  );
  const [log, setLog] = React.useState<string[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [activeInstaller, setActiveInstaller] = React.useState<
    'brew' | 'pipx' | 'pip3' | 'pip' | null
  >(null);

  React.useEffect(() => {
    void window.cofounderos
      .detectWhisperInstaller()
      .then((res) => setInstaller(res.installer))
      .catch(() => setInstaller(null));
  }, []);

  React.useEffect(() => {
    if (!window.cofounderos.onWhisperInstallProgress) return;
    window.cofounderos.onWhisperInstallProgress((event) => {
      if (event.kind === 'started') {
        setState('running');
        setError(null);
        setLog([`$ ${event.message ?? `${event.installer} install openai-whisper`}`]);
        setActiveInstaller(event.installer);
      } else if (event.kind === 'log') {
        setLog((prev) => [...prev.slice(-80), event.message]);
      } else if (event.kind === 'finished') {
        setState(event.available ? 'finished' : 'failed');
        if (!event.available) {
          setError(
            "Install completed but Whisper still isn't on PATH. Try restarting CofounderOS from a fresh terminal.",
          );
        }
        onInstalled();
      } else if (event.kind === 'failed') {
        setState('failed');
        setError(event.reason ?? 'Install failed.');
      }
    });
  }, [onInstalled]);

  async function runInstall() {
    setState('running');
    setError(null);
    setLog([]);
    try {
      const res = await window.cofounderos.installWhisper();
      if (!res.started) {
        setState('failed');
        setError(res.reason ?? 'Could not start the installer.');
      } else if (res.installer) {
        setActiveInstaller(res.installer);
      }
    } catch (err) {
      setState('failed');
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (installer === undefined) {
    return null;
  }

  if (installer === null) {
    return (
      <Alert variant="warning">
        <Shield />
        <AlertTitle>We can't auto-install Whisper here</AlertTitle>
        <AlertDescription>
          CofounderOS couldn't find Homebrew, pipx, or pip on your system. Install one of those and
          come back, or skip transcription for now.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="rounded-md border bg-muted/30 p-4 flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <div className="size-8 shrink-0 grid place-items-center rounded-md bg-primary/10 text-primary">
          {state === 'running' ? (
            <Loader2 className="size-4 animate-spin" />
          ) : state === 'finished' ? (
            <Check className="size-4" />
          ) : state === 'failed' ? (
            <X className="size-4 text-destructive" />
          ) : (
            <Mic className="size-4" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <h4 className="font-medium text-sm">
            {state === 'finished'
              ? 'Whisper installed'
              : state === 'running'
                ? `Installing Whisper via ${activeInstaller ?? installer}…`
                : state === 'failed'
                  ? 'Install ran into a snag'
                  : `Install Whisper via ${installer}`}
          </h4>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
            {state === 'running'
              ? 'This usually takes a minute or two. The install runs locally — nothing leaves this device.'
              : state === 'failed'
                ? error ?? 'See the log below.'
                : 'CofounderOS will run the install for you using your existing package manager.'}
          </p>
        </div>
        {state !== 'running' && (
          <Button
            size="sm"
            variant={state === 'failed' ? 'outline' : 'default'}
            onClick={() => void runInstall()}
          >
            {state === 'failed' ? (
              <>
                <RefreshCw />
                Try again
              </>
            ) : (
              'Install Whisper'
            )}
          </Button>
        )}
      </div>
      <SettingsInstallLogDisclosure log={log} />
    </div>
  );
}

function SettingsInstallLogDisclosure({ log }: { log: string[] }) {
  if (log.length === 0) return null;
  return (
    <details className="text-xs">
      <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">
        Show install details
      </summary>
      <pre className="mt-2 max-h-40 overflow-auto rounded-md border bg-card p-3 font-mono text-[11px] leading-snug">
        {log.slice(-12).join('\n')}
      </pre>
    </details>
  );
}

function DangerZone() {
  const [confirmText, setConfirmText] = React.useState('');
  const [pending, setPending] = React.useState(false);
  const [open, setOpen] = React.useState(false);

  const requiredPhrase = 'DELETE';
  const canConfirm = confirmText.trim() === requiredPhrase;

  async function handleDelete() {
    setPending(true);
    try {
      const result = await window.cofounderos.deleteAllMemory();
      toast.success('All memory deleted', {
        description: `Removed ${result.frames.toLocaleString()} moments and ${formatBytes(result.assetBytes)} of screenshots.`,
      });
      setConfirmText('');
      setOpen(false);
    } catch (err) {
      toast.error('Could not delete memory', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <Card className="border-destructive/40 bg-destructive/5">
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-start gap-3">
          <div className="size-8 shrink-0 grid place-items-center rounded-md bg-destructive/15 text-destructive">
            <AlertTriangle className="size-4" />
          </div>
          <div>
            <h4 className="font-medium text-destructive">Delete all my memory</h4>
            <p className="text-sm text-muted-foreground mt-0.5">
              Removes every captured moment, screenshot, session, and search index from this
              device. The app keeps running and starts capturing fresh data afterwards. There
              is no undo.
            </p>
          </div>
        </div>
        <div>
          <AlertDialog
            open={open}
            onOpenChange={(next) => {
              setOpen(next);
              if (!next) setConfirmText('');
            }}
          >
            <AlertDialogTrigger asChild>
              <Button variant="destructive">
                <Trash2 />
                Delete everything…
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete all memory?</AlertDialogTitle>
                <AlertDialogDescription>
                  This permanently removes every captured moment, screenshot, and the entire
                  search index from this device. It can't be undone, and there is no backup copy to
                  restore from.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <div className="flex flex-col gap-2">
                <Label htmlFor="danger-confirm">
                  Type <span className="font-mono font-semibold">{requiredPhrase}</span> to
                  confirm.
                </Label>
                <Input
                  id="danger-confirm"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.currentTarget.value)}
                  placeholder={requiredPhrase}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={(e) => {
                    e.preventDefault();
                    if (canConfirm && !pending) void handleDelete();
                  }}
                  disabled={!canConfirm || pending}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  {pending ? 'Deleting…' : 'Delete everything'}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </CardContent>
    </Card>
  );
}

function ThemePicker({
  value,
  onChange,
}: {
  value: ThemePreference;
  onChange: (next: ThemePreference) => void;
}) {
  const options: Array<{ id: ThemePreference; label: string; icon: React.ReactNode }> = [
    { id: 'auto', label: 'Auto', icon: <Monitor /> },
    { id: 'light', label: 'Light', icon: <Sun /> },
    { id: 'dark', label: 'Dark', icon: <Moon /> },
  ];
  return (
    <RadioGroup
      value={value}
      onValueChange={(v) => onChange(v as ThemePreference)}
      className="grid grid-cols-3 gap-2"
    >
      {options.map((opt) => (
        <Label
          key={opt.id}
          htmlFor={`theme-${opt.id}`}
          className={cn(
            'flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border bg-card p-3 text-sm font-normal transition-colors',
            value === opt.id
              ? 'border-primary ring-2 ring-primary/20'
              : 'hover:bg-accent/40',
          )}
        >
          <RadioGroupItem value={opt.id} id={`theme-${opt.id}`} className="sr-only" />
          <div className="size-8 grid place-items-center text-muted-foreground [&>svg]:size-4">
            {opt.icon}
          </div>
          <span className="font-medium">{opt.label}</span>
        </Label>
      ))}
    </RadioGroup>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
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
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <h4 className="font-medium">{title}</h4>
        <p className="text-sm text-muted-foreground mt-0.5">{description}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function SaveBar({
  hasUnsavedChanges,
  saving,
  onSave,
  onSaveAndRestart,
  onReset,
}: {
  hasUnsavedChanges: boolean;
  saving: boolean;
  onSave: () => void;
  onSaveAndRestart: () => void;
  onReset: () => void;
}) {
  if (!hasUnsavedChanges) return null;
  return (
    <div
      className="fixed bottom-4 right-4 z-30 mx-auto max-w-2xl pl-4 animate-in fade-in-0 slide-in-from-bottom-3"
      style={{ left: 'var(--sidebar-w, 15rem)' }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-popover px-4 py-3 shadow-lg">
        <p className="text-sm">
          You have unsaved changes.{' '}
          <span className="text-muted-foreground">Some take effect on next start.</span>
        </p>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onReset} disabled={saving}>
            Reset
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onSaveAndRestart}
            disabled={saving}
            title="Save and restart the runtime so changes apply now"
          >
            <Power />
            {saving ? 'Working…' : 'Save & restart'}
          </Button>
          <Button size="sm" onClick={onSave} disabled={saving}>
            <Save />
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function settingsDraftFromConfig(loaded: LoadedConfig): SettingsDraft {
  const cfg = loaded.config;
  const markdown = cfg.export.plugins.find((p) => p.name === 'markdown');
  const mcp = cfg.export.plugins.find((p) => p.name === 'mcp');
  return {
    blurPasswordFields: cfg.capture.privacy.blur_password_fields,
    pauseOnScreenLock: cfg.capture.privacy.pause_on_screen_lock,
    sensitiveKeywords: cfg.capture.privacy.sensitive_keywords.join('\n'),
    excludedApps: cfg.capture.excluded_apps.join('\n'),
    excludedUrlPatterns: cfg.capture.excluded_url_patterns.join('\n'),
    maxSizeGb: cfg.storage.local.max_size_gb,
    retentionDays: cfg.storage.local.retention_days,
    compressAfterDays: cfg.storage.local.vacuum.compress_after_days,
    deleteAfterDays: cfg.storage.local.vacuum.delete_after_days,
    ollamaModel: cfg.index.model.ollama?.model ?? '',
    ollamaHost: cfg.index.model.ollama?.host ?? '',
    ollamaAutoInstall: cfg.index.model.ollama?.auto_install ?? true,
    markdownPath: typeof markdown?.path === 'string' ? markdown.path : '',
    mcpPort: typeof mcp?.port === 'number' ? mcp.port : 3456,
    captureAudio: cfg.capture.capture_audio ?? false,
    whisperModel: cfg.capture.whisper_model ?? 'base',
    liveRecordingEnabled: cfg.capture.audio?.live_recording?.enabled ?? false,
    chunkSeconds: cfg.capture.audio?.live_recording?.chunk_seconds ?? 300,
    deleteAudioAfterTranscribe: cfg.capture.audio?.delete_audio_after_transcribe ?? true,
  };
}

function configPatchFromDraft(draft: SettingsDraft) {
  const lines = (s: string) =>
    s
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  return {
    capture: {
      excluded_apps: lines(draft.excludedApps),
      excluded_url_patterns: lines(draft.excludedUrlPatterns),
      privacy: {
        blur_password_fields: draft.blurPasswordFields,
        pause_on_screen_lock: draft.pauseOnScreenLock,
        sensitive_keywords: lines(draft.sensitiveKeywords),
      },
      capture_audio: draft.captureAudio,
      whisper_model: draft.whisperModel.trim() || 'base',
      audio: {
        delete_audio_after_transcribe: draft.deleteAudioAfterTranscribe,
        live_recording: {
          enabled: draft.liveRecordingEnabled,
          activation: 'other_process_input',
          poll_interval_sec: 3,
          chunk_seconds: Math.max(1, draft.chunkSeconds),
        },
      },
    },
    storage: {
      local: {
        max_size_gb: draft.maxSizeGb,
        retention_days: draft.retentionDays,
        vacuum: {
          compress_after_days: draft.compressAfterDays,
          delete_after_days: draft.deleteAfterDays,
        },
      },
    },
    index: {
      model: {
        plugin: 'ollama',
        ollama: {
          model: draft.ollamaModel.trim(),
          host: draft.ollamaHost.trim(),
          auto_install: draft.ollamaAutoInstall,
        },
      },
    },
    export: {
      plugins: [
        { name: 'markdown', path: draft.markdownPath.trim() },
        { name: 'mcp', host: '127.0.0.1', port: draft.mcpPort },
      ],
    },
  };
}
