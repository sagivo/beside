export type MarkdownExportProfile = 'obsidian' | 'logseq' | 'portable';

export interface MarkdownExportProfileInfo {
  id: MarkdownExportProfile;
  label: string;
  shortLabel: string;
  description: string;
  linkStyle: 'Wikilinks' | 'Markdown links';
  suggestedPath: string;
}

export interface MarkdownExportToolTarget {
  label: string;
  profile: MarkdownExportProfile;
  url: string;
  description: string;
}

export const MARKDOWN_EXPORT_PROFILES: MarkdownExportProfileInfo[] = [
  {
    id: 'obsidian',
    label: 'Obsidian vault',
    shortLabel: 'Obsidian',
    description: 'Vault-ready pages with native wikilinks and local screenshots.',
    linkStyle: 'Wikilinks',
    suggestedPath: '~/.beside/export/obsidian',
  },
  {
    id: 'logseq',
    label: 'Logseq graph',
    shortLabel: 'Logseq',
    description: 'Graph-friendly Markdown that keeps page references as wikilinks.',
    linkStyle: 'Wikilinks',
    suggestedPath: '~/.beside/export/logseq',
  },
  {
    id: 'portable',
    label: 'Portable Markdown',
    shortLabel: 'Portable',
    description: 'Relative Markdown links for Notion import, GitHub, VS Code, Cursor, and static sites.',
    linkStyle: 'Markdown links',
    suggestedPath: '~/.beside/export/markdown',
  },
];

export const MARKDOWN_EXPORT_TOOL_TARGETS: MarkdownExportToolTarget[] = [
  {
    label: 'Obsidian',
    profile: 'obsidian',
    url: 'https://obsidian.md',
    description: 'Open the export folder as a vault.',
  },
  {
    label: 'Logseq',
    profile: 'logseq',
    url: 'https://logseq.com',
    description: 'Open the export folder as a graph.',
  },
  {
    label: 'Notion',
    profile: 'portable',
    url: 'https://www.notion.so',
    description: 'Import the folder as Markdown.',
  },
  {
    label: 'VS Code / Cursor',
    profile: 'portable',
    url: 'https://code.visualstudio.com',
    description: 'Open the folder directly.',
  },
  {
    label: 'Quartz / GitHub',
    profile: 'portable',
    url: 'https://quartz.jzhao.xyz',
    description: 'Publish or version the folder.',
  },
];

export function normalizeMarkdownExportProfile(value: unknown): MarkdownExportProfile {
  return value === 'logseq' || value === 'portable' ? value : 'obsidian';
}

export function getMarkdownExportProfileInfo(value: unknown): MarkdownExportProfileInfo {
  return MARKDOWN_EXPORT_PROFILES.find((profile) => profile.id === normalizeMarkdownExportProfile(value)) ?? MARKDOWN_EXPORT_PROFILES[0]!;
}
