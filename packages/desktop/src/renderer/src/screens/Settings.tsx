import * as React from 'react';
import { Check, FolderOpen, Save, X } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { PageHeader } from '@/components/PageHeader';
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
  const [message, setMessage] = React.useState<{ kind: 'ok' | 'error'; text: string } | null>(
    null,
  );
  const [startAtLogin, setStartAtLogin] = React.useState<boolean | null>(null);

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
      </div>
    );
  }

  const loadedConfig = config;
  const currentDraft = draft;

  const set = <K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) => {
    setDraft({ ...currentDraft, [key]: value });
    setMessage(null);
  };
  const baseline = settingsDraftFromConfig(loadedConfig);
  const hasUnsavedChanges = JSON.stringify(draft) !== JSON.stringify(baseline);

  async function save() {
    if (!hasUnsavedChanges) return;
    setSaving(true);
    setMessage(null);
    try {
      const next = await window.cofounderos.saveConfigPatch(configPatchFromDraft(currentDraft));
      onSaved(next);
      setMessage({ kind: 'ok', text: 'Saved! Changes apply next time you start.' });
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
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
    setMessage(null);
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

      {message && (
        <Alert variant={message.kind === 'error' ? 'destructive' : 'success'}>
          {message.kind === 'ok' ? <Check /> : <X />}
          <AlertTitle>{message.kind === 'ok' ? 'Saved' : 'Could not save'}</AlertTitle>
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      )}

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
            <CardContent>
              <ToggleRow
                title="Open at startup"
                description="CofounderOS opens quietly in the background when you sign in."
                checked={Boolean(startAtLogin)}
                onChange={(v) => void toggleStartAtLogin(v)}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="privacy">
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
        onSave={save}
        onReset={resetDraft}
      />
    </div>
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
  onReset,
}: {
  hasUnsavedChanges: boolean;
  saving: boolean;
  onSave: () => void;
  onReset: () => void;
}) {
  if (!hasUnsavedChanges) return null;
  return (
    <div className="fixed bottom-4 left-64 right-4 z-30 mx-auto max-w-2xl">
      <div className="flex items-center justify-between gap-3 rounded-xl border bg-popover px-4 py-3 shadow-lg">
        <p className="text-sm">You have unsaved changes.</p>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onReset}>
            Reset
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
