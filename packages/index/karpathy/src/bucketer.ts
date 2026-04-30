import type { RawEvent } from '@cofounderos/interfaces';

export interface BucketAssignment {
  /** Path relative to the index root, e.g. "projects/my-project.md". */
  path: string;
  /** Display title for this page. */
  title: string;
  /** Top-level category — used for index.md grouping and reorg. */
  category: 'projects' | 'meetings' | 'contacts' | 'tools' | 'topics' | 'patterns';
}

const MEETING_APPS = new Set([
  'Google Meet',
  'Zoom',
  'zoom.us',
  'Microsoft Teams',
  'Webex',
  'Around',
]);

const MEETING_DOMAINS = [
  'meet.google.com',
  'zoom.us',
  'teams.microsoft.com',
  'webex.com',
];

const CODE_APPS = new Set([
  'Code',
  'Visual Studio Code',
  'Cursor',
  'WebStorm',
  'IntelliJ IDEA',
  'PyCharm',
  'Xcode',
  'Sublime Text',
]);

const TERMINAL_APPS = new Set([
  'Terminal',
  'iTerm2',
  'Warp',
  'Hyper',
  'Alacritty',
]);

const COMMS_APPS = new Set([
  'Slack',
  'Discord',
  'Telegram',
  'Signal',
  'Mail',
  'Outlook',
  'Spark',
]);

/**
 * Map a single raw event to a single wiki page. Pure heuristic — no LLM
 * involved. The LLM later writes the page _content_; the bucketer just
 * decides which page each event contributes to.
 */
export function bucketEvent(event: RawEvent): BucketAssignment | null {
  // Skip events that aren't worth indexing on their own.
  if (event.type === 'idle_start' || event.type === 'idle_end') return null;
  if (event.type === 'app_launch' || event.type === 'app_quit') return null;

  const app = event.app ?? 'unknown';
  const title = event.window_title ?? '';
  const url = event.url ?? '';

  // 1. Meetings — by app or domain.
  if (
    MEETING_APPS.has(app) ||
    MEETING_DOMAINS.some((d) => url.includes(d))
  ) {
    const day = event.timestamp.slice(0, 10);
    const slug = slugify(deriveMeetingTitle(title, app)) || 'untitled';
    return {
      path: `meetings/${day}-${slug}.md`,
      title: `Meeting — ${deriveMeetingTitle(title, app)} (${day})`,
      category: 'meetings',
    };
  }

  // 2. Code editors — group by project name (typically the rightmost
  // segment of the window title after an em-dash).
  if (CODE_APPS.has(app)) {
    const project = deriveProjectName(title);
    if (project) {
      return {
        path: `projects/${slugify(project)}.md`,
        title: project,
        category: 'projects',
      };
    }
  }

  // 3. Terminals — usually working in a project. Use cwd if encoded in
  // title (best-effort), else generic terminal page.
  if (TERMINAL_APPS.has(app)) {
    const project = deriveProjectName(title);
    if (project) {
      return {
        path: `projects/${slugify(project)}.md`,
        title: project,
        category: 'projects',
      };
    }
    return {
      path: `tools/${slugify(app)}.md`,
      title: app,
      category: 'tools',
    };
  }

  // 4. Communication tools — group by app.
  if (COMMS_APPS.has(app)) {
    return {
      path: `tools/${slugify(app)}.md`,
      title: app,
      category: 'tools',
    };
  }

  // 5. Browsers + URLs — derive topic from URL (or title).
  if (url) {
    const topic = deriveTopicFromUrl(url, title);
    if (topic) {
      return {
        path: `topics/${slugify(topic)}.md`,
        title: topic,
        category: 'topics',
      };
    }
  }

  // 6. Fallback — group everything else under tools/<app>.
  return {
    path: `tools/${slugify(app)}.md`,
    title: app,
    category: 'tools',
  };
}

function deriveProjectName(title: string): string | null {
  // Common patterns from VS Code / Cursor / WebStorm:
  //   "filename — projectname"     (em-dash with spaces)
  //   "filename - projectname"     (hyphen with spaces)
  //   "filename · projectname"     (interpunct)
  // Project names themselves may contain hyphens, so only the SPACED
  // separator counts as the boundary.
  const sepMatch = title.match(/(?: — | - | · )([^—·]+?)\s*$/);
  if (sepMatch && sepMatch[1]) return sepMatch[1].trim();
  return null;
}

function deriveMeetingTitle(title: string, app: string): string {
  // Drop trailing app name suffixes ("— Google Meet", "- Zoom").
  return title
    .replace(/[\-—]\s*(Google Meet|Zoom|Microsoft Teams|Webex|Around)\s*$/i, '')
    .replace(/^\s*Meet\s*[\-—]\s*/i, '')
    .trim() || app;
}

function deriveTopicFromUrl(url: string, fallbackTitle: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    // GitHub/GitLab repos are projects, not topics.
    if (host === 'github.com' || host === 'gitlab.com') {
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
      return host;
    }
    // Docs/blog — use the page title if available.
    if (fallbackTitle && fallbackTitle.length > 4 && fallbackTitle.length < 80) {
      return fallbackTitle.replace(/\s*[\-—|]\s*[^\-—|]+$/, '').trim();
    }
    return host;
  } catch {
    return fallbackTitle && fallbackTitle.length > 0 ? fallbackTitle : null;
  }
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/['"`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
