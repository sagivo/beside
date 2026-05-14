import * as React from 'react';
import { Plus, Plug, Pencil, Trash2, Save, Power, X, Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/sonner';
import { cn } from '@/lib/utils';
import { NumberField, SelectField, SettingsSection, TextAreaField, TextField, ToggleRow } from '@/screens/settings/settings-controls';
import type {
  CaptureHookDefinition,
  CaptureHookDiagnostics,
  CaptureHookInputKind,
  CaptureHookMatcher,
  CaptureHookWidgetManifest,
  CaptureHookWidgetManifestRuntime,
  LoadedConfig,
} from '@/global';

/**
 * Visual editor for the capture hook system.
 *
 * - Lists hook plugin refs from `config.hooks.plugins` with enable toggles
 *   and badges showing which hook ids each plugin contributes at runtime.
 * - Lists config-defined hooks from `config.hooks.definitions` with edit
 *   and delete affordances.
 * - "Add hook" opens a dialog form that produces a `CaptureHookDefinition`.
 *
 * Saves are done through `window.beside.saveConfigPatch({ hooks: ... })`,
 * which restarts the runtime so new/removed plugin hooks take effect.
 */

interface HookSettingsProps {
  config: LoadedConfig | null;
  onSaved: (config: LoadedConfig) => void;
}

const BUILTIN_PLUGIN_NAMES = ['calendar', 'followups'] as const;
const INPUT_KIND_OPTIONS: Array<{ value: CaptureHookInputKind; label: string }> = [
  { value: 'screen', label: 'Screen (screenshot + OCR)' },
  { value: 'audio', label: 'Audio (transcript)' },
];
const BUILTIN_WIDGET_OPTIONS = [
  { value: 'list', label: 'Generic list' },
  { value: 'calendar', label: 'Calendar' },
  { value: 'followups', label: 'Follow-ups' },
  { value: 'json', label: 'Raw JSON' },
];

export function HookSettings({ config, onSaved }: HookSettingsProps): React.JSX.Element {
  const [hooksEnabled, setHooksEnabled] = React.useState(true);
  const [pluginRefs, setPluginRefs] = React.useState<Array<{ name: string; enabled: boolean }>>([]);
  const [definitions, setDefinitions] = React.useState<CaptureHookDefinition[]>([]);
  const [throttleDefault, setThrottleDefault] = React.useState(60_000);
  const [maxRecords, setMaxRecords] = React.useState(2_000);

  const [runtimeDefs, setRuntimeDefs] = React.useState<CaptureHookDefinition[]>([]);
  const [widgetManifests, setWidgetManifests] = React.useState<CaptureHookWidgetManifestRuntime[]>([]);
  const [diagnostics, setDiagnostics] = React.useState<CaptureHookDiagnostics[]>([]);

  const [editingIndex, setEditingIndex] = React.useState<number | null>(null);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  // Hydrate state from config.
  React.useEffect(() => {
    if (!config) return;
    const h = config.config.hooks ?? {};
    setHooksEnabled(h.enabled !== false);
    setPluginRefs(
      (h.plugins ?? []).map((p) => ({ name: p.name, enabled: p.enabled !== false })),
    );
    setDefinitions(((h.definitions ?? []) as CaptureHookDefinition[]).map(cloneDefinition));
    setThrottleDefault(h.throttle_ms_default ?? 60_000);
    setMaxRecords(h.max_records_per_hook ?? 2_000);
  }, [config]);

  // Load live runtime state so users can see what hooks/widgets are active right now.
  React.useEffect(() => {
    let cancelled = false;
    const loadStatic = async () => {
      try {
        const [defs, widgets] = await Promise.all([
          window.beside.listCaptureHookDefinitions(),
          window.beside.listCaptureHookWidgetManifests(),
        ]);
        if (!cancelled) {
          setRuntimeDefs(defs);
          setWidgetManifests(widgets);
        }
      } catch {
        // runtime may be stopped; that's fine
      }
    };
    const loadDiagnostics = async () => {
      try {
        const diag = await window.beside.getCaptureHookDiagnostics();
        if (!cancelled) setDiagnostics(diag);
      } catch {
        if (!cancelled) setDiagnostics([]);
      }
    };
    void loadStatic();
    void loadDiagnostics();
    const handle = setInterval(loadDiagnostics, 3000);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [config]);

  const diagnosticsById = React.useMemo(() => {
    const out = new Map<string, CaptureHookDiagnostics>();
    for (const d of diagnostics) out.set(d.hookId, d);
    return out;
  }, [diagnostics]);

  const initialSerialized = React.useMemo(() => serializeHooksState(config), [config]);
  const currentSerialized = JSON.stringify({
    enabled: hooksEnabled,
    plugins: pluginRefs,
    definitions,
    throttle_ms_default: throttleDefault,
    max_records_per_hook: maxRecords,
  });
  const hasUnsavedChanges = initialSerialized !== currentSerialized;

  if (!config) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-32 w-full rounded-lg" />
        <Skeleton className="h-32 w-full rounded-lg" />
      </div>
    );
  }

  const resetDraft = () => {
    const h = config.config.hooks ?? {};
    setHooksEnabled(h.enabled !== false);
    setPluginRefs((h.plugins ?? []).map((p) => ({ name: p.name, enabled: p.enabled !== false })));
    setDefinitions(((h.definitions ?? []) as CaptureHookDefinition[]).map(cloneDefinition));
    setThrottleDefault(h.throttle_ms_default ?? 60_000);
    setMaxRecords(h.max_records_per_hook ?? 2_000);
  };

  async function save(opts: { restart?: boolean } = {}) {
    if (!hasUnsavedChanges) return;
    setSaving(true);
    try {
      const patch = {
        hooks: {
          enabled: hooksEnabled,
          plugins: pluginRefs.map((p) => ({ name: p.name, enabled: p.enabled })),
          definitions: definitions.map(serializeDefinition),
          throttle_ms_default: clampInt(throttleDefault, 0),
          max_records_per_hook: clampInt(maxRecords, 1),
        },
      };
      const next = await window.beside.saveConfigPatch(patch);
      onSaved(next);
      if (opts.restart) {
        await window.beside.stopRuntime();
        await window.beside.startRuntime();
        toast.success('Hook settings saved & runtime restarted');
      } else {
        toast.success('Hook settings saved', {
          description: 'Restart the runtime to load new or removed plugin hooks.',
        });
      }
    } catch (err: any) {
      toast.error('Could not save hook settings', { description: err?.message ?? String(err) });
    } finally {
      setSaving(false);
    }
  }

  function addPluginRef(name: string) {
    if (!name.trim()) return;
    if (pluginRefs.some((p) => p.name === name.trim())) {
      toast.error(`Plugin "${name}" is already added`);
      return;
    }
    setPluginRefs([...pluginRefs, { name: name.trim(), enabled: true }]);
  }

  function togglePluginRef(index: number, enabled: boolean) {
    setPluginRefs(pluginRefs.map((p, i) => (i === index ? { ...p, enabled } : p)));
  }

  function removePluginRef(index: number) {
    setPluginRefs(pluginRefs.filter((_, i) => i !== index));
  }

  function openEditor(index: number | null) {
    setEditingIndex(index);
    setDialogOpen(true);
  }

  function saveDefinition(def: CaptureHookDefinition) {
    if (editingIndex == null) setDefinitions([...definitions, def]);
    else setDefinitions(definitions.map((d, i) => (i === editingIndex ? def : d)));
    setDialogOpen(false);
    setEditingIndex(null);
  }

  function deleteDefinition(index: number) {
    setDefinitions(definitions.filter((_, i) => i !== index));
  }

  const pluginRuntimeByName = new Map<string, CaptureHookDefinition[]>();
  for (const def of runtimeDefs) {
    const widget = widgetManifests.find((w) => w.hookId === def.id);
    const pluginName = widget?.pluginName ?? null;
    if (!pluginName) continue;
    const arr = pluginRuntimeByName.get(pluginName) ?? [];
    arr.push(def);
    pluginRuntimeByName.set(pluginName, arr);
  }

  return (
    <div className="flex flex-col gap-4 pb-24">
      <SettingsSection
        title="Capture hooks"
        description="Run custom logic on every interesting screenshot + OCR or audio + transcript capture. Each hook owns an isolated record store and can render its own dashboard widget."
      >
        <ToggleRow
          title="Enable capture hooks"
          description="Turns the entire hook engine on or off. When off, no plugin or config-defined hook runs."
          typeLabel="boolean"
          checked={hooksEnabled}
          onChange={setHooksEnabled}
        />
        <Separator className="my-2" />
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField
            label="Default throttle"
            value={throttleDefault}
            onChange={setThrottleDefault}
            min={0}
            step={1000}
            unit="ms"
            typeLabel="integer"
            hint="Per-surface debounce when a hook doesn't set its own throttleMs."
          />
          <NumberField
            label="Max records per hook"
            value={maxRecords}
            onChange={setMaxRecords}
            min={1}
            step={100}
            typeLabel="integer"
            hint="Soft cap on stored records per hook namespace."
          />
        </div>
      </SettingsSection>

      <SettingsSection
        title="Hook plugins"
        description="Plugins discovered in plugins/hook/* contribute hook definitions. Toggle them off here to skip loading them on next start."
      >
        <div className="flex flex-col gap-2">
          {pluginRefs.length === 0 && (
            <p className="text-sm text-muted-foreground">No hook plugins configured yet.</p>
          )}
          {pluginRefs.map((ref, idx) => {
            const defs = pluginRuntimeByName.get(ref.name) ?? [];
            const pluginDiagnostics = defs
              .map((d) => diagnosticsById.get(d.id))
              .filter((d): d is CaptureHookDiagnostics => !!d);
            return (
              <PluginRow
                key={ref.name}
                ref={ref}
                runtimeDefinitions={defs}
                diagnostics={pluginDiagnostics}
                onToggle={(enabled) => togglePluginRef(idx, enabled)}
                onRemove={() => removePluginRef(idx)}
              />
            );
          })}
        </div>
        <Separator className="my-2" />
        <AddPluginRow
          existing={pluginRefs.map((p) => p.name)}
          onAdd={addPluginRef}
        />
      </SettingsSection>

      <SettingsSection
        title="Custom hooks"
        description="Define a hook in config that the engine runs against every matching capture. Hook output is stored in its own collection and rendered with a built-in widget."
      >
        <div className="flex flex-col gap-2">
          {definitions.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No custom hooks yet. Add one to wire a prompt to a built-in widget without writing a plugin.
            </p>
          )}
          {definitions.map((def, idx) => (
            <DefinitionRow
              key={`${def.id}:${idx}`}
              def={def}
              diagnostics={diagnosticsById.get(def.id) ?? null}
              onEdit={() => openEditor(idx)}
              onDelete={() => deleteDefinition(idx)}
            />
          ))}
        </div>
        <div className="flex justify-end">
          <Button size="sm" onClick={() => openEditor(null)}>
            <Plus className="size-4" /> Add hook
          </Button>
        </div>
      </SettingsSection>

      <HookSaveBar
        hasUnsavedChanges={hasUnsavedChanges}
        saving={saving}
        onSave={() => save()}
        onSaveAndRestart={() => save({ restart: true })}
        onReset={resetDraft}
      />

      <HookEditorDialog
        open={dialogOpen}
        initial={editingIndex == null ? null : definitions[editingIndex] ?? null}
        existingIds={definitions.map((d) => d.id)}
        onClose={() => {
          setDialogOpen(false);
          setEditingIndex(null);
        }}
        onSave={saveDefinition}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Plugin row + add affordance
// ---------------------------------------------------------------------------

function PluginRow({
  ref,
  runtimeDefinitions,
  diagnostics,
  onToggle,
  onRemove,
}: {
  ref: { name: string; enabled: boolean };
  runtimeDefinitions: CaptureHookDefinition[];
  diagnostics: CaptureHookDiagnostics[];
  onToggle: (enabled: boolean) => void;
  onRemove: () => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2 rounded-md border bg-background/55 p-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Plug className="size-3.5 text-muted-foreground" />
            <span className="text-sm font-medium">{ref.name}</span>
            {!ref.enabled && (
              <Badge variant="outline" className="text-[10px] uppercase">
                disabled
              </Badge>
            )}
          </div>
          {runtimeDefinitions.length > 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Contributes: {runtimeDefinitions.map((d) => d.title).join(', ')}
            </p>
          ) : ref.enabled ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Restart the runtime to load this plugin.
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Switch checked={ref.enabled} onCheckedChange={onToggle} />
          <Button size="icon" variant="ghost" onClick={onRemove} title="Remove plugin reference">
            <X className="size-4" />
          </Button>
        </div>
      </div>
      {diagnostics.map((d) => (
        <DiagnosticsLine key={d.hookId} diagnostics={d} />
      ))}
    </div>
  );
}

function AddPluginRow({
  existing,
  onAdd,
}: {
  existing: string[];
  onAdd: (name: string) => void;
}): React.JSX.Element {
  const [custom, setCustom] = React.useState('');
  const missingBuiltins = BUILTIN_PLUGIN_NAMES.filter((b) => !existing.includes(b));
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="flex flex-1 flex-col gap-1">
        <TextField
          label="Add plugin by name"
          value={custom}
          onChange={setCustom}
          placeholder="my-hook-plugin"
          typeLabel="string"
          hint="Must match the manifest name under plugins/hook/<name>/plugin.json."
        />
      </div>
      <Button
        size="sm"
        onClick={() => {
          onAdd(custom.trim());
          setCustom('');
        }}
        disabled={!custom.trim()}
      >
        <Plus className="size-4" /> Add
      </Button>
      {missingBuiltins.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>Built-ins:</span>
          {missingBuiltins.map((b) => (
            <Button key={b} size="sm" variant="outline" onClick={() => onAdd(b)}>
              {b}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Custom hook definition row
// ---------------------------------------------------------------------------

function DefinitionRow({
  def,
  diagnostics,
  onEdit,
  onDelete,
}: {
  def: CaptureHookDefinition;
  diagnostics: CaptureHookDiagnostics | null;
  onEdit: () => void;
  onDelete: () => void;
}): React.JSX.Element {
  const inputKinds = def.match.inputKinds ?? ['screen'];
  const triggerCount =
    (def.match.apps?.length ?? 0) +
    (def.match.urlHosts?.length ?? 0) +
    (def.match.urlPatterns?.length ?? 0) +
    (def.match.windowTitles?.length ?? 0);
  return (
    <Card>
      <CardContent className="flex items-start justify-between gap-3 p-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Sparkles className="size-3.5 text-primary" />
            <span className="text-sm font-medium">{def.title}</span>
            <span className="text-[10px] text-muted-foreground">id: {def.id}</span>
            {inputKinds.map((k) => (
              <Badge key={k} variant="outline" className="text-[10px] uppercase">
                {k}
              </Badge>
            ))}
            {def.widget?.builtin && (
              <Badge variant="outline" className="text-[10px] uppercase">
                widget: {def.widget.builtin}
              </Badge>
            )}
          </div>
          {def.description && (
            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{def.description}</p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">
            {triggerCount} matcher{triggerCount === 1 ? '' : 's'}
            {def.throttleMs ? ` · throttle ${def.throttleMs} ms` : ''}
            {def.outputCollection ? ` · collection ${def.outputCollection}` : ''}
          </p>
          {diagnostics && (
            <div className="mt-2">
              <DiagnosticsLine diagnostics={diagnostics} />
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button size="icon" variant="ghost" onClick={onEdit} title="Edit hook">
            <Pencil className="size-4" />
          </Button>
          <Button size="icon" variant="ghost" onClick={onDelete} title="Delete hook">
            <Trash2 className="size-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function DiagnosticsLine({ diagnostics }: { diagnostics: CaptureHookDiagnostics }): React.JSX.Element {
  const status: { tone: 'ok' | 'warn' | 'error' | 'idle'; label: string } = (() => {
    if (diagnostics.lastError) return { tone: 'error', label: diagnostics.lastError };
    if (diagnostics.stored > 0) return { tone: 'ok', label: `last stored ${formatTimeAgo(diagnostics.lastStoredAt)}` };
    if (diagnostics.ran > 0 && diagnostics.lastSkipReason)
      return { tone: 'warn', label: diagnostics.lastSkipReason };
    if (diagnostics.ran > 0) return { tone: 'warn', label: `${diagnostics.ran} run(s), 0 stored` };
    if (diagnostics.matched > 0) return { tone: 'warn', label: `${diagnostics.matched} match(es), ${diagnostics.throttled} throttled` };
    return { tone: 'idle', label: 'waiting for matching capture' };
  })();
  return (
    <div className="flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-wide text-muted-foreground">
      <span
        className={cn(
          'rounded-full border px-1.5 py-0.5',
          status.tone === 'ok' && 'border-success/40 text-success',
          status.tone === 'warn' && 'border-warning/40 text-warning',
          status.tone === 'error' && 'border-destructive/40 text-destructive',
        )}
      >
        {status.label}
      </span>
      <span>matched {diagnostics.matched}</span>
      <span>throttled {diagnostics.throttled}</span>
      <span>ran {diagnostics.ran}</span>
      <span>stored {diagnostics.stored}</span>
      <span>skipped {diagnostics.skipped ?? 0}</span>
      <span>failed {diagnostics.failed}</span>
    </div>
  );
}

function formatTimeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const delta = Date.now() - Date.parse(iso);
  if (!Number.isFinite(delta) || delta < 0) return 'just now';
  if (delta < 60_000) return `${Math.round(delta / 1000)}s ago`;
  if (delta < 3600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3600_000)}h ago`;
  return iso.slice(0, 16).replace('T', ' ');
}

// ---------------------------------------------------------------------------
// Editor dialog
// ---------------------------------------------------------------------------

interface EditorDraft {
  id: string;
  title: string;
  description: string;
  inputKinds: CaptureHookInputKind[];
  apps: string;
  urlHosts: string;
  urlPatterns: string;
  windowTitles: string;
  textIncludes: string;
  throttleMs: number;
  needsVision: boolean;
  systemPrompt: string;
  promptTemplate: string;
  outputCollection: string;
  widgetTitle: string;
  widgetBuiltin: 'list' | 'calendar' | 'followups' | 'json';
}

function blankDraft(): EditorDraft {
  return {
    id: '',
    title: '',
    description: '',
    inputKinds: ['screen'],
    apps: '',
    urlHosts: '',
    urlPatterns: '',
    windowTitles: '',
    textIncludes: '',
    throttleMs: 60_000,
    needsVision: true,
    systemPrompt: '',
    promptTemplate: '',
    outputCollection: 'records',
    widgetTitle: '',
    widgetBuiltin: 'list',
  };
}

function draftFromDefinition(def: CaptureHookDefinition): EditorDraft {
  return {
    id: def.id,
    title: def.title,
    description: def.description ?? '',
    inputKinds: def.match.inputKinds ?? ['screen'],
    apps: (def.match.apps ?? []).join('\n'),
    urlHosts: (def.match.urlHosts ?? []).join('\n'),
    urlPatterns: (def.match.urlPatterns ?? []).join('\n'),
    windowTitles: (def.match.windowTitles ?? []).join('\n'),
    textIncludes: (def.match.textIncludes ?? []).join('\n'),
    throttleMs: def.throttleMs ?? 60_000,
    needsVision: def.needsVision !== false,
    systemPrompt: def.systemPrompt ?? '',
    promptTemplate: def.promptTemplate ?? '',
    outputCollection: def.outputCollection ?? 'records',
    widgetTitle: def.widget?.title ?? '',
    widgetBuiltin: (def.widget?.builtin as EditorDraft['widgetBuiltin']) ?? 'list',
  };
}

function definitionFromDraft(d: EditorDraft): CaptureHookDefinition {
  const match: CaptureHookMatcher = {
    inputKinds: d.inputKinds.length > 0 ? d.inputKinds : ['screen'],
    apps: linesOrUndefined(d.apps),
    urlHosts: linesOrUndefined(d.urlHosts),
    urlPatterns: linesOrUndefined(d.urlPatterns),
    windowTitles: linesOrUndefined(d.windowTitles),
    textIncludes: linesOrUndefined(d.textIncludes),
  };
  const widget: CaptureHookWidgetManifest = {
    id: d.id.trim(),
    title: d.widgetTitle.trim() || d.title.trim(),
    builtin: d.widgetBuiltin,
    defaultCollection: d.outputCollection.trim() || 'records',
  };
  return {
    id: d.id.trim(),
    title: d.title.trim(),
    description: d.description.trim() || undefined,
    match,
    throttleMs: clampInt(d.throttleMs, 0),
    needsVision: d.needsVision,
    systemPrompt: d.systemPrompt.trim() || undefined,
    promptTemplate: d.promptTemplate.trim() || undefined,
    outputCollection: d.outputCollection.trim() || 'records',
    widget,
  };
}

function HookEditorDialog({
  open,
  initial,
  existingIds,
  onClose,
  onSave,
}: {
  open: boolean;
  initial: CaptureHookDefinition | null;
  existingIds: string[];
  onClose: () => void;
  onSave: (def: CaptureHookDefinition) => void;
}): React.JSX.Element {
  const [draft, setDraft] = React.useState<EditorDraft>(blankDraft);
  React.useEffect(() => {
    if (!open) return;
    setDraft(initial ? draftFromDefinition(initial) : blankDraft());
  }, [open, initial]);

  const set = <K extends keyof EditorDraft>(key: K, value: EditorDraft[K]) =>
    setDraft({ ...draft, [key]: value });

  const idError = (() => {
    const id = draft.id.trim();
    if (!id) return 'Required.';
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id)) return 'Use letters, digits, hyphens, underscores.';
    if (initial?.id !== id && existingIds.includes(id)) return 'Already used by another hook.';
    return null;
  })();
  const titleError = draft.title.trim() ? null : 'Required.';
  const canSave = !idError && !titleError;

  function handleSave() {
    if (!canSave) return;
    onSave(definitionFromDraft(draft));
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{initial ? 'Edit hook' : 'Add hook'}</DialogTitle>
          <DialogDescription>
            Define matchers, an LLM prompt, and the widget that renders the hook's records.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5 py-2">
          <section className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="Hook id"
              value={draft.id}
              onChange={(v: string) => set('id', v)}
              placeholder="meeting-notes"
              typeLabel="string"
              hint={idError ?? 'Stable identifier used in storage and config.'}
            />
            <TextField
              label="Title"
              value={draft.title}
              onChange={(v: string) => set('title', v)}
              placeholder="Meeting Notes"
              typeLabel="string"
              hint={titleError ?? 'Shown in the dashboard widget header.'}
            />
            <div className="sm:col-span-2">
              <TextAreaField
                label="Description"
                value={draft.description}
                onChange={(v: string) => set('description', v)}
                placeholder="What this hook captures and why."
                typeLabel="string"
                rows={2}
              />
            </div>
          </section>

          <Separator />

          <section className="flex flex-col gap-3">
            <h4 className="text-sm font-semibold">Triggers</h4>
            <p className="text-xs text-muted-foreground">
              The hook runs only when at least one matcher in each populated category matches. Leave a list empty to skip that filter.
            </p>
            <InputKindPicker
              value={draft.inputKinds}
              onChange={(v) => set('inputKinds', v)}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <TextAreaField
                label="Apps (one per line)"
                value={draft.apps}
                onChange={(v: string) => set('apps', v)}
                placeholder="slack\nnotion\noutlook"
                typeLabel="strings"
                hint="Substring match against app name (case-insensitive)."
                rows={3}
              />
              <TextAreaField
                label="Window titles (one per line)"
                value={draft.windowTitles}
                onChange={(v: string) => set('windowTitles', v)}
                placeholder="Inbox\nPull request"
                typeLabel="strings"
                hint="Substring match against window title."
                rows={3}
              />
              <TextAreaField
                label="URL hosts (one per line)"
                value={draft.urlHosts}
                onChange={(v: string) => set('urlHosts', v)}
                placeholder="calendar.google.com\noutlook.office.com"
                typeLabel="strings"
                hint="Exact host or trailing-subdomain match."
                rows={3}
              />
              <TextAreaField
                label="URL regex patterns (one per line)"
                value={draft.urlPatterns}
                onChange={(v: string) => set('urlPatterns', v)}
                placeholder="github\\.com/.+/pull/\\d+"
                typeLabel="regex"
                hint="JavaScript regex tested against the full URL."
                rows={3}
              />
              <div className="sm:col-span-2">
                <TextAreaField
                  label="Text includes (one per line)"
                  value={draft.textIncludes}
                  onChange={(v: string) => set('textIncludes', v)}
                  placeholder="invoice\nfollow up"
                  typeLabel="strings"
                  hint="Substring match against OCR text (screen) or transcript (audio)."
                  rows={2}
                />
              </div>
              <NumberField
                label="Throttle"
                value={draft.throttleMs}
                onChange={(v: number) => set('throttleMs', v)}
                min={0}
                step={1000}
                unit="ms"
                typeLabel="integer"
                hint="Minimum gap between LLM calls for the same surface."
              />
              <ToggleRow
                title="Use vision"
                description="Pass screenshot bytes to vision-capable models when available."
                typeLabel="boolean"
                checked={draft.needsVision}
                onChange={(v: boolean) => set('needsVision', v)}
              />
            </div>
          </section>

          <Separator />

          <section className="flex flex-col gap-3">
            <h4 className="text-sm font-semibold">Prompt</h4>
            <TextAreaField
              label="System prompt"
              value={draft.systemPrompt}
              onChange={(v: string) => set('systemPrompt', v)}
              placeholder={`You read a capture and return STRICT JSON:\n{ "items": [{ "title": string, "body": string }] }`}
              typeLabel="string"
              rows={5}
              hint="Sent as the system message to the LLM. Force JSON output here."
            />
            <TextAreaField
              label="User prompt template"
              value={draft.promptTemplate}
              onChange={(v: string) => set('promptTemplate', v)}
              placeholder="Optional. Overrides the default 'Analyze this captured moment…' template."
              typeLabel="string"
              rows={3}
              hint="Capture metadata (app, URL, OCR/transcript) is appended automatically."
            />
          </section>

          <Separator />

          <section className="flex flex-col gap-3">
            <h4 className="text-sm font-semibold">Storage &amp; widget</h4>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label="Output collection"
                value={draft.outputCollection}
                onChange={(v: string) => set('outputCollection', v)}
                placeholder="records"
                typeLabel="string"
                hint="Logical table inside the hook's isolated storage namespace."
              />
              <TextField
                label="Widget title"
                value={draft.widgetTitle}
                onChange={(v: string) => set('widgetTitle', v)}
                placeholder={draft.title || 'Hook widget'}
                typeLabel="string"
                hint="Optional; defaults to the hook title."
              />
              <SelectField
                label="Widget kind"
                value={draft.widgetBuiltin}
                onChange={(v: EditorDraft['widgetBuiltin']) => set('widgetBuiltin', v)}
                typeLabel="enum"
                options={BUILTIN_WIDGET_OPTIONS}
              />
            </div>
          </section>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!canSave}>
            {initial ? 'Save changes' : 'Add hook'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InputKindPicker({
  value,
  onChange,
}: {
  value: CaptureHookInputKind[];
  onChange: (v: CaptureHookInputKind[]) => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap gap-2">
      {INPUT_KIND_OPTIONS.map((opt) => {
        const active = value.includes(opt.value);
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() =>
              onChange(active ? value.filter((v) => v !== opt.value) : [...value, opt.value])
            }
            className={cn(
              'rounded-md border px-3 py-1.5 text-xs transition-colors',
              active
                ? 'border-primary/50 bg-primary/10 text-primary'
                : 'border-border bg-background/55 text-muted-foreground hover:text-foreground',
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Local save bar (separate from the main Settings SaveBar so the tab can
// be edited independently)
// ---------------------------------------------------------------------------

function HookSaveBar({
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
}): React.JSX.Element | null {
  if (!hasUnsavedChanges) return null;
  return (
    <div
      className="fixed bottom-4 right-4 z-30 mx-auto max-w-2xl pl-4 animate-in fade-in-0 slide-in-from-bottom-3"
      style={{ left: 'var(--sidebar-w, 15rem)' }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-popover px-4 py-3 shadow-lg">
        <p className="text-sm">
          You have unsaved hook changes.{' '}
          <span className="text-muted-foreground">Restart the runtime to load new plugins.</span>
        </p>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onReset} disabled={saving}>
            Reset
          </Button>
          <Button variant="outline" size="sm" onClick={onSaveAndRestart} disabled={saving}>
            <Power className="size-4" /> {saving ? 'Working…' : 'Save & restart'}
          </Button>
          <Button size="sm" onClick={onSave} disabled={saving}>
            <Save className="size-4" /> {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cloneDefinition(def: CaptureHookDefinition): CaptureHookDefinition {
  return JSON.parse(JSON.stringify(def));
}

function serializeDefinition(def: CaptureHookDefinition): CaptureHookDefinition {
  return {
    ...def,
    match: pruneMatcher(def.match),
    widget: def.widget ? { ...def.widget } : undefined,
  };
}

function pruneMatcher(match: CaptureHookMatcher): CaptureHookMatcher {
  const out: CaptureHookMatcher = {};
  if (match.inputKinds?.length) out.inputKinds = match.inputKinds;
  if (match.apps?.length) out.apps = match.apps;
  if (match.appBundleIds?.length) out.appBundleIds = match.appBundleIds;
  if (match.windowTitles?.length) out.windowTitles = match.windowTitles;
  if (match.urlHosts?.length) out.urlHosts = match.urlHosts;
  if (match.urlPatterns?.length) out.urlPatterns = match.urlPatterns;
  if (match.textIncludes?.length) out.textIncludes = match.textIncludes;
  return out;
}

function linesOrUndefined(raw: string): string[] | undefined {
  const items = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
}

function clampInt(value: number, min: number, max?: number): number {
  const f = Number.isFinite(value) ? value : min;
  const l = Math.max(Math.round(f), min);
  return max == null ? l : Math.min(l, max);
}

function serializeHooksState(config: LoadedConfig | null): string {
  const h = config?.config.hooks ?? {};
  return JSON.stringify({
    enabled: h.enabled !== false,
    plugins: (h.plugins ?? []).map((p) => ({ name: p.name, enabled: p.enabled !== false })),
    definitions: (h.definitions ?? []) as CaptureHookDefinition[],
    throttle_ms_default: h.throttle_ms_default ?? 60_000,
    max_records_per_hook: h.max_records_per_hook ?? 2_000,
  });
}
