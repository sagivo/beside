import type { Frame, EntityRef, EntityKind, IStorage, Logger } from '@cofounderos/interfaces';

type FrameResolver = (frame: Frame) => EntityRef | null;

const RESOLVERS: FrameResolver[] = [resolveMeeting, resolveRepo, resolveDoc, resolveChannel, resolveContact, resolveProject, resolveWebpage, resolveApp];

export function resolveEntity(frame: Frame): EntityRef | null {
  for (const r of RESOLVERS) { const res = r(frame); if (res) return res; }
  return null;
}

export class EntityResolverWorker {
  private readonly logger: Logger;
  constructor(private readonly storage: IStorage, logger: Logger, private readonly batchSize = 500) { this.logger = logger.child('entity-resolver'); }

  async tick(): Promise<{ resolved: number; remaining: number }> {
    const fs = await this.storage.listFramesNeedingResolution(this.batchSize); if (!fs.length) return { resolved: 0, remaining: 0 };
    const items = fs.map(f => ({ frameId: f.id, entity: resolveEntity(f) })).filter(i => i.entity) as { frameId: string; entity: EntityRef }[];
    if (!items.length) return { resolved: 0, remaining: fs.length };
    try { await this.storage.resolveFramesToEntities(items); } catch (e) { this.logger.debug(`failed to resolve ${items.length}`, { err: String(e) }); return { resolved: 0, remaining: fs.length }; }
    this.logger.debug(`resolved ${items.length}/${fs.length} frames`);
    return { resolved: items.length, remaining: Math.max(0, fs.length - items.length) };
  }

  async drain(): Promise<{ resolved: number }> {
    let tot = 0; for (let i = 0; i < 10000; i++) { const r = await this.tick(); tot += r.resolved; if (!r.resolved) break; } return { resolved: tot };
  }
}

const MEETING_APPS = new Set(['Google Meet', 'Zoom', 'zoom.us', 'zoom.us (Meeting)', 'Microsoft Teams', 'Webex', 'Around', 'Whereby', 'Tuple', 'Pop', 'Tandem']);
const MEETING_DOMAINS = ['meet.google.com', 'zoom.us', 'teams.microsoft.com', 'whereby.com', 'webex.com', 'around.co'];

function resolveMeeting(f: Frame): EntityRef | null {
  const a = f.app ?? '', u = f.url ?? '', te = meetingEvidenceFromText(f.text);
  if (!MEETING_APPS.has(a) && !hasMeetingUrl(u) && !te) return null;
  const t = cleanMeetingEntityTitle(te?.title ?? f.window_title ?? te?.fallbackTitle ?? '', f, te?.fallbackTitle), slug = slugify(t) || 'untitled', d = f.timestamp.slice(0, 10);
  return { kind: 'meeting', path: `meetings/${d}-${slug}`, title: `${t} (${d})` };
}

function hasMeetingUrl(u: string): boolean {
  if (!u) return false;
  if (/\bmeet\.google\.com\/(?!landing\b)[a-z]{3}-[a-z]{4}-[a-z]{3}\b/i.test(u) || /\bzoom\.us\/(?:j|my|wc)\//i.test(u) || /\bteams\.microsoft\.com\/(?:l\/meetup-join|_\#\/meetup)\b/i.test(u)) return true;
  return MEETING_DOMAINS.filter(d => !['meet.google.com', 'zoom.us', 'teams.microsoft.com'].includes(d)).some(d => u.includes(d));
}

const REPO_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.org', 'codeberg.org']);

function resolveRepo(f: Frame): EntityRef | null {
  if (!f.url) return null; try {
    const u = new URL(f.url), h = u.hostname.replace(/^www\./, ''); if (!REPO_HOSTS.has(h)) return null;
    const p = u.pathname.split('/').filter(Boolean); if (p.length < 2 || /^(settings|marketplace|search|notifications|pulls|issues|topics|trending)$/.test(p[0]!)) return null;
    return { kind: 'repo', path: `repos/${slugify(p[0]!)}-${slugify(p[1]!)}`, title: `${p[0]}/${p[1]}` };
  } catch { return null; }
}

function resolveDoc(f: Frame): EntityRef | null {
  if (!f.url) return null; try {
    const u = new URL(f.url), h = u.hostname.replace(/^www\./, '');
    if (h === 'notion.so' || h.endsWith('.notion.so')) return { kind: 'doc', path: `docs/notion-${slugify(u.pathname.split('/').filter(Boolean).pop()?.replace(/-?[a-f0-9]{32}$/i, '') || 'untitled')}`, title: titleFromFrame(f, 'Notion page') };
    if (h === 'docs.google.com') { const p = u.pathname.split('/').filter(Boolean); return { kind: 'doc', path: `docs/gdocs-${p[0] ?? 'doc'}-${(p[2] ?? '').slice(0, 12) || 'unknown'}`, title: titleFromFrame(f, `Google ${p[0] ?? 'doc'}`) }; }
    if (h === 'linear.app') { const p = u.pathname.split('/').filter(Boolean), i = p.indexOf('issue'); if (i >= 0 && p[i+1]) return { kind: 'doc', path: `docs/linear-${slugify(p[i+1]!)}`, title: titleFromFrame(f, `Linear ${p[i+1]}`) }; }
    return null;
  } catch { return null; }
}

const CHANNEL_APPS = new Set(['Slack', 'Discord']);

function resolveChannel(f: Frame): EntityRef | null {
  if (!CHANNEL_APPS.has(f.app)) return null;
  const t = f.window_title || '';
  const sm = /^(#?)([\w._-]+)\s*\((Channel|Private channel|Private)\)/i.exec(t);
  if (sm) { const ws = /\(\s*(?:Channel|Private channel|Private)\s*\)\s*-\s*([^-\n]+?)\s*(?:-|$)/i.exec(t)?.[1]?.trim() ?? ''; return { kind: 'channel', path: `channels/${ws ? `${slugify(ws)}-${slugify(sm[2]!)}` : slugify(sm[2]!)}`, title: ws ? `#${sm[2]} — ${ws}` : `#${sm[2]}` }; }
  const dm = /^#\s*([\w._-]+)\s*\|\s*(.+)$/.exec(t);
  if (dm) { const s = dm[2]?.replace(/\s+\|\s+Discord\s*$/i, '').trim() ?? ''; return { kind: 'channel', path: `channels/${s ? `${slugify(s)}-${slugify(dm[1]!)}` : slugify(dm[1]!)}`, title: `#${dm[1]} — ${s}` }; }
  return null;
}

function resolveContact(f: Frame): EntityRef | null {
  if (!CHANNEL_APPS.has(f.app)) return null;
  const n = /^(.+?)\s*\((?:DM|Direct message)\)/i.exec(f.window_title || '')?.[1]?.trim();
  return n ? { kind: 'contact', path: `contacts/${slugify(n)}`, title: n } : null;
}

export const CODE_APPS = new Set(['Code', 'Code - Insiders', 'Visual Studio Code', 'Cursor', 'Cursor Nightly', 'Windsurf', 'WebStorm', 'IntelliJ IDEA', 'IntelliJ IDEA Ultimate', 'PyCharm', 'PyCharm Professional', 'GoLand', 'RustRover', 'CLion', 'Rider', 'PhpStorm', 'RubyMine', 'DataGrip', 'Xcode', 'Sublime Text', 'Zed', 'Nova']);
export const TERMINAL_APPS = new Set(['Terminal', 'iTerm2', 'iTerm', 'Warp', 'Hyper', 'Alacritty', 'kitty', 'WezTerm', 'Tabby']);
export const SUPPORTING_APP_SLUGS: ReadonlySet<string> = new Set([...CODE_APPS, ...TERMINAL_APPS].map(a => slugify(a)));
export function isSupportingAppEntity(p: string | null | undefined): boolean { return !!p?.startsWith('apps/') && SUPPORTING_APP_SLUGS.has(p.slice(5)); }

function resolveProject(f: Frame): EntityRef | null {
  const ic = CODE_APPS.has(f.app), it = TERMINAL_APPS.has(f.app); if (!ic && !it) return null;
  const p = deriveProjectName(f.window_title || '', f.app, it); return p ? { kind: 'project', path: `projects/${slugify(p)}`, title: p } : null;
}

function resolveWebpage(f: Frame): EntityRef | null {
  if (!f.url) return null; try { const u = new URL(f.url); if (!['http:', 'https:'].includes(u.protocol)) return null; const h = u.hostname.replace(/^www\./, ''); return h ? { kind: 'webpage', path: `web/${slugify(h)}`, title: titleFromFrame(f, h) } : null; } catch { return null; }
}

function resolveApp(f: Frame): EntityRef | null { return f.app ? { kind: 'app', path: `apps/${slugify(f.app)}`, title: f.app } : null; }

function deriveProjectName(t: string, a: string, it: boolean): string | null {
  const sm = t.match(/(?: — | – | - | · )([^—–·]+?)\s*$/); if (sm?.[1] && sm[1].trim().toLowerCase() !== a.toLowerCase()) return sm[1].trim();
  const bm = t.match(/\[([^\]]+)\]\s*$/); if (bm?.[1]) return bm[1].trim();
  if (it) { const ph = t.match(/(?:~?\/)?([\w._-]+)\/?\s*$/); if (ph?.[1]?.length && ph[1].length > 1) return ph[1]; }
  return null;
}

const MEETING_TITLE_NOISE_SEGMENT_RE = /^(camera and microphone recording|microphone recording|audio playing|screen share|presenting|high memory usage\b.*|\d+(?:\.\d+)?\s*(?:kb|mb|gb)|google chrome|chrome|sagiv \(your chrome\)|profile)$/i;
const GENERIC_MEETING_TITLE_RE = /^(zoom(\s+(meeting|workplace|us))?(\s+40\s+minutes)?|google\s+meet|meet|microsoft\s+teams|teams|webex|whereby|around|you have ended the meeting|camera and microphone recording|microphone recording|audio playing|google chrome|chrome|profile)$/i;

function cleanMeetingEntityTitle(r: string, f: Frame, fb?: string): string {
  let t = r.replace(/[\-—–]\s*(Google Meet|Zoom|Microsoft Teams|Webex|Around|Whereby)\s*$/i, '').replace(/^\s*Meet\s*[\-—–]\s*/i, '').replace(/\s+[—–\-]\s+(Mozilla Firefox|Google Chrome|Chrome|Safari|Brave|Arc|Edge|Microsoft Edge|Vivaldi|Opera).*$/i, '').replace(/\s+/g, ' ').trim();
  const p = t.split(/\s+[-–—]\s+/).map(x => x.trim()).filter(Boolean).filter(x => !MEETING_TITLE_NOISE_SEGMENT_RE.test(x));
  t = p.length ? p.join(' - ') : '';
  return !t || GENERIC_MEETING_TITLE_RE.test(t) ? (fb ?? fallbackMeetingTitle(f)) : t;
}

function fallbackMeetingTitle(f: Frame): string {
  const a = f.app ?? '', u = f.url ?? '', t = f.text ?? '';
  if (/zoom/i.test(a) || u.includes('zoom.us')) return 'Zoom';
  if (/google meet/i.test(a) || u.includes('meet.google.com') || /meet\.google\.com/i.test(t)) return 'Google Meet';
  if (/microsoft teams/i.test(a) || u.includes('teams.microsoft.com') || /teams\.microsoft\.com/i.test(t)) return 'Microsoft Teams';
  if (/webex/i.test(a) || u.includes('webex.com') || /webex\.com/i.test(t)) return 'Webex';
  if (/whereby/i.test(a) || u.includes('whereby.com') || /whereby\.com/i.test(t)) return 'Whereby';
  if (/around/i.test(a) || u.includes('around.co') || /around\.co/i.test(t)) return 'Around';
  return 'Meeting';
}

function meetingEvidenceFromText(t: string | null): { title?: string; fallbackTitle: string } | null {
  if (!t) return null; const ls = t.split(/\r?\n/).map(l => l.replace(/^[\s•*·-]+/, '').replace(/\s+/g, ' ').trim()).filter(Boolean), h = ls.join('\n');
  for (const l of ls) {
    if (/^(?:Google\s+)?Meet\s*[-–—]\s*(.{3,80})$/i.test(l)) return { title: l.match(/^(?:Google\s+)?Meet\s*[-–—]\s*(.{3,80})$/i)![1].trim(), fallbackTitle: 'Google Meet' };
    if (/^Zoom(?:\s+Meeting)?\s*[-–—]\s*(.{3,80})$/i.test(l)) return { title: l.match(/^Zoom(?:\s+Meeting)?\s*[-–—]\s*(.{3,80})$/i)![1].trim(), fallbackTitle: 'Zoom' };
    if (/^(?:Microsoft\s+)?Teams\s*[-–—]\s*(.{3,80})$/i.test(l)) return { title: l.match(/^(?:Microsoft\s+)?Teams\s*[-–—]\s*(.{3,80})$/i)![1].trim(), fallbackTitle: 'Microsoft Teams' };
  }
  if (/\bmeet\.google\.com\/(?!landing\b)[a-z]{3}-[a-z]{4}-[a-z]{3}\b/i.test(h) && /\b(join now|ask gemini|use gemini to take notes|share notes and transcript|camera is starting|other ways to join|leave call|meeting details)\b/i.test(h)) return { fallbackTitle: 'Google Meet' };
  if (/\b(?:[\w.-]+\.)?zoom\.us\/(?:j|my|wc)\//i.test(h) && /\b(join(?: with)? computer audio|start video|participants|leave meeting|waiting room)\b/i.test(h)) return { fallbackTitle: 'Zoom' };
  if (/\bteams\.microsoft\.com\/(?:l\/meetup-join|_\#\/meetup)\b/i.test(h) && /\b(join now|leave|people|raise|camera|microphone)\b/i.test(h)) return { fallbackTitle: 'Microsoft Teams' };
  return null;
}

function titleFromFrame(f: Frame, fb: string): string { const t = (f.window_title || '').replace(/\s+[—–\-]\s+(Mozilla Firefox|Google Chrome|Chrome|Safari|Brave|Arc|Edge|Microsoft Edge|Vivaldi|Opera).*$/i, '').trim(); return t.length > 4 && t.length < 120 ? t : fb; }
export function slugify(s: string): string { return s.toLowerCase().replace(/['"`]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60); }
export function entityKindLabel(k: EntityKind): string { return { project: 'Projects', repo: 'Repos', meeting: 'Meetings', contact: 'Contacts', channel: 'Channels', doc: 'Docs', webpage: 'Web', app: 'Apps' }[k]; }
