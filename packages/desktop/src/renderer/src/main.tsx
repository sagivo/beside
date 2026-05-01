import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import type { ActivitySession, DoctorCheck, Frame, JournalDay, LoadedConfig, ModelBootstrapProgress, RuntimeOverview } from './global';

type Screen = 'home' | 'setup' | 'journals' | 'settings' | 'help';

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value >= 10 || i === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
}

function Pill({ children, tone }: { children: React.ReactNode; tone?: string }) {
  return <span className={`pill ${tone ?? ''}`}>{children}</span>;
}

function Header({ title, subtitle, children }: { title: string; subtitle: string; children?: React.ReactNode }) {
  return (
    <header>
      <div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      <div className="actions">{children}</div>
    </header>
  );
}

function App() {
  const [screen, setScreen] = useState<Screen>('home');
  const [overview, setOverview] = useState<RuntimeOverview | null>(null);
  const [doctor, setDoctor] = useState<DoctorCheck[] | null>(null);
  const [days, setDays] = useState<string[]>([]);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [journal, setJournal] = useState<JournalDay | null>(null);
  const [config, setConfig] = useState<LoadedConfig | null>(null);
  const [logs, setLogs] = useState('');
  const [bootstrapEvents, setBootstrapEvents] = useState<ModelBootstrapProgress[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    window.cofounderos?.onDesktopLogs?.((nextLogs) => setLogs(nextLogs || ''));
    window.cofounderos?.onBootstrapProgress?.((progress) => {
      setBootstrapEvents((events) => [...events.slice(-40), progress]);
    });
  }, []);

  useEffect(() => {
    void loadScreen(screen);
  }, [screen]);

  async function loadScreen(next: Screen) {
    try {
      if (!window.cofounderos) {
        throw new Error('Desktop preload bridge is unavailable.');
      }
      if (next === 'home') setOverview(await window.cofounderos.getOverview());
      if (next === 'setup') setDoctor(await window.cofounderos.runDoctor());
      if (next === 'journals') {
        const nextDays = await window.cofounderos.listJournalDays();
        setDays(nextDays);
        const day = selectedDay ?? nextDays[nextDays.length - 1] ?? null;
        setSelectedDay(day);
        setJournal(day ? await window.cofounderos.getJournalDay(day) : null);
      }
      if (next === 'settings') setConfig(await window.cofounderos.readConfig());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function chooseDay(day: string) {
    setSelectedDay(day);
    setJournal(null);
    setJournal(await window.cofounderos.getJournalDay(day));
  }

  async function startRuntime() {
    setOverview(await window.cofounderos.startRuntime());
  }

  async function stopRuntime() {
    await window.cofounderos.stopRuntime();
    setOverview(await window.cofounderos.getOverview().catch(() => null));
  }

  const nav: Array<[Screen, string]> = [
    ['home', 'Home'],
    ['setup', 'Setup'],
    ['journals', 'Journals'],
    ['settings', 'Settings'],
    ['help', 'Help'],
  ];

  return (
    <div className="shell">
      <nav>
        <div className="brand">CofounderOS</div>
        {nav.map(([id, label]) => (
          <button key={id} className={`nav-btn ${screen === id ? 'active' : ''}`} onClick={() => setScreen(id)}>
            {label}
          </button>
        ))}
      </nav>
      <main>
        {error ? (
          <NeedsAttention error={error} />
        ) : screen === 'home' ? (
          <Home overview={overview} onRefresh={() => loadScreen('home')} onStart={startRuntime} onStop={stopRuntime} />
        ) : screen === 'setup' ? (
          <Setup checks={doctor} bootstrapEvents={bootstrapEvents} onRefresh={() => loadScreen('setup')} onBootstrap={async () => {
            setBootstrapEvents([]);
            await window.cofounderos.bootstrapModel();
            setDoctor(await window.cofounderos.runDoctor());
          }} />
        ) : screen === 'journals' ? (
          <Journals days={days} selectedDay={selectedDay} journal={journal} onRefresh={() => loadScreen('journals')} onChooseDay={chooseDay} />
        ) : screen === 'settings' ? (
          <Settings config={config} onSaved={setConfig} />
        ) : (
          <Help logs={logs} />
        )}
      </main>
    </div>
  );
}

function NeedsAttention({ error }: { error: string }) {
  return (
    <>
      <Header title="Needs Attention" subtitle="Something went wrong." />
      <div className="card">
        <Pill tone="fail">error</Pill>
        <pre>{error}</pre>
      </div>
    </>
  );
}

function Home({
  overview,
  onRefresh,
  onStart,
  onStop,
}: {
  overview: RuntimeOverview | null;
  onRefresh: () => void;
  onStart: () => void;
  onStop: () => void;
}) {
  if (!overview) {
    return (
      <>
        <Header title="Home" subtitle="Checking runtime status..." />
        <div className="empty">Loading status...</div>
      </>
    );
  }
  const running = overview.status === 'running';
  return (
    <>
      <Header title="Home" subtitle="Your local memory system at a glance.">
        <button className="btn primary" onClick={onStart}>{running ? 'Restart runtime' : 'Start runtime'}</button>
        {running ? <button className="btn" onClick={onStop}>Stop runtime</button> : null}
        <button className="btn" onClick={onRefresh}>Refresh</button>
      </Header>
      <div className="grid">
        <Stat title="Memory Capture" value={overview.capture.running ? 'Running' : 'Stopped'} detail={`${overview.capture.eventsToday} events today`} />
        <Stat title="Local AI Model" value={overview.model.ready ? 'Ready' : 'Needs setup'} detail={overview.model.name} />
        <Stat title="Storage" value={formatBytes(overview.storage.totalAssetBytes)} detail={`${overview.storage.totalEvents.toLocaleString()} events saved`} />
      </div>
      <h2>Memory Organization</h2>
      <div className="grid two">
        <Stat title="Index Pages" value={overview.index.pageCount.toLocaleString()} detail={`${overview.index.eventsCovered.toLocaleString()} events covered`} />
        <div className="card">
          <h3>Exports</h3>
          <div className="list">
            {overview.exports.map((exp) => (
              <div className="row" key={exp.name}>
                <div>{exp.name}</div>
                <Pill tone={exp.running ? 'ok' : undefined}>{exp.running ? 'running' : 'stopped'}</Pill>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

function Stat({ title, value, detail }: { title: string; value: string; detail: string }) {
  return (
    <div className="card">
      <h3>{title}</h3>
      <div className="value">{value}</div>
      <p>{detail}</p>
    </div>
  );
}

function Setup({
  checks,
  bootstrapEvents,
  onRefresh,
  onBootstrap,
}: {
  checks: DoctorCheck[] | null;
  bootstrapEvents: ModelBootstrapProgress[];
  onRefresh: () => void;
  onBootstrap: () => Promise<void>;
}) {
  const [bootstrapping, setBootstrapping] = useState(false);
  async function runBootstrap() {
    setBootstrapping(true);
    try {
      await onBootstrap();
    } finally {
      setBootstrapping(false);
    }
  }

  if (!checks) {
    return (
      <>
        <Header title="Setup" subtitle="Checking your machine..." />
        <div className="empty">Running setup checks...</div>
      </>
    );
  }
  const failures = checks.filter((check) => check.status === 'fail').length;
  const warnings = checks.filter((check) => check.status === 'warn').length;
  return (
    <>
      <Header
        title="Setup"
        subtitle={failures ? 'Some setup steps need attention.' : warnings ? 'CofounderOS can run, with a few warnings.' : 'Everything looks ready.'}
      >
        <button className="btn primary" onClick={() => void runBootstrap()} disabled={bootstrapping}>{bootstrapping ? 'Preparing...' : 'Prepare local AI model'}</button>
        <button className="btn" onClick={onRefresh}>Run checks again</button>
      </Header>
      {bootstrapEvents.length ? (
        <>
          <h2>Model Setup Progress</h2>
          <div className="card progress-card">
            {bootstrapEvents.slice(-10).map((event, index) => (
              <div className="progress-row" key={`${event.kind}-${index}`}>
                <Pill tone={event.kind.includes('failed') ? 'fail' : event.kind === 'ready' || event.kind.includes('done') ? 'ok' : undefined}>{event.kind}</Pill>
                <span>{bootstrapMessage(event)}</span>
              </div>
            ))}
          </div>
        </>
      ) : null}
      <div className="list">
        {checks.map((check, index) => (
          <div className="card" key={`${check.area}-${index}`}>
            <div className="row">
              <div>
                <strong>{check.area}</strong>
                <p>{check.message}</p>
                {check.detail ? <p className="muted">{check.detail}</p> : null}
                {check.action ? <p>Next: {check.action}</p> : null}
              </div>
              <Pill tone={check.status === 'ok' ? 'ok' : check.status === 'fail' ? 'fail' : check.status === 'warn' ? 'warn' : undefined}>{check.status}</Pill>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function bootstrapMessage(event: ModelBootstrapProgress): string {
  if (event.message) return event.message;
  if (event.line) return event.line;
  if (event.reason) return event.reason;
  if (event.status && typeof event.completed === 'number' && typeof event.total === 'number' && event.total > 0) {
    return `${event.model ?? 'model'} ${event.status} ${Math.round((event.completed / event.total) * 100)}%`;
  }
  return event.model ?? event.tool ?? event.host ?? '';
}

function Journals({
  days,
  selectedDay,
  journal,
  onRefresh,
  onChooseDay,
}: {
  days: string[];
  selectedDay: string | null;
  journal: JournalDay | null;
  onRefresh: () => void;
  onChooseDay: (day: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [selectedApp, setSelectedApp] = useState('');
  const [searchResults, setSearchResults] = useState<Frame[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const sessions = journal?.sessions ?? [];
  const frames = journal?.frames ?? [];
  const appOptions = Array.from(new Set(frames.map((frame) => frame.app).filter(Boolean) as string[])).sort();
  const sessionFrames = selectedSessionId
    ? frames.filter((frame) => frame.activity_session_id === selectedSessionId)
    : [];
  const filteredFrames = frames.filter((frame) => {
    if (selectedApp && frame.app !== selectedApp) return false;
    return true;
  });
  const visibleFrames = searchResults ?? filteredFrames;

  async function runSearch() {
    if (!query.trim()) {
      setSearchResults(null);
      return;
    }
    setSearching(true);
    try {
      setSearchResults(await window.cofounderos.searchFrames({
        text: query.trim(),
        day: selectedDay ?? undefined,
        apps: selectedApp ? [selectedApp] : undefined,
        limit: 50,
      }));
    } finally {
      setSearching(false);
    }
  }

  function clearSearch() {
    setQuery('');
    setSearchResults(null);
  }

  return (
    <>
      <Header title="Journals" subtitle="Explore saved work sessions and captured moments.">
        <button className="btn" onClick={onRefresh}>Refresh</button>
      </Header>
      <div className="card toolbar">
        <input placeholder="Search captured moments..." value={query} onChange={(e) => setQuery(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter') void runSearch(); }} />
        <select value={selectedApp} onChange={(e) => { setSelectedApp(e.currentTarget.value); setSearchResults(null); }}>
          <option value="">All apps</option>
          {appOptions.map((app) => <option key={app} value={app}>{app}</option>)}
        </select>
        <button className="btn primary" onClick={() => void runSearch()} disabled={searching}>{searching ? 'Searching...' : 'Search'}</button>
        <button className="btn" onClick={clearSearch}>Clear</button>
      </div>
      {days.length ? (
        <div className="days">
          {days.map((day) => (
            <button key={day} className={`day ${day === selectedDay ? 'active' : ''}`} onClick={() => onChooseDay(day)}>{day}</button>
          ))}
        </div>
      ) : (
        <div className="empty">No journal days found yet.</div>
      )}
      {journal ? (
        <>
          <div className="grid two">
            <Stat title="Selected Day" value={journal.day} detail={`${frames.length} moments captured`} />
            <Stat title="Work Sessions" value={sessions.length.toString()} detail="Grouped by focus and idle gaps" />
          </div>
          <h2>Sessions</h2>
          <SessionList sessions={sessions} selectedSessionId={selectedSessionId} onSelect={setSelectedSessionId} />
          {selectedSessionId ? (
            <>
              <h2>Selected Session</h2>
              <FrameList frames={sessionFrames} />
            </>
          ) : null}
          <h2>{searchResults ? 'Search Results' : selectedApp ? `${selectedApp} Moments` : 'Recent Moments'}</h2>
          <FrameList frames={visibleFrames} />
        </>
      ) : null}
    </>
  );
}

function SessionList({
  sessions,
  selectedSessionId,
  onSelect,
}: {
  sessions: ActivitySession[];
  selectedSessionId: string | null;
  onSelect: (id: string | null) => void;
}) {
  if (!sessions.length) return <div className="empty">No sessions for this day yet.</div>;
  return (
    <div className="list">
      {sessions.slice(0, 20).map((session, index) => (
        <button
          className={`card session-card ${selectedSessionId === session.id ? 'selected' : ''}`}
          key={`${session.started_at}-${index}`}
          onClick={() => onSelect(selectedSessionId === session.id ? null : session.id ?? null)}
        >
          <strong>{(session.started_at || '').slice(11, 16)} - {(session.ended_at || '').slice(11, 16)}</strong>
          <p>{session.primary_entity_path || session.primary_app || 'Unresolved activity'}</p>
          <p className="muted">{Math.round((session.active_ms || 0) / 60000)} active min · {session.frame_count} moments</p>
        </button>
      ))}
    </div>
  );
}

function FrameList({ frames }: { frames: Frame[] }) {
  if (!frames.length) return <div className="empty">No moments for this day.</div>;
  return (
    <div className="list">
      {frames.slice(0, 30).map((frame, index) => (
        <FrameCard frame={frame} key={`${frame.id ?? frame.timestamp}-${index}`} />
      ))}
    </div>
  );
}

function FrameCard({ frame }: { frame: Frame }) {
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);

  useEffect(() => {
    let revoke: string | null = null;
    let cancelled = false;
    async function loadThumb() {
      if (!frame.asset_path) {
        setThumbUrl(null);
        return;
      }
      try {
        const bytes = await window.cofounderos.readAsset(frame.asset_path);
        if (cancelled) return;
        const type = frame.asset_path.endsWith('.jpg') || frame.asset_path.endsWith('.jpeg')
          ? 'image/jpeg'
          : frame.asset_path.endsWith('.png')
            ? 'image/png'
            : 'image/webp';
        revoke = URL.createObjectURL(new Blob([bytes], { type }));
        setThumbUrl(revoke);
      } catch {
        setThumbUrl(null);
      }
    }
    void loadThumb();
    return () => {
      cancelled = true;
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [frame.asset_path]);

  return (
    <div className="card frame-card">
      {thumbUrl ? <img src={thumbUrl} alt="" /> : <div className="thumb-placeholder">No screenshot</div>}
      <div>
        <strong>{(frame.timestamp || '').slice(11, 19)} · {frame.app || 'Unknown app'}</strong>
        <p>{frame.window_title || '(no title)'}</p>
        {frame.entity_path ? <p className="muted">{frame.entity_path}</p> : null}
        {frame.url ? <p className="muted">{frame.url}</p> : null}
        {frame.text ? <p className="muted">{String(frame.text).replace(/\s+/g, ' ').slice(0, 220)}</p> : null}
      </div>
    </div>
  );
}

function Settings({ config, onSaved }: { config: LoadedConfig | null; onSaved: (config: LoadedConfig) => void }) {
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (config) setDraft(settingsDraftFromConfig(config));
  }, [config]);

  if (!config) {
    return (
      <>
        <Header title="Settings" subtitle="Loading configuration..." />
        <div className="empty">Reading config...</div>
      </>
    );
  }
  if (!draft) {
    return (
      <>
        <Header title="Settings" subtitle="Preparing settings..." />
        <div className="empty">Loading controls...</div>
      </>
    );
  }

  const set = <K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) => {
    setDraft({ ...draft, [key]: value });
    setMessage(null);
  };

  async function save() {
    if (!draft) return;
    setSaving(true);
    setMessage(null);
    try {
      const next = await window.cofounderos.saveConfigPatch(configPatchFromDraft(draft));
      onSaved(next);
      setMessage('Saved. Runtime was stopped so changes apply on next start.');
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Header title="Settings" subtitle="Update common configuration without editing YAML.">
        <button className="btn primary" disabled={saving} onClick={save}>{saving ? 'Saving...' : 'Save settings'}</button>
      </Header>
      {message ? <div className="card"><p>{message}</p></div> : null}
      <div className="grid two">
        <div className="card"><h3>Config File</h3><p>{config.sourcePath}</p></div>
        <div className="card"><h3>Data Folder</h3><p>{config.dataDir}</p></div>
      </div>
      <h2>Privacy</h2>
      <div className="grid two">
        <div className="card">
          <label className="check"><input type="checkbox" checked={draft.blurPasswordFields} onChange={(e) => set('blurPasswordFields', e.currentTarget.checked)} /> Blur password fields</label>
          <label className="check"><input type="checkbox" checked={draft.pauseOnScreenLock} onChange={(e) => set('pauseOnScreenLock', e.currentTarget.checked)} /> Pause when screen locks</label>
        </div>
        <div className="card">
          <Field label="Sensitive keywords" hint="One per line. Lines containing these words are redacted.">
            <textarea value={draft.sensitiveKeywords} onChange={(e) => set('sensitiveKeywords', e.currentTarget.value)} />
          </Field>
        </div>
      </div>
      <h2>Capture Filters</h2>
      <div className="grid two">
        <Field label="Excluded apps" hint="One app name per line.">
          <textarea value={draft.excludedApps} onChange={(e) => set('excludedApps', e.currentTarget.value)} />
        </Field>
        <Field label="Excluded URL patterns" hint="One pattern per line.">
          <textarea value={draft.excludedUrlPatterns} onChange={(e) => set('excludedUrlPatterns', e.currentTarget.value)} />
        </Field>
      </div>
      <h2>Storage</h2>
      <div className="grid two">
        <Field label="Max storage size (GB)">
          <input type="number" min="1" value={draft.maxSizeGb} onChange={(e) => set('maxSizeGb', Number(e.currentTarget.value))} />
        </Field>
        <Field label="Retention days">
          <input type="number" min="0" value={draft.retentionDays} onChange={(e) => set('retentionDays', Number(e.currentTarget.value))} />
        </Field>
        <Field label="Compress screenshots after days">
          <input type="number" min="0" value={draft.compressAfterDays} onChange={(e) => set('compressAfterDays', Number(e.currentTarget.value))} />
        </Field>
        <Field label="Delete screenshot assets after days" hint="Metadata and extracted text remain searchable. 0 disables deletion.">
          <input type="number" min="0" value={draft.deleteAfterDays} onChange={(e) => set('deleteAfterDays', Number(e.currentTarget.value))} />
        </Field>
      </div>
      <h2>Local AI Model</h2>
      <div className="grid two">
        <Field label="Ollama model">
          <input value={draft.ollamaModel} onChange={(e) => set('ollamaModel', e.currentTarget.value)} />
        </Field>
        <Field label="Ollama host">
          <input value={draft.ollamaHost} onChange={(e) => set('ollamaHost', e.currentTarget.value)} />
        </Field>
        <div className="card">
          <label className="check"><input type="checkbox" checked={draft.ollamaAutoInstall} onChange={(e) => set('ollamaAutoInstall', e.currentTarget.checked)} /> Auto-install local model tools when needed</label>
        </div>
      </div>
      <h2>Exports And AI Connection</h2>
      <div className="grid two">
        <Field label="Markdown export path">
          <input value={draft.markdownPath} onChange={(e) => set('markdownPath', e.currentTarget.value)} />
        </Field>
        <Field label="AI connection port">
          <input type="number" min="1" value={draft.mcpPort} onChange={(e) => set('mcpPort', Number(e.currentTarget.value))} />
        </Field>
      </div>
    </>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="field card">
      <span>{label}</span>
      {children}
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

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

function settingsDraftFromConfig(loaded: LoadedConfig): SettingsDraft {
  const cfg = loaded.config;
  const markdown = cfg.export.plugins.find((plugin) => plugin.name === 'markdown');
  const mcp = cfg.export.plugins.find((plugin) => plugin.name === 'mcp');
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

function lines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function Help({ logs }: { logs: string }) {
  return (
    <>
      <Header title="Help" subtitle="Diagnostics and local paths." />
      <div className="grid two">
        <div className="card"><h3>Runtime Logs</h3><pre>{logs || '(no desktop logs yet)'}</pre></div>
        <div className="card"><h3>Tips</h3><p>Use Setup when something needs attention. Use Journals to browse captured work sessions. Raw config editing remains available from the tray.</p></div>
      </div>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
