import * as React from 'react';
import * as ReactJsxRuntime from 'react/jsx-runtime';
import { Loader2, Sparkles, Plug } from 'lucide-react';
import type {
  CaptureHookDiagnostics,
  CaptureHookRecord,
  CaptureHookStorageMutation,
  CaptureHookStorageQuery,
  CaptureHookWidgetManifest,
  CaptureHookWidgetManifestRuntime,
} from '@/global';

/**
 * Capture hook widget host.
 *
 * Loads widget manifests from the runtime. For each enabled hook with a
 * widget, either evaluates the plugin-provided React bundle (via a
 * sandboxed factory pattern) or renders a built-in fallback widget
 * (calendar, followups, generic list, json).
 */

interface HookWidgetApi {
  hookId: string;
  manifest: CaptureHookWidgetManifest;
  React: typeof React;
  jsx: typeof ReactJsxRuntime;
  /** Convenience: subscribe to record updates for this hook. */
  useHookRecords<T = unknown>(query?: CaptureHookStorageQuery): {
    records: CaptureHookRecord<T>[];
    loading: boolean;
    refresh: () => Promise<void>;
  };
  queryStorage: <T = unknown>(query?: CaptureHookStorageQuery) => Promise<CaptureHookRecord<T>[]>;
  mutateStorage: (mutation: CaptureHookStorageMutation) => Promise<CaptureHookRecord | null>;
  assetUrl: (assetPath: string) => Promise<string>;
}

type WidgetFactory = (api: HookWidgetApi) => React.ComponentType;

const widgetModuleCache = new Map<string, WidgetFactory>();

export function CaptureHookWidgets(): React.JSX.Element | null {
  const [manifests, setManifests] = React.useState<CaptureHookWidgetManifestRuntime[] | null>(null);
  const [updateTick, setUpdateTick] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await window.beside.listCaptureHookWidgetManifests();
        if (!cancelled) setManifests(list);
      } catch {
        if (!cancelled) setManifests([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [updateTick]);

  React.useEffect(() => {
    if (typeof window.beside.onCaptureHookUpdate !== 'function') return;
    return window.beside.onCaptureHookUpdate(() => setUpdateTick((t) => t + 1));
  }, []);

  if (manifests == null) return null;
  if (manifests.length === 0) return null;

  return (
    <section className="flex flex-col gap-4">
      {manifests.map((m) => (
        <HookWidgetCard key={`${m.hookId}:${m.widget.id}`} manifest={m} />
      ))}
    </section>
  );
}

function HookWidgetCard({ manifest }: { manifest: CaptureHookWidgetManifestRuntime }): React.JSX.Element {
  return (
    <div className="rounded-lg border bg-card/70 p-4 shadow-card">
      <header className="mb-3 flex items-center gap-2">
        <Sparkles className="size-4 text-primary" />
        <h3 className="text-sm font-semibold">{manifest.widget.title}</h3>
        {manifest.pluginName && (
          <span className="ml-auto text-[10px] uppercase text-muted-foreground">
            {manifest.pluginName}
          </span>
        )}
      </header>
      <HookWidgetBody manifest={manifest} />
    </div>
  );
}

function HookWidgetBody({ manifest }: { manifest: CaptureHookWidgetManifestRuntime }): React.JSX.Element {
  if (manifest.resolvedBundlePath) {
    return <PluginWidget manifest={manifest} />;
  }
  return <BuiltinWidget manifest={manifest} />;
}

// ---------------------------------------------------------------------------
// Plugin-provided widget loader
// ---------------------------------------------------------------------------

function PluginWidget({ manifest }: { manifest: CaptureHookWidgetManifestRuntime }): React.JSX.Element {
  const [Component, setComponent] = React.useState<React.ComponentType | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!manifest.resolvedBundlePath) throw new Error('no bundle path');
        let factory = widgetModuleCache.get(manifest.resolvedBundlePath);
        if (!factory) {
          const { source } = await window.beside.readCaptureHookWidgetBundle({
            resolvedBundlePath: manifest.resolvedBundlePath,
          });
          factory = compileWidgetSource(source);
          widgetModuleCache.set(manifest.resolvedBundlePath, factory);
        }
        const api = buildWidgetApi(manifest);
        const ResolvedComponent = factory(api);
        if (!cancelled) setComponent(() => ResolvedComponent);
      } catch (err) {
        if (!cancelled) setError(String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [manifest.resolvedBundlePath]);

  if (error)
    return (
      <div className="rounded-md border border-warning/40 bg-warning/5 p-3 text-xs text-warning">
        <Plug className="mr-1 inline size-3" /> Widget failed to load: {error}
      </div>
    );
  if (!Component)
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-3 animate-spin" /> Loading widget…
      </div>
    );
  return <Component />;
}

function compileWidgetSource(source: string): WidgetFactory {
  // The bundle is expected to call `defineWidget(factory)`. We supply
  // a minimal global module-like surface. NodeIntegration is disabled
  // in the renderer, so this is the most we expose to plugin code.
  let registered: WidgetFactory | null = null;
  const defineWidget = (factory: WidgetFactory) => {
    registered = factory;
  };
  // eslint-disable-next-line no-new-func
  const fn = new Function(
    'defineWidget',
    'React',
    'jsx',
    `${source}\n;`,
  );
  fn(defineWidget, React, ReactJsxRuntime);
  if (!registered) throw new Error('widget bundle did not call defineWidget()');
  return registered;
}

function buildWidgetApi(manifest: CaptureHookWidgetManifestRuntime): HookWidgetApi {
  const queryStorage = <T = unknown>(query?: CaptureHookStorageQuery) =>
    window.beside.queryCaptureHookStorage({
      hookId: manifest.hookId,
      query: query ?? { collection: manifest.widget.defaultCollection },
    }) as Promise<CaptureHookRecord<T>[]>;
  return {
    hookId: manifest.hookId,
    manifest: manifest.widget,
    React,
    jsx: ReactJsxRuntime,
    queryStorage,
    mutateStorage: (mutation) =>
      window.beside.mutateCaptureHookStorage({ hookId: manifest.hookId, mutation }),
    assetUrl: (assetPath) => window.beside.assetUrl(assetPath),
    useHookRecords<T = unknown>(query?: CaptureHookStorageQuery) {
      const [records, setRecords] = React.useState<CaptureHookRecord<T>[]>([]);
      const [loading, setLoading] = React.useState(true);
      const refresh = React.useCallback(async () => {
        setLoading(true);
        try {
          setRecords(await queryStorage<T>(query));
        } finally {
          setLoading(false);
        }
      }, [JSON.stringify(query ?? {})]);
      React.useEffect(() => {
        refresh().catch(() => undefined);
        if (typeof window.beside.onCaptureHookUpdate !== 'function') return;
        return window.beside.onCaptureHookUpdate((p) => {
          if (p.hookId === manifest.hookId) refresh().catch(() => undefined);
        });
      }, [refresh, manifest.hookId]);
      return { records, loading, refresh };
    },
  };
}

// ---------------------------------------------------------------------------
// Built-in widgets (used by config-defined hooks without a custom bundle)
// ---------------------------------------------------------------------------

function BuiltinWidget({ manifest }: { manifest: CaptureHookWidgetManifestRuntime }): React.JSX.Element {
  const collection = manifest.widget.defaultCollection;
  const { records, loading } = useHookRecords(manifest.hookId, collection ? { collection } : {});
  const diagnostics = useHookDiagnostics(manifest.hookId);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-3 animate-spin" /> Loading…
      </div>
    );
  }
  if (records.length === 0) {
    return <EmptyHookState diagnostics={diagnostics} />;
  }

  switch (manifest.widget.builtin ?? 'list') {
    case 'calendar':
      return <CalendarBuiltinWidget records={records} />;
    case 'followups':
      return <FollowupsBuiltinWidget records={records} />;
    case 'json':
      return <JsonBuiltinWidget records={records} />;
    case 'list':
    default:
      return <ListBuiltinWidget records={records} />;
  }
}

function useHookRecords(hookId: string, query: CaptureHookStorageQuery) {
  const [records, setRecords] = React.useState<CaptureHookRecord[]>([]);
  const [loading, setLoading] = React.useState(true);
  const queryKey = JSON.stringify(query);
  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const list = await window.beside.queryCaptureHookStorage({ hookId, query });
        if (!cancelled) setRecords(list);
      } catch {
        if (!cancelled) setRecords([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    if (typeof window.beside.onCaptureHookUpdate === 'function') {
      const unsubscribe = window.beside.onCaptureHookUpdate(async (p) => {
        if (cancelled) return;
        if (p.hookId !== hookId) return;
        try {
          setRecords(await window.beside.queryCaptureHookStorage({ hookId, query }));
        } catch {
          // ignore
        }
      });
      return () => {
        cancelled = true;
        unsubscribe();
      };
    }
    return () => {
      cancelled = true;
    };
  }, [hookId, queryKey]);
  return { records, loading };
}

function CalendarBuiltinWidget({ records }: { records: CaptureHookRecord[] }): React.JSX.Element {
  const allItems = records.flatMap((r) => extractCalendarItems(r));
  const now = Date.now();
  const upcoming = allItems
    .filter((item) => isUpcomingCalendarItem(item, now))
    .sort((a, b) => calendarItemSortKey(a) - calendarItemSortKey(b));
  if (upcoming.length === 0)
    return <p className="text-sm text-muted-foreground">No upcoming events.</p>;
  return (
    <ul className="flex flex-col gap-2">
      {upcoming.slice(0, 10).map((item, idx) => (
        <li key={idx} className="rounded-md border bg-background/55 px-3 py-2 text-sm">
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-medium truncate">{item.title}</span>
            {item.starts_at && (
              <span className="text-[11px] text-muted-foreground">{item.starts_at}</span>
            )}
          </div>
          {item.context && (
            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{item.context}</p>
          )}
        </li>
      ))}
    </ul>
  );
}

function FollowupsBuiltinWidget({ records }: { records: CaptureHookRecord[] }): React.JSX.Element {
  const items = records.flatMap((r) => extractFollowupItems(r));
  if (items.length === 0)
    return <p className="text-sm text-muted-foreground">No follow-ups yet.</p>;
  return (
    <ul className="flex flex-col gap-2">
      {items.slice(0, 10).map((item, idx) => (
        <li key={idx} className="rounded-md border bg-background/55 px-3 py-2 text-sm">
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-medium truncate">{item.title}</span>
            {item.urgency && (
              <span className="text-[10px] uppercase text-muted-foreground">{item.urgency}</span>
            )}
          </div>
          {item.body && (
            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{item.body}</p>
          )}
        </li>
      ))}
    </ul>
  );
}

function ListBuiltinWidget({ records }: { records: CaptureHookRecord[] }): React.JSX.Element {
  return (
    <ul className="flex flex-col gap-2 text-sm">
      {records.slice(0, 10).map((r) => (
        <li key={r.id} className="rounded-md border bg-background/55 px-3 py-2">
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate font-medium">{pickString(r.data, 'title', 'name', 'id') ?? r.id}</span>
            <span className="text-[11px] text-muted-foreground">{r.updatedAt.slice(0, 16).replace('T', ' ')}</span>
          </div>
          {pickString(r.data, 'body', 'summary', 'context') && (
            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
              {pickString(r.data, 'body', 'summary', 'context')}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

function JsonBuiltinWidget({ records }: { records: CaptureHookRecord[] }): React.JSX.Element {
  return (
    <pre className="max-h-72 overflow-auto rounded-md border bg-background/40 p-2 text-[11px]">
      {JSON.stringify(records, null, 2)}
    </pre>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type CalendarItem = {
  title: string;
  starts_at?: string;
  ends_at?: string;
  context?: string;
};
type FollowupItem = { title: string; body?: string; urgency?: string };

function extractCalendarItems(record: CaptureHookRecord): CalendarItem[] {
  const data = record.data as any;
  if (!data) return [];
  const arr = Array.isArray(data?.events)
    ? data.events
    : Array.isArray(data?.items)
      ? data.items
      : Array.isArray(data)
        ? data
        : [];
  return arr
    .map((item: any) => {
      if (!item || typeof item !== 'object') return null;
      const title = pickString(item, 'title', 'name', 'summary');
      if (!title) return null;
      return {
        title,
        starts_at: pickString(item, 'starts_at', 'startsAt', 'start', 'when') ?? undefined,
        ends_at: pickString(item, 'ends_at', 'endsAt', 'end') ?? undefined,
        context: pickString(item, 'context', 'description', 'body') ?? undefined,
      } as CalendarItem;
    })
    .filter((x: CalendarItem | null): x is CalendarItem => x !== null);
}

// Returns ms-since-epoch for an event time string, or null if unparseable.
// Handles ISO timestamps, "May 11, 2026 9:00 AM", and "May 11, 2026 all day".
function parseCalendarTime(value: string | undefined): number | null {
  if (!value) return null;
  const cleaned = value.replace(/\s+all day$/i, '').trim();
  if (!cleaned) return null;
  const ts = Date.parse(cleaned);
  return Number.isFinite(ts) ? ts : null;
}

function isAllDay(item: CalendarItem): boolean {
  return /\ball day\b/i.test(item.starts_at ?? '');
}

function isUpcomingCalendarItem(item: CalendarItem, now: number): boolean {
  const end = parseCalendarTime(item.ends_at);
  if (end !== null) return end >= now;
  const start = parseCalendarTime(item.starts_at);
  if (start === null) return true; // unknown time → keep so we don't accidentally hide
  if (isAllDay(item)) {
    // Include any all-day event whose day hasn't fully passed.
    const endOfDay = start + 24 * 60 * 60 * 1000;
    return endOfDay >= now;
  }
  return start >= now;
}

function calendarItemSortKey(item: CalendarItem): number {
  return parseCalendarTime(item.starts_at) ?? Number.MAX_SAFE_INTEGER;
}

function extractFollowupItems(record: CaptureHookRecord): FollowupItem[] {
  const data = record.data as any;
  if (!data) return [];
  const arr = Array.isArray(data?.followups)
    ? data.followups
    : Array.isArray(data?.items)
      ? data.items
      : Array.isArray(data)
        ? data
        : [];
  return arr
    .map((item: any) => {
      if (!item || typeof item !== 'object') return null;
      const title = pickString(item, 'title', 'task', 'text');
      if (!title) return null;
      return {
        title,
        body: pickString(item, 'body', 'context', 'detail') ?? undefined,
        urgency: pickString(item, 'urgency', 'priority') ?? undefined,
      } as FollowupItem;
    })
    .filter((x: FollowupItem | null): x is FollowupItem => x !== null);
}

function useHookDiagnostics(hookId: string): CaptureHookDiagnostics | null {
  const [diagnostics, setDiagnostics] = React.useState<CaptureHookDiagnostics | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const all = await window.beside.getCaptureHookDiagnostics();
        if (!cancelled) {
          setDiagnostics(all.find((d) => d.hookId === hookId) ?? null);
        }
      } catch {
        if (!cancelled) setDiagnostics(null);
      }
    };
    refresh();
    const handle = setInterval(refresh, 3000);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [hookId]);
  return diagnostics;
}

function EmptyHookState({ diagnostics }: { diagnostics: CaptureHookDiagnostics | null }): React.JSX.Element {
  if (!diagnostics) {
    return (
      <p className="text-sm text-muted-foreground">
        No captures matched this hook yet.
      </p>
    );
  }
  const status = (() => {
    if (diagnostics.lastError) return `Last attempt failed: ${diagnostics.lastError}`;
    if (diagnostics.matched === 0) return 'No matching captures yet. Open a matching app, URL, or window for the hook to fire.';
    if (diagnostics.matched > 0 && diagnostics.ran === 0)
      return `${diagnostics.matched} match(es), but all were throttled. Tighten or remove throttle in Settings → Hooks.`;
    if (diagnostics.ran > 0 && diagnostics.stored === 0) {
      if (diagnostics.lastSkipReason) {
        return `${diagnostics.ran} run(s) completed but nothing was stored. Last reason: ${diagnostics.lastSkipReason}`;
      }
      return `${diagnostics.ran} run(s) completed, but the model produced no usable output.`;
    }
    return 'Waiting for the next capture…';
  })();
  const skipped = diagnostics.skipped ?? 0;
  return (
    <div className="flex flex-col gap-1 text-xs text-muted-foreground">
      <p>{status}</p>
      <p className="text-[10px] uppercase tracking-wide">
        matched {diagnostics.matched} · throttled {diagnostics.throttled} · ran {diagnostics.ran} · stored {diagnostics.stored} · skipped {skipped} · failed {diagnostics.failed}
      </p>
    </div>
  );
}

function pickString(record: unknown, ...keys: string[]): string | null {
  if (!record || typeof record !== 'object') return null;
  for (const key of keys) {
    const value = (record as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}
