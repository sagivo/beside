import { LEGAL_PAGES, type LegalPageData } from "./pages";

export default function LegalPage({ page }: { page: LegalPageData }) {
  return (
    <>
      <div className="ambient" aria-hidden>
        <div className="aurora one" />
        <div className="aurora two" />
        <div className="aurora three" />
        <div className="aurora four" />
      </div>

      <header className="nav">
        <div className="container nav-inner">
          <a href="/" className="brand" aria-label="beside home">
            <img className="brand-mark" src="/images/logo.png" alt="" aria-hidden="true" />
            <span>beside</span>
          </a>
          <nav className="nav-links" aria-label="Primary">
            <a href="/docs">Docs</a>
            <a href="https://github.com/sagivo/beside" className="nav-gh">
              <GitHubIcon />
              <span>Open source</span>
            </a>
            <a href="/#download" className="nav-cta">
              Download
            </a>
          </nav>
        </div>
      </header>

      <main className="legal-shell">
        <section className="legal-hero">
          <div className="container legal-hero-inner">
            <div>
              <div className="docs-eyebrow">
                <span className="docs-eyebrow-group">Legal</span>
                <span className="docs-eyebrow-sep" />
                <span className="docs-eyebrow-title">Updated {page.updated}</span>
              </div>
              <h1>{page.title}</h1>
              <p className="lede">{page.description}</p>
            </div>
            <nav className="legal-switcher" aria-label="Legal pages">
              {LEGAL_PAGES.map((item) => (
                <a
                  href={item.path}
                  key={item.path}
                  className={item.slug === page.slug ? "is-active" : undefined}
                  aria-current={item.slug === page.slug ? "page" : undefined}
                >
                  {item.title}
                </a>
              ))}
            </nav>
          </div>
        </section>

        <div className="container legal-layout">
          <aside className="legal-summary" aria-label="Page summary">
            <span>Updated</span>
            <strong>{page.updated}</strong>
            <p>Beside is local-first, open source, and designed to keep your app data on your machine.</p>
          </aside>

          <article className="legal-article docs-markdown">
            {page.sections.map((section) => (
              <section key={section.title}>
                <h2>{section.title}</h2>
                {section.body}
              </section>
            ))}
          </article>
        </div>
      </main>

      <footer>
        <div className="container footer-inner">
          <div>© {new Date().getFullYear()} beside · Local-first AI memory.</div>
          <div className="footer-links">
            <a href="https://github.com/sagivo/beside">GitHub</a>
            <a href="/privacy">Privacy</a>
            <a href="/terms">Terms</a>
            <a href="mailto:hello@beside.so">Contact</a>
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
