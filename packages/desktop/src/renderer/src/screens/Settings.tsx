import * as React from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Cpu,
  Download,
  ExternalLink,
  FolderOpen,
  HelpCircle,
  Keyboard,
  Loader2,
  Mic,
  Monitor,
  Moon,
  Power,
  RefreshCw,
  Save,
  Shield,
  Sparkles,
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Separator } from '@/components/ui/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/sonner';
import { PageHeader } from '@/components/PageHeader';
import { StatusPill } from '@/components/StatusPill';
import { formatBytes } from '@/lib/format';
import { formatBootstrapLine, pullPercent } from '@/lib/bootstrap-phases';
import {
  MODEL_CHOICES,
  findModelChoice,
  isPlausibleOllamaTag,
} from '@/lib/model-catalog';
import { useTheme, type ThemePreference } from '@/lib/theme';
import { cn } from '@/lib/utils';
import type {
  AccessibilityPermission,
  LoadedConfig,
  MicPermission,
  ModelBootstrapProgress,
  RuntimeOverview,
  ScreenPermission,
  WhisperProbe,
} from '@/global';

type BackgroundModelJobs = 'manual' | 'scheduled';
type CaptureMode = 'active' | 'all';
type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type ScreenshotFormat = 'webp' | 'jpeg';
type SystemAudioBackend = 'core_audio_tap' | 'screencapturekit' | 'off';
type LiveRecordingFormat = 'm4a';
type McpTransport = 'http' | 'stdio';

interface SettingsDraft {
  // App
  appName: string;
  appDataDir: string;
  logLevel: LogLevel;
  sessionId: string;
  // Capture
  capturePlugin: string;
  pollIntervalMs: number;
  idlePollIntervalMs: number;
  focusSettleDelayMs: number;
  screenshotDiffThreshold: number;
  idleThresholdSec: number;
  screenshotFormat: ScreenshotFormat;
  screenshotQuality: number;
  jpegQuality: string;
  screenshotMaxDim: number;
  contentChangeMinIntervalMs: number;
  multiScreen: boolean;
  screens: string;
  captureMode: CaptureMode;
  blurPasswordFields: boolean;
  pauseOnScreenLock: boolean;
  sensitiveKeywords: string;
  excludedApps: string;
  excludedUrlPatterns: string;
  accessibilityEnabled: boolean;
  accessibilityTimeoutMs: number;
  accessibilityMaxChars: number;
  accessibilityMaxElements: number;
  accessibilityExcludedApps: string;
  // Storage
  storagePlugin: string;
  storagePath: string;
  maxSizeGb: number;
  retentionDays: number;
  compressAfterDays: number;
  compressAfterMinutes: string;
  compressQuality: number;
  thumbnailAfterDays: number;
  thumbnailAfterMinutes: string;
  thumbnailMaxDim: number;
  deleteAfterDays: number;
  deleteAfterMinutes: string;
  vacuumTickIntervalMin: number;
  vacuumBatchSize: number;
  // Index
  indexStrategy: string;
  indexPath: string;
  incrementalIntervalMin: number;
  reorganiseSchedule: string;
  reorganiseOnIdle: boolean;
  indexIdleTriggerMin: number;
  indexBatchSize: number;
  sessionsIdleThresholdSec: number;
  sessionsAfkThresholdSec: number;
  sessionsMinActiveMs: number;
  sessionsFallbackFrameAttentionMs: number;
  meetingsIdleThresholdSec: number;
  meetingsMinDurationSec: number;
  meetingsAudioGraceSec: number;
  meetingsSummarize: boolean;
  meetingsSummarizeCooldownSec: number;
  meetingsVisionAttachments: number;
  embeddingsEnabled: boolean;
  embeddingsBatchSize: number;
  embeddingsTickIntervalMin: number;
  embeddingsSearchWeight: number;
  // Model / AI
  modelPlugin: string;
  // Model selection is owned by the dedicated picker in the AI tab and
  // saved/applied via its own action (see ModelSettings below). We
  // intentionally do NOT include it in this generic draft so the
  // global SaveBar can't quietly trigger a model swap or re-pull as a
  // side-effect of saving e.g. a sensitive_keywords change.
  ollamaHost: string;
  ollamaAutoInstall: boolean;
  ollamaEmbeddingModel: string;
  ollamaVisionModel: string;
  ollamaIndexerModel: string;
  ollamaKeepAlive: string;
  ollamaUnloadAfterIdleMin: number;
  ollamaModelRevision: number;
  openaiApiKey: string;
  openaiBaseUrl: string;
  openaiModel: string;
  openaiVisionModel: string;
  openaiEmbeddingModel: string;
  claudeApiKey: string;
  claudeModel: string;
  // Export
  markdownEnabled: boolean;
  markdownPath: string;
  mcpEnabled: boolean;
  mcpHost: string;
  mcpPort: number;
  mcpTransport: McpTransport;
  mcpTextExcerptChars: number;
  extraExportPlugins: Array<Record<string, unknown> & { name: string; enabled?: boolean }>;
  // Audio
  captureAudio: boolean;
  whisperModel: string;
  audioInboxPath: string;
  audioProcessedPath: string;
  audioFailedPath: string;
  audioTickIntervalSec: number;
  audioBatchSize: number;
  whisperCommand: string;
  whisperLanguage: string;
  maxAudioBytes: number;
  minAudioBytesPerSec: number;
  minAudioRateCheckMs: number;
  liveRecordingEnabled: boolean;
  liveRecordingFormat: LiveRecordingFormat;
  liveRecordingSampleRate: number;
  liveRecordingChannels: number;
  liveRecordingPollIntervalSec: number;
  systemAudioBackend: SystemAudioBackend;
  chunkSeconds: number;
  deleteAudioAfterTranscribe: boolean;
  // System
  backgroundModelJobs: BackgroundModelJobs;
  loadGuardEnabled: boolean;
  loadGuardThreshold: number;
  loadGuardMemoryThreshold: number;
  loadGuardLowBatteryThresholdPct: number;
  loadGuardMaxConsecutiveSkips: number;
}

export function Settings({
  config,
  overview,
  bootstrapEvents,
  onClearBootstrapEvents,
  onSaved,
}: {
  config: LoadedConfig | null;
  /**
   * Live runtime overview pushed from the main process. The AI tab uses
   * `overview.model.ready` to render the "ready / updating" status pill
   * and to know when a force-refresh has produced a usable model again.
   */
  overview: RuntimeOverview | null;
  /**
   * Bootstrap progress events streamed from the runtime. Used by the AI
   * tab to render a live progress bar during model install / refresh.
   */
  bootstrapEvents: ModelBootstrapProgress[];
  /** Clear the local copy of bootstrap events before kicking off a new run. */
  onClearBootstrapEvents: () => void;
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
        <TabsList className="h-auto flex-wrap justify-start self-start">
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="permissions">Permissions</TabsTrigger>
          <TabsTrigger value="capture">Capture</TabsTrigger>
          <TabsTrigger value="privacy">Privacy</TabsTrigger>
          <TabsTrigger value="storage">Storage</TabsTrigger>
          <TabsTrigger value="ai">AI</TabsTrigger>
          <TabsTrigger value="audio">Audio</TabsTrigger>
          <TabsTrigger value="index">Index</TabsTrigger>
          <TabsTrigger value="export">Export</TabsTrigger>
          <TabsTrigger value="system">System</TabsTrigger>
        </TabsList>

        <TabsContent value="general" className="flex flex-col gap-4">
          <SettingsSection
            title="Launch and appearance"
            description="Set how the app starts and how the interface looks."
          >
            <div className="flex flex-col gap-0">
              <ToggleRow
                title="Open at startup"
                description="CofounderOS opens quietly in the background when you sign in."
                typeLabel="boolean"
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
            </div>
          </SettingsSection>

          <SettingsSection
            title="App configuration"
            description="Identity, data location, logging, and optional session scoping."
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label="App name"
                value={draft.appName}
                onChange={(v) => set('appName', v)}
                typeLabel="string"
                hint="Used in app metadata and logs. Most people can leave this alone."
              />
              <SelectField
                label="Log level"
                value={draft.logLevel}
                onChange={(v) => set('logLevel', v as LogLevel)}
                typeLabel="enum"
                hint="Use info for normal use, debug only when troubleshooting."
                options={[
                  { value: 'debug', label: 'Debug' },
                  { value: 'info', label: 'Info' },
                  { value: 'warn', label: 'Warn' },
                  { value: 'error', label: 'Error' },
                ]}
              />
              <TextField
                label="Data directory"
                value={draft.appDataDir}
                onChange={(v) => set('appDataDir', v)}
                typeLabel="path"
                hint="Root folder for config, exports, and default storage. Restart after changing."
              />
              <TextField
                label="Session ID"
                value={draft.sessionId}
                onChange={(v) => set('sessionId', v)}
                typeLabel="string"
                hint="Optional. Leave blank unless you intentionally separate runs."
                placeholder="optional"
              />
            </div>
          </SettingsSection>
        </TabsContent>

        <TabsContent value="permissions" className="flex flex-col gap-4">
          <PermissionsSettingsPanel />
        </TabsContent>

        <TabsContent value="capture" className="flex flex-col gap-4">
          <SettingsSection
            title="Capture cadence"
            description="Control how often CofounderOS looks for active-window and visual changes."
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label="Capture plugin"
                value={draft.capturePlugin}
                onChange={(v) => set('capturePlugin', v)}
                typeLabel="string"
                hint="The installed capture adapter to use. The default is node."
              />
              <NumberField
                label="Poll interval"
                value={draft.pollIntervalMs}
                onChange={(v) => set('pollIntervalMs', v)}
                min={1}
                step={100}
                unit="ms"
                typeLabel="integer"
                hint="Lower values react faster but use more CPU."
              />
              <NumberField
                label="Idle poll interval"
                value={draft.idlePollIntervalMs}
                onChange={(v) => set('idlePollIntervalMs', v)}
                min={1}
                step={1000}
                unit="ms"
                typeLabel="integer"
                hint="Polling cadence while the machine is idle. Set near poll interval to disable backoff."
              />
              <NumberField
                label="Focus settle delay"
                value={draft.focusSettleDelayMs}
                onChange={(v) => set('focusSettleDelayMs', v)}
                min={0}
                step={50}
                unit="ms"
                typeLabel="integer"
                hint="Wait after app switches before taking a screenshot."
              />
              <NumberField
                label="Visual change threshold"
                value={draft.screenshotDiffThreshold}
                onChange={(v) => set('screenshotDiffThreshold', v)}
                min={0}
                max={1}
                step={0.01}
                typeLabel="number"
                hint="0 captures tiny changes; 1 captures only total visual changes."
              />
              <NumberField
                label="Idle threshold"
                value={draft.idleThresholdSec}
                onChange={(v) => set('idleThresholdSec', v)}
                min={1}
                step={5}
                unit="sec"
                typeLabel="integer"
                hint="After this much inactivity, capture enters idle mode."
              />
            </div>
          </SettingsSection>

          <SettingsSection
            title="Screenshot encoding"
            description="Balance file size, readability, and compatibility."
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <SelectField
                label="Screenshot format"
                value={draft.screenshotFormat}
                onChange={(v) => set('screenshotFormat', v as ScreenshotFormat)}
                typeLabel="enum"
                hint="WebP is smaller; JPEG is useful for older tools."
                options={[
                  { value: 'webp', label: 'WebP' },
                  { value: 'jpeg', label: 'JPEG' },
                ]}
              />
              <NumberField
                label="Screenshot quality"
                value={draft.screenshotQuality}
                onChange={(v) => set('screenshotQuality', v)}
                min={1}
                max={100}
                step={1}
                typeLabel="integer"
                hint="1 is smallest, 100 is highest quality. Screen text is usually readable around 45."
              />
              <OptionalNumberField
                label="Legacy JPEG quality"
                value={draft.jpegQuality}
                onChange={(v) => set('jpegQuality', v)}
                min={1}
                max={100}
                step={1}
                typeLabel="integer"
                hint="Deprecated override for older JPEG configs. Leave blank to use screenshot quality."
              />
              <NumberField
                label="Max screenshot dimension"
                value={draft.screenshotMaxDim}
                onChange={(v) => set('screenshotMaxDim', v)}
                min={0}
                max={8192}
                step={50}
                unit="px"
                typeLabel="integer"
                hint="Caps the longest edge. 0 keeps native resolution."
              />
              <NumberField
                label="Content-change throttle"
                value={draft.contentChangeMinIntervalMs}
                onChange={(v) => set('contentChangeMinIntervalMs', v)}
                min={0}
                step={1000}
                unit="ms"
                typeLabel="integer"
                hint="Minimum time between soft visual-change captures. 0 disables the throttle."
              />
            </div>
          </SettingsSection>

          <SettingsSection
            title="Displays and ignore rules"
            description="Choose the screens and apps that are eligible for capture."
          >
            <div className="flex flex-col gap-0">
              <ToggleRow
                title="Capture multiple displays"
                description="Record more than the primary display on each trigger."
                typeLabel="boolean"
                checked={draft.multiScreen}
                onChange={(v) => set('multiScreen', v)}
              />
              <Separator className="my-4" />
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField
                  label="Screen indexes"
                  value={draft.screens}
                  onChange={(v) => set('screens', v)}
                  typeLabel="integer list"
                  hint="Comma-separated display indexes, such as 0, 1. Leave blank to use every detected display."
                  placeholder="0, 1"
                />
                <SelectField
                  label="Multi-display mode"
                  value={draft.captureMode}
                  onChange={(v) => set('captureMode', v as CaptureMode)}
                  typeLabel="enum"
                  hint="Active captures the focused display; all captures every selected display."
                  options={[
                    { value: 'active', label: 'Active display' },
                    { value: 'all', label: 'All selected displays' },
                  ]}
                />
                <TextAreaField
                  label="Apps to ignore"
                  value={draft.excludedApps}
                  onChange={(v) => set('excludedApps', v)}
                  typeLabel="string list"
                  hint="One app name per line. Matching apps are not saved."
                  placeholder="One app name per line"
                />
                <TextAreaField
                  label="URLs to ignore"
                  value={draft.excludedUrlPatterns}
                  onChange={(v) => set('excludedUrlPatterns', v)}
                  typeLabel="string list"
                  hint="One rule per line. Use domains like example.com, subdomains like *.example.com, or paths like example.com/private/*."
                  placeholder="example.com"
                />
              </div>
            </div>
          </SettingsSection>
        </TabsContent>

        <TabsContent value="privacy" className="flex flex-col gap-4">
          <SettingsSection
            title="Redaction and lock behavior"
            description="Guardrails that keep sensitive screen content out of memory."
          >
            <div className="flex flex-col gap-0">
              <ToggleRow
                title="Blur password fields"
                description="Skip password boxes so they're never captured."
                typeLabel="boolean"
                checked={draft.blurPasswordFields}
                onChange={(v) => set('blurPasswordFields', v)}
              />
              <Separator className="my-4" />
              <ToggleRow
                title="Pause when screen is locked"
                description="Stop capturing when you step away from your computer."
                typeLabel="boolean"
                checked={draft.pauseOnScreenLock}
                onChange={(v) => set('pauseOnScreenLock', v)}
              />
              <Separator className="my-4" />
              <TextAreaField
                label="Words to skip"
                value={draft.sensitiveKeywords}
                onChange={(v) => set('sensitiveKeywords', v)}
                typeLabel="string list"
                hint="Anything containing these words will not be saved. One keyword per line."
                placeholder="One per line, e.g. salary, passport"
              />
            </div>
          </SettingsSection>

          <SettingsSection
            title="Accessibility text"
            description="Use macOS Accessibility data to read app text more accurately than OCR."
          >
            <div className="flex flex-col gap-0">
              <ToggleRow
                title="Read visible app text"
                description="Adds Accessibility text to screenshots when available, then falls back to OCR."
                typeLabel="boolean"
                checked={draft.accessibilityEnabled}
                onChange={(v) => set('accessibilityEnabled', v)}
              />
              <Separator className="my-4" />
              <div className="grid gap-4 sm:grid-cols-2">
                <NumberField
                  label="Accessibility timeout"
                  value={draft.accessibilityTimeoutMs}
                  onChange={(v) => set('accessibilityTimeoutMs', v)}
                  min={1}
                  step={100}
                  unit="ms"
                  typeLabel="integer"
                  hint="Maximum time spent asking the focused app for text."
                />
                <NumberField
                  label="Maximum text characters"
                  value={draft.accessibilityMaxChars}
                  onChange={(v) => set('accessibilityMaxChars', v)}
                  min={1}
                  step={500}
                  typeLabel="integer"
                  hint="Caps text stored from one Accessibility read."
                />
                <NumberField
                  label="Maximum UI elements"
                  value={draft.accessibilityMaxElements}
                  onChange={(v) => set('accessibilityMaxElements', v)}
                  min={1}
                  step={250}
                  typeLabel="integer"
                  hint="Caps how many Accessibility nodes are inspected per read."
                />
                <TextAreaField
                  label="Accessibility apps to ignore"
                  value={draft.accessibilityExcludedApps}
                  onChange={(v) => set('accessibilityExcludedApps', v)}
                  typeLabel="string list"
                  hint="One app per line. These apps can still use OCR unless also ignored above."
                  placeholder="One app name per line"
                />
              </div>
            </div>
          </SettingsSection>

          <DangerZone />
        </TabsContent>

        <TabsContent value="storage" className="flex flex-col gap-4">
          <SettingsSection
            title="Storage root and limits"
            description="Decide where memory lives and how much disk CofounderOS may use."
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label="Storage plugin"
                value={draft.storagePlugin}
                onChange={(v) => set('storagePlugin', v)}
                typeLabel="string"
                hint="The installed storage adapter to use. The default is local."
              />
              <TextField
                label="Storage path"
                value={draft.storagePath}
                onChange={(v) => set('storagePath', v)}
                typeLabel="path"
                hint="Screenshots, SQLite, and checkpoints live under this folder."
              />
              <NumberField
                label="Maximum space"
                value={draft.maxSizeGb}
                onChange={(v) => set('maxSizeGb', v)}
                min={0.1}
                step={1}
                unit="GB"
                typeLabel="number"
                hint="Soft cap for local storage. Use a larger value if you keep long visual history."
              />
              <NumberField
                label="Keep memories for"
                value={draft.retentionDays}
                onChange={(v) => set('retentionDays', v)}
                min={0}
                step={1}
                unit="days"
                typeLabel="integer"
                hint="0 keeps metadata forever. Screenshot asset cleanup is controlled below."
              />
            </div>
          </SettingsSection>

          <SettingsSection
            title="Screenshot vacuum"
            description="Downsize or remove old screenshot files while keeping text searchable."
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <OptionalNumberField
                label="Compress after"
                value={draft.compressAfterMinutes}
                onChange={(v) => set('compressAfterMinutes', v)}
                min={0}
                step={15}
                unit="min"
                typeLabel="integer"
                hint="Minute-granularity window. Leave blank to use the day fallback; 0 disables compression."
              />
              <NumberField
                label="Compress after fallback"
                value={draft.compressAfterDays}
                onChange={(v) => set('compressAfterDays', v)}
                min={0}
                step={1}
                unit="days"
                typeLabel="integer"
                hint="Used only when minute value is not present."
              />
              <NumberField
                label="Compressed quality"
                value={draft.compressQuality}
                onChange={(v) => set('compressQuality', v)}
                min={1}
                max={100}
                step={1}
                typeLabel="integer"
                hint="Lower values save more disk; higher values preserve screenshots."
              />
              <OptionalNumberField
                label="Thumbnail after"
                value={draft.thumbnailAfterMinutes}
                onChange={(v) => set('thumbnailAfterMinutes', v)}
                min={0}
                step={60}
                unit="min"
                typeLabel="integer"
                hint="Minute window for thumbnailing. Leave blank to use the day fallback; 0 disables thumbnailing."
              />
              <NumberField
                label="Thumbnail after fallback"
                value={draft.thumbnailAfterDays}
                onChange={(v) => set('thumbnailAfterDays', v)}
                min={0}
                step={1}
                unit="days"
                typeLabel="integer"
                hint="Used only when minute value is not present."
              />
              <NumberField
                label="Thumbnail max dimension"
                value={draft.thumbnailMaxDim}
                onChange={(v) => set('thumbnailMaxDim', v)}
                min={64}
                max={2048}
                step={16}
                unit="px"
                typeLabel="integer"
                hint="Longest edge of thumbnails kept for old screenshots."
              />
              <OptionalNumberField
                label="Delete screenshots after"
                value={draft.deleteAfterMinutes}
                onChange={(v) => set('deleteAfterMinutes', v)}
                min={0}
                step={60}
                unit="min"
                typeLabel="integer"
                hint="Minute window for deleting old image files. Leave blank to use the day fallback; 0 keeps images."
              />
              <NumberField
                label="Delete after fallback"
                value={draft.deleteAfterDays}
                onChange={(v) => set('deleteAfterDays', v)}
                min={0}
                step={1}
                unit="days"
                typeLabel="integer"
                hint="Text stays searchable even after screenshot files are removed."
              />
              <NumberField
                label="Vacuum interval"
                value={draft.vacuumTickIntervalMin}
                onChange={(v) => set('vacuumTickIntervalMin', v)}
                min={1}
                step={1}
                unit="min"
                typeLabel="integer"
                hint="How often the cleanup worker wakes up."
              />
              <NumberField
                label="Vacuum batch size"
                value={draft.vacuumBatchSize}
                onChange={(v) => set('vacuumBatchSize', v)}
                min={1}
                step={10}
                typeLabel="integer"
                hint="Files processed per cleanup tick. Smaller batches are gentler."
              />
            </div>
          </SettingsSection>
        </TabsContent>

        <TabsContent value="ai" className="flex flex-col gap-4">
          <ModelSettings
            savedModel={loadedConfig.config.index.model.ollama?.model ?? ''}
            savedRevision={loadedConfig.config.index.model.ollama?.model_revision ?? 1}
            ollamaHost={draft.ollamaHost}
            ollamaAutoInstall={draft.ollamaAutoInstall}
            modelReady={overview?.model.ready ?? false}
            bootstrapEvents={bootstrapEvents}
            onClearBootstrapEvents={onClearBootstrapEvents}
            onHostChange={(v) => set('ollamaHost', v)}
            onAutoInstallChange={(v) => set('ollamaAutoInstall', v)}
            onModelChanged={(next) => onSaved(next)}
          />

          <SettingsSection
            title="Provider and model internals"
            description="Configure the model adapter, embeddings, warm-loading, and hosted model fallbacks."
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label="Model provider"
                value={draft.modelPlugin}
                onChange={(v) => set('modelPlugin', v)}
                typeLabel="string"
                hint="Installed model adapter name. Common choices are ollama, openai, and claude."
              />
              <TextField
                label="Ollama embedding model"
                value={draft.ollamaEmbeddingModel}
                onChange={(v) => set('ollamaEmbeddingModel', v)}
                typeLabel="string"
                hint="Used for semantic search vectors. nomic-embed-text is the default."
              />
              <TextField
                label="Ollama vision model"
                value={draft.ollamaVisionModel}
                onChange={(v) => set('ollamaVisionModel', v)}
                typeLabel="string"
                hint="Optional override for image-aware answers. Blank uses the primary model."
                placeholder="optional"
              />
              <TextField
                label="Indexer model"
                value={draft.ollamaIndexerModel}
                onChange={(v) => set('ollamaIndexerModel', v)}
                typeLabel="string"
                hint="Optional smaller local model for summaries and organization."
                placeholder="optional"
              />
              <TextField
                label="Ollama keep alive"
                value={draft.ollamaKeepAlive}
                onChange={(v) => set('ollamaKeepAlive', v)}
                typeLabel="string | number"
                hint="Examples: 30s, 5m, or -1. Controls how long Ollama keeps weights warm."
              />
              <NumberField
                label="Host unload after idle"
                value={draft.ollamaUnloadAfterIdleMin}
                onChange={(v) => set('ollamaUnloadAfterIdleMin', v)}
                min={0}
                step={1}
                unit="min"
                typeLabel="number"
                hint="0 relies on Ollama's keep_alive. Set higher only for special warm-load setups."
              />
              <NumberField
                label="Model revision"
                value={draft.ollamaModelRevision}
                onChange={(v) => set('ollamaModelRevision', v)}
                min={0}
                step={1}
                typeLabel="integer"
                hint="Bump this to force a model re-pull on next start."
              />
              <TextField
                label="OpenAI API key"
                value={draft.openaiApiKey}
                onChange={(v) => set('openaiApiKey', v)}
                typeLabel="secret string"
                hint="Blank uses OPENAI_API_KEY from the environment."
                inputType="password"
                placeholder="optional"
              />
              <TextField
                label="OpenAI base URL"
                value={draft.openaiBaseUrl}
                onChange={(v) => set('openaiBaseUrl', v)}
                typeLabel="URL"
                hint="Use the default for OpenAI, or point to any OpenAI-compatible API."
              />
              <TextField
                label="OpenAI chat model"
                value={draft.openaiModel}
                onChange={(v) => set('openaiModel', v)}
                typeLabel="string"
                hint="Used for text completion when the OpenAI-compatible provider is active."
              />
              <TextField
                label="OpenAI vision model"
                value={draft.openaiVisionModel}
                onChange={(v) => set('openaiVisionModel', v)}
                typeLabel="string"
                hint="Optional override for vision requests. Blank uses the chat model."
                placeholder="optional"
              />
              <TextField
                label="OpenAI embedding model"
                value={draft.openaiEmbeddingModel}
                onChange={(v) => set('openaiEmbeddingModel', v)}
                typeLabel="string"
                hint="Used for semantic vectors when the OpenAI-compatible provider is active."
              />
              <TextField
                label="Claude API key"
                value={draft.claudeApiKey}
                onChange={(v) => set('claudeApiKey', v)}
                typeLabel="secret string"
                hint="Blank relies on the environment if your model adapter supports it."
                inputType="password"
                placeholder="optional"
              />
              <TextField
                label="Claude model"
                value={draft.claudeModel}
                onChange={(v) => set('claudeModel', v)}
                typeLabel="string"
                hint="Used only when the Claude provider is selected."
              />
            </div>
          </SettingsSection>
        </TabsContent>

        <TabsContent value="audio">
          <AudioSettings
            capturePlugin={draft.capturePlugin}
            captureAudio={draft.captureAudio}
            liveRecordingEnabled={draft.liveRecordingEnabled}
            systemAudioBackend={draft.systemAudioBackend}
            whisperModel={draft.whisperModel}
            chunkSeconds={draft.chunkSeconds}
            deleteAudioAfterTranscribe={draft.deleteAudioAfterTranscribe}
            audioInboxPath={draft.audioInboxPath}
            audioProcessedPath={draft.audioProcessedPath}
            audioFailedPath={draft.audioFailedPath}
            audioTickIntervalSec={draft.audioTickIntervalSec}
            audioBatchSize={draft.audioBatchSize}
            whisperCommand={draft.whisperCommand}
            whisperLanguage={draft.whisperLanguage}
            maxAudioBytes={draft.maxAudioBytes}
            minAudioBytesPerSec={draft.minAudioBytesPerSec}
            minAudioRateCheckMs={draft.minAudioRateCheckMs}
            liveRecordingFormat={draft.liveRecordingFormat}
            liveRecordingSampleRate={draft.liveRecordingSampleRate}
            liveRecordingChannels={draft.liveRecordingChannels}
            liveRecordingPollIntervalSec={draft.liveRecordingPollIntervalSec}
            set={set}
          />
        </TabsContent>

        <TabsContent value="index" className="flex flex-col gap-4">
          <SettingsSection
            title="Organization schedule"
            description="Control the wiki-like index and background organization cadence."
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label="Index strategy"
                value={draft.indexStrategy}
                onChange={(v) => set('indexStrategy', v)}
                typeLabel="string"
                hint="The installed index strategy. The default is karpathy."
              />
              <TextField
                label="Index path"
                value={draft.indexPath}
                onChange={(v) => set('indexPath', v)}
                typeLabel="path"
                hint="Where generated index pages are stored."
              />
              <NumberField
                label="Incremental interval"
                value={draft.incrementalIntervalMin}
                onChange={(v) => set('incrementalIntervalMin', v)}
                min={1}
                step={1}
                unit="min"
                typeLabel="integer"
                hint="Used only when background model jobs are scheduled."
              />
              <TextField
                label="Reorganize schedule"
                value={draft.reorganiseSchedule}
                onChange={(v) => set('reorganiseSchedule', v)}
                typeLabel="cron string"
                hint="Cron expression for full index reorganization."
              />
              <NumberField
                label="Idle trigger"
                value={draft.indexIdleTriggerMin}
                onChange={(v) => set('indexIdleTriggerMin', v)}
                min={1}
                step={1}
                unit="min"
                typeLabel="integer"
                hint="Idle time before deferred heavy index work may run."
              />
              <NumberField
                label="Index batch size"
                value={draft.indexBatchSize}
                onChange={(v) => set('indexBatchSize', v)}
                min={1}
                step={10}
                typeLabel="integer"
                hint="Items processed per indexing pass."
              />
            </div>
            <Separator className="my-4" />
            <ToggleRow
              title="Reorganize while idle"
              description="Allow idle-on-power catch-up to run expensive index work."
              typeLabel="boolean"
              checked={draft.reorganiseOnIdle}
              onChange={(v) => set('reorganiseOnIdle', v)}
            />
          </SettingsSection>

          <SettingsSection
            title="Sessions and meetings"
            description="Tune how raw frames become work sessions and meeting records."
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <NumberField
                label="Session idle gap"
                value={draft.sessionsIdleThresholdSec}
                onChange={(v) => set('sessionsIdleThresholdSec', v)}
                min={1}
                step={30}
                unit="sec"
                typeLabel="integer"
                hint="A larger gap merges nearby activity into longer sessions."
              />
              <NumberField
                label="AFK marker threshold"
                value={draft.sessionsAfkThresholdSec}
                onChange={(v) => set('sessionsAfkThresholdSec', v)}
                min={1}
                step={30}
                unit="sec"
                typeLabel="integer"
                hint="Gaps above this appear as idle markers in journals."
              />
              <NumberField
                label="Minimum active time"
                value={draft.sessionsMinActiveMs}
                onChange={(v) => set('sessionsMinActiveMs', v)}
                min={0}
                step={1000}
                unit="ms"
                typeLabel="integer"
                hint="Shorter sessions are dropped from primary session lists."
              />
              <NumberField
                label="Fallback frame attention"
                value={draft.sessionsFallbackFrameAttentionMs}
                onChange={(v) => set('sessionsFallbackFrameAttentionMs', v)}
                min={1}
                step={1000}
                unit="ms"
                typeLabel="integer"
                hint="Attention time assumed for frames without better duration data."
              />
              <NumberField
                label="Meeting idle gap"
                value={draft.meetingsIdleThresholdSec}
                onChange={(v) => set('meetingsIdleThresholdSec', v)}
                min={1}
                step={30}
                unit="sec"
                typeLabel="integer"
                hint="Gap that closes a detected active meeting."
              />
              <NumberField
                label="Minimum meeting duration"
                value={draft.meetingsMinDurationSec}
                onChange={(v) => set('meetingsMinDurationSec', v)}
                min={0}
                step={30}
                unit="sec"
                typeLabel="integer"
                hint="Shorter meetings are kept but skipped for model summary."
              />
              <NumberField
                label="Audio grace window"
                value={draft.meetingsAudioGraceSec}
                onChange={(v) => set('meetingsAudioGraceSec', v)}
                min={0}
                step={10}
                unit="sec"
                typeLabel="integer"
                hint="Audio arriving this long after meeting close still attaches."
              />
              <NumberField
                label="Summary cooldown"
                value={draft.meetingsSummarizeCooldownSec}
                onChange={(v) => set('meetingsSummarizeCooldownSec', v)}
                min={0}
                step={30}
                unit="sec"
                typeLabel="integer"
                hint="Wait after a meeting ends so Whisper can finish before summary."
              />
              <NumberField
                label="Vision attachments"
                value={draft.meetingsVisionAttachments}
                onChange={(v) => set('meetingsVisionAttachments', v)}
                min={0}
                step={1}
                typeLabel="integer"
                hint="Number of key screenshots sent to the vision model per meeting summary."
              />
            </div>
            <Separator className="my-4" />
            <ToggleRow
              title="Summarize meetings"
              description="Use the model to generate TL;DR, decisions, and action items."
              typeLabel="boolean"
              checked={draft.meetingsSummarize}
              onChange={(v) => set('meetingsSummarize', v)}
            />
          </SettingsSection>

          <SettingsSection
            title="Semantic embeddings"
            description="Blend vector search with keyword search for conceptual recall."
          >
            <div className="flex flex-col gap-0">
              <ToggleRow
                title="Generate embeddings"
                description="Creates semantic vectors from frame text, titles, and URLs."
                typeLabel="boolean"
                checked={draft.embeddingsEnabled}
                onChange={(v) => set('embeddingsEnabled', v)}
              />
              <Separator className="my-4" />
              <div className="grid gap-4 sm:grid-cols-2">
                <NumberField
                  label="Embedding batch size"
                  value={draft.embeddingsBatchSize}
                  onChange={(v) => set('embeddingsBatchSize', v)}
                  min={1}
                  step={1}
                  typeLabel="integer"
                  hint="Frames embedded per worker pass."
                />
                <NumberField
                  label="Embedding interval"
                  value={draft.embeddingsTickIntervalMin}
                  onChange={(v) => set('embeddingsTickIntervalMin', v)}
                  min={1}
                  step={1}
                  unit="min"
                  typeLabel="integer"
                  hint="How often the embedding worker wakes up."
                />
                <NumberField
                  label="Search blend weight"
                  value={draft.embeddingsSearchWeight}
                  onChange={(v) => set('embeddingsSearchWeight', v)}
                  min={0.01}
                  step={0.05}
                  typeLabel="number"
                  hint="Higher values give semantic matches more influence in search ranking."
                />
              </div>
            </div>
          </SettingsSection>
        </TabsContent>

        <TabsContent value="export" className="flex flex-col gap-4">
          <SettingsSection
            title="Markdown export"
            description="Mirror organized memory pages to regular Markdown files."
          >
            <div className="flex flex-col gap-0">
              <ToggleRow
                title="Enable Markdown export"
                description="Writes daily journals and index pages to a folder you can browse or sync."
                typeLabel="boolean"
                checked={draft.markdownEnabled}
                onChange={(v) => set('markdownEnabled', v)}
              />
              <Separator className="my-4" />
              <TextField
                label="Folder for daily journals"
                value={draft.markdownPath}
                onChange={(v) => set('markdownPath', v)}
                typeLabel="path"
                hint="Where Markdown export files are written."
              />
            </div>
          </SettingsSection>

          <SettingsSection
            title="AI app connection"
            description="Configure the built-in MCP server for external AI tools."
          >
            <div className="flex flex-col gap-0">
              <ToggleRow
                title="Enable MCP server"
                description="Exposes memory tools to MCP-compatible apps on this machine."
                typeLabel="boolean"
                checked={draft.mcpEnabled}
                onChange={(v) => set('mcpEnabled', v)}
              />
              <Separator className="my-4" />
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField
                  label="MCP host"
                  value={draft.mcpHost}
                  onChange={(v) => set('mcpHost', v)}
                  typeLabel="host string"
                  hint="127.0.0.1 keeps the server local to this computer."
                />
                <NumberField
                  label="MCP port"
                  value={draft.mcpPort}
                  onChange={(v) => set('mcpPort', v)}
                  min={1}
                  max={65535}
                  step={1}
                  typeLabel="integer"
                  hint="Choose an unused local TCP port."
                />
                <SelectField
                  label="MCP transport"
                  value={draft.mcpTransport}
                  onChange={(v) => set('mcpTransport', v as McpTransport)}
                  typeLabel="enum"
                  hint="HTTP is best for the desktop server; stdio is for standalone launches."
                  options={[
                    { value: 'http', label: 'HTTP' },
                    { value: 'stdio', label: 'stdio' },
                  ]}
                />
                <NumberField
                  label="Frame text excerpt"
                  value={draft.mcpTextExcerptChars}
                  onChange={(v) => set('mcpTextExcerptChars', v)}
                  min={0}
                  step={500}
                  typeLabel="integer"
                  hint="Maximum OCR/Accessibility characters returned per frame preview. 0 means no excerpt."
                />
              </div>
            </div>
          </SettingsSection>
        </TabsContent>

        <TabsContent value="system" className="flex flex-col gap-4">
          <SettingsSection
            title="Background work"
            description="Decide when expensive model work runs without an explicit click."
          >
            <SelectField
              label="Background model jobs"
              value={draft.backgroundModelJobs}
              onChange={(v) => set('backgroundModelJobs', v as BackgroundModelJobs)}
              typeLabel="enum"
              hint="Manual is laptop-friendly. Scheduled keeps the index warmer in the background."
              options={[
                { value: 'manual', label: 'Manual' },
                { value: 'scheduled', label: 'Scheduled' },
              ]}
            />
          </SettingsSection>

          <SettingsSection
            title="Load guard"
            description="Pause heavy work when the computer is busy, low on memory, or low on battery."
          >
            <div className="flex flex-col gap-0">
              <ToggleRow
                title="Enable load guard"
                description="Defers OCR, Whisper, embeddings, summaries, and vacuum when system pressure is high."
                typeLabel="boolean"
                checked={draft.loadGuardEnabled}
                onChange={(v) => set('loadGuardEnabled', v)}
              />
              <Separator className="my-4" />
              <div className="grid gap-4 sm:grid-cols-2">
                <NumberField
                  label="CPU load threshold"
                  value={draft.loadGuardThreshold}
                  onChange={(v) => set('loadGuardThreshold', v)}
                  min={0.01}
                  max={8}
                  step={0.05}
                  typeLabel="number"
                  hint="Normalized 1-minute load average. 0.7 means about 70% of CPU capacity."
                />
                <NumberField
                  label="Memory threshold"
                  value={draft.loadGuardMemoryThreshold}
                  onChange={(v) => set('loadGuardMemoryThreshold', v)}
                  min={0.01}
                  max={1}
                  step={0.01}
                  typeLabel="number"
                  hint="Used-memory ratio. 0.9 skips heavy work near 90% memory use."
                />
                <NumberField
                  label="Low-battery threshold"
                  value={draft.loadGuardLowBatteryThresholdPct}
                  onChange={(v) => set('loadGuardLowBatteryThresholdPct', v)}
                  min={0}
                  max={100}
                  step={1}
                  unit="%"
                  typeLabel="integer"
                  hint="While unplugged, heavy work is skipped below this battery level. 0 disables."
                />
                <NumberField
                  label="Max consecutive CPU skips"
                  value={draft.loadGuardMaxConsecutiveSkips}
                  onChange={(v) => set('loadGuardMaxConsecutiveSkips', v)}
                  min={0}
                  step={1}
                  typeLabel="integer"
                  hint="0 never forces a CPU-overload run. Memory and battery skips are never forced."
                />
              </div>
            </div>
          </SettingsSection>
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
  capturePlugin,
  captureAudio,
  liveRecordingEnabled,
  systemAudioBackend,
  whisperModel,
  chunkSeconds,
  deleteAudioAfterTranscribe,
  audioInboxPath,
  audioProcessedPath,
  audioFailedPath,
  audioTickIntervalSec,
  audioBatchSize,
  whisperCommand,
  whisperLanguage,
  maxAudioBytes,
  minAudioBytesPerSec,
  minAudioRateCheckMs,
  liveRecordingFormat,
  liveRecordingSampleRate,
  liveRecordingChannels,
  liveRecordingPollIntervalSec,
  set,
}: {
  capturePlugin: string;
  captureAudio: boolean;
  liveRecordingEnabled: boolean;
  systemAudioBackend: SystemAudioBackend;
  whisperModel: string;
  chunkSeconds: number;
  deleteAudioAfterTranscribe: boolean;
  audioInboxPath: string;
  audioProcessedPath: string;
  audioFailedPath: string;
  audioTickIntervalSec: number;
  audioBatchSize: number;
  whisperCommand: string;
  whisperLanguage: string;
  maxAudioBytes: number;
  minAudioBytesPerSec: number;
  minAudioRateCheckMs: number;
  liveRecordingFormat: LiveRecordingFormat;
  liveRecordingSampleRate: number;
  liveRecordingChannels: number;
  liveRecordingPollIntervalSec: number;
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

  const liveCaptureNeedsNative =
    captureAudio && liveRecordingEnabled && capturePlugin.trim() !== 'native';
  const setCaptureAudio = (enabled: boolean) => {
    set('captureAudio', enabled);
    if (!enabled) set('liveRecordingEnabled', false);
    else if (liveRecordingEnabled && capturePlugin.trim() !== 'native') {
      set('capturePlugin', 'native');
    }
  };
  const setLiveRecordingEnabled = (enabled: boolean) => {
    set('liveRecordingEnabled', enabled);
    if (enabled) {
      set('captureAudio', true);
      if (capturePlugin.trim() !== 'native') set('capturePlugin', 'native');
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardContent className="flex flex-col gap-0">
          <ToggleRow
            title="Process audio and transcripts"
            description="Import audio files from the inbox and transcribe them locally with Whisper."
            typeLabel="boolean"
            checked={captureAudio}
            onChange={setCaptureAudio}
          />
          {captureAudio && (
            <>
              {liveCaptureNeedsNative && (
                <>
                  <Separator className="my-4" />
                  <Alert>
                    <AlertTriangle className="size-4" />
                    <AlertTitle>Native capture required</AlertTitle>
                    <AlertDescription>
                      Live meeting audio uses the native capture plugin. Enabling live recording
                      switches the capture plugin to native when you save.
                    </AlertDescription>
                  </Alert>
                </>
              )}
              <Separator className="my-4" />
              <ToggleRow
                title="Live microphone recording"
                description="Record short chunks only after another app is already using audio input."
                typeLabel="boolean"
                checked={liveRecordingEnabled}
                onChange={setLiveRecordingEnabled}
              />
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
              <div className="flex flex-col gap-3">
                <div>
                  <h4 className="font-medium">Remote participant audio</h4>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    Choose how CofounderOS joins remote audio after another app opens input.
                  </p>
                </div>
                <RadioGroup
                  value={systemAudioBackend}
                  onValueChange={(v) => set('systemAudioBackend', v as SystemAudioBackend)}
                  className="grid gap-2"
                >
                  <Label
                    htmlFor="sab-core"
                    className={cn(
                      'flex cursor-pointer items-start gap-3 rounded-md border bg-card p-3 text-sm font-normal transition-colors',
                      systemAudioBackend === 'core_audio_tap'
                        ? 'border-primary ring-2 ring-primary/20'
                        : 'hover:bg-accent/40',
                    )}
                  >
                    <RadioGroupItem value="core_audio_tap" id="sab-core" className="mt-0.5" />
                    <div className="min-w-0">
                      <div className="font-medium">Core Audio tap</div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        Recommended on macOS 14.2+. Joins system output without the
                        macOS screen-sharing indicator once another app is using input.
                      </div>
                    </div>
                  </Label>
                  <Label
                    htmlFor="sab-off"
                    className={cn(
                      'flex cursor-pointer items-start gap-3 rounded-md border bg-card p-3 text-sm font-normal transition-colors',
                      systemAudioBackend === 'off'
                        ? 'border-primary ring-2 ring-primary/20'
                        : 'hover:bg-accent/40',
                    )}
                  >
                    <RadioGroupItem value="off" id="sab-off" className="mt-0.5" />
                    <div className="min-w-0">
                      <div className="font-medium">Mic only</div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        Records your voice only. Remote participants are not captured.
                      </div>
                    </div>
                  </Label>
                  <Label
                    htmlFor="sab-sck"
                    className={cn(
                      'flex cursor-pointer items-start gap-3 rounded-md border bg-card p-3 text-sm font-normal transition-colors',
                      systemAudioBackend === 'screencapturekit'
                        ? 'border-primary ring-2 ring-primary/20'
                        : 'hover:bg-accent/40',
                    )}
                  >
                    <RadioGroupItem value="screencapturekit" id="sab-sck" className="mt-0.5" />
                    <div className="min-w-0">
                      <div className="font-medium">ScreenCaptureKit fallback</div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        Joins remote audio on older macOS versions, but macOS shows
                        "Currently Sharing" while active.
                      </div>
                    </div>
                  </Label>
                </RadioGroup>
              </div>
              <Separator className="my-4" />
              <div className="grid gap-4 sm:grid-cols-2">
                <NumberField
                  label="Chunk length (seconds)"
                  value={chunkSeconds}
                  onChange={(v) => set('chunkSeconds', v)}
                  min={1}
                  step={30}
                  unit="sec"
                  typeLabel="integer"
                  hint="Shorter chunks = faster feedback during calls, more Whisper invocations."
                />
                <SelectField
                  label="Recording format"
                  value={liveRecordingFormat}
                  onChange={(v) => set('liveRecordingFormat', v as LiveRecordingFormat)}
                  typeLabel="enum"
                  hint="m4a is the supported live-recording container."
                  options={[{ value: 'm4a', label: 'm4a' }]}
                />
                <NumberField
                  label="Sample rate"
                  value={liveRecordingSampleRate}
                  onChange={(v) => set('liveRecordingSampleRate', v)}
                  min={1}
                  step={1000}
                  unit="Hz"
                  typeLabel="integer"
                  hint="16000 Hz is a good speech transcription default."
                />
                <NumberField
                  label="Audio channels"
                  value={liveRecordingChannels}
                  onChange={(v) => set('liveRecordingChannels', v)}
                  min={1}
                  max={2}
                  step={1}
                  typeLabel="integer"
                  hint="1 is mono and smaller. 2 keeps stereo input."
                />
                <NumberField
                  label="Input poll interval"
                  value={liveRecordingPollIntervalSec}
                  onChange={(v) => set('liveRecordingPollIntervalSec', v)}
                  min={1}
                  step={1}
                  unit="sec"
                  typeLabel="integer"
                  hint="How often CofounderOS checks whether another app still has mic input."
                />
              </div>
              <Separator className="my-4" />
              <ToggleRow
                title="Delete audio after transcribing"
                description="Recommended. The redacted transcript stays; the raw audio file is removed so credentials and other PII don't linger on disk."
                typeLabel="boolean"
                checked={deleteAudioAfterTranscribe}
                onChange={(v) => set('deleteAudioAfterTranscribe', v)}
              />
              <Separator className="my-4" />
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField
                  label="Audio inbox path"
                  value={audioInboxPath}
                  onChange={(v) => set('audioInboxPath', v)}
                  typeLabel="path"
                  hint="Audio files dropped here are imported and transcribed."
                />
                <TextField
                  label="Processed audio path"
                  value={audioProcessedPath}
                  onChange={(v) => set('audioProcessedPath', v)}
                  typeLabel="path"
                  hint="Successfully processed source files move here when they are retained."
                />
                <TextField
                  label="Failed audio path"
                  value={audioFailedPath}
                  onChange={(v) => set('audioFailedPath', v)}
                  typeLabel="path"
                  hint="Files that cannot be processed are moved here for inspection."
                />
                <NumberField
                  label="Transcript worker interval"
                  value={audioTickIntervalSec}
                  onChange={(v) => set('audioTickIntervalSec', v)}
                  min={1}
                  step={5}
                  unit="sec"
                  typeLabel="integer"
                  hint="How often the audio import worker scans the inbox."
                />
                <NumberField
                  label="Transcript batch size"
                  value={audioBatchSize}
                  onChange={(v) => set('audioBatchSize', v)}
                  min={1}
                  step={1}
                  typeLabel="integer"
                  hint="Audio files processed per worker tick."
                />
                <TextField
                  label="Whisper command"
                  value={whisperCommand}
                  onChange={(v) => set('whisperCommand', v)}
                  typeLabel="command string"
                  hint="Executable used for transcription. Keep as whisper unless you installed a compatible wrapper."
                />
                <TextField
                  label="Whisper language"
                  value={whisperLanguage}
                  onChange={(v) => set('whisperLanguage', v)}
                  typeLabel="string"
                  hint="Optional language code. Blank lets Whisper auto-detect."
                  placeholder="optional"
                />
                <NumberField
                  label="Maximum audio file size"
                  value={maxAudioBytes}
                  onChange={(v) => set('maxAudioBytes', v)}
                  min={0}
                  step={1024 * 1024}
                  unit="bytes"
                  typeLabel="integer"
                  hint="Reject larger files before Whisper. 0 disables the size cap."
                />
                <NumberField
                  label="Minimum audio byte rate"
                  value={minAudioBytesPerSec}
                  onChange={(v) => set('minAudioBytesPerSec', v)}
                  min={0}
                  step={512}
                  unit="bytes/sec"
                  typeLabel="integer"
                  hint="Files below this byte rate are treated as silence. 0 disables the check."
                />
                <NumberField
                  label="Minimum rate-check length"
                  value={minAudioRateCheckMs}
                  onChange={(v) => set('minAudioRateCheckMs', v)}
                  min={0}
                  step={500}
                  unit="ms"
                  typeLabel="integer"
                  hint="Shorter clips skip the silence byte-rate check."
                />
              </div>
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

/**
 * Settings → Permissions panel. Lets users repair / re-grant the
 * macOS permissions CofounderOS uses any time after onboarding.
 * Mirrors the onboarding `PermissionsStep` but lives at a stable
 * surface so users always have a place to fix permissions if a macOS
 * upgrade or a config change wipes them.
 */
function PermissionsSettingsPanel() {
  const [screen, setScreen] = React.useState<ScreenPermission | null>(null);
  const [accessibility, setAccessibility] = React.useState<AccessibilityPermission | null>(null);
  const [mic, setMic] = React.useState<MicPermission | null>(null);
  const [requesting, setRequesting] = React.useState<
    'screen' | 'accessibility' | 'microphone' | null
  >(null);

  const refresh = React.useCallback(async () => {
    try {
      const [s, a, m] = await Promise.all([
        window.cofounderos.probeScreenPermission(),
        window.cofounderos.probeAccessibilityPermission(),
        window.cofounderos.probeMicPermission(),
      ]);
      setScreen(s);
      setAccessibility(a);
      setMic(m);
    } catch {
      /* ignore */
    }
  }, []);

  React.useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2500);
    return () => window.clearInterval(timer);
  }, [refresh]);

  React.useEffect(() => {
    const handler = () => void refresh();
    window.addEventListener('focus', handler);
    return () => window.removeEventListener('focus', handler);
  }, [refresh]);

  async function request(kind: 'screen' | 'accessibility' | 'microphone') {
    setRequesting(kind);
    try {
      if (kind === 'screen') await window.cofounderos.requestScreenPermission();
      if (kind === 'accessibility') await window.cofounderos.requestAccessibilityPermission();
      if (kind === 'microphone') await window.cofounderos.requestMicPermission();
    } finally {
      setRequesting(null);
      void refresh();
    }
  }

  const screenStatus = screen?.status ?? 'unsupported';
  const screenSupported = screenStatus !== 'unsupported';
  const screenGranted = screenStatus === 'granted';
  const screenNeedsRelaunch = screen?.needsRelaunch === true;

  const accessibilityStatus = accessibility?.status ?? 'unsupported';
  const accessibilitySupported = accessibilityStatus !== 'unsupported';
  const accessibilityGranted = accessibilityStatus === 'granted';

  const micStatus = mic?.status ?? 'unsupported';
  const micSupported = micStatus !== 'unsupported';
  const micGranted = micStatus === 'granted';

  if (!screenSupported && !accessibilitySupported && !micSupported) {
    return (
      <SettingsSection
        title="System permissions"
        description="Per-app permissions don't apply on this OS — CofounderOS uses standard system APIs."
      >
        <p className="text-sm text-muted-foreground">
          Nothing to manage here on your platform.
        </p>
      </SettingsSection>
    );
  }

  return (
    <>
      {screenNeedsRelaunch && (
        <Alert variant="warning">
          <RefreshCw />
          <AlertTitle>Restart required to apply Screen Recording</AlertTitle>
          <AlertDescription>
            macOS only honours the new Screen Recording grant after the next launch.
            <div className="mt-3">
              <Button size="sm" onClick={() => void window.cofounderos.relaunchApp()}>
                <RefreshCw />
                Restart CofounderOS
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}
      <SettingsSection
        title="System permissions"
        description="CofounderOS asks for these only to power local capture. Toggle them in System Settings any time."
      >
        <div className="flex flex-col gap-3">
          {screenSupported && (
            <SettingsPermissionRow
              icon={<Monitor className="size-5" />}
              title="Screen Recording"
              requirement="required"
              granted={screenGranted}
              needsRelaunch={screenNeedsRelaunch}
              statusText={
                screenGranted
                  ? screenNeedsRelaunch
                    ? 'Granted — restart to apply.'
                    : 'Granted. Capture can take screenshots.'
                  : screenStatus === 'denied'
                    ? 'Denied. Capture cannot take screenshots.'
                    : screenStatus === 'restricted'
                      ? 'Restricted by a profile. CofounderOS cannot capture.'
                      : 'Not granted yet.'
              }
              busy={requesting === 'screen'}
              onRequest={() => void request('screen')}
              onOpenSettings={() =>
                void window.cofounderos.openPermissionSettings('screen')
              }
            />
          )}
          {accessibilitySupported && (
            <SettingsPermissionRow
              icon={<Keyboard className="size-5" />}
              title="Accessibility"
              requirement="recommended"
              granted={accessibilityGranted}
              statusText={
                accessibilityGranted
                  ? 'Granted. Window focus and on-screen text are available.'
                  : 'Not granted. Capture falls back to OCR-only text and reduced window metadata.'
              }
              busy={requesting === 'accessibility'}
              onRequest={() => void request('accessibility')}
              onOpenSettings={() =>
                void window.cofounderos.openPermissionSettings('accessibility')
              }
            />
          )}
          {micSupported && (
            <SettingsPermissionRow
              icon={<Mic className="size-5" />}
              title="Microphone"
              requirement="optional"
              granted={micGranted}
              statusText={
                micGranted
                  ? 'Granted. Live audio capture can record while another app uses the mic.'
                  : micStatus === 'denied'
                    ? 'Denied. Live audio capture is disabled.'
                    : micStatus === 'restricted'
                      ? 'Restricted by a profile. Live audio capture is disabled.'
                      : 'Not requested yet. CofounderOS will prompt when audio capture starts.'
              }
              busy={requesting === 'microphone'}
              onRequest={() => void request('microphone')}
              onOpenSettings={() =>
                void window.cofounderos.openPermissionSettings('microphone')
              }
            />
          )}
        </div>
      </SettingsSection>
    </>
  );
}

function SettingsPermissionRow({
  icon,
  title,
  requirement,
  granted,
  needsRelaunch,
  statusText,
  busy,
  onRequest,
  onOpenSettings,
}: {
  icon: React.ReactNode;
  title: string;
  requirement: 'required' | 'recommended' | 'optional';
  granted: boolean;
  needsRelaunch?: boolean;
  statusText: string;
  busy: boolean;
  onRequest: () => void;
  onOpenSettings: () => void;
}) {
  const requirementBadge =
    requirement === 'required' ? (
      <Badge>Required</Badge>
    ) : requirement === 'recommended' ? (
      <Badge variant="muted">Recommended</Badge>
    ) : (
      <Badge variant="outline">Optional</Badge>
    );
  return (
    <div
      className={cn(
        'flex flex-wrap items-start gap-4 rounded-lg border bg-card p-4',
        granted ? 'border-success/30 bg-success/5' : undefined,
      )}
    >
      <div
        className={cn(
          'size-10 shrink-0 grid place-items-center rounded-md',
          granted ? 'bg-success/15 text-success' : 'bg-primary/10 text-primary',
        )}
      >
        {granted ? <Check className="size-4" /> : icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="text-sm font-medium">{title}</h4>
          {requirementBadge}
          {granted && (
            <Badge variant="outline" className="border-success/40 text-success">
              <CheckCircle2 />
              Granted
            </Badge>
          )}
          {needsRelaunch && (
            <Badge variant="outline" className="border-warning/40 text-warning">
              <RefreshCw />
              Restart needed
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">{statusText}</p>
      </div>
      <div className="flex items-center gap-2">
        {!granted && (
          <Button size="sm" onClick={onRequest} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            Grant access
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onOpenSettings}>
          <ExternalLink />
          System Settings
        </Button>
      </div>
    </div>
  );
}

function SettingsSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <div>
          <h3 className="text-sm font-semibold">{title}</h3>
          {description ? (
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

function InfoTip({ content }: { content: string }) {
  const [open, setOpen] = React.useState(false);
  const [pinned, setPinned] = React.useState(false);
  const lines = content.split('\n').filter(Boolean);

  function setPinnedOpen(next: boolean) {
    setPinned(next);
    setOpen(next);
  }

  return (
    <TooltipPrimitive.Provider delayDuration={120} skipDelayDuration={0}>
      <TooltipPrimitive.Root
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setPinned(false);
        }}
      >
        <TooltipPrimitive.Trigger asChild>
          <button
            type="button"
            className="inline-flex size-5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            aria-label="Show setting help"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setPinnedOpen(!pinned);
            }}
            onPointerEnter={() => setOpen(true)}
            onPointerLeave={() => {
              if (!pinned) setOpen(false);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => {
              if (!pinned) setOpen(false);
            }}
          >
            <HelpCircle className="size-3.5" />
          </button>
        </TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side="top"
            align="start"
            sideOffset={7}
            collisionPadding={12}
            className="z-50 max-w-72 rounded-md border bg-popover px-3 py-2 text-xs leading-relaxed text-popover-foreground shadow-md"
          >
            {lines.map((line, index) => (
              <div
                key={`${line}-${index}`}
                className={cn(index > 0 && 'mt-1 text-muted-foreground')}
              >
                {line}
              </div>
            ))}
            <TooltipPrimitive.Arrow className="fill-popover" />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}

function Field({
  label,
  hint,
  typeLabel,
  rangeLabel,
  children,
}: {
  label: string;
  hint?: string;
  typeLabel?: string;
  rangeLabel?: string;
  children: React.ReactNode;
}) {
  const tooltip = [
    hint,
    typeLabel ? `Type: ${typeLabel}` : null,
    rangeLabel ? `Range: ${rangeLabel}` : null,
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex min-h-5 flex-wrap items-center gap-2">
        <Label>{label}</Label>
        {typeLabel ? (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.04em] text-muted-foreground">
            {typeLabel}
          </span>
        ) : null}
        {rangeLabel ? (
          <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {rangeLabel}
          </span>
        ) : null}
        {tooltip ? <InfoTip content={tooltip} /> : null}
      </div>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  hint,
  typeLabel,
  placeholder,
  inputType = 'text',
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  typeLabel?: string;
  placeholder?: string;
  inputType?: React.HTMLInputTypeAttribute;
}) {
  return (
    <Field label={label} hint={hint} typeLabel={typeLabel}>
      <Input
        type={inputType}
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        placeholder={placeholder}
        autoComplete={inputType === 'password' ? 'off' : undefined}
        spellCheck={false}
      />
    </Field>
  );
}

function TextAreaField({
  label,
  value,
  onChange,
  hint,
  typeLabel,
  placeholder,
  rows = 4,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  typeLabel?: string;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <Field label={label} hint={hint} typeLabel={typeLabel}>
      <Textarea
        rows={rows}
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        placeholder={placeholder}
        spellCheck={false}
      />
    </Field>
  );
}

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step,
  unit,
  hint,
  typeLabel,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  hint?: string;
  typeLabel?: string;
}) {
  return (
    <Field
      label={label}
      hint={hint}
      typeLabel={typeLabel}
      rangeLabel={formatRange(min, max, unit)}
    >
      <Input
        type="number"
        min={min}
        max={max}
        step={step}
        value={Number.isFinite(value) ? value : ''}
        onChange={(e) => {
          const raw = e.currentTarget.value;
          onChange(raw.trim() === '' ? (min ?? 0) : Number(raw));
        }}
      />
    </Field>
  );
}

function OptionalNumberField({
  label,
  value,
  onChange,
  min,
  max,
  step,
  unit,
  hint,
  typeLabel,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  hint?: string;
  typeLabel?: string;
}) {
  return (
    <Field
      label={label}
      hint={hint}
      typeLabel={typeLabel}
      rangeLabel={formatRange(min, max, unit)}
    >
      <Input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        placeholder="blank"
      />
    </Field>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
  hint,
  typeLabel,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  hint?: string;
  typeLabel?: string;
}) {
  return (
    <Field label={label} hint={hint} typeLabel={typeLabel}>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

function formatRange(min?: number, max?: number, unit?: string): string | undefined {
  if (min == null && max == null) return unit;
  const body =
    min != null && max != null
      ? `${min}-${max}`
      : min != null
        ? `>= ${min}`
        : `<= ${max}`;
  return unit ? `${body} ${unit}` : body;
}

function ToggleRow({
  title,
  description,
  typeLabel,
  checked,
  onChange,
}: {
  title: string;
  description: string;
  typeLabel?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="font-medium">{title}</h4>
          {typeLabel ? (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.04em] text-muted-foreground">
              {typeLabel}
            </span>
          ) : null}
          <InfoTip content={`Type: ${typeLabel ?? 'boolean'}\n${description}`} />
        </div>
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

// ────────────────────────────────────────────────────────────────────────────
// AI / model picker
// ────────────────────────────────────────────────────────────────────────────

const CUSTOM_MODEL_ID = '__custom__';

/**
 * Model picker on the AI tab. Owns its own state because changing the
 * model is a discrete action (save config + force-pull weights + stream
 * progress) rather than a bag of generic settings the global SaveBar can
 * batch up. The `Host` and `Auto-install` fields stay in the parent
 * draft and ride the SaveBar — they're cheap to apply on next start.
 *
 * Two primary actions:
 * 1. **Apply model** — when the picked model differs from what's saved.
 *    Saves config, then runs a forced bootstrap so the new weights get
 *    pulled even if the tag is already cached.
 * 2. **Refresh weights** — when the picked model matches what's saved.
 *    Force-re-pulls under the same tag to pick up updated weights for
 *    floating tags like `gemma4:e2b` (Ollama re-uses cached blobs by
 *    content hash so a refresh with no actual new bytes is fast).
 *
 * Both share one progress bar; we infer phase from the bootstrap event
 * stream the runtime emits and the renderer already subscribes to in
 * App.tsx.
 */
function ModelSettings({
  savedModel,
  savedRevision,
  ollamaHost,
  ollamaAutoInstall,
  modelReady,
  bootstrapEvents,
  onClearBootstrapEvents,
  onHostChange,
  onAutoInstallChange,
  onModelChanged,
}: {
  savedModel: string;
  savedRevision: number;
  ollamaHost: string;
  ollamaAutoInstall: boolean;
  modelReady: boolean;
  bootstrapEvents: ModelBootstrapProgress[];
  onClearBootstrapEvents: () => void;
  onHostChange: (value: string) => void;
  onAutoInstallChange: (value: boolean) => void;
  onModelChanged: (config: LoadedConfig) => void;
}) {
  // Picker state: which radio is selected, and the custom-tag input.
  // We seed both from the saved config so the UI matches reality on
  // first paint and after a successful apply.
  const initialIsCustom = !MODEL_CHOICES.some((m) => m.id === savedModel);
  const [pickerId, setPickerId] = React.useState<string>(
    initialIsCustom ? CUSTOM_MODEL_ID : savedModel || MODEL_CHOICES[0]!.id,
  );
  const [customTag, setCustomTag] = React.useState<string>(
    initialIsCustom ? savedModel : '',
  );

  // Re-sync if the upstream `savedModel` changes (another window saved
  // settings, or we just finished an apply). We don't want to clobber
  // an in-flight selection mid-typing, so only sync when the saved
  // model differs from what the picker currently resolves to.
  const resolvedPickerModel =
    pickerId === CUSTOM_MODEL_ID ? customTag.trim() : pickerId;
  React.useEffect(() => {
    if (savedModel && savedModel !== resolvedPickerModel) {
      const isCustom = !MODEL_CHOICES.some((m) => m.id === savedModel);
      setPickerId(isCustom ? CUSTOM_MODEL_ID : savedModel);
      setCustomTag(isCustom ? savedModel : '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedModel]);

  // Action state: idle | running | done | error. Driven by the bootstrap
  // event stream so the bar still updates if the user navigates away
  // and back (events are buffered in App.tsx).
  const [phase, setPhase] = React.useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [intent, setIntent] = React.useState<'switch' | 'refresh' | null>(null);

  React.useEffect(() => {
    if (phase !== 'running') return;
    for (let i = bootstrapEvents.length - 1; i >= 0; i--) {
      const ev = bootstrapEvents[i]!;
      if (
        ev.kind === 'install_failed' ||
        ev.kind === 'pull_failed' ||
        ev.kind === 'server_failed'
      ) {
        setPhase('error');
        setErrorMessage(ev.reason || `${ev.kind} failed`);
        return;
      }
      if (ev.kind === 'ready') {
        setPhase('done');
        return;
      }
    }
  }, [bootstrapEvents, phase]);

  // Last pull-progress event drives the progress bar.
  const lastPullProgress = React.useMemo(() => {
    for (let i = bootstrapEvents.length - 1; i >= 0; i--) {
      const ev = bootstrapEvents[i]!;
      if (
        ev.kind === 'pull_progress' &&
        typeof ev.completed === 'number' &&
        typeof ev.total === 'number'
      ) {
        return ev;
      }
    }
    return null;
  }, [bootstrapEvents]);

  const customValid =
    pickerId !== CUSTOM_MODEL_ID || isPlausibleOllamaTag(customTag);
  const targetModel = resolvedPickerModel;
  const dirty = !!targetModel && targetModel !== savedModel;
  const canApply =
    !!targetModel && customValid && phase !== 'running';
  const canRefresh =
    !dirty && !!savedModel && phase !== 'running';

  async function applyAndPull(): Promise<void> {
    if (!canApply) return;
    setErrorMessage(null);
    onClearBootstrapEvents();
    setPhase('running');
    setIntent('switch');
    try {
      // Save the new model (and bump the revision so the marker file
      // is consistent — the force-pull would already do the work, but
      // bumping ensures a future restart doesn't try to "refresh"
      // again unnecessarily).
      const next = await window.cofounderos.saveConfigPatch({
        index: {
          model: {
            plugin: 'ollama',
            ollama: {
              model: targetModel,
              model_revision: savedRevision + 1,
              auto_install: true,
            },
          },
        },
      });
      onModelChanged(next);
      // Force-pull so the new weights actually land (and so a custom
      // tag pointing at fresh weights gets refreshed too).
      await window.cofounderos.updateModel();
      setPhase('done');
      toast.success(`Model switched to ${targetModel}`, {
        description: 'New weights are ready.',
      });
    } catch (err) {
      setPhase('error');
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMessage(msg);
      toast.error('Could not switch model', { description: msg });
    }
  }

  async function refreshWeights(): Promise<void> {
    if (!canRefresh) return;
    setErrorMessage(null);
    onClearBootstrapEvents();
    setPhase('running');
    setIntent('refresh');
    try {
      // Bump the revision so future restarts don't repeat this work.
      const next = await window.cofounderos.saveConfigPatch({
        index: {
          model: {
            plugin: 'ollama',
            ollama: { model_revision: savedRevision + 1 },
          },
        },
      });
      onModelChanged(next);
      await window.cofounderos.updateModel();
      setPhase('done');
      toast.success(`${savedModel} is up to date`);
    } catch (err) {
      setPhase('error');
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMessage(msg);
      toast.error('Could not refresh weights', { description: msg });
    }
  }

  const currentChoice = findModelChoice(savedModel);
  const statusLabel = phase === 'running'
    ? intent === 'refresh'
      ? 'Refreshing weights…'
      : 'Installing…'
    : modelReady
      ? 'Ready'
      : 'Not installed';
  const statusTone: 'success' | 'warning' | 'muted' =
    phase === 'running' ? 'muted' : modelReady ? 'success' : 'warning';

  return (
    <>
      <Card>
        <CardContent className="flex flex-col gap-4">
          {/* Current model summary */}
          <div className="flex items-start gap-3">
            <div className="size-10 shrink-0 grid place-items-center rounded-md bg-primary/10 text-primary">
              <Cpu className="size-5" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-semibold">Local AI model</h3>
                <StatusPill tone={statusTone} size="compact">{statusLabel}</StatusPill>
              </div>
              <p className="text-sm text-muted-foreground mt-0.5 break-all">
                <span className="font-mono">{savedModel || '(none)'}</span>
                {currentChoice && (
                  <span className="text-muted-foreground/80">
                    {' · '}
                    {currentChoice.vendor} · {currentChoice.size}
                  </span>
                )}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void refreshWeights()}
              disabled={!canRefresh}
              title={
                dirty
                  ? 'Apply the selected model first to refresh its weights.'
                  : 'Re-pull the current model to pick up updated weights under the same tag.'
              }
            >
              {phase === 'running' && intent === 'refresh' ? (
                <Loader2 className="animate-spin" />
              ) : (
                <RefreshCw />
              )}
              Refresh weights
            </Button>
          </div>

          <Separator />

          {/* Picker */}
          <div className="flex flex-col gap-3">
            <div>
              <h4 className="font-medium">Choose a model</h4>
              <p className="text-sm text-muted-foreground mt-0.5">
                Pick from popular options below, or paste any tag from{' '}
                <a
                  href="https://ollama.com/library"
                  target="_blank"
                  rel="noreferrer"
                  className="underline hover:text-foreground"
                >
                  ollama.com/library
                </a>
                .
              </p>
            </div>

            <RadioGroup
              value={pickerId}
              onValueChange={(v) => setPickerId(v)}
              className="grid gap-2 sm:grid-cols-2"
            >
              {MODEL_CHOICES.map((m) => {
                const isSaved = m.id === savedModel;
                return (
                  <Label
                    key={m.id}
                    htmlFor={`model-${m.id}`}
                    className={cn(
                      'flex cursor-pointer items-start gap-3 rounded-md border bg-card p-3 text-sm font-normal transition-colors',
                      pickerId === m.id
                        ? 'border-primary ring-2 ring-primary/20'
                        : 'hover:bg-accent/40',
                    )}
                  >
                    <RadioGroupItem value={m.id} id={`model-${m.id}`} className="mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{m.name}</span>
                        {m.badge && (
                          <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                            <Sparkles className="size-3" />
                            {m.badge}
                          </Badge>
                        )}
                        {isSaved && (
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                            Current
                          </Badge>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {m.vendor} · {m.size}
                        {m.vision ? ' · vision' : ''}
                      </div>
                      <div className="text-xs text-muted-foreground/90 mt-1 leading-relaxed">
                        {m.description}
                      </div>
                    </div>
                  </Label>
                );
              })}

              {/* Custom tag */}
              <Label
                htmlFor={`model-${CUSTOM_MODEL_ID}`}
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-md border bg-card p-3 text-sm font-normal transition-colors sm:col-span-2',
                  pickerId === CUSTOM_MODEL_ID
                    ? 'border-primary ring-2 ring-primary/20'
                    : 'hover:bg-accent/40',
                )}
              >
                <RadioGroupItem
                  value={CUSTOM_MODEL_ID}
                  id={`model-${CUSTOM_MODEL_ID}`}
                  className="mt-0.5"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">Custom Ollama model</span>
                    {pickerId === CUSTOM_MODEL_ID &&
                      customTag.trim() !== '' &&
                      customTag.trim() === savedModel && (
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                          Current
                        </Badge>
                      )}
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    Any model tag from ollama.com/library — e.g.{' '}
                    <span className="font-mono">qwen3:14b</span>,{' '}
                    <span className="font-mono">mistral:7b</span>,{' '}
                    <span className="font-mono">phi3:mini</span>.
                  </div>
                  <div className="mt-2">
                    <Input
                      value={customTag}
                      onChange={(e) => {
                        setCustomTag(e.currentTarget.value);
                        if (pickerId !== CUSTOM_MODEL_ID) setPickerId(CUSTOM_MODEL_ID);
                      }}
                      placeholder="family:tag"
                      autoComplete="off"
                      spellCheck={false}
                      onClick={(e) => e.stopPropagation()}
                    />
                    {pickerId === CUSTOM_MODEL_ID && customTag.trim() !== '' && !customValid && (
                      <p className="text-xs text-destructive mt-1">
                        That doesn't look like a valid Ollama tag. Use the{' '}
                        <span className="font-mono">family:tag</span> format, e.g.{' '}
                        <span className="font-mono">gemma4:e2b</span>.
                      </p>
                    )}
                  </div>
                </div>
              </Label>
            </RadioGroup>

            {/* Action row */}
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/30 p-3">
              <div className="text-sm">
                {dirty ? (
                  <>
                    <span className="font-medium">Apply </span>
                    <span className="font-mono">{targetModel}</span>
                    <span className="text-muted-foreground"> — downloads weights if needed.</span>
                  </>
                ) : modelReady ? (
                  <span className="text-muted-foreground">
                    Selection matches what's installed. Use{' '}
                    <span className="font-medium">Refresh weights</span> above to pick up
                    newer weights under the same tag.
                  </span>
                ) : (
                  <span className="text-muted-foreground">
                    Selection matches your saved config but isn't installed yet — apply to
                    download.
                  </span>
                )}
              </div>
              <Button
                onClick={() => void applyAndPull()}
                disabled={!canApply || (!dirty && modelReady)}
              >
                {phase === 'running' && intent === 'switch' ? (
                  <>
                    <Loader2 className="animate-spin" />
                    Working…
                  </>
                ) : (
                  <>
                    <Download />
                    {dirty ? 'Apply model' : 'Re-install'}
                  </>
                )}
              </Button>
            </div>

            {/* Live progress */}
            {phase === 'running' && (
              <ModelInstallProgress
                model={targetModel || savedModel}
                progress={lastPullProgress}
              />
            )}

            {phase === 'error' && errorMessage && (
              <Alert variant="destructive">
                <X />
                <AlertTitle>
                  {intent === 'refresh' ? 'Could not refresh weights' : 'Could not install model'}
                </AlertTitle>
                <AlertDescription>{errorMessage}</AlertDescription>
              </Alert>
            )}

            {bootstrapEvents.length > 0 && (
              <details className="text-xs">
                <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">
                  Show technical log
                </summary>
                <pre className="mt-2 max-h-40 overflow-auto rounded-md border bg-card p-3 font-mono text-[11px] leading-snug">
                  {bootstrapEvents.slice(-25).map(formatBootstrapLine).join('\n')}
                </pre>
              </details>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-0">
          <ToggleRow
            title="Auto-install AI tools when needed"
            description="Lets us set up Ollama and pull the model for you on first run."
            typeLabel="boolean"
            checked={ollamaAutoInstall}
            onChange={onAutoInstallChange}
          />
          <Separator className="my-4" />
          <TextField
            label="Ollama host"
            value={ollamaHost}
            onChange={onHostChange}
            typeLabel="URL"
            hint="The URL where the local Ollama daemon listens."
          />
        </CardContent>
      </Card>
    </>
  );
}

function ModelInstallProgress({
  model,
  progress,
}: {
  model: string;
  progress: ModelBootstrapProgress | null;
}) {
  const pct = progress ? pullPercent(progress) : null;
  const completed = typeof progress?.completed === 'number' ? progress.completed : 0;
  const total = typeof progress?.total === 'number' ? progress.total : 0;
  return (
    <div className="rounded-md border bg-card p-3 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium flex items-center gap-2 min-w-0">
          <Loader2 className="size-4 animate-spin text-primary" />
          <span className="truncate font-mono">{model}</span>
        </div>
        {pct != null && (
          <span className="text-xs text-muted-foreground">
            {pct}%
          </span>
        )}
      </div>
      {progress ? (
        <>
          <Progress value={pct ?? 0} />
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>{progress.status || 'downloading'}</span>
            <span>
              {formatBytes(completed)} / {formatBytes(total)}
            </span>
          </div>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">Preparing…</p>
      )}
    </div>
  );
}

function settingsDraftFromConfig(loaded: LoadedConfig): SettingsDraft {
  const cfg = loaded.config;
  const markdown = cfg.export.plugins.find((p) => p.name === 'markdown');
  const mcp = cfg.export.plugins.find((p) => p.name === 'mcp');
  const vacuum = cfg.storage.local.vacuum;
  const audio = cfg.capture.audio;
  const liveRecording = audio?.live_recording;
  const accessibility = cfg.capture.accessibility;
  const ollama = cfg.index.model.ollama;
  const openai = cfg.index.model.openai;
  const claude = cfg.index.model.claude;
  return {
    appName: cfg.app.name,
    appDataDir: cfg.app.data_dir,
    logLevel: cfg.app.log_level,
    sessionId: cfg.app.session_id ?? '',
    capturePlugin: cfg.capture.plugin,
    pollIntervalMs: cfg.capture.poll_interval_ms,
    idlePollIntervalMs: cfg.capture.idle_poll_interval_ms,
    focusSettleDelayMs: cfg.capture.focus_settle_delay_ms,
    screenshotDiffThreshold: cfg.capture.screenshot_diff_threshold,
    idleThresholdSec: cfg.capture.idle_threshold_sec,
    screenshotFormat: cfg.capture.screenshot_format,
    screenshotQuality: cfg.capture.screenshot_quality,
    jpegQuality: cfg.capture.jpeg_quality == null ? '' : String(cfg.capture.jpeg_quality),
    screenshotMaxDim: cfg.capture.screenshot_max_dim,
    contentChangeMinIntervalMs: cfg.capture.content_change_min_interval_ms,
    multiScreen: cfg.capture.multi_screen ?? false,
    screens: Array.isArray(cfg.capture.screens) ? cfg.capture.screens.join(', ') : '',
    captureMode: cfg.capture.capture_mode ?? 'active',
    blurPasswordFields: cfg.capture.privacy.blur_password_fields,
    pauseOnScreenLock: cfg.capture.privacy.pause_on_screen_lock,
    sensitiveKeywords: cfg.capture.privacy.sensitive_keywords.join('\n'),
    excludedApps: cfg.capture.excluded_apps.join('\n'),
    excludedUrlPatterns: cfg.capture.excluded_url_patterns.join('\n'),
    accessibilityEnabled: accessibility?.enabled ?? true,
    accessibilityTimeoutMs: accessibility?.timeout_ms ?? 1500,
    accessibilityMaxChars: accessibility?.max_chars ?? 8000,
    accessibilityMaxElements: accessibility?.max_elements ?? 4000,
    accessibilityExcludedApps: (accessibility?.excluded_apps ?? []).join('\n'),
    storagePlugin: cfg.storage.plugin,
    storagePath: cfg.storage.local.path,
    maxSizeGb: cfg.storage.local.max_size_gb,
    retentionDays: cfg.storage.local.retention_days,
    compressAfterDays: vacuum.compress_after_days,
    compressAfterMinutes:
      vacuum.compress_after_minutes == null ? '' : String(vacuum.compress_after_minutes),
    compressQuality: vacuum.compress_quality,
    thumbnailAfterDays: vacuum.thumbnail_after_days,
    thumbnailAfterMinutes:
      vacuum.thumbnail_after_minutes == null ? '' : String(vacuum.thumbnail_after_minutes),
    thumbnailMaxDim: vacuum.thumbnail_max_dim,
    deleteAfterDays: vacuum.delete_after_days,
    deleteAfterMinutes:
      vacuum.delete_after_minutes == null ? '' : String(vacuum.delete_after_minutes),
    vacuumTickIntervalMin: vacuum.tick_interval_min,
    vacuumBatchSize: vacuum.batch_size,
    indexStrategy: cfg.index.strategy,
    indexPath: cfg.index.index_path,
    incrementalIntervalMin: cfg.index.incremental_interval_min,
    reorganiseSchedule: cfg.index.reorganise_schedule,
    reorganiseOnIdle: cfg.index.reorganise_on_idle,
    indexIdleTriggerMin: cfg.index.idle_trigger_min,
    indexBatchSize: cfg.index.batch_size,
    sessionsIdleThresholdSec: cfg.index.sessions.idle_threshold_sec,
    sessionsAfkThresholdSec: cfg.index.sessions.afk_threshold_sec,
    sessionsMinActiveMs: cfg.index.sessions.min_active_ms,
    sessionsFallbackFrameAttentionMs: cfg.index.sessions.fallback_frame_attention_ms,
    meetingsIdleThresholdSec: cfg.index.meetings.idle_threshold_sec,
    meetingsMinDurationSec: cfg.index.meetings.min_duration_sec,
    meetingsAudioGraceSec: cfg.index.meetings.audio_grace_sec,
    meetingsSummarize: cfg.index.meetings.summarize,
    meetingsSummarizeCooldownSec: cfg.index.meetings.summarize_cooldown_sec,
    meetingsVisionAttachments: cfg.index.meetings.vision_attachments,
    embeddingsEnabled: cfg.index.embeddings.enabled,
    embeddingsBatchSize: cfg.index.embeddings.batch_size,
    embeddingsTickIntervalMin: cfg.index.embeddings.tick_interval_min,
    embeddingsSearchWeight: cfg.index.embeddings.search_weight,
    modelPlugin: cfg.index.model.plugin,
    ollamaHost: ollama?.host ?? 'http://127.0.0.1:11434',
    ollamaAutoInstall: ollama?.auto_install ?? true,
    ollamaEmbeddingModel: ollama?.embedding_model ?? 'nomic-embed-text',
    ollamaVisionModel: ollama?.vision_model ?? '',
    ollamaIndexerModel: ollama?.indexer_model ?? '',
    ollamaKeepAlive: String(ollama?.keep_alive ?? '30s'),
    ollamaUnloadAfterIdleMin: ollama?.unload_after_idle_min ?? 0,
    ollamaModelRevision: ollama?.model_revision ?? 0,
    openaiApiKey: openai?.api_key ?? '',
    openaiBaseUrl: openai?.base_url ?? 'https://api.openai.com/v1',
    openaiModel: openai?.model ?? 'gpt-4o-mini',
    openaiVisionModel: openai?.vision_model ?? '',
    openaiEmbeddingModel: openai?.embedding_model ?? 'text-embedding-3-small',
    claudeApiKey: claude?.api_key ?? '',
    claudeModel: claude?.model ?? 'claude-sonnet-4-6',
    markdownEnabled: markdown?.enabled ?? true,
    markdownPath: typeof markdown?.path === 'string' ? markdown.path : '',
    mcpEnabled: mcp?.enabled ?? true,
    mcpHost: typeof mcp?.host === 'string' ? mcp.host : '127.0.0.1',
    mcpPort: typeof mcp?.port === 'number' ? mcp.port : 3456,
    mcpTransport: mcp?.transport === 'stdio' ? 'stdio' : 'http',
    mcpTextExcerptChars:
      typeof mcp?.text_excerpt_chars === 'number' ? mcp.text_excerpt_chars : 5000,
    extraExportPlugins: cfg.export.plugins.filter((p) => p.name !== 'markdown' && p.name !== 'mcp'),
    captureAudio: cfg.capture.capture_audio ?? true,
    whisperModel: cfg.capture.whisper_model ?? 'base',
    audioInboxPath: audio?.inbox_path ?? '~/.cofounderOS/raw/audio/inbox',
    audioProcessedPath: audio?.processed_path ?? '~/.cofounderOS/raw/audio/processed',
    audioFailedPath: audio?.failed_path ?? '~/.cofounderOS/raw/audio/failed',
    audioTickIntervalSec: audio?.tick_interval_sec ?? 60,
    audioBatchSize: audio?.batch_size ?? 5,
    whisperCommand: audio?.whisper_command ?? 'whisper',
    whisperLanguage: audio?.whisper_language ?? '',
    maxAudioBytes: audio?.max_audio_bytes ?? 500 * 1024 * 1024,
    minAudioBytesPerSec: audio?.min_audio_bytes_per_sec ?? 4096,
    minAudioRateCheckMs: audio?.min_audio_rate_check_ms ?? 5000,
    liveRecordingEnabled: liveRecording?.enabled ?? false,
    liveRecordingFormat: liveRecording?.format ?? 'm4a',
    liveRecordingSampleRate: liveRecording?.sample_rate ?? 16_000,
    liveRecordingChannels: liveRecording?.channels ?? 1,
    liveRecordingPollIntervalSec: liveRecording?.poll_interval_sec ?? 3,
    systemAudioBackend: liveRecording?.system_audio_backend ?? 'core_audio_tap',
    chunkSeconds: liveRecording?.chunk_seconds ?? 300,
    deleteAudioAfterTranscribe: audio?.delete_audio_after_transcribe ?? true,
    backgroundModelJobs: cfg.system.background_model_jobs,
    loadGuardEnabled: cfg.system.load_guard.enabled,
    loadGuardThreshold: cfg.system.load_guard.threshold,
    loadGuardMemoryThreshold: cfg.system.load_guard.memory_threshold,
    loadGuardLowBatteryThresholdPct: cfg.system.load_guard.low_battery_threshold_pct,
    loadGuardMaxConsecutiveSkips: cfg.system.load_guard.max_consecutive_skips,
  };
}

function configPatchFromDraft(draft: SettingsDraft) {
  const screens = integerList(draft.screens);
  return {
    app: {
      name: draft.appName.trim() || 'CofounderOS',
      data_dir: draft.appDataDir.trim() || '~/.cofounderOS',
      log_level: draft.logLevel,
      session_id: optionalString(draft.sessionId),
    },
    capture: {
      plugin:
        draft.captureAudio && draft.liveRecordingEnabled
          ? 'native'
          : draft.capturePlugin.trim() || 'node',
      poll_interval_ms: clampInt(draft.pollIntervalMs, 1),
      idle_poll_interval_ms: clampInt(draft.idlePollIntervalMs, 1),
      focus_settle_delay_ms: clampInt(draft.focusSettleDelayMs, 0),
      screenshot_diff_threshold: clampNumber(draft.screenshotDiffThreshold, 0, 1),
      idle_threshold_sec: clampInt(draft.idleThresholdSec, 1),
      screenshot_format: draft.screenshotFormat,
      screenshot_quality: clampInt(draft.screenshotQuality, 1, 100),
      jpeg_quality: optionalInt(draft.jpegQuality, 1, 100),
      screenshot_max_dim: clampInt(draft.screenshotMaxDim, 0, 8192),
      content_change_min_interval_ms: clampInt(draft.contentChangeMinIntervalMs, 0),
      multi_screen: draft.multiScreen,
      screens: screens.length > 0 ? screens : null,
      capture_mode: draft.captureMode,
      excluded_apps: lines(draft.excludedApps),
      excluded_url_patterns: lines(draft.excludedUrlPatterns),
      accessibility: {
        enabled: draft.accessibilityEnabled,
        timeout_ms: clampInt(draft.accessibilityTimeoutMs, 1),
        max_chars: clampInt(draft.accessibilityMaxChars, 1),
        max_elements: clampInt(draft.accessibilityMaxElements, 1),
        excluded_apps: lines(draft.accessibilityExcludedApps),
      },
      privacy: {
        blur_password_fields: draft.blurPasswordFields,
        pause_on_screen_lock: draft.pauseOnScreenLock,
        sensitive_keywords: lines(draft.sensitiveKeywords),
      },
      capture_audio: draft.captureAudio,
      whisper_model: draft.whisperModel.trim() || 'base',
      audio: {
        inbox_path: draft.audioInboxPath.trim() || '~/.cofounderOS/raw/audio/inbox',
        processed_path:
          draft.audioProcessedPath.trim() || '~/.cofounderOS/raw/audio/processed',
        failed_path: draft.audioFailedPath.trim() || '~/.cofounderOS/raw/audio/failed',
        tick_interval_sec: clampInt(draft.audioTickIntervalSec, 1),
        batch_size: clampInt(draft.audioBatchSize, 1),
        whisper_command: draft.whisperCommand.trim() || 'whisper',
        whisper_language: optionalString(draft.whisperLanguage),
        delete_audio_after_transcribe: draft.deleteAudioAfterTranscribe,
        max_audio_bytes: clampInt(draft.maxAudioBytes, 0),
        min_audio_bytes_per_sec: clampInt(draft.minAudioBytesPerSec, 0),
        min_audio_rate_check_ms: clampInt(draft.minAudioRateCheckMs, 0),
        live_recording: {
          enabled: draft.liveRecordingEnabled,
          activation: 'other_process_input',
          system_audio_backend: draft.systemAudioBackend,
          poll_interval_sec: clampInt(draft.liveRecordingPollIntervalSec, 1),
          chunk_seconds: clampInt(draft.chunkSeconds, 1),
          format: draft.liveRecordingFormat,
          sample_rate: clampInt(draft.liveRecordingSampleRate, 1),
          channels: clampInt(draft.liveRecordingChannels, 1, 2),
        },
      },
    },
    storage: {
      plugin: draft.storagePlugin.trim() || 'local',
      local: {
        path: draft.storagePath.trim() || '~/.cofounderOS',
        max_size_gb: clampNumber(draft.maxSizeGb, 0.1),
        retention_days: clampInt(draft.retentionDays, 0),
        vacuum: {
          compress_after_days: clampInt(draft.compressAfterDays, 0),
          compress_after_minutes: optionalInt(draft.compressAfterMinutes, 0),
          compress_quality: clampInt(draft.compressQuality, 1, 100),
          thumbnail_after_days: clampInt(draft.thumbnailAfterDays, 0),
          thumbnail_after_minutes: optionalInt(draft.thumbnailAfterMinutes, 0),
          thumbnail_max_dim: clampInt(draft.thumbnailMaxDim, 64, 2048),
          delete_after_days: clampInt(draft.deleteAfterDays, 0),
          delete_after_minutes: optionalInt(draft.deleteAfterMinutes, 0),
          tick_interval_min: clampInt(draft.vacuumTickIntervalMin, 1),
          batch_size: clampInt(draft.vacuumBatchSize, 1),
        },
      },
    },
    index: {
      strategy: draft.indexStrategy.trim() || 'karpathy',
      index_path: draft.indexPath.trim() || '~/.cofounderOS/index',
      incremental_interval_min: clampInt(draft.incrementalIntervalMin, 1),
      reorganise_schedule: draft.reorganiseSchedule.trim() || '0 2 * * *',
      reorganise_on_idle: draft.reorganiseOnIdle,
      idle_trigger_min: clampInt(draft.indexIdleTriggerMin, 1),
      batch_size: clampInt(draft.indexBatchSize, 1),
      sessions: {
        idle_threshold_sec: clampInt(draft.sessionsIdleThresholdSec, 1),
        afk_threshold_sec: clampInt(draft.sessionsAfkThresholdSec, 1),
        min_active_ms: clampInt(draft.sessionsMinActiveMs, 0),
        fallback_frame_attention_ms: clampInt(draft.sessionsFallbackFrameAttentionMs, 1),
      },
      meetings: {
        idle_threshold_sec: clampInt(draft.meetingsIdleThresholdSec, 1),
        min_duration_sec: clampInt(draft.meetingsMinDurationSec, 0),
        audio_grace_sec: clampInt(draft.meetingsAudioGraceSec, 0),
        summarize: draft.meetingsSummarize,
        summarize_cooldown_sec: clampInt(draft.meetingsSummarizeCooldownSec, 0),
        vision_attachments: clampInt(draft.meetingsVisionAttachments, 0),
      },
      embeddings: {
        enabled: draft.embeddingsEnabled,
        batch_size: clampInt(draft.embeddingsBatchSize, 1),
        tick_interval_min: clampInt(draft.embeddingsTickIntervalMin, 1),
        search_weight: clampNumber(draft.embeddingsSearchWeight, 0.01),
      },
      model: {
        plugin: draft.modelPlugin.trim() || 'ollama',
        ollama: {
          // Note: `model` and `model_revision` are managed by the AI
          // tab's dedicated picker (see ModelSettings). The generic
          // SaveBar exposes every other model runtime setting.
          host: draft.ollamaHost.trim(),
          auto_install: draft.ollamaAutoInstall,
          embedding_model: draft.ollamaEmbeddingModel.trim() || 'nomic-embed-text',
          vision_model: optionalString(draft.ollamaVisionModel),
          indexer_model: optionalString(draft.ollamaIndexerModel),
          keep_alive: draft.ollamaKeepAlive.trim() || '30s',
          unload_after_idle_min: clampNumber(draft.ollamaUnloadAfterIdleMin, 0),
          model_revision: clampInt(draft.ollamaModelRevision, 0),
        },
        openai: {
          api_key: optionalString(draft.openaiApiKey),
          base_url: draft.openaiBaseUrl.trim() || 'https://api.openai.com/v1',
          model: draft.openaiModel.trim() || 'gpt-4o-mini',
          vision_model: optionalString(draft.openaiVisionModel),
          embedding_model:
            draft.openaiEmbeddingModel.trim() || 'text-embedding-3-small',
        },
        claude: {
          api_key: optionalString(draft.claudeApiKey),
          model: draft.claudeModel.trim() || 'claude-sonnet-4-6',
        },
      },
    },
    export: {
      plugins: [
        {
          name: 'markdown',
          enabled: draft.markdownEnabled,
          path: draft.markdownPath.trim(),
        },
        {
          name: 'mcp',
          enabled: draft.mcpEnabled,
          host: draft.mcpHost.trim() || '127.0.0.1',
          port: clampInt(draft.mcpPort, 1, 65535),
          transport: draft.mcpTransport,
          text_excerpt_chars: clampInt(draft.mcpTextExcerptChars, 0),
        },
        ...draft.extraExportPlugins,
      ],
    },
    system: {
      background_model_jobs: draft.backgroundModelJobs,
      load_guard: {
        enabled: draft.loadGuardEnabled,
        threshold: clampNumber(draft.loadGuardThreshold, 0.01, 8),
        memory_threshold: clampNumber(draft.loadGuardMemoryThreshold, 0.01, 1),
        low_battery_threshold_pct: clampInt(
          draft.loadGuardLowBatteryThresholdPct,
          0,
          100,
        ),
        max_consecutive_skips: clampInt(draft.loadGuardMaxConsecutiveSkips, 0),
      },
    },
  };
}

function lines(s: string): string[] {
  return s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

function integerList(s: string): number[] {
  return s
    .split(/[,\s]+/)
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value >= 0);
}

function optionalString(s: string): string | undefined {
  const value = s.trim();
  return value ? value : undefined;
}

function optionalInt(s: string, min: number, max?: number): number | undefined {
  const value = s.trim();
  if (!value) return undefined;
  return clampInt(Number(value), min, max);
}

function clampInt(value: number, min: number, max?: number): number {
  return Math.round(clampNumber(value, min, max));
}

function clampNumber(value: number, min: number, max?: number): number {
  const finite = Number.isFinite(value) ? value : min;
  const lower = Math.max(finite, min);
  return max == null ? lower : Math.min(lower, max);
}
