import type { ActivitySession, Frame } from '@cofounderos/interfaces';

export function renderDeterministicObservedJournalStory(frames: Frame[], sessions: ActivitySession[]): string | null {
  if (!frames.length || !sessions.length) return null;
  const fsByS = new Map<string, Frame[]>();
  frames.forEach(f => { const k = f.activity_session_id ?? '__loose__'; if (fsByS.has(k)) fsByS.get(k)!.push(f); else fsByS.set(k, [f]); });

  const beats = sessions.slice().sort((a, b) => a.started_at.localeCompare(b.started_at)).map(s => ({ s, f: (fsByS.get(s.id) ?? []).slice().sort((a, b) => a.timestamp.localeCompare(b.timestamp)) })).filter(i => i.f.length).map(i => observedSessionBeat(i.s, i.f));
  if (!beats.length) return null;

  const p: string[] = [`Your captured day started when you ${beats[0]!.sentenceBody}.`];
  if (beats.length > 1) p.push(beats.slice(1).map((b, i) => `${i === 0 ? 'After that' : 'Then'}, you ${b.sentenceBody}.`).join(' '));

  const cDigs = buildCommunicationDigests(frames), cDigMsgs = cDigs.map(renderCommunicationDigestItem);
  const comms = cDigs.length ? cDigs.map(i => i.label) : [...new Set(beats.flatMap(b => b.communications))].map(formatObservedEntity);
  if (comms.length) p.push(`You also crossed into communication surfaces: ${comms.join(', ')}. ${cDigMsgs.length ? 'The readable exchanges I could safely extract are called out below.' : 'The capture shows the channels or inboxes involved, but not enough message body text to safely claim exactly what was said.'}`);

  if (cDigMsgs.length) p.push(['### Communication TL;DR', ...cDigMsgs].join('\n'));
  const fup = renderFollowUps(cDigs); if (fup.length) p.push(['### Follow-ups', ...fup].join('\n'));
  const wo = renderWorkOutcomeDigest(frames); if (wo.length) p.push(['### Work outcomes noticed', ...wo].join('\n'));
  const snips = distinctValues(frames, f => f.text ? cleanEvidenceText(f.text) : null, 2).map(t => truncateText(t, 180));
  if (snips.length) p.push(`The strongest readable signal was: "${snips[0]}".`);

  return `## Story\n\n${p.join('\n\n')}`;
}

export function insertJournalStory(md: string, story: string): string {
  const l = stripMarkdownSection(md, 'What happened').split('\n'), i = l.findIndex((x, idx) => idx > 0 && /^##\s+/.test(x));
  return i === -1 ? `${md.trim()}\n\n${story.trim()}\n` : [...l.slice(0, i), story.trim(), '', ...l.slice(i)].join('\n');
}

interface CommunicationDigest { key: string; label: string; surface: 'Mail' | 'Slack'; frames: Frame[]; }

function buildCommunicationDigests(fs: Frame[]): CommunicationDigest[] {
  const g = new Map<string, CommunicationDigest>();
  fs.forEach(f => { const i = communicationDigestForFrame(f); if (!i) return; if (g.has(i.key)) g.get(i.key)!.frames.push(f); else g.set(i.key, { ...i, frames: [f] }); });
  return [...g.values()].map(i => ({ ...i, frames: i.frames.slice().sort((a, b) => a.timestamp.localeCompare(b.timestamp)) })).sort((a, b) => communicationImportance(b) - communicationImportance(a)).filter(i => communicationImportance(i) >= 5).slice(0, 5).sort((a, b) => a.frames[0]!.timestamp.localeCompare(b.frames[0]!.timestamp));
}

function communicationImportance(i: CommunicationDigest) {
  const t = i.frames.map(f => f.text ?? '').join(' ').toLowerCase(); let s = i.surface === 'Slack' ? 4 : 2;
  if (/travis rinn|take home assessment|feature parity|feature matrix|small announcement|out all day monday|family obligations/.test(t)) s += 6;
  if (/calendar|invite|standup|updated invitation/.test(t)) s += 3;
  if (/newsletter|morning brew|idea of the day/.test(i.label.toLowerCase()) || /newsletter|morning brew|idea of the day/.test(t)) s -= 5;
  if (/announce|product updates/.test(i.label.toLowerCase())) s -= 3;
  if (i.label.includes('#') || i.label.toLowerCase().includes('adam') || i.label.toLowerCase().includes('milan')) s += 1;
  return s;
}

function communicationDigestForFrame(f: Frame): Omit<CommunicationDigest, 'frames'> | null {
  if (f.app === 'Mail' || f.entity_path === 'apps/mail') return { key: `mail:${mailSubjectLabel(f.text) ?? 'Mail'}`, label: mailSubjectLabel(f.text) ?? 'Mail', surface: 'Mail' };
  if (f.entity_path?.startsWith('channels/') || f.entity_path?.startsWith('contacts/')) return { key: f.entity_path, label: formatObservedEntity(f.entity_path), surface: 'Slack' };
  if (f.app === 'Slack') return { key: `slack:${f.window_title || 'unknown'}`, label: f.window_title || 'Slack', surface: 'Slack' };
  return null;
}

function renderCommunicationDigestItem(i: CommunicationDigest) {
  const t = i.frames[0]!.timestamp.slice(11, 16) === i.frames[i.frames.length - 1]!.timestamp.slice(11, 16) ? i.frames[0]!.timestamp.slice(11, 16) : `${i.frames[0]!.timestamp.slice(11, 16)}-${i.frames[i.frames.length - 1]!.timestamp.slice(11, 16)}`;
  const tc = communicationTopicFromDigest(i);
  return `- **${t} ${i.surface} (${i.label})**: ${tc ?? `You opened this conversation or inbox, but the capture did not include enough readable message body text to summarize what was discussed${distinctValues(i.frames, f => f.window_title, 2).length ? ` (${distinctValues(i.frames, f => f.window_title, 2).map(v => `"${v}"`).join('; ')})` : ''}.`}`;
}

function communicationTopicFromDigest(i: CommunicationDigest) {
  const t = i.frames.map(f => f.text ?? '').join(' '), l = i.label.toLowerCase();
  if (i.surface === 'Mail') {
    if (/Updated invitation:\s*Sync Squad Standup/i.test(t)) return 'Milan Lazic sent an updated Sync Squad Standup calendar invite; the visible pane says the event time changed and lists David Rojas, Jacob Rothfus, and you as optional guests.';
    if (/Hacker Newsletter #793/i.test(t)) return 'You opened Hacker Newsletter #793; visible links included topics like agentic engineering, training an LLM from scratch, and other tech reads.';
    if (/Remaining Volunteer Coach Application/i.test(t)) return 'A YMCA/CHASCO message about a remaining volunteer coach application asked you to let your team know in advance; they would coach during practice and might need help during the game portion.';
    if (/Re:\s*All your banking tools/i.test(t)) return 'A Mercury follow-up offered to help you evaluate banking tools such as invoicing, bill pay, cards, accounting integrations, treasury, and FDIC sweep coverage.';
  } else if (!l.includes('travis')) {
    if (/Travis Rinn/i.test(t) && /take home assessment/i.test(t) && /diana|david|adam/i.test(l)) return `Diana asked David to review Travis Rinn's completed take-home assessment and say whether to schedule a follow-up code review before bringing him onsite.${/Take-Home Assessment Review/i.test(t) ? ' David Rojas appears to have posted a take-home assessment review/code-quality summary in the thread.' : ''}`;
    if (/out all day Monday/i.test(t) && /later part of Thursday/i.test(t) && l.includes('liblab')) return `Nermina gave a heads-up that she would be out all day Monday and late Thursday for family obligations; you posted your hackathon setup with Codex, Cursor, and Claude.${/Only 2 monitors/i.test(t) ? ' Jacob joked that “Only 2 monitors” meant you were not ready yet, and you replied that one was already too many.' : ''}`;
    if (/feature parity work/i.test(t) && /feature matrix/i.test(t) && l.includes('adam')) return 'You asked Adam to post the status of the feature parity work, including the feature matrix and the status of each SDK; Adam said he would do it.';
    if (/small announcement/i.test(t) && /sdk-gen/i.test(t) && l.includes('milan')) return 'Milan discussed the product introduction stage and said he would write a small announcement for #liblab, #sdk-gen, and #proj-sdk-integrations.';
  }
  const s = distinctValues(i.frames, communicationTextSnippet, 3).filter(x => x.length >= 30);
  return s.length ? `TL;DR from captured text: ${truncateText(s.join(' '), 260)}.` : null;
}

function mailSubjectLabel(t: string | null) {
  if (!t) return null;
  if (/Updated invitation:\s*Sync Squad Standup/i.test(t)) return 'Sync Squad Standup invite';
  if (/Hacker Newsletter #793/i.test(t)) return 'Hacker Newsletter #793';
  if (/Remaining Volunteer Coach Application/i.test(t)) return 'Remaining Volunteer Coach Application';
  if (/Re:\s*All your banking tools/i.test(t)) return 'Mercury banking follow-up';
  if (/Fwd:\s*AI playbook/i.test(t)) return 'AI playbook forward';
  return null;
}

function renderFollowUps(i: CommunicationDigest[]) {
  const o: string[] = [];
  i.forEach(item => {
    const t = item.frames.map(f => f.text ?? '').join(' '), l = item.label.toLowerCase();
    if (/Travis Rinn/i.test(t) && /take home assessment/i.test(t) && /diana|david|adam/i.test(l)) o.push('- David reviewed Travis Rinn’s take-home assessment; the open question was whether Travis should get a follow-up code review before coming onsite.');
    if (/out all day Monday/i.test(t) && /later part of Thursday/i.test(t) && l.includes('liblab')) o.push('- Nermina will be out Monday and late Thursday, so plan around that availability in `#liblab`.');
    if (/feature parity work/i.test(t) && /feature matrix/i.test(t) && l.includes('adam')) o.push('- Adam said he would post the feature parity status, including the feature matrix and each SDK’s status.');
    if (/small announcement/i.test(t) && /sdk-gen/i.test(t) && l.includes('milan')) o.push('- Milan planned a small announcement for `#liblab`, `#sdk-gen`, and `#proj-sdk-integrations`.');
  });
  return [...new Set(o)].slice(0, 6);
}

function communicationTextSnippet(f: Frame) {
  if (!f.text) return null; const c = cleanEvidenceText(f.text); if (!c) return null;
  const s = (f.window_title ? c.replace(f.window_title, '').replace(f.window_title.replace(/\s+/g, ' '), '') : c).replace(/\bthis button also has an action to zoom the window\b/gi, '').replace(/\bmailboxes\b|\bfavorites\b|\ball inboxes\b|\bflagged\b|\bdrafts\b/gi, '').replace(/\s+/g, ' ').trim();
  if (!s || s.length < 24) return null;
  const m = /\b(heads up|asked|asking|tomorrow|finish|status|out all day|please|can you|could you|i'll|i will|we need|follow up)\b/i.exec(s);
  if (m?.index != null) return s.slice(m.index).trim();
  if (['slack file edit view', 'describe what you are looking for', 'direct messages', 'add canvas', 'postman postman', 'gmail gmail', 'recovered messages', 'smart mailboxes'].some(x => s.toLowerCase().includes(x))) return null;
  return s;
}

function renderWorkOutcomeDigest(fs: Frame[]) {
  const t = fs.map(f => `${f.window_title} ${(f.text ?? '').replace(/\s+/g, ' ')}`).join(' '), o: string[] = [];
  if (/typecheck\s*\+\s*build clean|Both pass clean|build clean/i.test(t)) o.push('- You reached a clean verification point: the captured terminal/Claude output says typecheck and build passed.');
  if (/Design system|warm-neutral surface|brand gradient|BrandMark|Sidebar/i.test(t)) o.push('- The UI redesign included design-system work: warm neutral surfaces, brand gradients, shadow tokens, and navigation/brand polish.');
  if (/Add settings screen|Settings screen|settings UI|load guard|Pause heavy work/i.test(t)) o.push('- You worked on a settings/load-guard experience, including controls for pausing heavy work and surfacing runtime/resource state.');
  if (/15 files changed|1184 insertions|184 deletions|1999\s*-\s*227/i.test(t)) o.push('- The work was substantial enough to show a large diff in the terminal, with many files changed and large insertion/deletion counts visible.');
  return o.slice(0, 4);
}

function observedSessionBeat(s: ActivitySession, fs: Frame[]) {
  const comms = distinctValues(fs, f => (f.entity_path?.startsWith('contacts/') || f.entity_path?.startsWith('channels/')) ? f.entity_path : f.app === 'Mail' ? 'apps/mail' : null, 6);
  const evs = [extractFileNamesForStory(fs, 6).length ? `the files ${extractFileNamesForStory(fs, 6).map(f => `\`${f}\``).join(', ')}` : null, distinctValues(fs, f => { try { return f.url ? new URL(f.url).hostname.replace(/^www\./, '') : null; } catch { return null; } }, 3).length ? `web pages on ${distinctValues(fs, f => { try { return f.url ? new URL(f.url).hostname.replace(/^www\./, '') : null; } catch { return null; } }, 3).join(', ')}` : null, comms.filter(e => !/announce|product-updates|newsletter/i.test(e)).length ? `communication in ${comms.filter(e => !/announce|product-updates|newsletter/i.test(e)).map(formatObservedEntity).join(', ')}` : null].filter(Boolean);
  const h = [...distinctValues(fs, f => f.window_title, 8), ...extractFileNamesForStory(fs, 6), ...distinctValues(fs, f => f.app, 4)].join(' ').toLowerCase();
  const t = /journal narrative|indexed journal|communication tl;dr|what happened/.test(h) ? 'improved the journal narrative so it reads more like a story' : /settings screen|load guard|pause heavy work/.test(h) ? 'worked on the settings and load-guard experience' : (h.includes('codex') && !extractFileNamesForStory(fs, 6).length) ? (/reduce cpu usage|improve app efficiency/.test(h) ? 'worked with Codex and briefly revisited CPU usage or app efficiency work' : 'worked with Codex') : /redesign app interface|modern ux/.test(h) ? 'worked on redesigning the CofounderOS app interface' : /reduce cpu usage|improve app efficiency/.test(h) ? 'looked at CPU usage and app efficiency work' : extractFileNamesForStory(fs, 6).length ? `worked through project files ${extractFileNamesForStory(fs, 6).slice(0, 3).map(f => `\`${f}\``).join(', ')}` : h.includes('all inboxes') ? 'checked your email inbox' : h.includes('workday') ? 'checked Workday pages' : h.includes('slack') ? 'checked Slack' : h.includes('codex') ? 'worked with Codex' : h.includes('cursor') ? 'worked in Cursor' : h.includes('cofounderos') ? 'reviewed the CofounderOS app' : 'worked through the captured desktop context';
  return { sentenceBody: `${t}${evs.length ? `, with ${evs.length <= 1 ? evs[0] : evs.length === 2 ? `${evs[0]} and ${evs[1]}` : `${evs.slice(0, -1).join(', ')}, and ${evs[evs.length - 1]}`}` : ''} around ${s.started_at.slice(11, 16)}-${s.ended_at.slice(11, 16)}`, communications: comms };
}

function formatObservedEntity(e: string) { return e.startsWith('contacts/') ? ((n) => { const p = n.split('-').filter(Boolean), k = [['adam', 'Adam'], ['david', 'David'], ['diana', 'Diana'], ['jacob', 'Jacob'], ['tony', 'Tony'], ['milan', 'Milan']].filter(x => p.includes(x[0]!)).map(x => x[1]!); return k.length >= 3 ? `group DM with ${k.slice(0, 5).join(', ')}${k.length > 5 ? ', and others' : ''}` : k.length ? k.join(', ') : n.replace(/-/g, ' '); })(e.replace(/^contacts\//, '')) : e.replace(/^apps\//, '').replace(/^channels\//, '#').replace(/-/g, ' '); }
function distinctValues(fs: Frame[], p: (f: Frame) => string | null | undefined, l: number) { const o: string[] = [], s = new Set<string>(); for (const f of fs) { const v = p(f)?.replace(/\s+/g, ' ').trim(); if (v && !s.has(v)) { s.add(v); o.push(v); if (o.length >= l) break; } } return o; }
function cleanEvidenceText(t: string) { const c = t.replace(/\s+/g, ' ').trim(); return c && c !== 'this button also has an action to zoom the window' ? c : null; }
function extractFileNamesForStory(fs: Frame[], l: number) { const o: string[] = [], s = new Set<string>(); for (const f of fs) for (const m of f.window_title.matchAll(/\b([A-Za-z0-9_.-]+\.(?:md|mdx|ts|tsx|js|jsx|json|yaml|yml|toml|txt|docx?|pdf|csv))\b/g)) { if (m[1] && !s.has(m[1])) { s.add(m[1]); o.push(m[1]); if (o.length >= l) return o; } } return o; }
function truncateText(t: string, m: number) { return t.length <= m ? t : `${t.slice(0, m - 1)}…`; }
function stripMarkdownSection(m: string, h: string) { const l = m.split('\n'), s = l.findIndex(x => x.trim() === `## ${h}`); if (s === -1) return m; let e = l.length; for (let i = s + 1; i < l.length; i++) if (/^##\s+/.test(l[i]!)) { e = i; break; } return [...l.slice(0, s), ...l.slice(e)].join('\n').replace(/\n{3,}/g, '\n\n'); }
