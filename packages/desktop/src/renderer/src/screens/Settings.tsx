import * as React from 'react';
import { AlertTriangle, Check, CheckCircle2, Cpu, Download, ExternalLink, FolderOpen, Keyboard, Loader2, Mic, Monitor, Moon, RefreshCw, Shield, Sparkles, Sun, Trash2, X } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from '@/components/ui/sonner';
import { PageHeader } from '@/components/PageHeader';
import { StatusPill } from '@/components/StatusPill';
import { formatBytes } from '@/lib/format';
import { formatBootstrapLine, pullPercent } from '@/lib/bootstrap-phases';
import { MODEL_CHOICES, findModelChoice, isPlausibleOllamaTag } from '@/lib/model-catalog';
import { useTheme, type ThemePreference } from '@/lib/theme';
import { cn } from '@/lib/utils';
import { NumberField, OptionalNumberField, SaveBar, SelectField, SettingsSection, TextAreaField, TextField, ToggleRow } from '@/screens/settings/settings-controls';
import { configPatchFromDraft, settingsDraftFromConfig, type BackgroundModelJobs, type CaptureMode, type LiveRecordingFormat, type LogLevel, type McpTransport, type ScreenshotFormat, type SettingsDraft, type SystemAudioBackend } from '@/screens/settings/settings-draft';
import type { AccessibilityPermission, LoadedConfig, MicPermission, ModelBootstrapProgress, RuntimeOverview, ScreenPermission, WhisperProbe } from '@/global';

export function Settings({ config, overview, bootstrapEvents, onClearBootstrapEvents, onSaved }: { config: LoadedConfig | null; overview: RuntimeOverview | null; bootstrapEvents: ModelBootstrapProgress[]; onClearBootstrapEvents: () => void; onSaved: (config: LoadedConfig) => void; }) {
  const [draft, setDraft] = React.useState<SettingsDraft | null>(null), [saving, setSaving] = React.useState(false), [startAtLogin, setStartAtLogin] = React.useState<boolean | null>(null);
  const { preference: themePreference, setPreference: setThemePreference } = useTheme();

  React.useEffect(() => { if (config) setDraft(settingsDraftFromConfig(config)); }, [config]);
  React.useEffect(() => { window.beside.getStartAtLogin().then(setStartAtLogin).catch(() => setStartAtLogin(false)); }, []);

  if (!config || !draft) return (
    <div className="flex flex-col gap-6 pt-6"><PageHeader title="Settings" description="Loading…" /><Skeleton className="h-9 w-72" />
      <Card><CardContent className="flex flex-col gap-4">{[1, 2, 3, 4].map(i => <div key={i} className="flex justify-between gap-4"><div className="flex-1 space-y-2"><Skeleton className="h-4 w-40" /><Skeleton className="h-3 w-72" /></div><Skeleton className="h-5 w-9 rounded-full" /></div>)}</CardContent></Card>
    </div>
  );

  const set = (key: keyof SettingsDraft, value: any) => setDraft({ ...draft, [key]: value });
  const hasUnsavedChanges = JSON.stringify(draft) !== JSON.stringify(settingsDraftFromConfig(config));
  const resetDraft = () => setDraft(settingsDraftFromConfig(config!));

  async function save(opts: { restart?: boolean } = {}) {
    if (!hasUnsavedChanges) return;
    setSaving(true);
    try {
      const next = await window.beside.saveConfigPatch(configPatchFromDraft(draft!));
      onSaved(next);
      if (opts.restart) { await window.beside.stopRuntime(); await window.beside.startRuntime(); toast.success('Settings saved & runtime restarted'); }
      else toast.success('Settings saved', { description: 'Some changes apply on next start.' });
    } catch (err: any) { toast.error('Could not save settings', { description: err.message || String(err) }); }
    finally { setSaving(false); }
  }

  return (
    <div className="flex flex-col gap-6 pt-6 pb-24">
      <PageHeader title="Settings" description="Make Beside work the way you like." actions={<><Button variant="outline" size="sm" onClick={() => window.beside.openPath('config')}><FolderOpen />Open config</Button><Button variant="outline" size="sm" onClick={() => window.beside.openPath('data')}><FolderOpen />Open data</Button></>} />
      
      <Tabs defaultValue="general" className="flex flex-col gap-4">
        <TabsList className="h-auto flex-wrap justify-start self-start">
          {['general', 'permissions', 'capture', 'privacy', 'storage', 'ai', 'audio', 'index', 'export', 'system'].map((v: any) => <TabsTrigger key={v} value={v}>{v.charAt(0).toUpperCase() + v.slice(1)}</TabsTrigger>)}
        </TabsList>

        <TabsContent value="general" className="flex flex-col gap-4">
          <SettingsSection title="Launch and appearance" description="Set how the app starts and how the interface looks.">
            <ToggleRow title="Open at startup" description="Beside opens quietly in the background." typeLabel="boolean" checked={!!startAtLogin} onChange={(v: any) => { setStartAtLogin(v); window.beside.setStartAtLogin(v).then(setStartAtLogin); }} />
            <Separator className="my-4" />
            <div className="flex flex-col gap-3"><div><h4 className="font-medium">Appearance</h4><p className="text-sm text-muted-foreground mt-0.5">Pick a theme.</p></div><ThemePicker value={themePreference} onChange={setThemePreference} /></div>
          </SettingsSection>
          <SettingsSection title="App configuration" description="Identity, data location, and logging.">
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField label="App name" value={draft.appName} onChange={(v: any) => set('appName', v)} typeLabel="string" hint="Used in logs." />
              <SelectField label="Log level" value={draft.logLevel} onChange={(v: any) => set('logLevel', v)} typeLabel="enum" options={[{ value: 'debug', label: 'Debug' }, { value: 'info', label: 'Info' }, { value: 'warn', label: 'Warn' }, { value: 'error', label: 'Error' }]} />
              <TextField label="Data directory" value={draft.appDataDir} onChange={(v: any) => set('appDataDir', v)} typeLabel="path" hint="Restart after changing." />
              <TextField label="Session ID" value={draft.sessionId} onChange={(v: any) => set('sessionId', v)} typeLabel="string" hint="Optional." />
            </div>
          </SettingsSection>
        </TabsContent>

        <TabsContent value="permissions" className="flex flex-col gap-4"><PermissionsSettingsPanel /></TabsContent>

        <TabsContent value="capture" className="flex flex-col gap-4">
          <SettingsSection title="Capture cadence" description="Control how often Beside looks for changes.">
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField label="Capture plugin" value={draft.capturePlugin} onChange={(v: any) => set('capturePlugin', v)} typeLabel="string" />
              <NumberField label="Poll interval" value={draft.pollIntervalMs} onChange={(v: any) => set('pollIntervalMs', v)} min={1} step={100} unit="ms" typeLabel="integer" />
              <NumberField label="Idle poll interval" value={draft.idlePollIntervalMs} onChange={(v: any) => set('idlePollIntervalMs', v)} min={1} step={1000} unit="ms" typeLabel="integer" />
              <NumberField label="Focus settle delay" value={draft.focusSettleDelayMs} onChange={(v: any) => set('focusSettleDelayMs', v)} min={0} step={50} unit="ms" typeLabel="integer" />
              <NumberField label="Visual change threshold" value={draft.screenshotDiffThreshold} onChange={(v: any) => set('screenshotDiffThreshold', v)} min={0} max={1} step={0.01} typeLabel="number" />
              <NumberField label="Idle threshold" value={draft.idleThresholdSec} onChange={(v: any) => set('idleThresholdSec', v)} min={1} step={5} unit="sec" typeLabel="integer" />
            </div>
          </SettingsSection>
          <SettingsSection title="Screenshot encoding" description="Balance file size, readability, and compatibility.">
            <div className="grid gap-4 sm:grid-cols-2">
              <SelectField label="Screenshot format" value={draft.screenshotFormat} onChange={(v: any) => set('screenshotFormat', v)} typeLabel="enum" options={[{ value: 'webp', label: 'WebP' }, { value: 'jpeg', label: 'JPEG' }]} />
              <NumberField label="Screenshot quality" value={draft.screenshotQuality} onChange={(v: any) => set('screenshotQuality', v)} min={1} max={100} step={1} typeLabel="integer" />
              <NumberField label="Max screenshot dimension" value={draft.screenshotMaxDim} onChange={(v: any) => set('screenshotMaxDim', v)} min={0} max={8192} step={50} unit="px" typeLabel="integer" />
              <NumberField label="Content-change throttle" value={draft.contentChangeMinIntervalMs} onChange={(v: any) => set('contentChangeMinIntervalMs', v)} min={0} step={1000} unit="ms" typeLabel="integer" />
            </div>
          </SettingsSection>
          <SettingsSection title="Displays and ignore rules" description="Choose screens and apps eligible for capture.">
            <ToggleRow title="Capture multiple displays" description="Record more than the primary display." typeLabel="boolean" checked={draft.multiScreen} onChange={(v: any) => set('multiScreen', v)} />
            <Separator className="my-4" />
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField label="Screen indexes" value={draft.screens} onChange={(v: any) => set('screens', v)} typeLabel="integer list" hint="e.g. 0, 1" />
              <SelectField label="Multi-display mode" value={draft.captureMode} onChange={(v: any) => set('captureMode', v)} typeLabel="enum" options={[{ value: 'active', label: 'Active display' }, { value: 'all', label: 'All displays' }]} />
              <TextAreaField label="Apps to ignore" value={draft.excludedApps} onChange={(v: any) => set('excludedApps', v)} typeLabel="string list" hint="One app per line." />
              <TextAreaField label="URLs to ignore" value={draft.excludedUrlPatterns} onChange={(v: any) => set('excludedUrlPatterns', v)} typeLabel="string list" hint="One domain/path per line." />
            </div>
          </SettingsSection>
        </TabsContent>

        <TabsContent value="privacy" className="flex flex-col gap-4">
          <SettingsSection title="Redaction and lock behavior" description="Guardrails to keep sensitive content out.">
            <ToggleRow title="Blur password fields" description="Skip password boxes." typeLabel="boolean" checked={draft.blurPasswordFields} onChange={(v: any) => set('blurPasswordFields', v)} />
            <Separator className="my-4" /><ToggleRow title="Pause when screen is locked" description="Stop capturing when away." typeLabel="boolean" checked={draft.pauseOnScreenLock} onChange={(v: any) => set('pauseOnScreenLock', v)} />
            <Separator className="my-4" /><TextAreaField label="Words to skip" value={draft.sensitiveKeywords} onChange={(v: any) => set('sensitiveKeywords', v)} typeLabel="string list" hint="One keyword per line." />
          </SettingsSection>
          <SettingsSection title="Accessibility text" description="Use macOS Accessibility for accurate text reading.">
            <ToggleRow title="Read visible app text" description="Add Accessibility text to screenshots." typeLabel="boolean" checked={draft.accessibilityEnabled} onChange={(v: any) => set('accessibilityEnabled', v)} />
            <Separator className="my-4" />
            <div className="grid gap-4 sm:grid-cols-2">
              <NumberField label="Accessibility timeout" value={draft.accessibilityTimeoutMs} onChange={(v: any) => set('accessibilityTimeoutMs', v)} min={1} step={100} unit="ms" typeLabel="integer" />
              <NumberField label="Maximum text characters" value={draft.accessibilityMaxChars} onChange={(v: any) => set('accessibilityMaxChars', v)} min={1} step={500} typeLabel="integer" />
              <NumberField label="Maximum UI elements" value={draft.accessibilityMaxElements} onChange={(v: any) => set('accessibilityMaxElements', v)} min={1} step={250} typeLabel="integer" />
              <TextAreaField label="Apps to ignore" value={draft.accessibilityExcludedApps} onChange={(v: any) => set('accessibilityExcludedApps', v)} typeLabel="string list" hint="One app per line." />
            </div>
          </SettingsSection>
          <DangerZone />
        </TabsContent>

        <TabsContent value="storage" className="flex flex-col gap-4">
          <SettingsSection title="Storage root and limits" description="Decide where memory lives.">
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField label="Storage plugin" value={draft.storagePlugin} onChange={(v: any) => set('storagePlugin', v)} typeLabel="string" />
              <TextField label="Storage path" value={draft.storagePath} onChange={(v: any) => set('storagePath', v)} typeLabel="path" />
              <NumberField label="Maximum space" value={draft.maxSizeGb} onChange={(v: any) => set('maxSizeGb', v)} min={0.1} step={1} unit="GB" typeLabel="number" />
              <NumberField label="Keep memories for" value={draft.retentionDays} onChange={(v: any) => set('retentionDays', v)} min={0} step={1} unit="days" typeLabel="integer" />
            </div>
          </SettingsSection>
          <SettingsSection title="Screenshot vacuum" description="Downsize or remove old screenshot files.">
            <div className="grid gap-4 sm:grid-cols-2">
              <OptionalNumberField label="Compress after (min)" value={draft.compressAfterMinutes} onChange={(v: any) => set('compressAfterMinutes', v)} min={0} step={15} typeLabel="integer" />
              <NumberField label="Compress after (days)" value={draft.compressAfterDays} onChange={(v: any) => set('compressAfterDays', v)} min={0} step={1} typeLabel="integer" />
              <NumberField label="Compressed quality" value={draft.compressQuality} onChange={(v: any) => set('compressQuality', v)} min={1} max={100} step={1} typeLabel="integer" />
              <OptionalNumberField label="Thumbnail after (min)" value={draft.thumbnailAfterMinutes} onChange={(v: any) => set('thumbnailAfterMinutes', v)} min={0} step={60} typeLabel="integer" />
              <NumberField label="Thumbnail after (days)" value={draft.thumbnailAfterDays} onChange={(v: any) => set('thumbnailAfterDays', v)} min={0} step={1} typeLabel="integer" />
              <NumberField label="Thumbnail max dim" value={draft.thumbnailMaxDim} onChange={(v: any) => set('thumbnailMaxDim', v)} min={64} max={2048} step={16} unit="px" typeLabel="integer" />
              <OptionalNumberField label="Delete after (min)" value={draft.deleteAfterMinutes} onChange={(v: any) => set('deleteAfterMinutes', v)} min={0} step={60} typeLabel="integer" />
              <NumberField label="Delete after (days)" value={draft.deleteAfterDays} onChange={(v: any) => set('deleteAfterDays', v)} min={0} step={1} typeLabel="integer" />
              <NumberField label="Vacuum interval (min)" value={draft.vacuumTickIntervalMin} onChange={(v: any) => set('vacuumTickIntervalMin', v)} min={1} step={1} typeLabel="integer" />
              <NumberField label="Vacuum batch size" value={draft.vacuumBatchSize} onChange={(v: any) => set('vacuumBatchSize', v)} min={1} step={10} typeLabel="integer" />
            </div>
          </SettingsSection>
        </TabsContent>

        <TabsContent value="ai" className="flex flex-col gap-4">
          <ModelSettings savedModel={config.config.index.model.ollama?.model ?? ''} savedRevision={config.config.index.model.ollama?.model_revision ?? 1} ollamaHost={draft.ollamaHost} ollamaAutoInstall={draft.ollamaAutoInstall} modelReady={overview?.model.ready ?? false} bootstrapEvents={bootstrapEvents} onClearBootstrapEvents={onClearBootstrapEvents} onHostChange={(v: any) => set('ollamaHost', v)} onAutoInstallChange={(v: any) => set('ollamaAutoInstall', v)} onModelChanged={onSaved} />
          <SettingsSection title="Provider and internals" description="Configure adapter, embeddings, and API fallbacks.">
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField label="Model provider" value={draft.modelPlugin} onChange={(v: any) => set('modelPlugin', v)} typeLabel="string" hint="ollama, openai, claude." />
              <TextField label="Embedding model" value={draft.ollamaEmbeddingModel} onChange={(v: any) => set('ollamaEmbeddingModel', v)} typeLabel="string" />
              <TextField label="Vision model" value={draft.ollamaVisionModel} onChange={(v: any) => set('ollamaVisionModel', v)} typeLabel="string" placeholder="optional" />
              <TextField label="Indexer model" value={draft.ollamaIndexerModel} onChange={(v: any) => set('ollamaIndexerModel', v)} typeLabel="string" placeholder="optional" />
              <TextField label="Ollama keep alive" value={draft.ollamaKeepAlive} onChange={(v: any) => set('ollamaKeepAlive', v)} typeLabel="string | number" />
              <NumberField label="Unload after idle" value={draft.ollamaUnloadAfterIdleMin} onChange={(v: any) => set('ollamaUnloadAfterIdleMin', v)} min={0} step={1} unit="min" typeLabel="number" />
              <NumberField label="Model revision" value={draft.ollamaModelRevision} onChange={(v: any) => set('ollamaModelRevision', v)} min={0} step={1} typeLabel="integer" />
              <TextField label="OpenAI API key" value={draft.openaiApiKey} onChange={(v: any) => set('openaiApiKey', v)} typeLabel="secret string" inputType="password" placeholder="optional" />
              <TextField label="OpenAI base URL" value={draft.openaiBaseUrl} onChange={(v: any) => set('openaiBaseUrl', v)} typeLabel="URL" />
              <TextField label="OpenAI chat model" value={draft.openaiModel} onChange={(v: any) => set('openaiModel', v)} typeLabel="string" />
              <TextField label="Claude API key" value={draft.claudeApiKey} onChange={(v: any) => set('claudeApiKey', v)} typeLabel="secret string" inputType="password" placeholder="optional" />
              <TextField label="Claude model" value={draft.claudeModel} onChange={(v: any) => set('claudeModel', v)} typeLabel="string" />
            </div>
          </SettingsSection>
        </TabsContent>

        <TabsContent value="audio">
          <AudioSettings d={draft} set={set} />
        </TabsContent>

        <TabsContent value="index" className="flex flex-col gap-4">
          <SettingsSection title="Organization schedule" description="Control index and background updates.">
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField label="Index strategy" value={draft.indexStrategy} onChange={(v: any) => set('indexStrategy', v)} typeLabel="string" />
              <TextField label="Index path" value={draft.indexPath} onChange={(v: any) => set('indexPath', v)} typeLabel="path" />
              <NumberField label="Incremental interval" value={draft.incrementalIntervalMin} onChange={(v: any) => set('incrementalIntervalMin', v)} min={1} step={1} unit="min" typeLabel="integer" />
              <TextField label="Reorganize schedule" value={draft.reorganiseSchedule} onChange={(v: any) => set('reorganiseSchedule', v)} typeLabel="cron string" />
              <NumberField label="Idle trigger" value={draft.indexIdleTriggerMin} onChange={(v: any) => set('indexIdleTriggerMin', v)} min={1} step={1} unit="min" typeLabel="integer" />
              <NumberField label="Index batch size" value={draft.indexBatchSize} onChange={(v: any) => set('indexBatchSize', v)} min={1} step={10} typeLabel="integer" />
            </div>
            <Separator className="my-4" />
            <ToggleRow title="Reorganize while idle" description="Run expensive index work when idle." typeLabel="boolean" checked={draft.reorganiseOnIdle} onChange={(v: any) => set('reorganiseOnIdle', v)} />
          </SettingsSection>
          <SettingsSection title="Sessions and meetings" description="Tune session builders.">
            <div className="grid gap-4 sm:grid-cols-2">
              <NumberField label="Session idle gap" value={draft.sessionsIdleThresholdSec} onChange={(v: any) => set('sessionsIdleThresholdSec', v)} min={1} step={30} unit="sec" typeLabel="integer" />
              <NumberField label="AFK marker threshold" value={draft.sessionsAfkThresholdSec} onChange={(v: any) => set('sessionsAfkThresholdSec', v)} min={1} step={30} unit="sec" typeLabel="integer" />
              <NumberField label="Minimum active time" value={draft.sessionsMinActiveMs} onChange={(v: any) => set('sessionsMinActiveMs', v)} min={0} step={1000} unit="ms" typeLabel="integer" />
              <NumberField label="Fallback frame attention" value={draft.sessionsFallbackFrameAttentionMs} onChange={(v: any) => set('sessionsFallbackFrameAttentionMs', v)} min={1} step={1000} unit="ms" typeLabel="integer" />
              <NumberField label="Meeting idle gap" value={draft.meetingsIdleThresholdSec} onChange={(v: any) => set('meetingsIdleThresholdSec', v)} min={1} step={30} unit="sec" typeLabel="integer" />
              <NumberField label="Minimum meeting duration" value={draft.meetingsMinDurationSec} onChange={(v: any) => set('meetingsMinDurationSec', v)} min={0} step={30} unit="sec" typeLabel="integer" />
              <NumberField label="Audio grace window" value={draft.meetingsAudioGraceSec} onChange={(v: any) => set('meetingsAudioGraceSec', v)} min={0} step={10} unit="sec" typeLabel="integer" />
              <NumberField label="Summary cooldown" value={draft.meetingsSummarizeCooldownSec} onChange={(v: any) => set('meetingsSummarizeCooldownSec', v)} min={0} step={30} unit="sec" typeLabel="integer" />
              <NumberField label="Vision attachments" value={draft.meetingsVisionAttachments} onChange={(v: any) => set('meetingsVisionAttachments', v)} min={0} step={1} typeLabel="integer" />
            </div>
            <Separator className="my-4" />
            <ToggleRow title="Summarize meetings" description="Generate TL;DR via model." typeLabel="boolean" checked={draft.meetingsSummarize} onChange={(v: any) => set('meetingsSummarize', v)} />
          </SettingsSection>
          <SettingsSection title="Semantic embeddings" description="Blend vector search with keyword search.">
            <ToggleRow title="Generate embeddings" description="Create semantic vectors." typeLabel="boolean" checked={draft.embeddingsEnabled} onChange={(v: any) => set('embeddingsEnabled', v)} />
            <Separator className="my-4" />
            <div className="grid gap-4 sm:grid-cols-2">
              <NumberField label="Batch size" value={draft.embeddingsBatchSize} onChange={(v: any) => set('embeddingsBatchSize', v)} min={1} step={1} typeLabel="integer" />
              <NumberField label="Interval" value={draft.embeddingsTickIntervalMin} onChange={(v: any) => set('embeddingsTickIntervalMin', v)} min={1} step={1} unit="min" typeLabel="integer" />
              <NumberField label="Weight" value={draft.embeddingsSearchWeight} onChange={(v: any) => set('embeddingsSearchWeight', v)} min={0.01} step={0.05} typeLabel="number" />
            </div>
          </SettingsSection>
        </TabsContent>

        <TabsContent value="export" className="flex flex-col gap-4">
          <SettingsSection title="Markdown export" description="Mirror pages to Markdown files.">
            <ToggleRow title="Enable Markdown export" description="Writes journals to folder." typeLabel="boolean" checked={draft.markdownEnabled} onChange={(v: any) => set('markdownEnabled', v)} />
            <Separator className="my-4" />
            <TextField label="Folder path" value={draft.markdownPath} onChange={(v: any) => set('markdownPath', v)} typeLabel="path" />
          </SettingsSection>
          <SettingsSection title="AI app connection" description="Configure built-in MCP server.">
            <ToggleRow title="Enable MCP server" description="Exposes memory tools." typeLabel="boolean" checked={draft.mcpEnabled} onChange={(v: any) => set('mcpEnabled', v)} />
            <Separator className="my-4" />
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField label="Host" value={draft.mcpHost} onChange={(v: any) => set('mcpHost', v)} typeLabel="string" />
              <NumberField label="Port" value={draft.mcpPort} onChange={(v: any) => set('mcpPort', v)} min={1} max={65535} step={1} typeLabel="integer" />
              <SelectField label="Transport" value={draft.mcpTransport} onChange={(v: any) => set('mcpTransport', v)} typeLabel="enum" options={[{ value: 'http', label: 'HTTP' }, { value: 'stdio', label: 'stdio' }]} />
              <NumberField label="Text excerpt chars" value={draft.mcpTextExcerptChars} onChange={(v: any) => set('mcpTextExcerptChars', v)} min={0} step={500} typeLabel="integer" />
            </div>
          </SettingsSection>
        </TabsContent>

        <TabsContent value="system" className="flex flex-col gap-4">
          <SettingsSection title="Background work" description="Decide when expensive model work runs.">
            <SelectField label="Background jobs" value={draft.backgroundModelJobs} onChange={(v: any) => set('backgroundModelJobs', v)} typeLabel="enum" options={[{ value: 'manual', label: 'Manual' }, { value: 'scheduled', label: 'Scheduled' }]} />
          </SettingsSection>
          <SettingsSection title="Load guard" description="Pause heavy work when busy.">
            <ToggleRow title="Enable load guard" description="Defers OCR, Whisper, embeddings, etc." typeLabel="boolean" checked={draft.loadGuardEnabled} onChange={(v: any) => set('loadGuardEnabled', v)} />
            <Separator className="my-4" />
            <div className="grid gap-4 sm:grid-cols-2">
              <NumberField label="CPU load threshold" value={draft.loadGuardThreshold} onChange={(v: any) => set('loadGuardThreshold', v)} min={0.01} max={8} step={0.05} typeLabel="number" />
              <NumberField label="Memory threshold" value={draft.loadGuardMemoryThreshold} onChange={(v: any) => set('loadGuardMemoryThreshold', v)} min={0.01} max={1} step={0.01} typeLabel="number" />
              <NumberField label="Low-battery threshold" value={draft.loadGuardLowBatteryThresholdPct} onChange={(v: any) => set('loadGuardLowBatteryThresholdPct', v)} min={0} max={100} step={1} unit="%" typeLabel="integer" />
              <NumberField label="Max consecutive skips" value={draft.loadGuardMaxConsecutiveSkips} onChange={(v: any) => set('loadGuardMaxConsecutiveSkips', v)} min={0} step={1} typeLabel="integer" />
            </div>
          </SettingsSection>
        </TabsContent>
      </Tabs>

      <SaveBar hasUnsavedChanges={hasUnsavedChanges} saving={saving} onSave={() => save()} onSaveAndRestart={() => save({ restart: true })} onReset={resetDraft} />
    </div>
  );
}

function AudioSettings({ d, set }: { d: any; set: any }) {
  const [whisper, setWhisper] = React.useState<any>(null), [ffprobe, setFfprobe] = React.useState<any>(null), [mic, setMic] = React.useState<any>(null), [refreshing, setRefreshing] = React.useState(false);
  const refreshProbes = React.useCallback(async () => {
    setRefreshing(true);
    try { setWhisper(await window.beside.probeWhisper()); setFfprobe(await window.beside.probeFfprobe()); setMic(await window.beside.probeMicPermission()); } catch {} finally { setRefreshing(false); }
  }, []);
  React.useEffect(() => { refreshProbes(); }, [refreshProbes]);

  return (
    <div className="flex flex-col gap-4">
      <Card><CardContent className="flex flex-col gap-0">
        <ToggleRow title="Process audio" description="Transcribe with Whisper." typeLabel="boolean" checked={d.captureAudio} onChange={(v: any) => { set('captureAudio', v); if (!v) set('liveRecordingEnabled', false); else if (d.liveRecordingEnabled && d.capturePlugin !== 'native') set('capturePlugin', 'native'); }} />
        {d.captureAudio && (
          <>
            {d.liveRecordingEnabled && d.capturePlugin !== 'native' && <><Separator className="my-4" /><Alert><AlertTriangle className="size-4" /><AlertTitle>Native capture required</AlertTitle><AlertDescription>Live audio requires native plugin.</AlertDescription></Alert></>}
            <Separator className="my-4" /><ToggleRow title="Live microphone recording" description="Record chunks while in use." typeLabel="boolean" checked={d.liveRecordingEnabled} onChange={(v: any) => { set('liveRecordingEnabled', v); if (v) { set('captureAudio', true); if (d.capturePlugin !== 'native') set('capturePlugin', 'native'); } }} />
            <Separator className="my-4" />
            <div className="grid gap-4 sm:grid-cols-2">
              <SelectField label="Whisper model" value={d.whisperModel} onChange={(v: any) => set('whisperModel', v)} options={[{ value: 'tiny', label: 'tiny' }, { value: 'base', label: 'base' }, { value: 'small', label: 'small' }, { value: 'medium', label: 'medium' }]} />
              <SelectField label="Remote audio backend" value={d.systemAudioBackend} onChange={(v: any) => set('systemAudioBackend', v)} options={[{ value: 'core_audio_tap', label: 'Core Audio' }, { value: 'off', label: 'Mic only' }, { value: 'screencapturekit', label: 'ScreenCaptureKit' }]} />
              <NumberField label="Chunk length (sec)" value={d.chunkSeconds} onChange={(v: any) => set('chunkSeconds', v)} min={1} step={30} />
              <SelectField label="Format" value={d.liveRecordingFormat} onChange={(v: any) => set('liveRecordingFormat', v)} options={[{ value: 'm4a', label: 'm4a' }]} />
              <NumberField label="Sample rate" value={d.liveRecordingSampleRate} onChange={(v: any) => set('liveRecordingSampleRate', v)} min={1} step={1000} />
              <NumberField label="Channels" value={d.liveRecordingChannels} onChange={(v: any) => set('liveRecordingChannels', v)} min={1} max={2} step={1} />
              <NumberField label="Input poll interval" value={d.liveRecordingPollIntervalSec} onChange={(v: any) => set('liveRecordingPollIntervalSec', v)} min={1} step={1} />
            </div>
            <Separator className="my-4" /><ToggleRow title="Delete audio after transcribing" description="Keep transcript, delete raw audio." typeLabel="boolean" checked={d.deleteAudioAfterTranscribe} onChange={(v: any) => set('deleteAudioAfterTranscribe', v)} />
            <Separator className="my-4" />
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField label="Inbox path" value={d.audioInboxPath} onChange={(v: any) => set('audioInboxPath', v)} />
              <TextField label="Processed path" value={d.audioProcessedPath} onChange={(v: any) => set('audioProcessedPath', v)} />
              <TextField label="Failed path" value={d.audioFailedPath} onChange={(v: any) => set('audioFailedPath', v)} />
              <NumberField label="Worker interval" value={d.audioTickIntervalSec} onChange={(v: any) => set('audioTickIntervalSec', v)} min={1} step={5} />
              <NumberField label="Batch size" value={d.audioBatchSize} onChange={(v: any) => set('audioBatchSize', v)} min={1} step={1} />
              <TextField label="Whisper command" value={d.whisperCommand} onChange={(v: any) => set('whisperCommand', v)} />
              <TextField label="Language" value={d.whisperLanguage} onChange={(v: any) => set('whisperLanguage', v)} placeholder="optional" />
              <NumberField label="Max file bytes" value={d.maxAudioBytes} onChange={(v: any) => set('maxAudioBytes', v)} min={0} step={1024*1024} />
              <NumberField label="Min bytes/sec" value={d.minAudioBytesPerSec} onChange={(v: any) => set('minAudioBytesPerSec', v)} min={0} step={512} />
              <NumberField label="Min rate-check length (ms)" value={d.minAudioRateCheckMs} onChange={(v: any) => set('minAudioRateCheckMs', v)} min={0} step={500} />
            </div>
          </>
        )}
      </CardContent></Card>
      
      <Card><CardContent className="flex flex-col gap-3">
        <div className="flex justify-between items-center"><div className="flex items-center gap-3"><div className="size-8 grid place-items-center bg-primary/10 text-primary rounded-md"><Mic className="size-4" /></div><div><h4 className="font-medium">Status</h4></div></div><Button size="sm" variant="outline" onClick={refreshProbes} disabled={refreshing}>{refreshing ? <Loader2 className="animate-spin" /> : <RefreshCw />} Re-check</Button></div>
        <div className="flex flex-col gap-2">
          <div className="p-3 border rounded-md bg-muted/30"><div className="text-sm font-medium">Whisper</div><div className="text-xs text-muted-foreground">{whisper ? (whisper.available ? whisper.path : 'Not found') : 'Checking...'}</div></div>
          <div className="p-3 border rounded-md bg-muted/30"><div className="text-sm font-medium">ffprobe</div><div className="text-xs text-muted-foreground">{ffprobe ? (ffprobe.available ? ffprobe.path : 'Missing') : 'Checking...'}</div></div>
        </div>
      </CardContent></Card>
    </div>
  );
}

function PermissionsSettingsPanel() {
  const [st, setSt] = React.useState<any>({});
  const refresh = React.useCallback(async () => {
    try { setSt({ s: await window.beside.probeScreenPermission(), a: await window.beside.probeAccessibilityPermission(), m: await window.beside.probeMicPermission() }); } catch {}
  }, []);
  React.useEffect(() => { refresh(); const t = setInterval(refresh, 2500); return () => clearInterval(t); }, [refresh]);
  const req = async (k: string) => { await (window.beside as any)[`request${k}Permission`](); refresh(); };
  
  if (st.s?.status === 'unsupported' && st.a?.status === 'unsupported' && st.m?.status === 'unsupported') return <SettingsSection title="System permissions"><p className="text-sm">Not applicable.</p></SettingsSection>;
  return (
    <SettingsSection title="System permissions" description="macOS settings.">
      <div className="flex flex-col gap-3">
        {st.s?.status !== 'unsupported' && <div className="p-4 border rounded-lg bg-card"><div className="font-medium text-sm">Screen Recording {st.s?.status === 'granted' && <Check className="inline size-4 text-success" />}</div><Button size="sm" onClick={() => req('Screen')}>Request</Button></div>}
        {st.a?.status !== 'unsupported' && <div className="p-4 border rounded-lg bg-card"><div className="font-medium text-sm">Accessibility {st.a?.status === 'granted' && <Check className="inline size-4 text-success" />}</div><Button size="sm" onClick={() => req('Accessibility')}>Request</Button></div>}
      </div>
    </SettingsSection>
  );
}

function ModelSettings({ savedModel, savedRevision, ollamaHost, ollamaAutoInstall, modelReady, bootstrapEvents, onClearBootstrapEvents, onHostChange, onAutoInstallChange, onModelChanged }: any) {
  const [pid, setPid] = React.useState(savedModel || MODEL_CHOICES[0]!.id), [tag, setTag] = React.useState(savedModel), [ph, setPh] = React.useState<'idle'|'running'|'done'|'error'>('idle');
  const apply = async () => { setPh('running'); onClearBootstrapEvents(); try { const n = await window.beside.saveConfigPatch({ index: { model: { plugin: 'ollama', ollama: { model: pid === '__custom__' ? tag : pid, model_revision: savedRevision + 1, auto_install: true } } } }); onModelChanged(n); await window.beside.updateModel(); setPh('done'); toast.success('Switched.'); } catch (e: any) { setPh('error'); toast.error(e.message); } };
  return (
    <Card><CardContent className="flex flex-col gap-4">
      <div className="flex items-center gap-3"><div className="size-10 grid place-items-center bg-primary/10 text-primary rounded-md"><Cpu className="size-5" /></div><div className="flex-1"><h3 className="font-semibold">Local AI model</h3><p className="text-sm font-mono text-muted-foreground">{savedModel}</p></div><Button onClick={apply} disabled={ph === 'running'}><Download /> Apply model</Button></div>
      <Separator />
      <RadioGroup value={pid} onValueChange={setPid} className="grid gap-2 sm:grid-cols-2">{MODEL_CHOICES.map(m => <Label key={m.id} className={cn('p-3 border rounded-md cursor-pointer flex gap-3', pid === m.id && 'border-primary ring-2 ring-primary/20')}><RadioGroupItem value={m.id} /><div className="font-medium text-sm">{m.name}</div></Label>)}</RadioGroup>
    </CardContent></Card>
  );
}

function DangerZone() {
  const [txt, setTxt] = React.useState(''), [op, setOp] = React.useState(false);
  const del = async () => { try { await window.beside.deleteAllMemory(); setOp(false); setTxt(''); toast.success('Deleted'); } catch (e: any) { toast.error(e.message); } };
  return (
    <Card className="border-destructive/40 bg-destructive/5"><CardContent className="flex flex-col gap-3">
      <div className="flex items-start gap-3"><div className="size-8 grid place-items-center bg-destructive/15 text-destructive rounded-md"><AlertTriangle className="size-4" /></div><div><h4 className="font-medium text-destructive">Delete all my memory</h4></div></div>
      <AlertDialog open={op} onOpenChange={setOp}><AlertDialogTrigger asChild><Button variant="destructive"><Trash2 /> Delete everything...</Button></AlertDialogTrigger><AlertDialogContent><AlertDialogTitle>Delete?</AlertDialogTitle><AlertDialogDescription>Type DELETE to confirm.</AlertDialogDescription><Input value={txt} onChange={e => setTxt(e.target.value)} /><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={del} disabled={txt !== 'DELETE'}>Confirm</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    </CardContent></Card>
  );
}

function ThemePicker({ value, onChange }: { value: ThemePreference; onChange: (v: ThemePreference) => void }) {
  const o = [{ id: 'auto' as const, label: 'Auto', icon: <Monitor /> }, { id: 'light' as const, label: 'Light', icon: <Sun /> }, { id: 'dark' as const, label: 'Dark', icon: <Moon /> }];
  return <RadioGroup value={value} onValueChange={v => onChange(v as ThemePreference)} className="grid grid-cols-3 gap-2">{o.map(x => <Label key={x.id} className={cn('flex flex-col items-center gap-1.5 p-3 border rounded-lg cursor-pointer', value === x.id ? 'border-primary ring-2 ring-primary/20' : 'hover:bg-accent/40')}><RadioGroupItem value={x.id} className="sr-only" /><div className="size-8 grid place-items-center text-muted-foreground [&>svg]:size-4">{x.icon}</div><span className="font-medium">{x.label}</span></Label>)}</RadioGroup>;
}
