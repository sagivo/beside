import "./styles.css";

const DOWNLOAD_URL = "https://github.com/beside-ai/beside/releases/latest/download/Beside-mac.dmg";

export default function App() {
  return (
    <>
      <AmbientBackdrop />

      <header className="nav">
        <div className="container nav-inner">
          <a href="/" className="brand" aria-label="Beside home">
            <span className="brand-mark" aria-hidden />
            <span>Beside</span>
          </a>
          <nav className="nav-links" aria-label="Primary">
            <a href="#pipeline">Live pipeline</a>
            <a href="#features">Features</a>
            <a href="#how">How it works</a>
            <a href="https://github.com/beside-ai/beside">GitHub</a>
            <a href="#download" className="nav-cta">Download</a>
          </nav>
        </div>
      </header>

      <main>
        {/* ─────── Hero ─────── */}
        <section className="hero">
          <div className="container hero-grid">
            <div>
              <span className="eyebrow">
                <span className="dot" aria-hidden />
                Ambient AI · captures, indexes, surfaces, remembers
              </span>

              <h1>
                <span className="grad">Watches. Indexes. Surfaces.</span>
                <br />
                A quiet memory for every AI on your&nbsp;Mac.
              </h1>

              <p className="lede">
                Beside <strong>captures</strong> what you do on your computer,{" "}
                <strong>indexes</strong> it into a self-organising knowledge base,
                quietly <strong>surfaces</strong> what matters, and{" "}
                <strong>remembers</strong> it as long-term context for every AI
                agent you use — securely on-device.
              </p>

              <div className="btn-row">
                <a className="btn btn-primary" href={DOWNLOAD_URL} id="download">
                  <DownloadIcon />
                  <span>
                    Download for Mac
                    <small>macOS 12+ · Apple silicon &amp; Intel</small>
                  </span>
                </a>
                <a className="btn btn-ghost" href="#pipeline">
                  See it in motion
                </a>
              </div>

              <div className="trust" aria-label="Highlights">
                <span><Tick /> 100% local-first</span>
                <span><Tick /> Free during beta</span>
                <span><Tick /> Works with MCP</span>
              </div>
            </div>

            <div className="hero-viz" aria-hidden>
              <div className="grid-bg" />
              <MemoryConstellation />

              {/* capture chips drifting toward the memory core */}
              <div className="cap-chip-layer">
                <div className="cap-chip tl">
                  <span className="ic cap">▢</span>
                  <span>Screenshot · Figma</span>
                </div>
                <div className="cap-chip tr">
                  <span className="ic url">↗</span>
                  <span>URL · Stripe docs</span>
                </div>
                <div className="cap-chip bl">
                  <span className="ic idx">▲</span>
                  <span>Slack · #beside-core</span>
                </div>
                <div className="cap-chip br">
                  <span className="ic rec">✦</span>
                  <span>Code · pricing.ts</span>
                </div>
              </div>

              {/* outbound agent chips pulling context */}
              <div className="agent-chip-layer">
                <div className="agent-chip a1">
                  <span className="a-dot" />
                  <span>Claude</span>
                </div>
                <div className="agent-chip a2">
                  <span className="a-dot" />
                  <span>Cursor</span>
                </div>
                <div className="agent-chip a3">
                  <span className="a-dot" />
                  <span>ChatGPT</span>
                </div>
              </div>

              <div className="hero-caption">
                <span className="dot" />
                Indexing — 14 new memories
              </div>
            </div>
          </div>
        </section>

        {/* ─────── Live pipeline ─────── */}
        <section id="pipeline" className="block pipeline">
          <div className="container">
            <div className="section-head">
              <span className="eyebrow"><span className="dot" />Live pipeline</span>
              <h2>It captures, indexes, surfaces — and remembers.</h2>
              <p>
                Four quiet loops, running in the background of your machine.
                Together they turn every signal on your computer into structured
                memory your AI agents can actually use.
              </p>
            </div>
            <div className="pipeline-grid">
              <CaptureCard />
              <IndexCard />
              <SurfaceCard />
              <RecallCard />
            </div>
          </div>
        </section>

        {/* ─────── Features ─────── */}
        <section id="features" className="block">
          <div className="container">
            <div className="section-head">
              <span className="eyebrow"><span className="dot" />What it does</span>
              <h2>An always-on context layer, tuned for the AI age.</h2>
              <p>
                LLMs forget. Agents start from zero. Beside is the quiet layer in
                between — continuously turning what you actually do on your
                computer into recallable memory that any tool can use.
              </p>
            </div>
            <div className="features">
              <Feature
                badge="01"
                title="Silent capture"
                body="Screenshots, active window, URLs, idle state — captured locally with negligible overhead. Nothing leaves your machine unless you say so."
              />
              <Feature
                badge="02"
                title="Self-organising knowledge"
                body="A local model turns captures into structured notes, topics, and timelines. The wiki re-organises itself as your work evolves."
              />
              <Feature
                badge="03"
                title="Proactive surfacing"
                body="Beside watches for the moments that matter — patterns, follow-ups, half-finished threads — and quietly pins them where you'll see them."
              />
              <Feature
                badge="04"
                title="Memory for agents"
                body="Ship rich context to Claude, ChatGPT, Cursor and any MCP-compatible agent — so they remember yesterday, last week, last quarter."
              />
              <Feature
                badge="05"
                title="Local-first by design"
                body="Raw data lives as JSONL + SQLite on your disk. Bring your own model — Ollama, OpenAI, Anthropic — or run fully offline."
              />
              <Feature
                badge="06"
                title="OCR &amp; semantic search"
                body="Every screenshot is OCR'd and embedded so you can search across everything you've ever seen — in plain English."
              />
            </div>
          </div>
        </section>

        {/* ─────── How ─────── */}
        <section id="how" className="block">
          <div className="container">
            <div className="section-head">
              <span className="eyebrow"><span className="dot" />Under the hood</span>
              <h2>From captured pixels to living memory.</h2>
              <p>
                The same four loops, in technical detail. Each stage is a
                swappable plugin — capture, storage, model, index, export.
              </p>
            </div>
            <div className="how">
              <ol className="steps">
                <Step
                  n="1"
                  title="Capture"
                  body="The capture layer records screenshots, focused windows, URLs and idle events — running silently in the background with negligible overhead."
                />
                <Step
                  n="2"
                  title="Store"
                  body="Raw events are appended to immutable JSONL + SQLite locally. Nothing is destructive; everything is replayable."
                />
                <Step
                  n="3"
                  title="Index &amp; surface"
                  body="A local LLM extracts entities, topics, and intents, continuously refactors the wiki, and surfaces patterns worth your attention."
                />
                <Step
                  n="4"
                  title="Recall"
                  body="Expose your memory to any AI agent over MCP, Markdown, or a simple API. Context engineering, finally automated."
                />
              </ol>

              <MemoryLog />
            </div>
          </div>
        </section>

        {/* ─────── CTA ─────── */}
        <section className="cta">
          <div className="container">
            <div className="cta-inner">
              <span className="eyebrow"><span className="dot" />Free during beta</span>
              <h2>Give your AI a memory worth&nbsp;keeping.</h2>
              <p>
                Install Beside once and every AI tool you use gets quietly smarter
                about <em>you</em>.
              </p>
              <div className="btn-row">
                <a className="btn btn-primary" href={DOWNLOAD_URL}>
                  <DownloadIcon />
                  <span>
                    Download for Mac
                    <small>Free during beta · macOS 12+</small>
                  </span>
                </a>
                <a className="btn btn-ghost" href="https://github.com/beside-ai/beside">
                  <GitHubIcon />
                  <span>
                    Star on GitHub
                    <small>Open source · MIT</small>
                  </span>
                </a>
              </div>
              <p className="os-hint" style={{ marginTop: 22 }}>
                Windows &amp; Linux — coming soon.
              </p>
            </div>
          </div>
        </section>
      </main>

      <footer>
        <div className="container footer-inner">
          <div>© {new Date().getFullYear()} Beside · Local-first AI memory.</div>
          <div style={{ display: "flex", gap: 22 }}>
            <a href="https://github.com/beside-ai/beside">GitHub</a>
            <a href="/privacy">Privacy</a>
            <a href="mailto:hello@beside.ai">Contact</a>
          </div>
        </div>
      </footer>
    </>
  );
}

/* ───────────────────────────── components ──────────────────── */

function AmbientBackdrop() {
  return (
    <div className="ambient" aria-hidden>
      <div className="aurora one" />
      <div className="aurora two" />
      <div className="aurora three" />
      <div className="aurora four" />
    </div>
  );
}

function MemoryConstellation() {
  const nodes = [
    { id: "n1", cx: 92,  cy: 110, r: 7 },
    { id: "n2", cx: 312, cy: 92,  r: 6 },
    { id: "n3", cx: 80,  cy: 290, r: 8 },
    { id: "n4", cx: 320, cy: 310, r: 7 },
    { id: "n5", cx: 200, cy: 60,  r: 5 },
    { id: "n6", cx: 340, cy: 200, r: 5 },
    { id: "n7", cx: 60,  cy: 200, r: 5 },
    { id: "n8", cx: 200, cy: 340, r: 5 },
  ];
  const center = { x: 200, y: 200 };

  return (
    <svg viewBox="0 0 400 400" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="coreGlow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#6b6cf0" stopOpacity="0.55" />
          <stop offset="60%" stopColor="#d2c8ec" stopOpacity="0.18" />
          <stop offset="100%" stopColor="#d2c8ec" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="edge" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#6b6cf0" stopOpacity="0.0" />
          <stop offset="50%" stopColor="#6b6cf0" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#6b6cf0" stopOpacity="0.0" />
        </linearGradient>
        <radialGradient id="nodeFill" cx="35%" cy="35%" r="65%">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="70%" stopColor="#c9c7ee" />
          <stop offset="100%" stopColor="#7c7df0" />
        </radialGradient>
        <filter id="soft" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="1.2" />
        </filter>
      </defs>

      <g className="viz-orbit" opacity="0.5">
        <circle cx="200" cy="200" r="140" fill="none" stroke="#15182a" strokeOpacity="0.06" strokeDasharray="2 6" />
        <circle cx="200" cy="200" r="170" fill="none" stroke="#15182a" strokeOpacity="0.04" strokeDasharray="1 8" />
      </g>

      <circle cx="200" cy="200" r="120" fill="url(#coreGlow)" />

      {nodes.map((n, i) => (
        <path
          key={`e-${n.id}`}
          d={`M${center.x} ${center.y} Q ${(center.x + n.cx) / 2 + (i % 2 ? 16 : -16)} ${(center.y + n.cy) / 2 + (i % 2 ? -12 : 12)} ${n.cx} ${n.cy}`}
          stroke="url(#edge)"
          strokeWidth="1.2"
          fill="none"
          className={`viz-flow ${i % 4 === 0 ? "" : i % 4 === 1 ? "b" : i % 4 === 2 ? "c" : "d"}`}
        />
      ))}

      {nodes.map((n, i) => (
        <g key={n.id} className={i % 3 === 0 ? "viz-pulse" : i % 3 === 1 ? "viz-pulse-2" : "viz-pulse-3"}>
          <circle cx={n.cx} cy={n.cy} r={n.r + 6} fill="#6b6cf0" opacity="0.08" filter="url(#soft)" />
          <circle cx={n.cx} cy={n.cy} r={n.r} fill="url(#nodeFill)" />
          <circle cx={n.cx} cy={n.cy} r={n.r} fill="none" stroke="#ffffff" strokeOpacity="0.6" strokeWidth="0.5" />
        </g>
      ))}

      <g className="viz-pulse">
        <circle cx={center.x} cy={center.y} r="22" fill="#6b6cf0" opacity="0.16" filter="url(#soft)" />
        <circle cx={center.x} cy={center.y} r="13" fill="url(#nodeFill)" />
        <circle cx={center.x} cy={center.y} r="13" fill="none" stroke="#ffffff" strokeOpacity="0.85" strokeWidth="0.8" />
        <circle cx={center.x - 3} cy={center.y - 3} r="3" fill="#ffffff" opacity="0.85" />
      </g>
    </svg>
  );
}

function MemoryLog() {
  const rows: Array<{ ts: string; kind: "cap" | "idx" | "rec"; label: string; what: string }> = [
    { ts: "09:14", kind: "cap", label: "▢", what: "Captured · Figma · Onboarding revision 7" },
    { ts: "09:14", kind: "idx", label: "▲", what: "Linked to topic Beside › Onboarding" },
    { ts: "09:22", kind: "cap", label: "▢", what: "Captured · Slack thread · pricing #beside-core" },
    { ts: "09:23", kind: "idx", label: "▲", what: "Extracted 3 entities · pricing, beta, founders" },
    { ts: "09:31", kind: "rec", label: "✦", what: "Claude recalled · context from yesterday's meeting" },
    { ts: "09:34", kind: "idx", label: "▲", what: "Refactored wiki · merged Onboarding v6 + v7" },
  ];
  return (
    <div className="memory-log" aria-hidden>
      <div className="memory-log-head">
        <span className="led" />
        Live · ~/beside/memory
      </div>
      {rows.map((r, i) => (
        <div className="log-row" key={i}>
          <span className="ts">{r.ts}</span>
          <span className={`badge ${r.kind}`}>{r.label}</span>
          <span className="what">{r.what}</span>
        </div>
      ))}
    </div>
  );
}

/* ── Pipeline stage cards ────────────────────────────────────── */

function CaptureCard() {
  return (
    <div className="p-card">
      <div className="p-card-head">
        <span className="p-step"><span className="n">1</span>Capture</span>
      </div>
      <h3>Watches every app, quietly.</h3>
      <p>Screenshots, active window, URLs, idle state — appended locally with negligible overhead.</p>
      <div className="p-viz" aria-hidden>
        <div className="cap-screen">
          <div className="cap-traffic"><span /><span /><span /></div>
          <div className="cap-app">
            <span className="frame">
              <span className="ico" />
              <span className="stack">
                <span>Figma</span>
                <span>Slack</span>
                <span>VS Code</span>
                <span>Notion</span>
              </span>
            </span>
          </div>
          <div className="cap-flash" />
          <div className="cap-strip">
            <span className="lit" /><span className="lit" /><span /><span /><span /><span /><span /><span />
          </div>
        </div>
      </div>
    </div>
  );
}

function IndexCard() {
  return (
    <div className="p-card">
      <div className="p-card-head">
        <span className="p-step"><span className="n">2</span>Index</span>
      </div>
      <h3>Shapes raw signals into knowledge.</h3>
      <p>A local model extracts entities and topics, then continuously refactors the wiki.</p>
      <div className="p-viz" aria-hidden>
        <div className="idx-scan" />
        <div className="idx-row r1">
          <span className="raw">"pricing discussion in #core"</span>
          <span className="arrow">→</span>
          <span className="tag">#pricing</span>
        </div>
        <div className="idx-row r2">
          <span className="raw">"Sagiv shipped Onboarding v7"</span>
          <span className="arrow">→</span>
          <span className="tag">#onboarding</span>
        </div>
        <div className="idx-row r3">
          <span className="raw">"Stripe docs · subscriptions"</span>
          <span className="arrow">→</span>
          <span className="tag">#stripe</span>
        </div>
      </div>
    </div>
  );
}

function SurfaceCard() {
  return (
    <div className="p-card">
      <div className="p-card-head">
        <span className="p-step"><span className="n">3</span>Surface</span>
      </div>
      <h3>Pins the moments that matter.</h3>
      <p>Patterns, follow-ups, half-finished threads — Beside surfaces them when you'll need them.</p>
      <div className="p-viz" aria-hidden>
        <div className="srf-bloom" />
        <div className="srf-spark" />
        <div className="srf-card">
          <div className="head">
            <span className="pin">★</span>
            <span className="label">Surfaced</span>
          </div>
          <div className="what">
            You mentioned <em>pricing</em> 3× this week — pinned for follow-up.
          </div>
        </div>
      </div>
    </div>
  );
}

function RecallCard() {
  return (
    <div className="p-card">
      <div className="p-card-head">
        <span className="p-step"><span className="n">4</span>Recall</span>
      </div>
      <h3>Remembers it — for every AI you use.</h3>
      <p>Claude, Cursor, ChatGPT — any MCP agent — gets persistent context, on demand.</p>
      <div className="p-viz" aria-hidden>
        <div className="rcl-lines">
          <svg viewBox="0 0 240 160" preserveAspectRatio="none">
            <path className="rcl-flow"    d="M 20 32  C 90 32, 110 80, 180 80" />
            <path className="rcl-flow f2" d="M 20 80  C 90 80, 110 80, 180 80" />
            <path className="rcl-flow f3" d="M 20 128 C 90 128, 110 80, 180 80" />
          </svg>
        </div>
        <div className="rcl">
          <div className="rcl-agents">
            <span className="rcl-chip c1"><span className="a-dot" />Claude</span>
            <span className="rcl-chip c2"><span className="a-dot" />Cursor</span>
            <span className="rcl-chip c3"><span className="a-dot" />ChatGPT</span>
          </div>
          <div className="rcl-orb" />
        </div>
      </div>
    </div>
  );
}

function Feature({ badge, title, body }: { badge: string; title: string; body: string }) {
  return (
    <div className="feature">
      <div className="ico">{badge}</div>
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  );
}

function Step({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <li className="step">
      <div className="n">{n}</div>
      <div>
        <h3>{title}</h3>
        <p>{body}</p>
      </div>
    </li>
  );
}

function DownloadIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden fill="currentColor">
      <path d="M12 1.5C6.2 1.5 1.5 6.2 1.5 12c0 4.6 3 8.6 7.2 10 .5.1.7-.2.7-.5v-1.7c-2.9.6-3.5-1.4-3.5-1.4-.5-1.2-1.2-1.5-1.2-1.5-.9-.6.1-.6.1-.6 1 .1 1.6 1.1 1.6 1.1.9 1.6 2.4 1.1 3 .9.1-.7.4-1.1.7-1.4-2.3-.3-4.8-1.2-4.8-5.2 0-1.2.4-2.1 1.1-2.8-.1-.3-.5-1.4.1-2.9 0 0 .9-.3 3 1.1.9-.2 1.8-.4 2.8-.4 1 0 1.9.1 2.8.4 2.1-1.4 3-1.1 3-1.1.6 1.5.2 2.6.1 2.9.7.7 1.1 1.6 1.1 2.8 0 4-2.5 4.9-4.8 5.1.4.3.7.9.7 1.9v2.8c0 .3.2.6.7.5 4.2-1.4 7.2-5.4 7.2-10 0-5.8-4.7-10.5-10.5-10.5z" />
    </svg>
  );
}

function Tick() {
  return (
    <span className="tick" aria-hidden>
      <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
        <path d="M2 6.5l2.5 2.5L10 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}
