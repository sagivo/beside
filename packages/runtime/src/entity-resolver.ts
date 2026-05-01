import type {
  Frame,
  EntityRef,
  EntityKind,
  IStorage,
  Logger,
} from '@cofounderos/interfaces';

/**
 * EntityResolver — turns a frame into a stable `EntityRef` (kind + path).
 *
 * This is the place to teach CofounderOS what "thing" any given moment
 * belongs to. Each resolver is a small pure function tried in priority
 * order; the first non-null match wins. Adding a new entity kind is one
 * new resolver function in this file.
 *
 * The path returned is **also the on-disk path of the wiki page** for that
 * entity, so it must be filesystem-safe and stable across runs.
 */

type FrameResolver = (frame: Frame) => EntityRef | null;

const RESOLVERS: FrameResolver[] = [
  resolveMeeting,
  resolveRepo,
  resolveDoc,
  resolveChannel,
  resolveContact,
  resolveProject,
  resolveWebpage,
  resolveApp, // last resort — every framed event resolves to *something*
];

export function resolveEntity(frame: Frame): EntityRef | null {
  for (const r of RESOLVERS) {
    const result = r(frame);
    if (result) return result;
  }
  return null;
}

export class EntityResolverWorker {
  private readonly logger: Logger;
  constructor(
    private readonly storage: IStorage,
    logger: Logger,
    private readonly batchSize = 500,
  ) {
    this.logger = logger.child('entity-resolver');
  }

  /** Resolve up to `batchSize` unresolved frames in one pass. */
  async tick(): Promise<{ resolved: number; remaining: number }> {
    const frames = await this.storage.listFramesNeedingResolution(this.batchSize);
    if (frames.length === 0) return { resolved: 0, remaining: 0 };
    let resolved = 0;
    for (const f of frames) {
      const ref = resolveEntity(f);
      if (!ref) continue;
      try {
        await this.storage.resolveFrameToEntity(f.id, ref);
        resolved += 1;
      } catch (err) {
        this.logger.debug(`failed to resolve frame ${f.id}`, { err: String(err) });
      }
    }
    if (resolved > 0) {
      this.logger.debug(
        `resolved ${resolved}/${frames.length} frames to entities`,
      );
    }
    return { resolved, remaining: Math.max(0, frames.length - resolved) };
  }

  /** Drain the resolution backlog. Used by `--full-reindex`. */
  async drain(): Promise<{ resolved: number }> {
    let total = 0;
    for (let i = 0; i < 10_000; i++) {
      const r = await this.tick();
      total += r.resolved;
      if (r.resolved === 0) break;
    }
    return { resolved: total };
  }
}

// ===========================================================================
// Resolvers — each is a small pure function. Priority = array order above.
// ===========================================================================

const MEETING_APPS = new Set([
  'Google Meet',
  'Zoom',
  'zoom.us',
  'zoom.us (Meeting)',
  'Microsoft Teams',
  'Webex',
  'Around',
  'Whereby',
  'Tuple',
  'Pop',
  'Tandem',
]);

const MEETING_DOMAINS = [
  'meet.google.com',
  'zoom.us',
  'teams.microsoft.com',
  'whereby.com',
  'webex.com',
  'around.co',
];

function resolveMeeting(frame: Frame): EntityRef | null {
  const app = frame.app ?? '';
  const url = frame.url ?? '';
  const inMeetingApp = MEETING_APPS.has(app);
  const inMeetingDomain = MEETING_DOMAINS.some((d) => url.includes(d));
  if (!inMeetingApp && !inMeetingDomain) return null;

  const day = frame.timestamp.slice(0, 10);
  const rawTitle = stripBrowserSuffixes(frame.window_title || '') || app;
  const title = stripMeetingSuffix(rawTitle);
  const slug = slugify(title) || 'untitled';
  return {
    kind: 'meeting',
    path: `meetings/${day}-${slug}`,
    title: `${title} (${day})`,
  };
}

const REPO_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.org', 'codeberg.org']);

function resolveRepo(frame: Frame): EntityRef | null {
  const url = frame.url;
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^www\./, '');
  if (!REPO_HOSTS.has(host)) return null;
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const [owner, repo] = parts as [string, string];
  // Skip GitHub features that aren't repos: settings, marketplace, search, etc.
  if (
    /^(settings|marketplace|search|notifications|pulls|issues|topics|trending)$/.test(
      owner,
    )
  ) {
    return null;
  }
  const slug = `${slugify(owner)}-${slugify(repo)}`;
  return {
    kind: 'repo',
    path: `repos/${slug}`,
    title: `${owner}/${repo}`,
  };
}

function resolveDoc(frame: Frame): EntityRef | null {
  const url = frame.url;
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^www\./, '');
  // Notion: notion.so/<workspace>/<title-with-id> — anchor on the path stem.
  if (host === 'notion.so' || host.endsWith('.notion.so')) {
    const parts = parsed.pathname.split('/').filter(Boolean);
    const last = parts[parts.length - 1] ?? '';
    // Strip the trailing 32-char hex id Notion appends to slugs.
    const slug = slugify(last.replace(/-?[a-f0-9]{32}$/i, '')) || 'untitled';
    return {
      kind: 'doc',
      path: `docs/notion-${slug}`,
      title: titleFromFrame(frame, 'Notion page'),
    };
  }
  // Google Docs / Sheets / Slides.
  if (host === 'docs.google.com') {
    const parts = parsed.pathname.split('/').filter(Boolean);
    const kind = parts[0] ?? 'doc';
    const id = parts[2] ?? '';
    return {
      kind: 'doc',
      path: `docs/gdocs-${kind}-${id.slice(0, 12) || 'unknown'}`,
      title: titleFromFrame(frame, `Google ${kind}`),
    };
  }
  // Linear issue.
  if (host === 'linear.app') {
    const parts = parsed.pathname.split('/').filter(Boolean);
    const idx = parts.indexOf('issue');
    const issueId = idx >= 0 ? parts[idx + 1] : null;
    if (issueId) {
      return {
        kind: 'doc',
        path: `docs/linear-${slugify(issueId)}`,
        title: titleFromFrame(frame, `Linear ${issueId}`),
      };
    }
  }
  return null;
}

const CHANNEL_APPS = new Set(['Slack', 'Discord']);

function resolveChannel(frame: Frame): EntityRef | null {
  if (!CHANNEL_APPS.has(frame.app)) return null;
  const title = frame.window_title || '';
  // Slack title formats:
  //   "channel-name (Channel) - Workspace - Slack"
  //   "channel-name (Private channel) - …"
  //   "First Last (DM) - …"
  //   "Threads - Workspace - Slack"
  // Discord title format:
  //   "#channel-name | Server"
  //   "@username | Discord"
  const slackChannel = /^(#?)([\w._-]+)\s*\((Channel|Private channel|Private)\)/i.exec(title);
  if (slackChannel) {
    const name = slackChannel[2] ?? '';
    // Slack title shape: "channel (Channel) - WORKSPACE - <maybe badge counter> - Slack".
    // The workspace is the FIRST segment after "(Channel) - ", not the last
    // before "- Slack" — that segment is often a badge like "2 new items".
    const wsMatch = /\(\s*(?:Channel|Private channel|Private)\s*\)\s*-\s*([^-\n]+?)\s*(?:-|$)/i.exec(
      title,
    );
    const workspace = (wsMatch?.[1] ?? '').trim();
    const slug = workspace
      ? `${slugify(workspace)}-${slugify(name)}`
      : slugify(name);
    return {
      kind: 'channel',
      path: `channels/${slug}`,
      title: workspace ? `#${name} — ${workspace}` : `#${name}`,
    };
  }
  const discordChannel = /^#\s*([\w._-]+)\s*\|\s*(.+)$/.exec(title);
  if (discordChannel) {
    const channel = discordChannel[1] ?? '';
    const server = discordChannel[2]?.replace(/\s+\|\s+Discord\s*$/i, '').trim() ?? '';
    const slug = server ? `${slugify(server)}-${slugify(channel)}` : slugify(channel);
    return {
      kind: 'channel',
      path: `channels/${slug}`,
      title: `#${channel} — ${server}`,
    };
  }
  return null;
}

function resolveContact(frame: Frame): EntityRef | null {
  if (!CHANNEL_APPS.has(frame.app)) return null;
  const title = frame.window_title || '';
  // Slack DMs render as "Person Name (DM) - …".
  const slackDm = /^(.+?)\s*\((?:DM|Direct message)\)/i.exec(title);
  if (slackDm) {
    const name = slackDm[1]?.trim() ?? '';
    if (name) {
      return {
        kind: 'contact',
        path: `contacts/${slugify(name)}`,
        title: name,
      };
    }
  }
  return null;
}

const CODE_APPS = new Set([
  'Code',
  'Code - Insiders',
  'Visual Studio Code',
  'Cursor',
  'Cursor Nightly',
  'Windsurf',
  'WebStorm',
  'IntelliJ IDEA',
  'IntelliJ IDEA Ultimate',
  'PyCharm',
  'PyCharm Professional',
  'GoLand',
  'RustRover',
  'CLion',
  'Rider',
  'PhpStorm',
  'RubyMine',
  'DataGrip',
  'Xcode',
  'Sublime Text',
  'Zed',
  'Nova',
]);

const TERMINAL_APPS = new Set([
  'Terminal',
  'iTerm2',
  'iTerm',
  'Warp',
  'Hyper',
  'Alacritty',
  'kitty',
  'WezTerm',
  'Tabby',
]);

function resolveProject(frame: Frame): EntityRef | null {
  const isCode = CODE_APPS.has(frame.app);
  const isTerm = TERMINAL_APPS.has(frame.app);
  if (!isCode && !isTerm) return null;
  const project = deriveProjectName(frame.window_title || '', frame.app, isTerm);
  if (!project) return null;
  return {
    kind: 'project',
    path: `projects/${slugify(project)}`,
    title: project,
  };
}

function resolveWebpage(frame: Frame): EntityRef | null {
  const url = frame.url;
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^www\./, '');
  // Group by host — pages on the same site collapse into one wiki entry.
  // Title prefers what the user actually saw.
  return {
    kind: 'webpage',
    path: `web/${slugify(host)}`,
    title: titleFromFrame(frame, host),
  };
}

function resolveApp(frame: Frame): EntityRef | null {
  if (!frame.app) return null;
  return {
    kind: 'app',
    path: `apps/${slugify(frame.app)}`,
    title: frame.app,
  };
}

// ===========================================================================
// Helpers
// ===========================================================================

function deriveProjectName(
  title: string,
  app: string,
  isTerminal: boolean,
): string | null {
  // Common editor patterns:
  //   "filename — projectname"
  //   "filename - projectname"
  //   "filename · projectname"
  //   "● filename — projectname"
  //   "filename [projectname]"
  // Project names themselves can contain hyphens, so only spaced separators
  // count as the boundary.
  const sepMatch = title.match(/(?: — | – | - | · )([^—–·]+?)\s*$/);
  if (sepMatch && sepMatch[1]) {
    const candidate = sepMatch[1].trim();
    // Reject endings that are obviously the app name itself.
    if (candidate.toLowerCase() !== app.toLowerCase()) return candidate;
  }
  const bracketMatch = title.match(/\[([^\]]+)\]\s*$/);
  if (bracketMatch && bracketMatch[1]) return bracketMatch[1].trim();
  // Terminal titles often include a path or zsh prompt — last path segment
  // is the best project guess.
  if (isTerminal) {
    const pathHint = title.match(/(?:~?\/)?([\w._-]+)\/?\s*$/);
    if (pathHint && pathHint[1] && pathHint[1].length > 1) {
      return pathHint[1];
    }
  }
  return null;
}

function stripMeetingSuffix(title: string): string {
  return title
    .replace(/[\-—–]\s*(Google Meet|Zoom|Microsoft Teams|Webex|Around|Whereby)\s*$/i, '')
    .replace(/^\s*Meet\s*[\-—–]\s*/i, '')
    .trim();
}

function stripBrowserSuffixes(title: string): string {
  return title
    .replace(/\s+[—–\-]\s+(Mozilla Firefox|Google Chrome|Chrome|Safari|Brave|Arc|Edge|Microsoft Edge|Vivaldi|Opera).*$/i, '')
    .trim();
}

function titleFromFrame(frame: Frame, fallback: string): string {
  const t = stripBrowserSuffixes(frame.window_title || '').trim();
  if (t.length > 4 && t.length < 120) return t;
  return fallback;
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/['"`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export function entityKindLabel(kind: EntityKind): string {
  switch (kind) {
    case 'project':
      return 'Projects';
    case 'repo':
      return 'Repos';
    case 'meeting':
      return 'Meetings';
    case 'contact':
      return 'Contacts';
    case 'channel':
      return 'Channels';
    case 'doc':
      return 'Docs';
    case 'webpage':
      return 'Web';
    case 'app':
      return 'Apps';
  }
}
