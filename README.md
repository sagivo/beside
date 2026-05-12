# CofounderOS

> AI-powered device capture, knowledge indexing, and agent memory system.

CofounderOS runs silently in the background, records how you interact with your
computer, and continuously organises that data into a living, self-reorganising
knowledge base. It is the persistent memory layer your AI agents have been
missing.

The system has five pluggable layers:

1. **Capture** — records raw inputs (screenshots, window focus, URL changes, idle).
2. **Storage** — persists raw data locally as JSONL + SQLite (immutable).
3. **Model** — the LLM adapter used by the index layer (Ollama, OpenAI, …).
4. **Index** — turns raw data into a structured, self-reorganising wiki.
5. **Export** — surfaces indexed knowledge to humans and AI agents (Markdown, MCP).

Every layer is a defined interface; defaults ship out of the box; everything is
swappable via `config.yaml`. Plugins are **drop-in folders**, not workspace
packages — see [Repository layout](#repository-layout) below.

---

## Platform support

CofounderOS targets all three desktop OSes from the same TypeScript codebase.
The host (config, plugin loader, scheduler, MCP server, indexer) is
platform-neutral; only the **capture layer** has OS-specific affordances.

| Platform | Status | Capture coverage | Notes |
|---|---|---|---|
| **macOS** (12+) | ✅ Fully supported | Node capture by default; experimental native sidecar supports metadata, screenshots, direct AX text, content-change hashing, and mic/input audio chunks. | Reference platform. Grant **Screen Recording** + **Accessibility** + **Automation** to your terminal/editor; native live audio also needs **Microphone** permission. |
| **Linux (X11)** | ✅ Supported | `screenshot-desktop` + `active-win`. No AX text — OCR fills in. No per-display ordinal addressing. | Install `libxss-dev libx11-dev libxext-dev libxtst-dev` for the native deps to build cleanly. |
| **Linux (Wayland)** | ⚠️ Partial | `active-win` and `screenshot-desktop` are limited or non-functional under Wayland. | Run an X11 session for now, or use `--offline` and the MCP server only. PipeWire portal capture is on the roadmap. |
| **Windows** (10 1809+ / 11) | ✅ Supported | `screenshot-desktop` (Desktop Duplication) + `active-win`. No AX text. Ollama auto-install via `winget`. | If a native module lacks a prebuild on your Node version, install **Visual Studio Build Tools (Desktop development with C++)** and Python 3 so `node-gyp` can compile. |

Anything not in the matrix above (e.g. arbitrary Linux DEs on Wayland)
should still install and run — capture will just degrade and log warnings
rather than crash.

### Capture plugins

The default capture plugin is still the TypeScript/Node implementation:

```yaml
capture:
  plugin: node
```

The native capture plugin is available as an experimental sidecar-backed
plugin:

```yaml
capture:
  plugin: native
```

Both implement the same `ICapture` interface and emit the same `RawEvent`
shape, so storage, frames, sessions, embeddings, index, Markdown export,
and MCP do not care which one is active. On macOS, the native plugin now
captures foreground-window metadata, URL changes for supported browsers,
idle, screenshots, direct AX text, content-change screenshots with dHash
suppression, and optional microphone/input audio chunks. Windows/Linux
native helpers will land behind the same sidecar protocol incrementally.
If native capture is unavailable, switch back to `capture.plugin: node`.

Run `pnpm cli doctor` before switching to native capture. It probes the
native helper binary and reports the macOS permissions it needs:

- **Screen Recording** for screenshots.
- **Accessibility** for foreground-window metadata and AX text.
- **Automation** prompts may appear when browser URL extraction talks to
  Chrome/Safari/Arc/etc. via Apple Events.
- **Microphone** only when `capture.audio.live_recording.enabled: true`.

If any native check warns, grant the permission in **System Settings →
Privacy & Security**, then restart the terminal/editor running
CofounderOS.

### Environment variables

| Variable | What it does |
|----------|--------------|
| `COFOUNDEROS_CONFIG` | Path to the YAML config file. Overrides the `~/.cofounderOS/config.yaml` lookup. |
| `COFOUNDEROS_DATA_DIR` | Re-roots all stock paths (raw capture, SQLite db, index, exports) under this directory. Use it to point at `$XDG_DATA_HOME/cofounderos` on Linux or `%APPDATA%\cofounderos` on Windows without editing config. Paths the user has explicitly customised in `config.yaml` are left alone. |
| `COFOUNDEROS_DEV` | Set by `pnpm dev` to enable the auto-reindex-on-stable behaviour. |
| `COFOUNDEROS_CAPTURE_FIXTURE` | Set to `1` to replace desktop APIs with deterministic in-process fakes. Used by CI to run `capture --once` on headless Linux/macOS/Windows runners. |
| `NO_COLOR` | Disable ANSI colour output (logs + status). |
| `FORCE_COLOR` | Force ANSI colour output even when stdout isn't a TTY (CI logs that render ANSI). |

---

## Quickstart

```bash
# Install all workspace deps
pnpm install

# Build all packages
pnpm build

# Initialise the data dir + default config AND auto-install the local AI
# model (Ollama + Gemma) with live progress. First run only — idempotent.
pnpm cli init

# Show status (read-only — never triggers an install or download)
pnpm cli status

# Preflight platform/dependency checks (also read-only)
pnpm cli doctor

# Detailed stats: disk usage breakdown, events, frames, recent activity
pnpm cli stats         # or: pnpm cli info  (alias)
pnpm cli stats --json  # machine-readable

# Start the desktop tray. It starts capturing on launch by default; set
# COFOUNDEROS_DESKTOP_AUTOSTART=0 if you want the app to launch idle.
pnpm start

# Headless/server mode: start the runtime through the CLI interface.
pnpm daemon        # equivalent to: pnpm cli start

# Run a single capture cycle (useful before committing to background mode)
pnpm cli capture --once

# Run an incremental index pass on demand
pnpm cli index --once

# Force a reorganisation pass
pnpm cli index --reorganise

# Re-index everything from raw data with a different strategy / model
pnpm cli index --full-reindex --strategy karpathy

# Re-index everything captured from a local date onward
pnpm cli index --reindex-from 2026-05-01

# Wipe everything (raw capture, sqlite db, index, exports) and start fresh.
# Preserves config.yaml by default. Prompts for confirmation; pass --yes to skip.
pnpm cli reset
```

### First-run model bootstrap

CofounderOS ships **Ollama + Gemma as the default local model** and installs
both for you on first run. You don't need to install or configure anything
manually.

What `cofounderos init` (and `start` / `index` on first launch) does:

1. **Probes** the configured Ollama host. If reachable and the model is
   already pulled, it does nothing.
2. **Auto-installs Ollama** using the platform path below (macOS / Linux:
   official shell installer; Windows: `winget`). Inherits your TTY so any
   `sudo` / UAC prompt surfaces directly. Live installer output is mirrored.
3. **Starts the Ollama daemon** if it isn't already serving.
4. **Pulls the configured model** (default: `gemma4:e4b`, ~9.6 GB — the
   recommended variant of Google's latest Gemma 4 with vision + audio
   and 128K context) with a live download progress bar — phase,
   percentage, bytes downloaded.

```
────────────────────────────────────────────
Installing ollama (one-time, first run)
You may be prompted for your password.
────────────────────────────────────────────
  >>> Downloading ollama...
  >>> Installing ollama to /usr/local/bin
  ✓ ollama installed
  ✓ Ollama daemon ready at http://localhost:11434

Downloading model gemma4:e4b (~9.6 GB) …
  pulling c6eb396dbd59  [██████████████████████████████]  100% (9.6GB / 9.6GB)
  ✓ gemma4:e4b ready
```

### Opting out

| Flag | Behaviour |
|------|-----------|
| `--offline` | Skip the Ollama install / pull entirely. Use the deterministic offline indexer (rule-based page generation). |
| `--no-bootstrap` | Skip the bootstrap *just for this command*. Useful if you've already verified Ollama is up. |

You can also disable auto-install permanently in `config.yaml`:

```yaml
index:
  model:
    plugin: ollama
    ollama:
      auto_install: false
```

If bootstrap fails for any reason (no network, install script failure,
no `winget`/`bash` available), CofounderOS falls back to the offline
deterministic indexer **automatically** and prints clear next-step
instructions — the rest of the pipeline keeps running.

### Per-OS bootstrap behaviour

| Platform | How `init` installs Ollama |
|----------|----------------------------|
| **macOS** | `curl -fsSL https://ollama.com/install.sh \| sh` (drops the .app + CLI). |
| **Linux** | Same as macOS. The installer registers a systemd unit on distros that have it. |
| **Windows** | `winget install --id Ollama.Ollama` (built into Windows 10 1809+ / Windows 11). A UAC prompt appears in a separate dialog. If `winget` is missing, you'll see a manual hint pointing at https://ollama.com/download. |

### Swapping the model later

The model is just one config line. To switch to a smaller variant
(`gemma4:e2b`) for faster responses, a larger one (`gemma4:26b`,
`gemma4:31b`) for more capability, or any other Ollama model:

```yaml
index:
  model:
    ollama:
      model: gemma4:e2b      # any Ollama-compatible tag
```

Then run `cofounderos init` again — it will pull just the new weights.

### Refreshing weights under a floating tag

Ollama tags like `gemma4:e4b` are *floating* — Google occasionally
republishes improved weights under the same name. Two ways to pick them up:

1. **On demand** — run `cofounderos model:update` to force a re-pull
   right now. Idempotent: blobs that already match by content hash are
   skipped, so the command is fast when there's nothing new.

2. **On next start** — bump `model_revision` in `config.yaml`. The
   orchestrator compares it against `~/.cofounderOS/.model-revision`
   and force-re-pulls when the configured value is higher, then writes
   the new value to the marker. Default ships at `2`; bumping to `3`
   later refreshes every install once.

```yaml
index:
  model:
    ollama:
      model: gemma4:e4b
      model_revision: 3      # bump to force a refresh on next start
```

---

## Multi-monitor capture

By default CofounderOS captures only the **primary display** — one
screenshot per trigger — to keep storage, CPU, and the privacy surface
predictable. To enable multi-monitor capture:

```yaml
capture:
  multi_screen: true
  # screens: [0, 1]      # optional whitelist of zero-based display indexes
  # capture_mode: active # 'active' (default) | 'all'
```

`capture_mode` controls **which** displays are shot on each trigger when
multi-screen is on. The default — `active` — captures only the monitor
the user is actually working on, which is almost always what you want:

| Mode | Behaviour |
|------|-----------|
| `active` (default) | Only the display owning the focused window is captured. The active screen is resolved by hit-testing the focused window's bounds (from `active-win`, with an osascript fallback on macOS) against each display's rectangle, then cached single-slot so subsequent ticks on the same window skip the math. Cuts storage/CPU ~N× without losing acted-on signal. |
| `all` | Every configured display is captured on every trigger. Use when secondary monitors carry independent signal you'll reference later (dashboards, reference docs). Storage and OCR scale linearly with display count. |

In `active` mode, content-change probes also run only on the focused
display — so a churning background dashboard won't trigger captures.
Triggers without a meaningful active window (e.g. `idle_end`) gracefully
fall back to capturing all configured displays so no frames are lost.
On startup, the capture log prints the detected displays, their
rectangles, and the resolved mode so you can confirm geometry was probed
correctly:

```
multi_screen capture: 2/2 display(s) [mode=active]
```

Each emitted event still carries a `screen_index` so downstream consumers
can tell which monitor a frame came from. If you preferred the previous
"capture every display every tick" semantics, set `capture_mode: all`.

---

## Development

For desktop UI development, run:

```bash
pnpm dev
```

This does an initial build, then in parallel:

- Serves the Electron renderer with Vite, so React edits hot-reload in the
  desktop window.
- Watches the workspace packages (`interfaces`, `core`, `runtime`) plus the
  Electron main/preload sources with `tsc --watch`, then restarts Electron when
  compiled main-process inputs change.
- Watches plugin sources and native helper sources, rebuilding plugin `dist/`
  output and Swift helpers when they change.

The old CLI live-development loop is still available as:

```bash
pnpm dev:cli
```

`pnpm dev:cli` also schedules a **full re-index 60 seconds after the dev
process becomes stable** - i.e. once you stop editing files for a minute. Each
file edit restarts `tsx` and cancels the pending timer, so the re-index only
fires when you've stopped iterating. A marker file in the data dir suppresses
re-runs for 24 h after a successful dev re-index, so an idle `pnpm dev:cli`
doesn't re-index repeatedly.

For plugin sources under `plugins/<layer>/<name>/src/`, `pnpm dev` rebuilds
them automatically. If you are not running the desktop dev loop, rerun
`pnpm build:plugins` after plugin edits because plugins are loaded from their
`dist/` output.

For one-off CLI commands against live source (e.g. `stats`, `index --once`):

```bash
pnpm --filter @cofounderos/cli exec tsx src/cli.ts stats
```

For headless smoke tests or CI, use the capture fixture. It writes a real
synthetic screenshot + raw event through the same storage path as normal
capture without touching desktop APIs or OS permissions:

```bash
COFOUNDEROS_CAPTURE_FIXTURE=1 \
COFOUNDEROS_DATA_DIR=/tmp/cofounderos-smoke \
pnpm cli capture --once
```

---

## Disk usage & retention

Captured screenshots dominate on-disk size. The defaults aim for a small,
self-bounded footprint by combining four levers — tweak any of them in
`config.yaml`:

| Knob | Where | Default | What it controls |
|------|-------|---------|------------------|
| `capture.screenshot_max_dim` | capture | `1100` | Longest-edge resize at capture time. Native Retina (~3000 px) is ~7× the pixels of the resized version. `0` keeps native resolution. |
| `capture.screenshot_quality` | capture | `45` | WebP quality. Screen content (UI, text) tolerates much lower quality than photographs; lower values reduce encode work and disk churn. |
| `capture.screenshot_diff_threshold` | capture | `0.15` | Soft-trigger floor on perceptual-hash distance. Higher = fewer near-duplicate frames. |
| `capture.focus_settle_delay_ms` | capture | `900` | Delay after a focus change before taking the screenshot, so transient switcher UI such as Cmd+Tab is not captured. |
| `capture.content_change_min_interval_ms` | capture | `60000` | Minimum delay between two soft-trigger captures of the same display. Hard triggers (window focus, URL change, idle end) bypass this. |
| `storage.local.vacuum.*` | storage | 1 h / 30 d / 180 d | Sliding-window retention: re-encode at lower quality after `compress_after_days`, downscale after `thumbnail_after_days`, delete after `delete_after_days`. Each accepts `*_minutes` for finer-grained tuning (e.g. `compress_after_minutes: 30` for testing). SQLite metadata + OCR text is kept forever — only the on-disk image evolves. |

For tight retention while testing scale:

```yaml
storage:
  local:
    vacuum:
      compress_after_minutes: 30   # re-encode within 30 min
      thumbnail_after_minutes: 360 # downscale after 6 h
      delete_after_days: 14
```

---

## Querying your data with AI agents

Once `cofounderos start` is running, your captured data is queryable by any
MCP-compatible AI agent (Claude Desktop, Claude Code, Cursor, etc.). The
built-in MCP server exposes the index, the raw event log, and frame-level
search as first-class tools — agents don't need to read files directly.

### Available MCP tools

| Tool | What it does |
|------|--------------|
| `search_memory` | Default entrypoint. Blended search across keyword frames + semantic frame embeddings + wiki pages. CofounderOS dashboard frames are filtered out by default — pass `exclude_self: false` to include them. |
| `search_frames` | FTS5 search over OCR / accessibility text, window titles, and URLs, optionally blended with semantic embedding matches. Same `exclude_self` default. |
| `get_frame_context` | Chronological neighbourhood around a specific frame. |
| `get_journal` | All frames captured on a given day, grouped by activity session, as a markdown timeline. |
| `get_daily_summary` | One-shot digest for a day: totals, top apps, top entities, top URL hosts, sessions with headlines, calendar events, Slack threads, code-review queue, and open loops. |
| `list_meetings` | Zoom / Google Meet / Microsoft Teams / Webex sessions detected from screenshots, fused with their audio transcripts. Each row reports time range, platform, attendees seen, links shared, and whether a structured summary is ready. |
| `get_meeting` | Fetch a single meeting by id. Returns the structured summary (TL;DR, decisions, action items, key moments) plus the fused transcript turns — each turn is tied to the screenshot frame on screen at the moment of the utterance via `visual_frame_id`. |
| `summarize_meeting` | Run (or re-run with `force: true`) the meeting summarizer on demand. Useful right after dropping a `.vtt` transcript into the audio inbox or when swapping models. |
| `get_calendar_events` | Heuristic structured calendar extraction from frames captured on a calendar UI for a given day. Returns `{ time_label, title, source_frame_id }` rows. |
| `get_open_loops` | Surfaces unanswered Slack messages and open / draft GitHub PRs and issues observed in a day or `since`/`until` window. The "what's still on my plate?" tool. |
| `get_entity_summary` | Fresh, focused rollup for one entity in an optional time window — totals, top window titles, top URL hosts, recent sessions, calendar events, and open loops tied to that entity. |
| `get_slack_activity` | Per-channel observations from chat frames on a given day: representative message OCR, mentions, whether the visible message looks unanswered. |
| `list_sessions` | Recent activity sessions (continuous focus runs) with primary entity, app, and active time. |
| `get_activity_session` | Drill into one activity session by id; returns metadata + frame timeline. |
| `list_entities` | Remembered entities (projects, repos, channels, contacts, …) by recent activity or FTS-ranked free-text search. |
| `get_entity` | Read one entity by stable path; optionally include its earliest frames as evidence. |
| `get_entity_frames` | Frames belonging to an entity, oldest first. |
| `list_entity_neighbours` | Entities that recurrently appear in the same activity sessions as the given entity (working knowledge graph). |
| `get_entity_timeline` | Per-day or per-hour attention buckets for an entity — frame count, focused minutes, distinct sessions per bucket. |
| `get_page` | Read a wiki page by relative path. |
| `get_index` | Read the wiki root `index.md`. |
| `query_raw_events` | Raw event log query (bypasses the index). |
| `get_session` | Reconstruct events + screenshot paths over a time range (raw-event time slice). |
| `trigger_reindex` | Queue an incremental or full re-index. |

The digest tools (`get_daily_summary`, `get_calendar_events`, `get_open_loops`,
`get_slack_activity`, `get_entity_summary`) compose existing storage primitives
plus heuristic OCR parsers — they do not require a separate indexer pass and
return fresh data on every call. The calendar / Slack / PR extractors are
deliberately conservative: they tag candidates with `source_frame_id` so you
can chase any individual extraction back to its screenshot via
`get_frame_context`. Frames captured of the CofounderOS dashboard itself are
excluded by default from every digest tool; pass `include_self: true` to
include them.

### Semantic embeddings

V2 semantic search runs locally by default with Ollama's
`nomic-embed-text` model. A background worker embeds each frame's
searchable content (app, title, URL, resolved entity, OCR/accessibility
text, and audio transcripts) and stores normalised vectors in SQLite. `search_memory` and
`search_frames` still use FTS5 for exact keyword precision, but now blend
in conceptual matches when wording differs.

```yaml
index:
  embeddings:
    enabled: true
    batch_size: 32
    tick_interval_min: 5
  model:
    ollama:
      embedding_model: nomic-embed-text
```

The first `cofounderos init` / `start` after enabling embeddings pulls
the embedding model alongside the chat model. If the active model adapter
doesn't support embeddings, the worker logs one warning and the system
falls back to keyword search unchanged.

### Hosted model plugins

Ollama remains the default local model, but the model layer is swappable.
The built-in `openai` plugin works with OpenAI's API and compatible
gateways that implement `/chat/completions` and `/embeddings`:

```yaml
index:
  model:
    plugin: openai
    openai:
      api_key: ${OPENAI_API_KEY}      # or set OPENAI_API_KEY in the environment
      base_url: https://api.openai.com/v1
      model: gpt-4o-mini
      embedding_model: text-embedding-3-small
```

No storage or index changes are required — the same `IModelAdapter`
contract powers wiki indexing, vision calls, and semantic embeddings.

### Audio transcription

V2 audio starts with a local inbox rather than live system-audio capture.
Drop transcript files (`.txt`, `.md`, `.vtt`, `.srt`) into the inbox and
CofounderOS imports them directly. Drop audio files (`.wav`, `.mp3`,
`.m4a`, `.flac`, `.ogg`, `.opus`, `.webm`, `.mp4`) and CofounderOS runs
the configured local Whisper CLI, then stores the transcript as an
`audio_transcript` event. Those transcripts become frames with
`text_source: audio`, so normal search, sessions, entities, embeddings,
journals, and MCP tools all pick them up.

```yaml
capture:
  capture_audio: true
  whisper_model: base
  audio:
    inbox_path: ~/.cofounderOS/raw/audio/inbox
    processed_path: ~/.cofounderOS/raw/audio/processed
    failed_path: ~/.cofounderOS/raw/audio/failed
    tick_interval_sec: 60
    batch_size: 5
    whisper_command: whisper
    live_recording:
      enabled: true       # native capture plugin only; joins after another process opens audio input
      activation: other_process_input
      system_audio_backend: core_audio_tap
      chunk_seconds: 300
      format: m4a
      sample_rate: 16000
      channels: 1
```

To use transcript import only, no Whisper install is needed. To transcribe
audio files, install a compatible `whisper` command first, for example
OpenAI Whisper's CLI. Files that fail transcription are moved to
`failed_path` with a `.error.txt` sidecar explaining why.

When using `capture.plugin: native` on macOS, live recording is enabled
by default and starts only while another process is actively using audio
input. CofounderOS does not start audio capture from meeting UI or URL
detection alone; it only joins an already-active audio session. The
transcript worker will pick up finished `.m4a` / `.wav` chunks on its
next tick.

### Meetings (Zoom / Google Meet / Microsoft Teams / Webex)

CofounderOS detects meeting frames from app/URL signals (Zoom, Google
Meet, Microsoft Teams, Webex, Whereby, Around) and fuses them with
overlapping audio transcripts to produce per-meeting summaries.

Two layers cooperate:

1. **MeetingBuilder** groups consecutive meeting screenshot frames into
   a first-class `Meeting` row, attaches every overlapping
   `audio_transcript` frame, and aligns each transcript turn to the
   screenshot frame on screen at the moment the line was spoken
   (`turn.visual_frame_id`). This is how "what was on screen when X said
   Y" becomes a query.
2. **MeetingSummarizer** produces a structured TL;DR + decisions + action
   items + key moments via the model adapter, with vision attachments
   for the most informative slides when the model supports vision. A
   deterministic Stage A summary (attendees, links, agenda from window
   titles, key screenshots) ships even when the LLM is unavailable.

Configure under `index.meetings`:

```yaml
index:
  meetings:
    idle_threshold_sec: 90      # gap that closes an active meeting
    min_duration_sec: 180       # below this, summary is skipped (skipped_short)
    audio_grace_sec: 60         # audio chunks arriving up to N sec late still attach
    summarize: true             # set false to skip the LLM step entirely
    summarize_cooldown_sec: 300 # wait this long after meeting close before summarising
    vision_attachments: 4       # number of key screenshots passed to the vision model
```

Query meetings via the MCP tools `list_meetings` / `get_meeting` /
`summarize_meeting`, or read them inline at the top of every daily
journal under the `## Meetings` section.

For best summary quality, use the native plugin's default
`core_audio_tap` backend on macOS 14.2+ so remote participants are
transcribed too. If system output capture is disabled or unavailable,
only your microphone is captured and the summary is built from your half
of the conversation plus the visible slides.

### Two transports

The MCP server runs over **HTTP by default** (alongside `cofounderos start`),
and can also be invoked over **stdio** for clients that spawn the server as
a subprocess.

```bash
# HTTP — already running as part of `cofounderos start` on http://127.0.0.1:3456
curl http://127.0.0.1:3456/health

# stdio — for clients that prefer to manage the process lifecycle
pnpm cli mcp --stdio
```

### Claude Code / Claude Desktop

Edit your Claude Desktop config — the file lives at:

| OS | Path |
|----|------|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

Or, for Claude Code, run `claude mcp add` from any shell.

**HTTP (recommended — uses the already-running daemon):**

```json
{
  "mcpServers": {
    "cofounderos": {
      "url": "http://127.0.0.1:3456"
    }
  }
}
```

Or with the Claude Code CLI:

```bash
claude mcp add --transport http cofounderos http://127.0.0.1:3456
```

**stdio (Claude spawns the server itself):**

```json
{
  "mcpServers": {
    "cofounderos": {
      "command": "pnpm",
      "args": ["--dir", "/absolute/path/to/cofounderos", "cli", "mcp", "--stdio"]
    }
  }
}
```

On **Windows**, use a backslash path and the `pnpm.cmd` shim
(JSON requires every backslash to be escaped):

```json
{
  "mcpServers": {
    "cofounderos": {
      "command": "pnpm.cmd",
      "args": ["--dir", "C:\\path\\to\\cofounderos", "cli", "mcp", "--stdio"]
    }
  }
}
```

### Cursor

Add to `~/.cursor/mcp.json` (or the workspace `.cursor/mcp.json`).
On Windows, the equivalent path is `%USERPROFILE%\.cursor\mcp.json`.

```json
{
  "mcpServers": {
    "cofounderos": {
      "url": "http://127.0.0.1:3456"
    }
  }
}
```

### Verifying the connection

Once configured, ask the agent something like:

> What was I working on yesterday afternoon? Use the `cofounderos` tools.

The agent should call `get_journal` or `search_memory` and stream back a
synthesised answer grounded in your captured frames. If a tool call fails,
check `pnpm cli status` — the MCP `url` row should show `http://127.0.0.1:3456`.

### Changing the port / host / preview size

```yaml
export:
  plugins:
    - name: mcp
      host: 127.0.0.1
      port: 3456
      text_excerpt_chars: 5000
```

---

## Repository layout

`packages/` holds the **host** workspace packages. `plugins/` holds
the **drop-in plugin folders** — both built-in and third-party — one folder
per layer, one folder per plugin underneath.

```
cofounderos/
├── packages/                   The host workspace packages.
│   ├── interfaces/             Shared types: ICapture, IStorage, IModelAdapter,
│   │                           IIndexStrategy, IExport, RawEvent schema.
│   ├── core/                   Config loader, plugin loader, event bus, scheduler.
│   ├── runtime/                Shared lifecycle, workers, status, journals, search.
│   ├── cli/                    Terminal interface (cofounderos ...).
│   └── desktop/                Electron desktop interface over the runtime.
└── plugins/                    Drop-in plugins. No package.json needed.
    ├── capture/
    │   ├── node/               Default capture: event-driven Node recorder.
    │   └── native/             Experimental native sidecar capture plugin.
    ├── storage/
    │   └── local/              Default storage: ~/.cofounderOS/raw + SQLite.
    ├── model/
    │   └── ollama/             Default model adapter (Ollama / Gemma).
    ├── index/
    │   └── karpathy/           Default index strategy (Karpathy LLM wiki).
    └── export/
        ├── markdown/           Default export — mirror to ~/.cofounderOS/export/markdown.
        └── mcp/                Built-in MCP server on 127.0.0.1:3456.
```

### Adding a plugin

A plugin is a folder with two things:

```
plugins/<layer>/<name>/
├── plugin.json     manifest (layer, interface, entrypoint, name, version, config_schema)
└── src/
    └── index.ts    exports `default` a PluginFactory<T> for the layer's interface
```

That's it — no `package.json`, no `tsconfig.json`, no `pnpm-workspace.yaml`
edit, no `pnpm install`. Then:

```bash
pnpm build:plugins      # compiles every plugins/<layer>/<name>/src to its dist/
pnpm cli plugin list    # confirms discovery
```

The host never imports any plugin by name. Discovery walks `plugins/` at
runtime, validates `plugin.json` against `@cofounderos/interfaces`, and
dynamically imports the entrypoint. To activate a plugin, reference it by
manifest `name` from `config.yaml` (e.g. `storage.plugin: local`).

The CLI and desktop app both call `@cofounderos/runtime`; neither owns the
product lifecycle by itself. Packaged desktop builds should place the runtime
resource root at `resources/cofounderos` (or set `COFOUNDEROS_RESOURCE_ROOT`)
so runtime plugin discovery can find `plugins/` without a source checkout.

Runtime dependencies common to plugins (`sharp`, `better-sqlite3`,
`active-win`, `ollama`, `@modelcontextprotocol/sdk`, `zod`, …) are hoisted
into the workspace root, so plugin source files resolve them via Node's
upward `node_modules` walk without each plugin declaring its own deps.

---

## Status vs spec v0.2

This implementation tracks the **V1 / MVP** scope from the spec, with two
explicit substitutions for tractability:

| Spec component        | Status in this repo |
|-----------------------|---------------------|
| Rust capture agent    | Replaced by `plugins/capture/node/` (TypeScript). Same `ICapture` interface, so the Rust agent is a drop-in replacement once built. |
| Electron tray + UI    | Deferred. CLI exposes the full surface (`cofounderos start/stop/status/...`). Electron is a thin wrapper to be added later. |
| Audio transcription   | Capture layer surfaces the event types and config knobs; transcription itself is V2. |
| Cloud storage / models| `IStorage` and `IModelAdapter` are stable; concrete cloud plugins live under `plugins/` and are not part of MVP. |

Everything else (the four layer interfaces, plugin loader, default storage,
default model adapter, Karpathy strategy with self-reorganisation, Markdown
export, built-in MCP server, CLI, full re-index from raw) is implemented and
runnable.
