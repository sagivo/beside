import * as React from 'react';

export interface ChangelogEntry {
  /** Stable id used to track which entries the user has seen. */
  id: string;
  /** Human-readable version label, e.g. "0.3 — May 2026". */
  version: string;
  /** ISO date the entry was published. Newest first in the array. */
  date: string;
  /** Short headline. */
  title: string;
  /** Bullet-point items describing what changed. */
  items: string[];
}

/**
 * In-repo changelog. Newest first. Adding a new entry with a fresh `id`
 * automatically lights up the "What's new" dot on the Help nav item until
 * the user opens the Help screen.
 */
export const CHANGELOG: ChangelogEntry[] = [
  {
    id: '2026-05-02-trust-touches',
    version: '0.3.2 — May 2026',
    date: '2026-05-02',
    title: 'Small trust-building touches',
    items: [
      'Connect AI has a "Test connection" button that pings the local MCP endpoint and reports latency or the actual error.',
      'Help has a new About card with the running version, your platform, and links to the source code.',
      'Timeline gained a "Delete day" action so you can prune one bad afternoon without nuking everything.',
      'Onboarding is now lazy-loaded so the dashboard paints faster after first run.',
    ],
  },
  {
    id: '2026-05-02-delete-memory',
    version: '0.3.1 — May 2026',
    date: '2026-05-02',
    title: 'Delete what you remember',
    items: [
      'Each captured moment now has a Delete button in its detail dialog.',
      'Settings → Privacy has a "Danger zone" that wipes all memory after a type-to-confirm prompt — frames, screenshots, sessions, search index, the lot.',
      'Deletes happen locally — no copy ever left this device, so nothing to revoke elsewhere.',
    ],
  },
  {
    id: '2026-05-02-shadcn-redesign',
    version: '0.3 — May 2026',
    date: '2026-05-02',
    title: 'A bigger redesign',
    items: [
      'New look powered by shadcn — cleaner cards, better spacing, proper dark mode toggle in Settings.',
      'Dashboard shows a live "just captured" strip and a per-app activity breakdown.',
      'Timeline and Search results now open a detail dialog with the full screenshot and metadata.',
      'Command palette (⌘K) plus keyboard shortcuts: ⌘1–7 jump screens, ⌘. toggles capture, j/k walks Timeline & Search results.',
      'Collapsible sidebar, toast notifications, and skeleton loaders.',
      'Settings has a new "Save & restart" button so config changes apply immediately.',
      'Window remembers its size and position across launches.',
      'Status updates are now pushed in real time instead of polled — pause / resume / index changes feel instant.',
    ],
  },
];

const STORAGE_KEY = 'cofounderos:changelog-last-seen';

function readLastSeen(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeLastSeen(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* ignore */
  }
}

/**
 * Returns true when the latest changelog entry hasn't been acknowledged.
 * Intended to drive a small dot on the Help nav item.
 */
export function useHasUnreadChangelog(): boolean {
  const latestId = CHANGELOG[0]?.id;
  const [lastSeen, setLastSeen] = React.useState<string | null>(() => readLastSeen());

  React.useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setLastSeen(e.newValue);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  if (!latestId) return false;
  return lastSeen !== latestId;
}

/**
 * Mark the latest changelog as seen. Triggers a re-render in any other
 * `useHasUnreadChangelog` consumers in this window via a synthetic
 * storage event (browsers only fire `storage` for *other* windows).
 */
export function markChangelogSeen(): void {
  const latestId = CHANGELOG[0]?.id;
  if (!latestId) return;
  const previous = readLastSeen();
  if (previous === latestId) return;
  writeLastSeen(latestId);
  // Manually broadcast within the same document so consumer hooks update.
  try {
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: STORAGE_KEY,
        oldValue: previous,
        newValue: latestId,
        storageArea: localStorage,
      }),
    );
  } catch {
    /* ignore */
  }
}
