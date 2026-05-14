import { DOC_PAGES, findDocByPath, siblingsFor, type DocPage } from "./pages";

export default function DocsPage({ pathname }: { pathname?: string }) {
  const path = pathname ?? (typeof window === "undefined" ? "/docs/" : window.location.pathname);
  const page = findDocByPath(path);
  const { prev, next } = siblingsFor(page);
  const PageBody = page.Component;

  const groups: Array<{ name: string; pages: DocPage[] }> = [];
  for (const p of DOC_PAGES) {
    const last = groups[groups.length - 1];
    if (!last || last.name !== p.group) groups.push({ name: p.group, pages: [p] });
    else last.pages.push(p);
  }

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
        <div className="container docs-layout">
          <aside className="docs-sidebar" aria-label="Docs navigation">
            <div className="docs-sidebar-card">
              <a href="/docs/" className="docs-sidebar-brand">
                <span className="docs-sidebar-brand-eyebrow">Beside</span>
                <span className="docs-sidebar-brand-title">Documentation</span>
              </a>
              {groups.map((group) => (
                <div className="docs-sidebar-group" key={group.name}>
                  <span className="docs-sidebar-label">{group.name}</span>
                  {group.pages.map((p) => {
                    const active = p.path === page.path;
                    return (
                      <a
                        href={p.path}
                        key={p.path}
                        className={active ? "docs-sidebar-link is-active" : "docs-sidebar-link"}
                        aria-current={active ? "page" : undefined}
                      >
                        {p.title}
                      </a>
                    );
                  })}
                </div>
              ))}
            </div>
          </aside>

          <article className="docs-article docs-markdown">
            <div className="docs-eyebrow">
              <span className="docs-eyebrow-group">{page.group}</span>
              <span className="docs-eyebrow-sep" />
              <span className="docs-eyebrow-title">{page.title}</span>
            </div>

            <PageBody />

            <nav className="docs-pager" aria-label="Page navigation">
              {prev ? (
                <a href={prev.path} className="docs-pager-link docs-pager-prev">
                  <span className="docs-pager-direction">← Previous</span>
                  <span className="docs-pager-title">{prev.title}</span>
                </a>
              ) : (
                <span />
              )}
              {next ? (
                <a href={next.path} className="docs-pager-link docs-pager-next">
                  <span className="docs-pager-direction">Next →</span>
                  <span className="docs-pager-title">{next.title}</span>
                </a>
              ) : (
                <span />
              )}
            </nav>
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
