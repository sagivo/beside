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

# Detailed stats: disk usage breakdown, events, frames, recent activity
pnpm cli stats         # or: pnpm cli info  (alias)
pnpm cli stats --json  # machine-readable

# Start the full pipeline: capture + scheduled indexing + MCP server.
# If `init` wasn't run, this will bootstrap the model on first launch.
pnpm cli start

# Run a single capture cycle (useful before committing to background mode)
pnpm cli capture --once

# Run an incremental index pass on demand
pnpm cli index --once

# Force a reorganisation pass
pnpm cli index --reorganise

# Re-index everything from raw data with a different strategy / model
pnpm cli index --full-reindex --strategy karpathy

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
2. **Auto-installs Ollama** (macOS / Linux) by piping the official
   `https://ollama.com/install.sh` through `sh`. Inherits your TTY so any
   `sudo` prompt surfaces directly. Live installer output is mirrored.
3. **Starts the Ollama daemon** if it isn't already serving.
4. **Pulls the configured model** (default: `gemma2:2b`, ~1.6 GB) with a
   live download progress bar — phase, percentage, bytes downloaded.

```
────────────────────────────────────────────
Installing ollama (one-time, first run)
You may be prompted for your password.
────────────────────────────────────────────
  >>> Downloading ollama...
  >>> Installing ollama to /usr/local/bin
  ✓ ollama installed
  ✓ Ollama daemon ready at http://localhost:11434

Downloading model gemma2:2b (~1.6 GB) …
  pulling 8eeb52dfb1c2  [██████████████████████████████]  100% (1.6GB / 1.6GB)
  ✓ gemma2:2b ready
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
unsupported platform like Windows where there's no shell installer),
CofounderOS falls back to the offline deterministic indexer **automatically**
and prints clear next-step instructions — the rest of the pipeline keeps
running.

### Swapping the model later

The model is just one config line. To upgrade to Gemma 3, larger Gemma
variants, or any other Ollama model:

```yaml
index:
  model:
    ollama:
      model: gemma3:9b      # any Ollama-compatible tag
```

Then run `cofounderos init` again — it will pull just the new weights.

---

## Development

`pnpm cli ...` runs the **compiled** output at `packages/app/dist/cli.js`, so
edits aren't picked up until you rebuild. For live development, just run:

```bash
pnpm dev
```

This does an initial build, then in parallel:

- Watches the 3 workspace packages (`interfaces`, `core`, `app`) with
  `tsc --watch` — any change to a `packages/**/src/**/*.ts` file triggers
  an incremental recompile of that package's `dist/`.
- Runs the CLI's `start` command via `tsx watch`, which restarts the process
  whenever any imported source or rebuilt `dist/` file changes.

For plugin sources under `plugins/<layer>/<name>/src/`, rerun
`pnpm build:plugins` after edits. (Plugins are loaded from their `dist/`
output at runtime, not the workspace's TS watcher graph, so they need an
explicit rebuild.)

For one-off CLI commands against live source (e.g. `stats`, `index --once`):

```bash
pnpm --filter @cofounderos/app exec tsx src/cli.ts stats
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
| `search_memory` | Default entrypoint. Blended search across frames + wiki pages. |
| `search_frames` | FTS5 search over OCR text, window titles, and URLs. |
| `get_frame_context` | Chronological neighbourhood around a specific frame. |
| `get_journal` | All frames captured on a given day, as a markdown timeline. |
| `get_page` | Read a wiki page by relative path. |
| `get_index` | Read the wiki root `index.md`. |
| `query_raw_events` | Raw event log query (bypasses the index). |
| `get_session` | Reconstruct events + screenshot paths over a time range. |
| `trigger_reindex` | Queue an incremental or full re-index. |

### Two transports

The MCP server runs over **HTTP by default** (alongside `cofounderos start`),
and can also be invoked over **stdio** for clients that spawn the server as
a subprocess.

```bash
# HTTP — already running as part of `cofounderos start` on http://localhost:3456
curl http://localhost:3456/health

# stdio — for clients that prefer to manage the process lifecycle
pnpm cli mcp --stdio
```

### Claude Code / Claude Desktop

Add CofounderOS to your Claude config (`~/Library/Application Support/Claude/claude_desktop_config.json`
on macOS, or via `claude mcp add` for Claude Code):

**HTTP (recommended — uses the already-running daemon):**

```json
{
  "mcpServers": {
    "cofounderos": {
      "url": "http://localhost:3456"
    }
  }
}
```

Or with the Claude Code CLI:

```bash
claude mcp add --transport http cofounderos http://localhost:3456
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

### Cursor

Add to `~/.cursor/mcp.json` (or the workspace `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "cofounderos": {
      "url": "http://localhost:3456"
    }
  }
}
```

### Verifying the connection

Once configured, ask the agent something like:

> What was I working on yesterday afternoon? Use the `cofounderos` tools.

The agent should call `get_journal` or `search_memory` and stream back a
synthesised answer grounded in your captured frames. If a tool call fails,
check `pnpm cli status` — the MCP `url` row should show `http://localhost:3456`.

### Changing the port / host

```yaml
export:
  plugins:
    - name: mcp
      config:
        host: 127.0.0.1
        port: 3456
```

---

## Repository layout

`packages/` holds the **host** (3 npm workspace packages). `plugins/` holds
the **drop-in plugin folders** — both built-in and third-party — one folder
per layer, one folder per plugin underneath.

```
cofounderos/
├── packages/                   The host. 3 npm workspace packages.
│   ├── interfaces/             Shared types: ICapture, IStorage, IModelAdapter,
│   │                           IIndexStrategy, IExport, RawEvent schema.
│   ├── core/                   Config loader, plugin loader, event bus, scheduler.
│   └── app/                    CLI orchestrator (cofounderos ...).
└── plugins/                    Drop-in plugins. No package.json needed.
    ├── capture/
    │   └── node/               Default capture: event-driven Node recorder.
    ├── storage/
    │   └── local/              Default storage: ~/.cofounderOS/raw + SQLite.
    ├── model/
    │   └── ollama/             Default model adapter (Ollama / Gemma).
    ├── index/
    │   └── karpathy/           Default index strategy (Karpathy LLM wiki).
    └── export/
        ├── markdown/           Default export — mirror to ~/.cofounderOS/export/markdown.
        └── mcp/                Built-in MCP server on localhost:3456.
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
