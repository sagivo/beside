import type { ComponentType } from "react";

import Overview from "./content/overview.mdx";
import Architecture from "./content/architecture.mdx";
import Capture from "./content/capture.mdx";
import Storage from "./content/storage.mdx";
import Model from "./content/model.mdx";
import Index from "./content/index-layer.mdx";
import Hooks from "./content/hooks.mdx";
import Export from "./content/export.mdx";
import Cli from "./content/cli.mdx";
import Desktop from "./content/desktop.mdx";
import Configuration from "./content/configuration.mdx";
import Privacy from "./content/privacy.mdx";
import Tutorial from "./content/tutorial.mdx";

export interface DocPage {
  slug: string;
  path: string;
  title: string;
  group: string;
  description: string;
  Component: ComponentType;
}

export const DOC_PAGES: DocPage[] = [
  {
    slug: "",
    path: "/docs/",
    title: "Overview",
    group: "Start here",
    description: "Why Beside exists and how the pieces fit together.",
    Component: Overview,
  },
  {
    slug: "architecture",
    path: "/docs/architecture/",
    title: "Architecture",
    group: "Start here",
    description: "The pipeline, the contracts, and the shape of the system.",
    Component: Architecture,
  },
  {
    slug: "tutorial",
    path: "/docs/tutorial/",
    title: "Tutorial",
    group: "Start here",
    description: "Stand up Beside, capture context, and wire it into your AI agent.",
    Component: Tutorial,
  },
  {
    slug: "capture",
    path: "/docs/capture/",
    title: "Capture",
    group: "Layers",
    description: "Turn what happens on your computer into structured raw events.",
    Component: Capture,
  },
  {
    slug: "storage",
    path: "/docs/storage/",
    title: "Storage",
    group: "Layers",
    description: "Local-first persistence for events, frames, embeddings, sessions, and meetings.",
    Component: Storage,
  },
  {
    slug: "model",
    path: "/docs/model/",
    title: "Model adapters",
    group: "Layers",
    description: "Plug in local or hosted LLMs and embedding providers.",
    Component: Model,
  },
  {
    slug: "index-layer",
    path: "/docs/index-layer/",
    title: "Index strategies",
    group: "Layers",
    description: "Turn raw signals into a self-organising Markdown wiki and memory chunks.",
    Component: Index,
  },
  {
    slug: "hooks",
    path: "/docs/hooks/",
    title: "Capture hooks",
    group: "Layers",
    description: "React to specific moments — calendar events, follow-ups, custom signals.",
    Component: Hooks,
  },
  {
    slug: "export",
    path: "/docs/export/",
    title: "Export & MCP",
    group: "Layers",
    description: "Make Beside memory available to Claude, Cursor, ChatGPT, and any MCP agent.",
    Component: Export,
  },
  {
    slug: "cli",
    path: "/docs/cli/",
    title: "CLI",
    group: "Surfaces",
    description: "Run, automate, and operate Beside from the terminal.",
    Component: Cli,
  },
  {
    slug: "desktop",
    path: "/docs/desktop/",
    title: "Desktop app",
    group: "Surfaces",
    description: "The Electron shell, native capture helper, and packaged user experience.",
    Component: Desktop,
  },
  {
    slug: "privacy",
    path: "/docs/privacy/",
    title: "Privacy",
    group: "Reference",
    description: "How Beside keeps your data local — local LLMs, local Whisper, local OCR, loopback MCP.",
    Component: Privacy,
  },
  {
    slug: "configuration",
    path: "/docs/configuration/",
    title: "Configuration",
    group: "Reference",
    description: "Every knob in config.yaml, with defaults and recommended postures.",
    Component: Configuration,
  },
];

export function findDocByPath(pathname: string): DocPage {
  const normalized = pathname.endsWith("/") ? pathname : `${pathname}/`;
  return (
    DOC_PAGES.find((p) => p.path === normalized) ??
    DOC_PAGES.find((p) => normalized.startsWith(p.path) && p.slug !== "") ??
    DOC_PAGES[0]
  );
}

export function siblingsFor(page: DocPage): { prev: DocPage | null; next: DocPage | null } {
  const idx = DOC_PAGES.indexOf(page);
  return {
    prev: idx > 0 ? DOC_PAGES[idx - 1] : null,
    next: idx < DOC_PAGES.length - 1 ? DOC_PAGES[idx + 1] : null,
  };
}
