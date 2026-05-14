import "./styles.css";
import DocsPage from "./docs/DocsPage";

const DOWNLOAD_URL = "https://github.com/sagivo/beside/releases/latest/download/Beside-0.2.0-mac-arm64.dmg";

export default function App({ initialPath }: { initialPath?: string } = {}) {
  const pathname = initialPath ?? (typeof window === "undefined" ? "/" : window.location.pathname);

  if (pathname.startsWith("/docs")) {
    return <DocsPage pathname={pathname} />;
  }

  return <LandingPage />;
}

function LandingPage() {
  return (
    <>
      <AmbientBackdrop />

      <header className="nav">
        <div className="container nav-inner">
          <a href="/" className="brand" aria-label="beside home">
            <img className="brand-mark" src="/images/logo.png" alt="" aria-hidden="true" />
            <span>beside</span>
          </a>
          <nav className="nav-links" aria-label="Primary">
            <a href="#pipeline">Live pipeline</a>
            <a href="#features">Features</a>
            <a href="#how">How it works</a>
            <a href="/docs">Docs</a>
            <a href="https://github.com/sagivo/beside" className="nav-gh">
              <GitHubIcon />
              <span>Open source</span>
            </a>
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
                <SparkleMark />
                Open source · Runs entirely on your Mac
              </span>

              <h1>
                <span className="grad">You AI memory, beside you.</span>
              </h1>

              <p className="lede">
                beside sits next to your work, <strong>capturing</strong> the
                apps, decisions, and half-finished threads that usually disappear.
                It <strong>indexes</strong> them into local memory,{" "}
                <strong>surfaces</strong> what matters, and keeps every AI agent
                grounded in your actual context — <strong>100% on your machine</strong>,
                every line of code <strong>open source</strong>.
              </p>

              <div className="btn-row">
                <a className="btn btn-primary" href={DOWNLOAD_URL} id="download">
                  <DownloadIcon />
                  <span>
                    Download for Mac
                    <small>macOS 12+ · Apple silicon</small>
                  </span>
                </a>
                <a
                  className="btn btn-ghost"
                  href="https://github.com/sagivo/beside"
                >
                  <GitHubIcon />
                  <span>
                    View source
                    <small>MIT · star on GitHub</small>
                  </span>
                </a>
              </div>

              <div className="proof-bar" aria-label="What you get with beside">
                <div className="proof-cell pc--local">
                  <span className="pc-ic" aria-hidden><LocalIcon /></span>
                  <div className="pc-body">
                    <span className="pc-label">Local-only</span>
                    <span className="pc-value">
                      <strong>0 bytes</strong> leave your Mac
                    </span>
                  </div>
                </div>
                <a className="proof-cell proof-cell--link pc--oss" href="https://github.com/sagivo/beside">
                  <span className="pc-ic" aria-hidden><GitHubIcon /></span>
                  <div className="pc-body">
                    <span className="pc-label">MIT licensed</span>
                    <span className="pc-value">
                      <strong>sagivo/beside</strong>
                      <span className="pc-chev" aria-hidden>↗</span>
                    </span>
                  </div>
                </a>
                <div className="proof-cell pc--model">
                  <span className="pc-ic" aria-hidden><ModelIcon /></span>
                  <div className="pc-body">
                    <span className="pc-label">Any model</span>
                    <span className="pc-value">Ollama · OpenAI · Anthropic</span>
                  </div>
                </div>
                <div className="proof-cell pc--mcp">
                  <span className="pc-ic" aria-hidden><MCPIcon /></span>
                  <div className="pc-body">
                    <span className="pc-label">MCP-ready</span>
                    <span className="pc-value">Claude · Cursor · ChatGPT</span>
                  </div>
                </div>
              </div>

              <div className="hero-meta" aria-hidden>
                <span className="hm-dot" />
                Free forever · no account · no telemetry
              </div>
            </div>

            <div className="hero-viz" aria-hidden>
              <div className="grid-bg" />
              <AmbientAINetwork />

              <div className="hero-status" aria-hidden>
                <span className="live-dot" />
                <span className="live-label">Live</span>
                <span className="status-sep" />
                <span className="caption-stack">
                  <span>Indexing · Mail</span>
                  <span>Indexing · Slack</span>
                  <span>Indexing · Calendar</span>
                  <span>Indexing · Figma</span>
                  <span>Indexing · Notion</span>
                  <span>Indexing · Linear</span>
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* ─────── Self-writing wiki ─────── */}
        <section id="wiki" className="wiki">
          <div className="container wiki-grid">
            <div className="wiki-copy">
              <span className="eyebrow">
                <span className="dot" />
                A wiki beside your work
              </span>
              <h2>Your day, written beside you as it happens.</h2>
              <p>
                While you move through apps, beside keeps pace: writing a Markdown
                wiki on your disk with the topics, tags, and decisions that belong
                next to the work itself, all under <code>~/beside/wiki</code>.
                No filing. No formatting. No forgetting.
              </p>
              <ul className="wiki-bullets" aria-label="What lives in the wiki">
                <li>
                  <span className="bs" />
                  Pages re-organise themselves as your work evolves
                </li>
                <li>
                  <span className="bs" />
                  Plain Markdown — grep it, edit it, version it
                </li>
                <li>
                  <span className="bs" />
                  Tags emerge from your actual signals, not a fixed schema
                </li>
              </ul>
            </div>

            <div className="wiki-stage" aria-hidden>
              <span className="wiki-stage-grid" />
              <span className="wiki-stage-tape" />
              <JournalPage />
              <div className="wiki-tags">
                <span className="wt wt-1">#acme</span>
                <span className="wt wt-2">#onboarding</span>
                <span className="wt wt-3">#pricing</span>
                <span className="wt wt-4">#ship</span>
              </div>
            </div>
          </div>
        </section>

        {/* ─────── Live pipeline ─────── */}
        <section id="pipeline" className="block pipeline">
          <div className="container">
            <div className="section-head">
              <span className="eyebrow"><span className="dot" />Live pipeline</span>
              <h2>From beside your screen to inside your AI's memory.</h2>
              <p>
                Four quiet loops run beside everything you do. Together they turn
                the signals on your computer into structured memory your AI agents
                can actually use.
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

        {/* ─────── Ask any AI ─────── */}
        <section id="ask" className="block ask">
          <div className="container">
            <div className="ask-grid">
              <div className="ask-copy">
                <span className="eyebrow"><span className="dot" />Ask any AI</span>
                <h2>The context beside you, available inside every AI.</h2>
                <p>
                  beside speaks <strong>MCP</strong>. Plug it into{" "}
                  <strong>Claude</strong>, <strong>Cursor</strong>,{" "}
                  <strong>ChatGPT</strong> — or any MCP-compatible agent —
                  and ask questions that normally send you digging through
                  six apps, three meetings, and yesterday's tabs.
                </p>
                <p>
                  The agent asks; beside remembers. Matching context comes from
                  your <strong>local</strong> knowledge base, so answers are
                  grounded in what was actually beside you this week. Your raw
                  data never leaves your machine.
                </p>
                <ul className="ask-prompts" aria-label="Example prompts">
                  <li><span className="q-dot" />“What are my open items?”</li>
                  <li><span className="q-dot" />“Summarise this week with Acme.”</li>
                  <li><span className="q-dot" />“What did we decide on pricing?”</li>
                  <li><span className="q-dot" />“Draft a follow-up from yesterday's call.”</li>
                </ul>
                <div className="ask-agents-row" aria-label="Compatible agents">
                  <span className="agent-pill"><ClaudeMark /> Claude</span>
                  <span className="agent-pill"><CursorMark /> Cursor</span>
                  <span className="agent-pill"><ChatGPTMark /> ChatGPT</span>
                  <span className="agent-pill agent-pill-more">+ any MCP agent</span>
                </div>
              </div>

              <AskDemo />
            </div>
          </div>
        </section>

        {/* ─────── Features ─────── */}
        <section id="features" className="block">
          <div className="container">
            <div className="section-head">
              <span className="eyebrow"><span className="dot" />What it does</span>
              <h2>The layer between your work and the AI beside it.</h2>
              <p>
                LLMs forget. Agents start from zero. beside stays close to the
                work itself, continuously turning what happens on your computer
                into recallable memory that any tool can use.
              </p>
            </div>
            <div className="features">
              <Feature
                badge="01"
                title="100% local-first"
                body="Captures, embeddings, and indexes live on your disk as JSONL + SQLite. Bring your own model — Ollama, llama.cpp, OpenAI, Anthropic — or run fully offline."
                accent="local"
                viz="vault"
              />
              <Feature
                badge="02"
                title="Open source · MIT"
                body="Every capture path, every prompt, every byte we touch is auditable on GitHub. Fork it, extend it, self-host it. No black boxes."
                accent="oss"
                viz="commits"
              />
              <Feature
                badge="03"
                title="Silent capture"
                body="Screenshots, active window, URLs, idle state — captured locally with negligible overhead. Nothing leaves your machine unless you say so."
                accent="capture"
                viz="ticks"
              />
              <Feature
                badge="04"
                title="Self-organising knowledge"
                body="A local model turns captures into structured notes, topics, and timelines. The wiki re-organises itself as your work evolves."
                accent="cluster"
                viz="cluster"
              />
              <Feature
                badge="05"
                title="Proactive surfacing"
                body="beside notices the moments that should stay beside you — patterns, follow-ups, half-finished threads — and quietly pins them where you'll see them."
                accent="surface"
                viz="pin"
              />
              <Feature
                badge="06"
                title="Memory for any agent"
                body="Ship rich context to Claude, ChatGPT, Cursor and any MCP-compatible agent — so they remember yesterday, last week, last quarter."
                accent="agents"
                viz="fanout"
              />
            </div>
          </div>
        </section>

        {/* ─────── How ─────── */}
        <section id="how" className="block">
          <div className="container">
            <div className="section-head">
              <span className="eyebrow"><span className="dot" />Under the hood</span>
              <h2>How beside turns activity into living memory.</h2>
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
              <span className="eyebrow"><span className="dot" />Free forever</span>
              <h2>Put your memory beside every AI you use.</h2>
              <p>
                Install beside once. Claude, Cursor, ChatGPT, and every MCP agent
                get the context that has been working beside you all along.
              </p>
              <div className="btn-row">
                <a className="btn btn-primary" href={DOWNLOAD_URL}>
                  <DownloadIcon />
                  <span>
                    Download for Mac
                    <small>Free forever · macOS 12+</small>
                  </span>
                </a>
                <a className="btn btn-ghost" href="https://github.com/sagivo/beside">
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
          <div>© {new Date().getFullYear()} beside · Local-first AI memory.</div>
          <div style={{ display: "flex", gap: 22 }}>
            <a href="https://github.com/sagivo/beside">GitHub</a>
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

/* ── Ambient AI hub: a quiet AI core connected to every app, indexing in real-time ── */
function AmbientAINetwork() {
  type App = {
    id: string;
    name: string;
    angle: number;            // degrees, 0=right, 90=down (SVG)
    color: string;            // brand-evocative ink
    tint: string;             // soft tint for icon background
    sample: string;           // what's being indexed
  };

  const apps: App[] = [
    { id: "calendar", name: "Calendar", angle: -90,  color: "#1f5fd0", tint: "rgba(31, 95, 208, 0.10)",  sample: "Standup · 9:00" },
    { id: "mail",     name: "Mail",     angle: -45,  color: "#c43c52", tint: "rgba(196, 60, 82, 0.10)",  sample: "Acme · contract" },
    { id: "linear",   name: "Linear",   angle: 0,    color: "#5e5cf7", tint: "rgba(94, 92, 247, 0.10)",  sample: "BES-218 · OCR loop" },
    { id: "github",   name: "GitHub",   angle: 45,   color: "#15182a", tint: "rgba(21, 24, 42, 0.08)",   sample: "PR #142 · merged" },
    { id: "figma",    name: "Figma",    angle: 90,   color: "#d7593e", tint: "rgba(215, 89, 62, 0.10)",  sample: "Hero · rev 7" },
    { id: "notion",   name: "Notion",   angle: 135,  color: "#3a3a48", tint: "rgba(58, 58, 72, 0.08)",   sample: "Spec · Onboarding" },
    { id: "slack",    name: "Slack",    angle: 180,  color: "#5d3aa6", tint: "rgba(93, 58, 166, 0.10)",  sample: "#beside-core" },
    { id: "drive",    name: "Drive",    angle: -135, color: "#2d8a4a", tint: "rgba(45, 138, 74, 0.10)",  sample: "Pricing · v3.pdf" },
  ];

  const center = { x: 200, y: 200 };
  const R_SVG = 158;     // SVG node radius from center
  const INNER = 50;      // inset before reaching the core
  const R_HTML = 41.5;   // % radius for HTML chips
  const R_TIP = 28;      // % radius for floating "indexed" tooltips (closer to core)

  return (
    <>
      <svg viewBox="0 0 400 400" className="ai-net" xmlns="http://www.w3.org/2000/svg">
        <defs>
          {/* halo behind the whole core */}
          <radialGradient id="coreHalo" cx="50%" cy="50%" r="50%">
            <stop offset="0%"  stopColor="#6b6cf0" stopOpacity="0.42" />
            <stop offset="55%" stopColor="#6b6cf0" stopOpacity="0.08" />
            <stop offset="100%" stopColor="#6b6cf0" stopOpacity="0" />
          </radialGradient>
          {/* edge flow lines */}
          <linearGradient id="edgeFlow" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%"   stopColor="#6b6cf0" stopOpacity="0.0" />
            <stop offset="55%"  stopColor="#6b6cf0" stopOpacity="0.55" />
            <stop offset="100%" stopColor="#6b6cf0" stopOpacity="0.05" />
          </linearGradient>
          {/* blur halo for the core glow */}
          <filter id="aiSoft" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="2" />
          </filter>
          <filter id="logoDrop" x="-35%" y="-35%" width="170%" height="170%">
            <feDropShadow dx="0" dy="5" stdDeviation="5" floodColor="#050014" floodOpacity="0.42" />
          </filter>
          {/* Keep the real logo artwork, but split it into two independently animated SVG bubbles. */}
          <clipPath id="logoTopBubbleClip" clipPathUnits="userSpaceOnUse">
            <ellipse cx="198" cy="176" rx="34" ry="28" transform="rotate(-12 198 176)" />
          </clipPath>
          <clipPath id="logoBottomBubbleClip" clipPathUnits="userSpaceOnUse">
            <ellipse cx="202" cy="224" rx="32" ry="31" transform="rotate(-18 202 224)" />
          </clipPath>
        </defs>

        {/* outer halo behind the core */}
        <circle cx={center.x} cy={center.y} r="180" fill="url(#coreHalo)" />

        {/* faint orbital guides */}
        <g className="viz-orbit" opacity="0.55">
          <circle cx={center.x} cy={center.y} r="170" fill="none" stroke="#15182a" strokeOpacity="0.05" strokeDasharray="2 7" />
          <circle cx={center.x} cy={center.y} r="120" fill="none" stroke="#15182a" strokeOpacity="0.04" strokeDasharray="1 6" />
        </g>

        {/* connection lines & packets, one per app */}
        {apps.map((a, i) => {
          const rad = (a.angle * Math.PI) / 180;
          const x  = +(center.x + Math.cos(rad) * R_SVG).toFixed(2);
          const y  = +(center.y + Math.sin(rad) * R_SVG).toFixed(2);
          const ix = +(center.x + Math.cos(rad) * INNER).toFixed(2);
          const iy = +(center.y + Math.sin(rad) * INNER).toFixed(2);
          const path = `M ${x} ${y} L ${ix} ${iy}`;
          return (
            <g key={`edge-${a.id}`} className="ai-edge">
              {/* base dashed rail */}
              <line
                x1={x} y1={y} x2={ix} y2={iy}
                stroke="rgba(107,108,240,0.22)"
                strokeWidth="0.7"
                strokeDasharray="3 5"
              />
              {/* glowing flow overlay */}
              <line
                x1={x} y1={y} x2={ix} y2={iy}
                stroke="url(#edgeFlow)"
                strokeWidth="1.2"
                className={`ai-flow ai-flow-${i % 4}`}
              />
              {/* primary data packet riding the line into the core */}
              <circle r="2.6" fill="#6b6cf0" opacity="0" className="ai-packet">
                <set attributeName="opacity" to="0.95" begin={`${(i * 0.35).toFixed(2)}s`} />
                <animateMotion
                  dur="2.8s"
                  repeatCount="indefinite"
                  begin={`${(i * 0.35).toFixed(2)}s`}
                  path={path}
                  keyPoints="0;1"
                  keyTimes="0;1"
                  calcMode="linear"
                />
              </circle>
              {/* secondary trailing packet */}
              <circle r="1.6" fill="#a4a5f7" opacity="0" className="ai-packet-2">
                <set attributeName="opacity" to="0.9" begin={`${(i * 0.35 + 1.4).toFixed(2)}s`} />
                <animateMotion
                  dur="2.8s"
                  repeatCount="indefinite"
                  begin={`${(i * 0.35 + 1.4).toFixed(2)}s`}
                  path={path}
                  keyPoints="0;1"
                  keyTimes="0;1"
                  calcMode="linear"
                />
              </circle>
            </g>
          );
        })}

        {/* concentric pulse rings emanating from the core */}
        <g>
          <circle cx={center.x} cy={center.y} r="50" fill="none" stroke="#6b6cf0" strokeWidth="1" className="ai-ripple" />
          <circle cx={center.x} cy={center.y} r="50" fill="none" stroke="#6b6cf0" strokeWidth="1" className="ai-ripple delay2" />
          <circle cx={center.x} cy={center.y} r="50" fill="none" stroke="#6b6cf0" strokeWidth="1" className="ai-ripple delay3" />
        </g>

        {/* central AI core — actual logo artwork split into two animated SVG bubbles */}
        <g className="ai-core">
          {/* subtle guide ring behind the artwork */}
          <circle cx={center.x} cy={center.y} r="46" fill="none" stroke="#ffffff" strokeOpacity="0.24" strokeWidth="0.7" />
          {/* soft bloom behind the pair */}
          <circle cx={center.x} cy={center.y} r="62" fill="#ffffff" opacity="0.14" filter="url(#aiSoft)" />
          <g filter="url(#logoDrop)">
            <g className="logo-orb-b">
              <g className="logo-orb-art-b" clipPath="url(#logoBottomBubbleClip)">
                <image
                  href="/images/logo.png"
                  x="168"
                  y="150"
                  width="68"
                  height="101"
                  preserveAspectRatio="xMidYMid meet"
                />
              </g>
            </g>
            <g className="logo-orb-t">
              <g className="logo-orb-art-t" clipPath="url(#logoTopBubbleClip)">
                <image
                  href="/images/logo.png"
                  x="168"
                  y="150"
                  width="68"
                  height="101"
                  preserveAspectRatio="xMidYMid meet"
                />
              </g>
            </g>
          </g>
        </g>
      </svg>

      {/* HTML overlay: app chips around the ring + floating "indexed" tooltips */}
      <div className="ai-ring">
        {apps.map((a, i) => {
          const rad = (a.angle * Math.PI) / 180;
          const x = 50 + Math.cos(rad) * R_HTML;
          const y = 50 + Math.sin(rad) * R_HTML;
          const tx = 50 + Math.cos(rad) * R_TIP;
          const ty = 50 + Math.sin(rad) * R_TIP;
          return (
            <span key={a.id}>
              <span
                className={`ai-node n-${a.id}`}
                style={{ left: `${x}%`, top: `${y}%`, ["--c" as any]: a.color, ["--t" as any]: a.tint }}
                aria-hidden
              >
                <span className="ic"><AppIcon id={a.id} /></span>
                <span className="lbl">{a.name}</span>
                <span className="live" />
              </span>
              <span
                className={`ai-tip t-${a.id}`}
                style={{
                  left: `${tx}%`,
                  top: `${ty}%`,
                  animationDelay: `${(i * 1.6).toFixed(2)}s`,
                  ["--c" as any]: a.color,
                }}
                aria-hidden
              >
                {a.sample}
              </span>
            </span>
          );
        })}
      </div>
    </>
  );
}

/* tiny, line-style app glyphs — distinctive but trademark-safe */
function AppIcon({ id }: { id: string }) {
  switch (id) {
    case "calendar":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
          <line x1="3.5" y1="10" x2="20.5" y2="10" />
          <line x1="8" y1="3" x2="8" y2="7" />
          <line x1="16" y1="3" x2="16" y2="7" />
          <circle cx="9" cy="14" r="0.9" fill="currentColor" stroke="none" />
          <circle cx="13" cy="14" r="0.9" fill="currentColor" stroke="none" />
          <circle cx="17" cy="14" r="0.9" fill="currentColor" stroke="none" />
        </svg>
      );
    case "mail":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect x="3" y="5.5" width="18" height="13.5" rx="2.5" />
          <path d="M3.5 7.5 L12 13.5 L20.5 7.5" />
        </svg>
      );
    case "linear":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <line x1="3" y1="8" x2="16" y2="21" />
          <line x1="3" y1="12" x2="12" y2="21" />
          <line x1="3" y1="16" x2="8" y2="21" />
          <line x1="3" y1="4" x2="20" y2="21" />
        </svg>
      );
    case "github":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="6" cy="5.5" r="2.2" />
          <circle cx="6" cy="18.5" r="2.2" />
          <circle cx="18" cy="5.5" r="2.2" />
          <line x1="6" y1="7.7" x2="6" y2="16.3" />
          <path d="M18 7.7 C 18 12, 12 12, 12 16.3" />
        </svg>
      );
    case "figma":
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <path d="M9 3h3v6H9a3 3 0 010-6z" opacity="0.85" />
          <path d="M12 3h3a3 3 0 110 6h-3V3z" opacity="0.65" />
          <path d="M9 9h3v6H9a3 3 0 010-6z" opacity="0.75" />
          <circle cx="14.5" cy="12" r="3" />
          <path d="M9 15h3v3a3 3 0 11-3-3z" opacity="0.55" />
        </svg>
      );
    case "notion":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect x="4" y="4" width="16" height="16" rx="2.5" />
          <line x1="8.5" y1="8" x2="8.5" y2="16" />
          <line x1="8.5" y1="8" x2="15.5" y2="16" />
          <line x1="15.5" y1="8" x2="15.5" y2="16" />
        </svg>
      );
    case "slack":
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <rect x="3" y="10" width="8" height="3" rx="1.5" />
          <rect x="13" y="11" width="8" height="3" rx="1.5" />
          <rect x="10" y="3" width="3" height="8" rx="1.5" />
          <rect x="11" y="13" width="3" height="8" rx="1.5" />
        </svg>
      );
    case "drive":
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <path d="M8 4h8l5 9h-9z" opacity="0.85" />
          <path d="M3 16l5-9 4.5 8L9 22z" opacity="0.7" />
          <path d="M9 22l4-7h9l-4 7z" opacity="0.9" />
        </svg>
      );
    default:
      return null;
  }
}

function MemoryLog() {
  const rows: Array<{ ts: string; kind: "cap" | "idx" | "rec"; label: string; what: string }> = [
    { ts: "09:14", kind: "cap", label: "▢", what: "Captured · Figma · Onboarding revision 7" },
    { ts: "09:14", kind: "idx", label: "▲", what: "Linked to topic beside › Onboarding" },
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

/* ── Journal page · ruled paper with handwriting being inked in.
   Lives in the bottom-right corner of the hero viz. Three lines per
   "page", three pages cycling on an 18s loop in sync with the
   ambient indexing animation. The whole thing is pure CSS — width +
   caret animation per .ink-stack variant gives the typewriter feel,
   subtle paper rotation gives it physicality. ────────────────────── */
function JournalPage() {
  return (
    <div className="journal" aria-hidden>
      <div className="journal-corner" />
      <div className="journal-page">
        <div className="journal-head">
          <span className="journal-led" />
          <span>~/beside/wiki · today</span>
        </div>
        <div className="journal-body">
          <div className="journal-line jl1">
            <span className="bullet">•</span>
            <span className="ink-stack">
              <span>Acme · contract redlines</span>
              <span>Standup · OCR loop ships</span>
              <span>Spec · onboarding v7</span>
            </span>
          </div>
          <div className="journal-line jl2">
            <span className="bullet">•</span>
            <span className="ink-stack">
              <span>→ Q2 plan, pricing</span>
              <span>→ BES-218 closed</span>
              <span>→ onboarding wiki</span>
            </span>
          </div>
          <div className="journal-line jl3">
            <span className="bullet">•</span>
            <span className="ink-stack">
              <span>tags: #acme · #q2</span>
              <span>tags: #linear · #ship</span>
              <span>tags: #users · #flow</span>
            </span>
          </div>
        </div>
      </div>
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
          <span className="raw">"Maya shipped Onboarding v7"</span>
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
      <p>Patterns, follow-ups, half-finished threads — beside surfaces them when you'll need them.</p>
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

/* ── Ask any AI · animated demo ─────────────────────────────────
   Two cards side-by-side with an MCP beam between them — a literal
   picture of how Beside connects to any agent:

      [ Agent window ]  ⇆ MCP ⇆  [ Beside · local memory ]

   Per 10s slot:
     · 0.4–2.8s  user types a prompt in the agent
     · 3.0–3.6s  query pulse fires left → right
     · 3.4–6.0s  Beside orb glows, status flips to "matching",
                 source chips light up around the orb
     · 6.0–6.6s  context pulse fires right → left
     · 6.6–9.6s  answer streams back in the agent

   3 prompts × 10s = 30s super-loop. Pure CSS, no state.            */
/* Each "scene" is a complete (prompt → MCP call → grounded answer)
   unit. We render all three in the same grid cell and crossfade them
   as a whole, so individual chunks never sit half-on-top of each
   other (the old design typed the user prompts in stacked variants
   with overlapping width animations, which is what produced the
   "What aire mssy hoepriictket eonjs?" garble). */
type AskBulletTag = "linear" | "slack" | "mail" | "figma";
type AskBullet = { tag: AskBulletTag; bold: string; rest: string };
type AskScene = {
  agent: { name: "Claude" | "Cursor" | "ChatGPT"; mark: JSX.Element };
  prompt: string;
  title: string;
  bullets: AskBullet[];
  sources: AskBulletTag[];
};

const ASK_SCENES: AskScene[] = [
  {
    agent: { name: "Claude", mark: <ClaudeMark /> },
    prompt: "What are my open items?",
    title: "3 open items worth your attention:",
    bullets: [
      { tag: "linear", bold: "BES-218",      rest: " — OCR loop, waiting on you (3d)." },
      { tag: "slack",  bold: "#beside-core", rest: " — pricing thread, 2 unread replies." },
      { tag: "mail",   bold: "Acme",         rest: " — contract draft, due tomorrow." },
    ],
    sources: ["linear", "slack", "mail"],
  },
  {
    agent: { name: "Cursor", mark: <CursorMark /> },
    prompt: "Summarise this week with Acme.",
    title: "This week with Acme:",
    bullets: [
      { tag: "mail",   bold: "Tue", rest: " — kickoff call, 4 action items captured." },
      { tag: "slack",  bold: "Wed", rest: " — pricing pushback, re-scoped tier 2." },
      { tag: "figma",  bold: "Fri", rest: " — contract v3 in your inbox, awaiting redlines." },
    ],
    sources: ["mail", "slack", "figma"],
  },
  {
    agent: { name: "ChatGPT", mark: <ChatGPTMark /> },
    prompt: "What did we decide on pricing?",
    title: "Pricing decision (Wed, #beside-core):",
    bullets: [
      { tag: "slack",  bold: "Two tiers",    rest: " — Solo and Team." },
      { tag: "slack",  bold: "Free tier",    rest: " for the duration of the beta." },
      { tag: "linear", bold: "Final number", rest: " TBD by Friday standup." },
    ],
    sources: ["slack", "linear"],
  },
];

const ALL_SOURCES: AskBulletTag[] = ["slack", "linear", "mail", "figma"];

function AskDemo() {
  return (
    <div className="ask-demo" aria-hidden>
      <div className="ask-glow" />

      <div className="ask-card">
        {/* chrome row · cycling agent name + permanent MCP · beside badge */}
        <div className="ask-chrome">
          <span className="ask-traffic"><i /><i /><i /></span>
          <span className="ask-agent-pill">
            <span className="ask-agent-cycle">
              {ASK_SCENES.map((s, i) => (
                <span className={`ag-slot ag-slot-${i + 1}`} key={s.agent.name}>
                  {s.agent.mark}
                  <b>{s.agent.name}</b>
                </span>
              ))}
            </span>
          </span>
          <span className="ask-mcp">
            <span className="ask-mcp-dot" />
            MCP · beside
          </span>
        </div>

        {/* the conversation — three full scenes share one grid area,
            one is fully visible at a time, swapped via simple opacity */}
        <div className="ask-conv">
          {ASK_SCENES.map((s, i) => (
            <div className={`scene scene-${i + 1}`} key={s.agent.name}>
              <div className="ask-msg ask-msg-user">
                <span className="ask-avatar ask-avatar-user">YOU</span>
                <div className="ask-bubble ask-bubble-user">{s.prompt}</div>
              </div>

              <div className="ask-tool">
                <span className="ask-tool-spinner" />
                <span>
                  Calling <code>beside.recall</code> via MCP — pulling local
                  context…
                </span>
              </div>

              <div className="ask-msg ask-msg-ai">
                <span className="ask-avatar ask-avatar-ai">
                  <span className="ask-orb" />
                </span>
                <div className="ask-bubble ask-bubble-ai">
                  <div className="ans-title">{s.title}</div>
                  {s.bullets.map((b, j) => (
                    <div className="ans-bullet" key={j}>
                      <span className={`ans-tag t-${b.tag}`}>●</span>
                      <strong>{b.bold}</strong>
                      {b.rest}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* sources strip · which apps in your local memory got matched */}
        <div className="ask-sources-row">
          <span className="src-label">Sources · ~/beside/memory</span>
          <div className="src-list">
            {ALL_SOURCES.map((s, i) => (
              <span className={`src-chip src-${s} src-pos-${i + 1}`} key={s}>
                <span className="src-ic"><AppIcon id={s} /></span>
                <span className="src-name">{s[0].toUpperCase() + s.slice(1)}</span>
                <span className="src-dot" />
              </span>
            ))}
          </div>
        </div>

        {/* footer · the calming reminder */}
        <div className="ask-footer">
          <span className="lock"><LocalIcon /></span>
          <span>Query ran on-device · raw data never leaves your machine</span>
        </div>
      </div>
    </div>
  );
}

type FeatureAccent = "local" | "oss" | "capture" | "cluster" | "surface" | "agents";
type FeatureVizKind = "vault" | "commits" | "ticks" | "cluster" | "pin" | "fanout";

function Feature({
  badge,
  title,
  body,
  accent,
  viz,
}: {
  badge: string;
  title: string;
  body: string;
  accent: FeatureAccent;
  viz: FeatureVizKind;
}) {
  return (
    <div className={`feature feature--${accent}`}>
      <div className="feature-viz" aria-hidden>
        <span className="feature-badge">{badge}</span>
        <FeatureViz kind={viz} />
      </div>
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  );
}

/* Tiny animated motifs that sit at the top of each feature card. They share
   the same visual vocabulary as the rest of the homepage (dashed rings,
   packets, pulse rails, ripples) but each tells a different story so the
   six cards no longer look identical. Pure CSS animations — no state. */
function FeatureViz({ kind }: { kind: FeatureVizKind }) {
  switch (kind) {
    case "vault":
      // Local-first: signals bounce inside a sealed dashed boundary.
      return (
        <span className="fv fv-vault">
          <span className="fv-vault-ring" />
          <span className="fv-vault-ring fv-vault-ring-2" />
          <span className="fv-vault-core" />
          <span className="fv-vault-bolt b1" />
          <span className="fv-vault-bolt b2" />
          <span className="fv-vault-bolt b3" />
        </span>
      );
    case "commits":
      // Open source: a tiny git rail with commits ticking in + a star pulse.
      return (
        <span className="fv fv-commits">
          <span className="fv-rail" />
          <span className="fv-commit c1" />
          <span className="fv-commit c2" />
          <span className="fv-commit c3" />
          <span className="fv-commit c4" />
          <span className="fv-head" />
          <span className="fv-star">★</span>
        </span>
      );
    case "ticks":
      // Silent capture: a quiet baseline with periodic capture pulses.
      return (
        <span className="fv fv-ticks">
          <span className="fv-baseline" />
          <span className="fv-tick t1" />
          <span className="fv-tick t2" />
          <span className="fv-tick t3" />
          <span className="fv-tick t4" />
          <span className="fv-tick t5" />
          <span className="fv-cursor" />
        </span>
      );
    case "cluster":
      // Self-organising: loose tag chips drift into 2 topic clusters.
      return (
        <span className="fv fv-cluster">
          <span className="fv-chip cc1">#acme</span>
          <span className="fv-chip cc2">#q2</span>
          <span className="fv-chip cc3">#ship</span>
          <span className="fv-chip cc4">#flow</span>
          <span className="fv-chip cc5">#price</span>
          <span className="fv-cluster-halo h1" />
          <span className="fv-cluster-halo h2" />
        </span>
      );
    case "pin":
      // Proactive surfacing: one line rises out of a stack and gets pinned.
      return (
        <span className="fv fv-pin">
          <span className="fv-row r1" />
          <span className="fv-row r2" />
          <span className="fv-row r3" />
          <span className="fv-lift">
            <span className="fv-lift-bar" />
            <span className="fv-pin-mark">★</span>
          </span>
        </span>
      );
    case "fanout":
      // Memory for any agent: a core radiates rings to three agent dots.
      return (
        <span className="fv fv-fanout">
          <span className="fv-core" />
          <span className="fv-ring g1" />
          <span className="fv-ring g2" />
          <span className="fv-ring g3" />
          <span className="fv-agent a1">C</span>
          <span className="fv-agent a2">Cu</span>
          <span className="fv-agent a3">G</span>
        </span>
      );
    default:
      return null;
  }
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

/* Laptop with a lock — "runs entirely on your Mac, data never leaves" */
function LocalIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      {/* laptop body */}
      <rect
        x="4"
        y="5"
        width="16"
        height="11"
        rx="1.8"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      {/* base */}
      <path
        d="M2.5 18.5h19"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      {/* lock body */}
      <rect
        x="9.6"
        y="10.2"
        width="4.8"
        height="3.6"
        rx="0.7"
        fill="currentColor"
      />
      {/* lock shackle */}
      <path
        d="M10.6 10.2v-1.2a1.4 1.4 0 012.8 0v1.2"
        stroke="currentColor"
        strokeWidth="1.2"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}

/* Tiny brand-ish marks for the agent pills. Trademark-safe glyphs that
   evoke each brand without copying their logo. */
function ClaudeMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
      <path
        d="M7 4.5 L12 19.5 M17 4.5 L12 19.5 M9 13 H15"
        stroke="#d97757"
        strokeWidth="2.2"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}
function CursorMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
      <path
        d="M5 3 L19 12 L12 13 L9 20 Z"
        fill="#15182a"
        stroke="#15182a"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function ChatGPTMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="8.5" stroke="#10a37f" strokeWidth="1.8" fill="none" />
      <path
        d="M8 12c0-2.2 1.8-4 4-4M16 12c0 2.2-1.8 4-4 4"
        stroke="#10a37f"
        strokeWidth="1.8"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}

/* Inline-SVG sparkle for the hero eyebrow — solid fill, explicit dims,
   no gradient/filter chain (those occasionally render blank on Safari/Firefox). */
function SparkleMark() {
  return (
    <span className="ai-mark" aria-hidden>
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden
      >
        {/* primary 4-point sparkle, solid violet */}
        <path
          d="M12 2 L14 10 L22 12 L14 14 L12 22 L10 14 L2 12 L10 10 Z"
          fill="#6b6cf0"
        />
        {/* secondary sparkle, lighter violet */}
        <path
          d="M19 14 L19.8 16.7 L22.5 17.5 L19.8 18.3 L19 21 L18.2 18.3 L15.5 17.5 L18.2 16.7 Z"
          fill="#a4a5f7"
        />
        {/* tiny accent sparkle */}
        <path
          d="M5 3.5 L5.5 5 L7 5.5 L5.5 6 L5 7.5 L4.5 6 L3 5.5 L4.5 5 Z"
          fill="#a4a5f7"
        />
      </svg>
    </span>
  );
}

/* "Bring your own model" — an octahedral solid suggesting model layers / weights. */
function ModelIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 3 L20 8 V16 L12 21 L4 16 V8 Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M4 8 L12 13 L20 8 M12 13 V21"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
        opacity="0.55"
      />
      <circle cx="12" cy="13" r="1.3" fill="currentColor" />
    </svg>
  );
}

/* MCP — three peripherals plugged into one hub, the literal shape of the protocol. */
function MCPIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="3.1" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="4.5" cy="6"  r="1.7" fill="currentColor" />
      <circle cx="4.5" cy="18" r="1.7" fill="currentColor" />
      <circle cx="19.5" cy="12" r="1.7" fill="currentColor" />
      <path
        d="M6 7 L9.4 10.4 M6 17 L9.4 13.6 M14.9 12 L18 12"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
