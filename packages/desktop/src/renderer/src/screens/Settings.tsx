import * as React from 'react';
import { AlertTriangle, FolderOpen, Monitor, Moon, Power, Save, Sun, Trash2 } from 'lucide-react';
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
import type { LoadedConfig } from '@/global';

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
                  search index from this device. It can't be undone — your data is local, so
                  there's no copy in the cloud to restore from.
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
