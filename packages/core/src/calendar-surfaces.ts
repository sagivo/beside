export type CalendarProvider =
  | 'apple_calendar'
  | 'google_calendar'
  | 'outlook_calendar'
  | 'icloud_calendar'
  | 'notion_calendar'
  | 'fantastical'
  | 'busycal'
  | 'amie'
  | 'cron'
  | 'vimcal'
  | 'cal_com'
  | 'proton_calendar'
  | 'fastmail_calendar'
  | 'zoho_calendar'
  | 'yahoo_calendar'
  | 'morgen'
  | 'akiflow'
  | 'reclaim'
  | 'motion'
  | 'sunsama'
  | 'calendly'
  | 'project_calendar'
  | 'calendar';

export interface CalendarSurfaceInput {
  app?: string | null;
  appBundleId?: string | null;
  url?: string | null;
  windowTitle?: string | null;
  text?: string | null;
}

export interface CalendarSurface {
  provider: CalendarProvider;
  sourceKey: string;
  label: string;
  app: string | null;
  appBundleId: string | null;
  url: string | null;
  urlHost: string | null;
  confidence: number;
  reason: 'native_app' | 'calendar_url' | 'calendar_chrome';
}

interface NativeCalendarSurface {
  provider: CalendarProvider;
  label: string;
  appNames?: string[];
  bundlePrefixes?: string[];
}

interface CalendarHostSurface {
  provider: CalendarProvider;
  label: string;
  hosts: string[];
  path?: RegExp;
}

const APPLE_CALENDAR_CANONICAL_BUNDLE_ID = 'com.apple.iCal';

const NATIVE_CALENDAR_SURFACES: NativeCalendarSurface[] = [
  { provider: 'apple_calendar', label: 'Apple Calendar', appNames: ['calendar'], bundlePrefixes: [APPLE_CALENDAR_CANONICAL_BUNDLE_ID] },
  { provider: 'fantastical', label: 'Fantastical', appNames: ['fantastical'], bundlePrefixes: ['com.flexibits.fantastical'] },
  { provider: 'notion_calendar', label: 'Notion Calendar', appNames: ['notion calendar'], bundlePrefixes: ['notion.id.notion-calendar'] },
  { provider: 'cron', label: 'Cron', appNames: ['cron'], bundlePrefixes: ['com.cron'] },
  { provider: 'busycal', label: 'BusyCal', appNames: ['busycal'], bundlePrefixes: ['com.busymac.busycal'] },
  { provider: 'amie', label: 'Amie', appNames: ['amie'], bundlePrefixes: ['co.amie'] },
  { provider: 'outlook_calendar', label: 'Outlook Calendar', appNames: ['outlook', 'mimestream'] },
];

const CALENDAR_HOST_SURFACES: CalendarHostSurface[] = [
  { provider: 'google_calendar', label: 'Google Calendar', hosts: ['calendar.google.com'] },
  { provider: 'outlook_calendar', label: 'Outlook Calendar', hosts: ['outlook.live.com', 'outlook.office.com', 'outlook.office365.com', 'outlook.com'], path: /\/calendar\b|\/owa\b.*calendar/i },
  { provider: 'icloud_calendar', label: 'iCloud Calendar', hosts: ['icloud.com', 'www.icloud.com'], path: /\/calendar\b/i },
  { provider: 'proton_calendar', label: 'Proton Calendar', hosts: ['calendar.proton.me'] },
  { provider: 'yahoo_calendar', label: 'Yahoo Calendar', hosts: ['calendar.yahoo.com'] },
  { provider: 'zoho_calendar', label: 'Zoho Calendar', hosts: ['calendar.zoho.com'] },
  { provider: 'fastmail_calendar', label: 'Fastmail Calendar', hosts: ['app.fastmail.com', 'fastmail.com'], path: /\/calendar\b/i },
  { provider: 'vimcal', label: 'Vimcal', hosts: ['vimcal.com', 'app.vimcal.com'] },
  { provider: 'cal_com', label: 'Cal.com', hosts: ['cal.com', 'app.cal.com'] },
  { provider: 'cron', label: 'Cron', hosts: ['cron.com'] },
  { provider: 'amie', label: 'Amie', hosts: ['amie.so'] },
  { provider: 'morgen', label: 'Morgen', hosts: ['web.morgen.so'] },
  { provider: 'akiflow', label: 'Akiflow', hosts: ['app.akiflow.com'] },
  { provider: 'reclaim', label: 'Reclaim', hosts: ['app.reclaim.ai'] },
  { provider: 'motion', label: 'Motion', hosts: ['app.usemotion.com'] },
  { provider: 'sunsama', label: 'Sunsama', hosts: ['app.sunsama.com'] },
  { provider: 'calendly', label: 'Calendly', hosts: ['calendly.com'] },
  { provider: 'notion_calendar', label: 'Notion Calendar', hosts: ['notion.so', 'www.notion.so'], path: /\/calendar\b|view=calendar|\?v=.*calendar/i },
  { provider: 'project_calendar', label: 'Linear Calendar', hosts: ['linear.app'], path: /\/views?\/calendar\b|\?layout=calendar/i },
  { provider: 'project_calendar', label: 'Asana Calendar', hosts: ['asana.com', 'app.asana.com'], path: /\/calendar\b|\?view=calendar/i },
  { provider: 'project_calendar', label: 'ClickUp Calendar', hosts: ['app.clickup.com'], path: /\/calendar\b|\?view=calendar/i },
  { provider: 'project_calendar', label: 'Monday Calendar', hosts: ['monday.com'], path: /\bcalendar\b/i },
  { provider: 'project_calendar', label: 'GitHub Project Calendar', hosts: ['github.com'], path: /\/projects\/.+\/views\/.*\bcalendar\b/i },
];

export function calendarUrlHosts(): string[] {
  return Array.from(new Set(CALENDAR_HOST_SURFACES.flatMap((surface) => surface.hosts)));
}

export function calendarAppNames(): string[] {
  return Array.from(new Set(NATIVE_CALENDAR_SURFACES.flatMap((surface) => surface.appNames ?? [])));
}

export function calendarAppBundlePrefixes(): string[] {
  return Array.from(new Set(NATIVE_CALENDAR_SURFACES.flatMap((surface) => surface.bundlePrefixes ?? [])));
}

export function classifyCalendarSurface(input: CalendarSurfaceInput): CalendarSurface | null {
  const app = clean(input.app);
  const appLower = app?.toLowerCase() ?? '';
  const appBundleId = clean(input.appBundleId);
  const bundleLower = appBundleId?.toLowerCase() ?? '';
  const url = clean(input.url);
  const urlParts = parseUrlParts(url);

  const native = NATIVE_CALENDAR_SURFACES.find((surface) => {
    const appHit = surface.appNames?.some((name) => appLower === name || appLower.includes(name));
    const bundleHit = surface.bundlePrefixes?.some((prefix) => bundleLower.startsWith(prefix.toLowerCase()));
    return appHit || bundleHit;
  });
  if (native) {
    return {
      provider: native.provider,
      sourceKey: sourceKey(native.provider, nativeSourceIdentity(native, appBundleId, app)),
      label: native.label,
      app,
      appBundleId,
      url,
      urlHost: urlParts?.host ?? null,
      confidence: 95,
      reason: 'native_app',
    };
  }

  if (urlParts) {
    const hosted = matchCalendarHost(urlParts.host, urlParts.path);
    if (hosted) {
      return {
        provider: hosted.provider,
        sourceKey: sourceKey(hosted.provider, hosted.matchedHost),
        label: hosted.label,
        app,
        appBundleId,
        url,
        urlHost: urlParts.host,
        confidence: hosted.path ? 92 : 90,
        reason: 'calendar_url',
      };
    }
  }

  if (looksLikeAppleCalendarChrome(input.text) && looksLikeCalendarGridText(input.text)) {
    return {
      provider: 'apple_calendar',
      sourceKey: sourceKey('apple_calendar', APPLE_CALENDAR_CANONICAL_BUNDLE_ID),
      label: 'Apple Calendar',
      app,
      appBundleId,
      url,
      urlHost: urlParts?.host ?? null,
      confidence: 70,
      reason: 'calendar_chrome',
    };
  }

  return null;
}

function nativeSourceIdentity(surface: NativeCalendarSurface, appBundleId: string | null, app: string | null): string {
  // macOS accessibility can expose the Calendar window while another app is frontmost. In that
  // case the frame carries Calendar text with Slack/Activity Monitor bundle metadata. Apple
  // Calendar needs one canonical source key so captures reconcile instead of accumulating aliases.
  if (surface.provider === 'apple_calendar') return APPLE_CALENDAR_CANONICAL_BUNDLE_ID;
  return appBundleId ?? app ?? surface.label;
}

export function isKnownCalendarUrl(url: string | null | undefined): boolean {
  const parts = parseUrlParts(url);
  return !!parts && !!matchCalendarHost(parts.host, parts.path);
}

export function looksLikeCalendarGridText(text: string | null | undefined): boolean {
  if (!text || text.length < 60) return false;
  let signals = 0;
  const monthMatch = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i.exec(text);
  if (monthMatch && /\b(?:20\d{2}|19\d{2})\b/.test(text.slice(monthMatch.index, monthMatch.index + 40))) signals++;

  const weekdayHits = [...text.matchAll(/\b(?:sun|mon|tue|wed|thu|fri|sat)\b/gi)].map((m) => m.index ?? 0);
  if (weekdayHits.length >= 3 && weekdayHits.some((hit, i) => weekdayHits[i + 2] - hit <= 120)) signals++;

  const hourHits = [
    ...[...text.matchAll(/\b(?:1[0-2]|0?[1-9])\s?(?:am|pm)\b/gi)].map((m) => m.index ?? 0),
    ...[...text.matchAll(/\b(?:[01]\d|2[0-3]):[0-5]\d\b/g)].map((m) => m.index ?? 0),
  ].sort((a, b) => a - b);
  if (hourHits.length >= 3 && hourHits.some((hit, i) => hourHits[i + 2] - hit <= 200)) signals++;

  return signals >= 2;
}

function looksLikeAppleCalendarChrome(text: string | null | undefined): boolean {
  return !!text && /\bCalendar\s+File\s+Edit\s+View\s+Window\s+Help\b/i.test(text.replace(/\s+/g, ' '));
}

function matchCalendarHost(host: string, path: string): (CalendarHostSurface & { matchedHost: string }) | null {
  for (const surface of CALENDAR_HOST_SURFACES) {
    const matchedHost = surface.hosts.find((entry) => host === entry || host.endsWith('.' + entry));
    if (!matchedHost) continue;
    if (surface.path && !surface.path.test(path)) continue;
    return { ...surface, matchedHost };
  }
  return null;
}

function parseUrlParts(url: string | null | undefined): { host: string; path: string } | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return { host: parsed.host.toLowerCase(), path: `${parsed.pathname}${parsed.search}` };
  } catch {
    return null;
  }
}

function sourceKey(provider: CalendarProvider, key: string): string {
  return `${provider}:${key.toLowerCase().replace(/^https?:\/\//, '').replace(/[^a-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '')}`;
}

function clean(value: string | null | undefined): string | null {
  const out = (value ?? '').trim();
  return out ? out : null;
}
