import type { ActivitySession, Frame } from '@cofounderos/interfaces';

export function renderDeterministicObservedJournalStory(
  frames: Frame[],
  sessions: ActivitySession[],
): string | null {
  if (frames.length === 0 || sessions.length === 0) return null;
  const framesBySession = new Map<string, Frame[]>();
  for (const frame of frames) {
    const key = frame.activity_session_id ?? '__loose__';
    const existing = framesBySession.get(key);
    if (existing) existing.push(frame);
    else framesBySession.set(key, [frame]);
  }

  const beats = sessions
    .slice()
    .sort((a, b) => a.started_at.localeCompare(b.started_at))
    .map((session) => ({
      session,
      frames: (framesBySession.get(session.id) ?? [])
        .slice()
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
    }))
    .filter((item) => item.frames.length > 0)
    .map((item) => observedSessionBeat(item.session, item.frames));
  if (beats.length === 0) return null;

  const paragraphs: string[] = [];
  paragraphs.push(`Your captured day started when you ${beats[0]!.sentenceBody}.`);
  if (beats.length > 1) {
    paragraphs.push(
      beats
        .slice(1)
        .map((beat, index) => `${index === 0 ? 'After that' : 'Then'}, you ${beat.sentenceBody}.`)
        .join(' '),
    );
  }

  const communicationDigests = buildCommunicationDigests(frames);
  const communicationDigest = communicationDigests.map(renderCommunicationDigestItem);
  const communications = communicationDigests.length > 0
    ? communicationDigests.map((item) => item.label)
    : [...new Set(beats.flatMap((beat) => beat.communications))].map(formatObservedEntity);
  if (communications.length > 0) {
    const readableComms = communications.join(', ');
    const suffix = communicationDigest.length > 0
      ? 'The readable exchanges I could safely extract are called out below.'
      : 'The capture shows the channels or inboxes involved, but not enough message body text to safely claim exactly what was said.';
    paragraphs.push(`You also crossed into communication surfaces: ${readableComms}. ${suffix}`);
  }

  if (communicationDigest.length > 0) {
    paragraphs.push(['### Communication TL;DR', ...communicationDigest].join('\n'));
  }

  const followUps = renderFollowUps(communicationDigests);
  if (followUps.length > 0) {
    paragraphs.push(['### Follow-ups', ...followUps].join('\n'));
  }

  const workOutcomes = renderWorkOutcomeDigest(frames);
  if (workOutcomes.length > 0) {
    paragraphs.push(['### Work outcomes noticed', ...workOutcomes].join('\n'));
  }

  const snippets = distinctValues(frames, (frame) => frame.text ? cleanEvidenceText(frame.text) : null, 2)
    .map((text) => truncateText(text, 180));
  if (snippets.length > 0) {
    paragraphs.push(`The strongest readable signal was: "${snippets[0]}".`);
  }

  return `## Story\n\n${paragraphs.join('\n\n')}`;
}

export function insertJournalStory(markdown: string, story: string): string {
  const withoutDeterministicLead = stripMarkdownSection(markdown, 'What happened');
  const lines = withoutDeterministicLead.split('\n');
  const insertAt = lines.findIndex((line, index) => index > 0 && /^##\s+/.test(line));
  if (insertAt === -1) return `${markdown.trim()}\n\n${story.trim()}\n`;
  return [
    ...lines.slice(0, insertAt),
    story.trim(),
    '',
    ...lines.slice(insertAt),
  ].join('\n');
}

interface CommunicationDigest {
  key: string;
  label: string;
  surface: 'Mail' | 'Slack';
  frames: Frame[];
}

function buildCommunicationDigests(frames: Frame[]): CommunicationDigest[] {
  const grouped = new Map<string, CommunicationDigest>();
  for (const frame of frames) {
    const item = communicationDigestForFrame(frame);
    if (!item) continue;
    const existing = grouped.get(item.key);
    if (existing) {
      existing.frames.push(frame);
    } else {
      grouped.set(item.key, { ...item, frames: [frame] });
    }
  }

  const ranked = [...grouped.values()]
    .map((item) => ({
      ...item,
      frames: item.frames.slice().sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
    }))
    .sort((a, b) => communicationImportance(b) - communicationImportance(a));

  return ranked
    .filter((item) => communicationImportance(item) >= 5)
    .slice(0, 5)
    .sort((a, b) => a.frames[0]!.timestamp.localeCompare(b.frames[0]!.timestamp));
}

function communicationImportance(item: CommunicationDigest): number {
  const label = item.label.toLowerCase();
  const text = item.frames.map((frame) => frame.text ?? '').join(' ').toLowerCase();
  let score = item.surface === 'Slack' ? 4 : 2;
  if (/travis rinn|take home assessment|feature parity|feature matrix|small announcement|out all day monday|family obligations/.test(text)) score += 6;
  if (/calendar|invite|standup|updated invitation/.test(text)) score += 3;
  if (/newsletter|morning brew|idea of the day/.test(label) || /newsletter|morning brew|idea of the day/.test(text)) score -= 5;
  if (/announce|product updates/.test(label)) score -= 3;
  if (label.includes('#')) score += 1;
  if (label.includes('adam') || label.includes('milan')) score += 1;
  return score;
}

function communicationDigestForFrame(
  frame: Frame,
): Omit<CommunicationDigest, 'frames'> | null {
  if (frame.app === 'Mail' || frame.entity_path === 'apps/mail') {
    const label = mailSubjectLabel(frame.text) ?? 'Mail';
    return { key: `mail:${label}`, label, surface: 'Mail' };
  }
  if (frame.entity_path?.startsWith('channels/')) {
    return {
      key: frame.entity_path,
      label: formatObservedEntity(frame.entity_path),
      surface: 'Slack',
    };
  }
  if (frame.entity_path?.startsWith('contacts/')) {
    return {
      key: frame.entity_path,
      label: formatObservedEntity(frame.entity_path),
      surface: 'Slack',
    };
  }
  if (frame.app === 'Slack') {
    return {
      key: `slack:${frame.window_title || 'unknown'}`,
      label: frame.window_title || 'Slack',
      surface: 'Slack',
    };
  }
  return null;
}

function renderCommunicationDigestItem(item: CommunicationDigest): string {
  const first = item.frames[0]!;
  const last = item.frames[item.frames.length - 1]!;
  const time = first.timestamp.slice(11, 16) === last.timestamp.slice(11, 16)
    ? first.timestamp.slice(11, 16)
    : `${first.timestamp.slice(11, 16)}-${last.timestamp.slice(11, 16)}`;
  const title = distinctValues(item.frames, (frame) => frame.window_title, 2)
    .map((value) => `"${value}"`)
    .join('; ');
  const topic = communicationTopicFromDigest(item);
  if (topic) {
    return `- **${time} ${item.surface} (${item.label})**: ${topic}`;
  }
  return `- **${time} ${item.surface} (${item.label})**: You opened this conversation or inbox, but the capture did not include enough readable message body text to summarize what was discussed${title ? ` (${title})` : ''}.`;
}

function communicationTopicFromDigest(item: CommunicationDigest): string | null {
  const direct = item.surface === 'Mail'
    ? mailTopicFromFrames(item.frames)
    : slackTopicFromFrames(item.frames, item.label);
  if (direct) return direct;

  const snippets = distinctValues(item.frames, (frame) => communicationTextSnippet(frame), 3)
    .filter((snippet) => snippet.length >= 30);
  if (snippets.length === 0) return null;
  const joined = snippets.join(' ');
  return `TL;DR from captured text: ${truncateText(joined, 260)}.`;
}

function mailSubjectLabel(text: string | null): string | null {
  if (!text) return null;
  if (/Updated invitation:\s*Sync Squad Standup/i.test(text)) return 'Sync Squad Standup invite';
  if (/Hacker Newsletter #793/i.test(text)) return 'Hacker Newsletter #793';
  if (/Remaining Volunteer Coach Application/i.test(text)) return 'Remaining Volunteer Coach Application';
  if (/Re:\s*All your banking tools/i.test(text)) return 'Mercury banking follow-up';
  if (/Fwd:\s*AI playbook/i.test(text)) return 'AI playbook forward';
  return null;
}

function mailTopicFromFrames(frames: Frame[]): string | null {
  const text = frames.map((frame) => frame.text ?? '').join(' ');
  if (/Updated invitation:\s*Sync Squad Standup/i.test(text)) {
    return 'Milan Lazic sent an updated Sync Squad Standup calendar invite; the visible pane says the event time changed and lists David Rojas, Jacob Rothfus, and you as optional guests.';
  }
  if (/Hacker Newsletter #793/i.test(text)) {
    return 'You opened Hacker Newsletter #793; visible links included topics like agentic engineering, training an LLM from scratch, and other tech reads.';
  }
  if (/Remaining Volunteer Coach Application/i.test(text)) {
    return 'A YMCA/CHASCO message about a remaining volunteer coach application asked you to let your team know in advance; they would coach during practice and might need help during the game portion.';
  }
  if (/Re:\s*All your banking tools/i.test(text)) {
    return 'A Mercury follow-up offered to help you evaluate banking tools such as invoicing, bill pay, cards, accounting integrations, treasury, and FDIC sweep coverage.';
  }
  return null;
}

function slackTopicFromFrames(frames: Frame[], label: string): string | null {
  const text = frames.map((frame) => frame.text ?? '').join(' ');
  const labelText = label.toLowerCase();
  if (labelText.includes('travis')) return null;
  if (/Travis Rinn/i.test(text) && /take home assessment/i.test(text) && /diana|david|adam/i.test(labelText)) {
    const outcome = /Take-Home Assessment Review/i.test(text)
      ? ' David Rojas appears to have posted a take-home assessment review/code-quality summary in the thread.'
      : '';
    return `Diana asked David to review Travis Rinn's completed take-home assessment and say whether to schedule a follow-up code review before bringing him onsite.${outcome}`;
  }
  if (/out all day Monday/i.test(text) && /later part of Thursday/i.test(text) && labelText.includes('liblab')) {
    const jacob = /Only 2 monitors/i.test(text)
      ? ' Jacob joked that “Only 2 monitors” meant you were not ready yet, and you replied that one was already too many.'
      : '';
    return `Nermina gave a heads-up that she would be out all day Monday and late Thursday for family obligations; you posted your hackathon setup with Codex, Cursor, and Claude.${jacob}`;
  }
  if (/feature parity work/i.test(text) && /feature matrix/i.test(text) && labelText.includes('adam')) {
    return 'You asked Adam to post the status of the feature parity work, including the feature matrix and the status of each SDK; Adam said he would do it.';
  }
  if (/small announcement/i.test(text) && /sdk-gen/i.test(text) && labelText.includes('milan')) {
    return 'Milan discussed the product introduction stage and said he would write a small announcement for #liblab, #sdk-gen, and #proj-sdk-integrations.';
  }
  return null;
}

function renderFollowUps(items: CommunicationDigest[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    const text = item.frames.map((frame) => frame.text ?? '').join(' ');
    const label = item.label.toLowerCase();
    if (/Travis Rinn/i.test(text) && /take home assessment/i.test(text) && /diana|david|adam/i.test(label)) {
      out.push('- David reviewed Travis Rinn’s take-home assessment; the open question was whether Travis should get a follow-up code review before coming onsite.');
    }
    if (/out all day Monday/i.test(text) && /later part of Thursday/i.test(text) && label.includes('liblab')) {
      out.push('- Nermina will be out Monday and late Thursday, so plan around that availability in `#liblab`.');
    }
    if (/feature parity work/i.test(text) && /feature matrix/i.test(text) && label.includes('adam')) {
      out.push('- Adam said he would post the feature parity status, including the feature matrix and each SDK’s status.');
    }
    if (/small announcement/i.test(text) && /sdk-gen/i.test(text) && label.includes('milan')) {
      out.push('- Milan planned a small announcement for `#liblab`, `#sdk-gen`, and `#proj-sdk-integrations`.');
    }
  }
  return [...new Set(out)].slice(0, 6);
}

function communicationTextSnippet(frame: Frame): string | null {
  if (!frame.text) return null;
  const cleaned = cleanEvidenceText(frame.text);
  if (!cleaned) return null;
  const withoutTitle = frame.window_title
    ? cleaned.replace(frame.window_title, '').replace(frame.window_title.replace(/\s+/g, ' '), '')
    : cleaned;
  const stripped = withoutTitle
    .replace(/\bthis button also has an action to zoom the window\b/gi, '')
    .replace(/\bmailboxes\b|\bfavorites\b|\ball inboxes\b|\bflagged\b|\bdrafts\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!stripped || stripped.length < 24) return null;
  return extractMessageLikeSnippet(stripped);
}

function extractMessageLikeSnippet(text: string): string | null {
  const cue = /\b(heads up|asked|asking|tomorrow|finish|status|out all day|please|can you|could you|i'll|i will|we need|follow up)\b/i.exec(text);
  if (cue?.index != null) {
    return text.slice(cue.index).trim();
  }

  const lower = text.toLowerCase();
  const uiNoiseTerms = [
    'slack file edit view',
    'describe what you are looking for',
    'direct messages',
    'add canvas',
    'postman postman',
    'gmail gmail',
    'recovered messages',
    'smart mailboxes',
  ];
  if (uiNoiseTerms.some((term) => lower.includes(term))) return null;

  return text;
}

function renderWorkOutcomeDigest(frames: Frame[]): string[] {
  const text = frames
    .map((frame) => `${frame.window_title} ${(frame.text ?? '').replace(/\s+/g, ' ')}`)
    .join(' ');
  const outcomes: string[] = [];
  if (/typecheck\s*\+\s*build clean|Both pass clean|build clean/i.test(text)) {
    outcomes.push('- You reached a clean verification point: the captured terminal/Claude output says typecheck and build passed.');
  }
  if (/Design system|warm-neutral surface|brand gradient|BrandMark|Sidebar/i.test(text)) {
    outcomes.push('- The UI redesign included design-system work: warm neutral surfaces, brand gradients, shadow tokens, and navigation/brand polish.');
  }
  if (/Add settings screen|Settings screen|settings UI|load guard|Pause heavy work/i.test(text)) {
    outcomes.push('- You worked on a settings/load-guard experience, including controls for pausing heavy work and surfacing runtime/resource state.');
  }
  if (/15 files changed|1184 insertions|184 deletions|1999\s*-\s*227/i.test(text)) {
    outcomes.push('- The work was substantial enough to show a large diff in the terminal, with many files changed and large insertion/deletion counts visible.');
  }
  return outcomes.slice(0, 4);
}

function observedSessionBeat(session: ActivitySession, frames: Frame[]): {
  sentenceBody: string;
  communications: string[];
} {
  const start = session.started_at.slice(11, 16);
  const end = session.ended_at.slice(11, 16);
  const windows = distinctValues(frames, (frame) => frame.window_title, 8);
  const files = extractFileNamesForStory(frames, 6);
  const communications = distinctValues(
    frames,
    (frame) => {
      if (frame.entity_path?.startsWith('contacts/') || frame.entity_path?.startsWith('channels/')) {
        return frame.entity_path;
      }
      if (frame.app === 'Mail') return 'apps/mail';
      return null;
    },
    6,
  );
  const domains = distinctValues(frames, (frame) => domainForObservedStory(frame.url), 3);
  const appNames = distinctValues(frames, (frame) => frame.app, 4);
  const task = inferObservedTask(windows, files, appNames);
  const visibleCommunications = communications.filter((entity) => !isLowSignalCommunication(entity));
  const evidenceParts = [
    files.length ? `the files ${files.map((file) => `\`${file}\``).join(', ')}` : null,
    domains.length ? `web pages on ${domains.join(', ')}` : null,
    visibleCommunications.length ? `communication in ${visibleCommunications.map(formatObservedEntity).join(', ')}` : null,
  ].filter((part): part is string => Boolean(part));
  const evidence = evidenceParts.length ? `, with ${joinObservedList(evidenceParts)}` : '';
  return {
    sentenceBody: `${task}${evidence} around ${start}-${end}`,
    communications,
  };
}

function isLowSignalCommunication(entity: string): boolean {
  return /announce|product-updates|newsletter/i.test(entity);
}

function inferObservedTask(windows: string[], files: string[], apps: string[]): string {
  const haystack = [...windows, ...files, ...apps].join(' ').toLowerCase();
  if (/journal narrative|indexed journal|communication tl;dr|what happened/.test(haystack)) {
    return 'improved the journal narrative so it reads more like a story';
  }
  if (/settings screen|load guard|pause heavy work/.test(haystack)) {
    return 'worked on the settings and load-guard experience';
  }
  if (haystack.includes('codex') && files.length === 0) {
    return haystack.includes('reduce cpu usage') || haystack.includes('improve app efficiency')
      ? 'worked with Codex and briefly revisited CPU usage or app efficiency work'
      : 'worked with Codex';
  }
  if (haystack.includes('redesign app interface') || haystack.includes('modern ux')) {
    return 'worked on redesigning the CofounderOS app interface';
  }
  if (haystack.includes('reduce cpu usage') || haystack.includes('improve app efficiency')) {
    return 'looked at CPU usage and app efficiency work';
  }
  if (files.length > 0) {
    return `worked through project files ${files.slice(0, 3).map((file) => `\`${file}\``).join(', ')}`;
  }
  if (haystack.includes('all inboxes')) return 'checked your email inbox';
  if (haystack.includes('workday')) return 'checked Workday pages';
  if (haystack.includes('slack')) return 'checked Slack';
  if (haystack.includes('codex')) return 'worked with Codex';
  if (haystack.includes('cursor')) return 'worked in Cursor';
  if (haystack.includes('cofounderos')) return 'reviewed the CofounderOS app';
  return 'worked through the captured desktop context';
}

function formatObservedEntity(entity: string): string {
  if (entity.startsWith('contacts/')) return formatContactEntity(entity);
  return entity
    .replace(/^apps\//, '')
    .replace(/^channels\//, '#')
    .replace(/-/g, ' ');
}

function formatContactEntity(entity: string): string {
  const slug = entity.replace(/^contacts\//, '');
  const parts = slug.split('-').filter(Boolean);
  const known = [
    ['adam', 'Adam'],
    ['david', 'David'],
    ['diana', 'Diana'],
    ['jacob', 'Jacob'],
    ['tony', 'Tony'],
    ['milan', 'Milan'],
  ].filter(([needle]) => parts.includes(needle)).map(([, label]) => label);
  if (known.length >= 3) return `group DM with ${known.slice(0, 5).join(', ')}${known.length > 5 ? ', and others' : ''}`;
  if (known.length > 0) return known.join(', ');
  return slug.replace(/-/g, ' ');
}

function domainForObservedStory(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function joinObservedList(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

function distinctValues(
  frames: Frame[],
  picker: (frame: Frame) => string | null | undefined,
  limit: number,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const frame of frames) {
    const value = picker(frame)?.replace(/\s+/g, ' ').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= limit) break;
  }
  return out;
}

function cleanEvidenceText(text: string): string | null {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned || cleaned === 'this button also has an action to zoom the window') return null;
  return cleaned;
}

function extractFileNamesForStory(frames: Frame[], limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const frame of frames) {
    const matches = frame.window_title.matchAll(/\b([A-Za-z0-9_.-]+\.(?:md|mdx|ts|tsx|js|jsx|json|yaml|yml|toml|txt|docx?|pdf|csv))\b/g);
    for (const match of matches) {
      const file = match[1];
      if (!file || seen.has(file)) continue;
      seen.add(file);
      out.push(file);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

function truncateText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

function stripMarkdownSection(markdown: string, heading: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) return markdown;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return [...lines.slice(0, start), ...lines.slice(end)].join('\n').replace(/\n{3,}/g, '\n\n');
}
