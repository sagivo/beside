import TechTutorial from "./content/technical-tutorial.mdx";

const docSections = [
  { href: "#what-beside-gives-you", label: "What Beside gives you" },
  { href: "#architecture-at-a-glance", label: "Architecture" },
  { href: "#choose-the-right-layer", label: "Layers" },
  { href: "#customize-the-pipeline", label: "Customize" },
  { href: "#tutorial-build-your-first-workflow", label: "Tutorial" },
  { href: "#where-to-go-next", label: "Next steps" },
];

export default function DocsPage() {
  return (
    <>
      <div className="ambient" aria-hidden>
        <div className="aurora one" />
        <div className="aurora two" />
        <div className="aurora three" />
        <div className="aurora four" />
      </div>

      <header className="nav docs-nav">
        <div className="container nav-inner">
          <a href="/" className="brand" aria-label="beside home">
            <img className="brand-mark" src="/images/logo.png" alt="" aria-hidden="true" />
            <span>beside</span>
          </a>
          <nav className="nav-links" aria-label="Documentation">
            <a href="/">Home</a>
            <a href="/#features">Features</a>
            <a href="/#how">How it works</a>
            <a href="https://github.com/sagivo/beside" className="nav-gh">
              <GitHubIcon />
              <span>Open source</span>
            </a>
            <a href="/#download" className="nav-cta">Download</a>
          </nav>
        </div>
      </header>

      <main className="docs-shell">
        <section className="docs-hero">
          <div className="container docs-hero-grid">
            <div>
              <span className="eyebrow">
                <span className="dot" />
                Technical docs
              </span>
              <h1>Build an AI memory layer that fits the way you work.</h1>
              <p className="lede">
                Beside captures the context around your apps, indexes it locally,
                and makes it useful inside every AI agent you already trust. These
                docs explain the layers so you can keep the default magic or tune
                every part of the stack.
              </p>
              <div className="docs-hero-actions">
                <a className="btn btn-primary" href="#tutorial-build-your-first-workflow">
                  Start the tutorial
                </a>
                <a className="btn btn-ghost" href="https://github.com/sagivo/beside">
                  View source
                </a>
              </div>
            </div>

            <div className="docs-map" aria-hidden>
              <div className="docs-map-core">beside</div>
              <div className="docs-map-row"><span>Apps</span><i />Capture</div>
              <div className="docs-map-row"><span>Events</span><i />Local storage</div>
              <div className="docs-map-row"><span>Signals</span><i />Index + hooks</div>
              <div className="docs-map-row"><span>Memory</span><i />MCP + CLI</div>
            </div>
          </div>
        </section>

        <div className="container docs-layout">
          <aside className="docs-sidebar" aria-label="Docs navigation">
            <div className="docs-sidebar-card">
              <span className="docs-sidebar-label">Tutorial</span>
              {docSections.map((section) => (
                <a href={section.href} key={section.href}>
                  {section.label}
                </a>
              ))}
            </div>
          </aside>

          <article className="docs-article docs-markdown">
            <TechTutorial />
          </article>
        </div>
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

function GitHubIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden fill="currentColor">
      <path d="M12 1.5C6.2 1.5 1.5 6.2 1.5 12c0 4.6 3 8.6 7.2 10 .5.1.7-.2.7-.5v-1.7c-2.9.6-3.5-1.4-3.5-1.4-.5-1.2-1.2-1.5-1.2-1.5-.9-.6.1-.6.1-.6 1 .1 1.6 1.1 1.6 1.1.9 1.6 2.4 1.1 3 .9.1-.7.4-1.1.7-1.4-2.3-.3-4.8-1.2-4.8-5.2 0-1.2.4-2.1 1.1-2.8-.1-.3-.5-1.4.1-2.9 0 0 .9-.3 3 1.1.9-.2 1.8-.4 2.8-.4 1 0 1.9.1 2.8.4 2.1-1.4 3-1.1 3-1.1.6 1.5.2 2.6.1 2.9.7.7 1.1 1.6 1.1 2.8 0 4-2.5 4.9-4.8 5.1.4.3.7.9.7 1.9v2.8c0 .3.2.6.7.5 4.2-1.4 7.2-5.4 7.2-10 0-5.8-4.7-10.5-10.5-10.5z" />
    </svg>
  );
}
