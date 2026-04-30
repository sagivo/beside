# CofounderOS

> AI-powered device capture, knowledge indexing, and agent memory system.

CofounderOS runs silently in the background, records how you interact with your
computer, and continuously organises that data into a living, self-reorganising
knowledge base. It is the persistent memory layer your AI agents have been
missing.

The system has four pluggable layers:

1. **Capture** — records raw inputs (screenshots, window focus, URL changes, idle).
2. **Storage** — persists raw data locally as JSONL + SQLite (immutable).
3. **Index** — an LLM parses raw data into a structured, self-reorganising wiki.
4. **Export** — surfaces indexed knowledge to humans and AI agents (Markdown, MCP).

Every layer is a defined interface; defaults ship out of the box; everything is
swappable via `config.yaml`.

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

## Repository layout

One folder per layer. Inside each layer folder, one folder per plugin.

```
cofounderos/
├── packages/
│   ├── interfaces/             Shared types: ICapture, IStorage, IModelAdapter,
│   │                           IIndexStrategy, IExport, RawEvent schema.
│   ├── core/                   Config loader, plugin loader, event bus, scheduler.
│   ├── app/                    CLI orchestrator (cofounderos ...).
│   ├── capture/
│   │   └── node/               Default capture: event-driven Node recorder.
│   ├── storage/
│   │   └── local/              Default storage: ~/.cofounderOS/raw + SQLite.
│   ├── model/
│   │   └── ollama/             Default model adapter (Ollama / Gemma).
│   ├── index/
│   │   └── karpathy/           Default index strategy (Karpathy LLM wiki).
│   └── export/
│       ├── markdown/           Default export — mirror to ~/.cofounderOS/export/markdown.
│       └── mcp/                Built-in MCP server on localhost:3456.
└── plugins/                    Optional / community plugins (same layered shape).
    ├── capture/
    ├── storage/
    ├── model/
    ├── index/
    └── export/
```

Each plugin folder contains `plugin.json`, `package.json`, `src/`, and is
loaded at runtime by the core plugin loader. The core never imports any
plugin directly — discovery happens via `pnpm-workspace.yaml` globs and
`plugin.json` manifests, so adding a new plugin is just dropping a new
folder under the right layer.

---

## Status vs spec v0.2

This implementation tracks the **V1 / MVP** scope from the spec, with two
explicit substitutions for tractability:

| Spec component        | Status in this repo |
|-----------------------|---------------------|
| Rust capture agent    | Replaced by `packages/capture-node` (TypeScript). Same `ICapture` interface, so the Rust agent is a drop-in replacement once built. |
| Electron tray + UI    | Deferred. CLI exposes the full surface (`cofounderos start/stop/status/...`). Electron is a thin wrapper to be added later. |
| Audio transcription   | Capture layer surfaces the event types and config knobs; transcription itself is V2. |
| Cloud storage / models| `IStorage` and `IModelAdapter` are stable; concrete cloud plugins live under `plugins/` and are not part of MVP. |

Everything else (the four layer interfaces, plugin loader, default storage,
default model adapter, Karpathy strategy with self-reorganisation, Markdown
export, built-in MCP server, CLI, full re-index from raw) is implemented and
runnable.
