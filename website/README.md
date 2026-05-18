# Beside — Website

Marketing site for [Beside](../README.md), built as a small **React + Vite**
app with **SSR (build-time prerender)** so every page ships fully-rendered
HTML to crawlers, OCR pipelines, and AI search indexers.

The content is intentionally keyword-rich around **AI**, **memory**, and
**context** — Beside's core value props — so it indexes well.

## Stack

- React 18 + TypeScript
- Vite 5 (client + SSR builds)
- `react-dom/server` `renderToString` for static SSR; client hydrates on load
- No CSS framework — hand-rolled styles in `src/styles.css` (fly.io-style:
  clean, lots of whitespace, serif display + sans body, single warm accent)

## Develop

```bash
pnpm install            # from repo root (workspace) or inside this folder
pnpm --filter @beside/website dev
```

Then open http://localhost:5173.

## Build (with SSR)

```bash
pnpm --filter @beside/website build
pnpm --filter @beside/website serve   # preview on :4173
```

`build` runs three steps:

1. `vite build --outDir dist/client` — client bundle + assets
2. `vite build --ssr src/entry-server.tsx --outDir dist/server` — SSR bundle
3. `node scripts/prerender.mjs` — renders `<App />` once and injects the HTML
   into `dist/client/index.html`, so the page is fully crawlable.

Deploy `dist/client/` to any static host (Cloudflare Pages, Vercel, S3 + CF,
fly.io static, etc.). No runtime server required.

## Structure

```
website/
├── index.html              # template w/ SEO meta + <!--app-html--> slot
├── public/
│   ├── favicon.svg
│   └── images/             # scribe artwork used on the landing page
├── src/
│   ├── App.tsx             # the landing page
│   ├── entry-client.tsx    # hydrateRoot
│   ├── entry-server.tsx    # renderToString
│   └── styles.css
└── scripts/
    ├── prerender.mjs       # SSR → static HTML
    └── serve.mjs           # tiny preview server
```
