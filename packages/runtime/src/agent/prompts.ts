import type { ChatIntent, ChatTurnHistoryItem, CollectedToolResults, CompactFrame, CompactSession, DateAnchor, FrameContextResult } from './types.js';

export function buildSystemPrompt(): string {
  return [
    'You are Beside, a personal-productivity assistant on the user\'s device.',
    'Answer ONLY from the CONTEXT block. Never invent.',
    '',
    'Hard rules:',
    '- GROUNDING: every concrete fact must appear verbatim or paraphrased in CONTEXT. Do not invent details.',
    '- If CONTEXT has no matches / "(No tool data was gathered.)", reply exactly: "I don\'t see that in your captures." and stop.',
    '- OUTPUT FORMAT shows shape only — never copy example text.',
    '- No preambles or closers.',
    '- No stats unless explicitly requested.',
    '- Use user-visible names, not internal entity paths.',
    '',
    'Style: Markdown bullets, terse. Use local times from CONTEXT verbatim. Reconstruct meaning from noisy OCR; do not quote it.',
  ].join('\n');
}

export function buildDirectSystemPrompt(): string {
  return [
    'You are Beside, a personal-productivity assistant.',
    'Answer directly from your knowledge plus history (no captured-data tools for this turn).',
    '',
    'Hard constraints:',
    '- NO internet access or real-time data.',
    '- If asked about current news, the user likely means their context. Suggest rephrasing.',
    '- Do not pretend to have read files/messages if you don\'t know.',
    '',
    'Style: Markdown bullets, inline code, fenced code blocks.',
    '',
    'CRITICAL:',
    '- Lead with the answer. No preambles.',
    '- Stop when complete. No closers.',
  ].join('\n');
}

export function buildDirectAnswerPrompt(input: { message: string; history: ChatTurnHistoryItem[] }): string {
  return [
    ...(input.history.length ? ['Recent conversation:', input.history.map(formatHistoryItem).join('\n')] : []),
    `User message:\n${input.message}`
  ].join('\n\n');
}

export function buildAnswerPrompt(input: { intent: ChatIntent; anchor: DateAnchor; message: string; history: ChatTurnHistoryItem[]; results: CollectedToolResults; }): string {
  return [
    `Today is ${input.anchor.day} (${input.anchor.label}). All times in CONTEXT are in the user's local timezone.`,
    ...(input.history.length ? ['Recent conversation:', input.history.map(formatHistoryItem).join('\n')] : []),
    `User asked: ${input.message}`,
    formatContextForIntent(input.intent, input.anchor, input.results),
    buildGroundingReminder(input.intent),
    formatOutputTemplate(input.intent, input.anchor, input.results)
  ].join('\n\n');
}

function buildGroundingReminder(intent: ChatIntent): string {
  return [
    'REMINDER:',
    '- Use ONLY facts from CONTEXT.',
    '- If CONTEXT is empty/"no matches", reply exactly: "I don\'t see that in your captures."',
    '- No preambles/closers.',
    ...(intent !== 'time_audit' ? ['- Do NOT include stats/counts.'] : [])
  ].join('\n');
}

function formatContextForIntent(intent: ChatIntent, anchor: DateAnchor, results: CollectedToolResults): string {
  const parts = ['CONTEXT:', 'Confidence guide:\n- HIGH: structured fields\n- MEDIUM: actionable excerpts\n- LOW: unreliable OCR (defer to verified context)'];
  if (results.notes.length) parts.push(`Planner notes:\n${results.notes.map(n => `- ${n}`).join('\n')}`);

  switch (intent) {
    case 'day_overview': parts.push(...buildDayOverviewContext(anchor, results)); break;
    case 'calendar_check': parts.push(...buildCalendarContext(results)); break;
    case 'open_loops': parts.push(...buildOpenLoopsContext(results)); break;
    case 'recall_event': case 'recall_preference': case 'topic_deep_dive': parts.push(...buildRecallContext(results), ...buildIndexContext(results)); break;
    case 'project_status': parts.push(...buildEntityContext(results), ...buildIndexContext(results)); break;
    case 'people_context': parts.push(...buildPeopleContext(results)); break;
    case 'time_audit': parts.push(...buildTimeAuditContext(anchor, results)); break;
    default: parts.push(...buildGeneralContext(results)); break;
  }

  const usefulContexts = results.frame_contexts.filter(c => c.anchor.garbled);
  if (usefulContexts.length) parts.push(formatFrameContexts(usefulContexts));
  if (parts.length === 1) parts.push('(No tool data was gathered.)');
  return parts.join('\n\n');
}

function buildDayOverviewContext(anchor: DateAnchor, results: CollectedToolResults): string[] {
  const d = results.day_overview;
  if (!d) return ['No day overview data.'];
  const out = [];
  out.push(d.calendar_candidates.length ? `Calendar screens for ${anchor.day}:\n${d.calendar_candidates.map(formatCalendarFrameForExtraction).join('\n')}` : 'No calendar frames.');
  out.push(d.open_loop_candidates.length ? `Pending items on ${anchor.day}:\n${d.open_loop_candidates.map(formatActionableFrameLine).join('\n')}` : 'No open loops.');
  if (d.top_entities.length) out.push(`Worked on today:\n${d.top_entities.map(e => `- ${displayEntity(e.path)}: ${e.minutes} min`).join('\n')}`);
  return out;
}

function buildCalendarContext(results: CollectedToolResults): string[] {
  const c = results.calendar_check ?? results.day_overview, cands = 'candidates' in c! ? c.candidates : c?.calendar_candidates;
  if (!cands?.length) return ['No calendar frames captured.'];
  return ['Calendar screens:', cands.map(formatCalendarFrameForExtraction).join('\n')];
}

function formatCalendarFrameForExtraction(frame: CompactFrame): string {
  return frame.garbled || !frame.excerpt ? `- (OCR unreliable; defer to verified context)` : `- Calendar OCR: "${truncate(frame.excerpt, 600)}"`;
}

function buildOpenLoopsContext(results: CollectedToolResults): string[] {
  const c = results.open_loops ?? results.day_overview, cands = 'candidates' in c! ? c.candidates : c?.open_loop_candidates;
  if (!cands?.length) return ['No open loops found.'];
  return [`Pending items:\n${cands.map(formatActionableFrameLine).join('\n')}`];
}

function buildRecallContext(results: CollectedToolResults): string[] {
  const out = results.searches.filter(s => s.matches.length).map(s => `Search results for "${s.query}":\n${s.matches.map(formatActionableFrameLine).join('\n')}`);
  if (!out.length && results.searches.length) out.push('No search results retrieved.');
  return out;
}

function buildEntityContext(results: CollectedToolResults): string[] {
  const out = results.entity_lookups.filter(l => l.entities.length).map(l => `Entity matches for "${l.query}":\n${l.entities.map(e => `- ${e.title} (${e.kind}, last seen ${shortDate(e.lastSeen)})`).join('\n')}`);
  for (const es of results.entity_summaries) {
    const l = [`Entity rollup — ${es.title} (${es.kind}):`];
    if (es.totalFocusedMin > 0) l.push(`- Focused time: ${formatMinutes(es.totalFocusedMin)}`);
    if (es.neighbours.length) l.push(`- Appears with: ${es.neighbours.slice(0,5).map(n => `${n.title} (${n.kind})`).join(', ')}`);
    if (es.timeline.length) l.push(`- Activity: ${es.timeline.slice(0,7).map(b => `${b.bucket}: ${b.minutes} min`).join('; ')}`);
    if (es.recentFrames.length) l.push(`- Recent screens:\n${es.recentFrames.slice(0,5).map(formatActionableFrameLine).join('\n')}`);
    out.push(l.join('\n'));
  }
  if (!out.length) out.push('No entity data retrieved.');
  return out;
}

function buildPeopleContext(results: CollectedToolResults): string[] {
  if (results.people_synthesis) return [`LLM memory synthesis for "${results.people_synthesis.query}":\n${results.people_synthesis.brief}`];
  const out = results.entity_lookups.map(l => l.entities.length ? `Contact lookup candidates for "${l.query}":\n${l.entities.map(e => `- ${e.title} (${e.kind}, ${e.path}, last seen ${shortDate(e.lastSeen)})`).join('\n')}` : `Contact lookup for "${l.query}" returned no candidates.`);
  for (const es of results.entity_summaries) {
    const l = [`Clean contact rollup — ${es.title}:`];
    if (es.neighbours.length) l.push(`- Appears with: ${es.neighbours.slice(0,5).map(n => `${n.title} (${n.kind})`).join(', ')}`);
    if (es.recentFrames.length) l.push(`- Recent frames:\n${es.recentFrames.slice(0,5).map(formatActionableFrameLine).join('\n')}`);
    out.push(l.join('\n'));
  }
  out.push(...buildPeopleIndexContext(results), ...buildPeopleSearchContext(results));
  if (!out.length) out.push('No people-context evidence retrieved.');
  return out;
}

function buildPeopleIndexContext(results: CollectedToolResults): string[] {
  return results.index_searches.map(s => s.matches.length ? `Knowledge-base candidates for "${s.query}":\n${s.matches.map(m => `- ${m.title} (${m.path}) — ${truncate(m.excerpt.replace(/\s+/g, ' '), 260)}`).join('\n')}` : `Knowledge-base search for "${s.query}" returned no matches.`);
}

function buildPeopleSearchContext(results: CollectedToolResults): string[] {
  return results.searches.map(s => s.matches.length ? `Person-related candidates for "${s.query}":\n${s.matches.map(formatPersonFrameLine).join('\n')}` : `Person frame search for "${s.query}" returned no matches.`);
}

function buildTimeAuditContext(anchor: DateAnchor, results: CollectedToolResults): string[] {
  const d = results.day_overview;
  if (!d) return ['No time-audit data retrieved.'];
  const out = [`Totals for ${anchor.day}: ${formatMinutes(d.totals.active_min)} active across ${d.totals.sessions} sessions.`];
  if (d.top_apps.length) out.push(`Top apps:\n${d.top_apps.map(a => `- ${a.app}: ${formatMinutes(a.minutes)}`).join('\n')}`);
  if (d.top_entities.length) out.push(`Top entities:\n${d.top_entities.map(e => `- ${displayEntity(e.path)}: ${formatMinutes(e.minutes)}`).join('\n')}`);
  if (d.sessions.length) out.push(formatSessionList('Sessions (chronological)', d.sessions));
  return out;
}

function buildGeneralContext(results: CollectedToolResults): string[] {
  const out = [];
  if (results.day_overview) out.push(...buildDayOverviewContext({ day: results.day_overview.day } as DateAnchor, results));
  if (results.searches.length) out.push(...buildRecallContext(results));
  if (results.entity_summaries.length || results.entity_lookups.length) out.push(...buildEntityContext(results));
  if (results.index_searches.length) out.push(...buildIndexContext(results));
  if (!out.length) out.push('No tool data gathered.');
  return out;
}

function buildIndexContext(results: CollectedToolResults): string[] {
  return results.index_searches.filter(s => s.matches.length).map(s => `Knowledge-base pages for "${s.query}":\n${s.matches.map(m => `- ${m.title} (${m.path}) — ${truncate(m.excerpt.replace(/\s+/g, ' '), 260)}`).join('\n')}`);
}

function formatOutputTemplate(intent: ChatIntent, anchor: DateAnchor, results: CollectedToolResults): string {
  switch (intent) {
    case 'day_overview': return 'OUTPUT FORMAT:\n1. **Today\'s calendar:** (clock time + title)\n2. **Pending / open loops:** (what\'s waiting)\n3. (Optional) **What you\'ve been on:** (focus)\nDo NOT include stats or closers.';
    case 'calendar_check': return `OUTPUT FORMAT:\n- List meetings for ${anchor.label} as \`**HH:MM AM/PM** — Title\`.\n- Do NOT add commentary.`;
    case 'open_loops': return 'OUTPUT FORMAT:\nBullet list: `- **<where>** — <what is waiting>`\nIf none, write exactly: `Nothing pending I can confirm from your captures.`';
    case 'recall_event': case 'recall_preference': return 'OUTPUT FORMAT:\nLead sentence: `<time> in <app> — <paraphrased summary>`.\nFollow with 1-3 bullets of details.\nIf empty, write exactly: `I don\'t see that in your captures.`\nDo NOT quote OCR verbatim.';
    case 'project_status': return 'OUTPUT FORMAT:\n- Summary sentence.\n- **Recent attention**\n- **Connected to**\nNo closers.';
    case 'people_context': return 'OUTPUT FORMAT:\n<summary sentence>\n**Recent messages**\n- <app> · <time> · <speaker>: <paraphrased>\n**Commitments / todos**\n**Open loops**\nNo raw OCR quotes or timestamps.';
    case 'time_audit': return 'OUTPUT FORMAT:\nYou spent **<total>** active today across <N> sessions.\n\n**Top apps**\n- <app> — <duration>\n\n**Top focus**\n- <entity> — <duration>';
    case 'topic_deep_dive': return 'OUTPUT FORMAT:\n- One-paragraph synthesis.\n- **Notable moments** (up to 5 bullets).\n- **Related entities** (one-liner).';
    default: return 'OUTPUT FORMAT:\nAnswer directly in 1-4 sentences from CONTEXT.\nIf empty, say "I don\'t see that in your captures." and offer follow-up.';
  }
}

function formatHistoryItem(item: ChatTurnHistoryItem): string { return `${item.role === 'user' ? 'User' : 'You (assistant)'}: ${truncate(item.content, 600)}`; }
function formatActionableFrameLine(frame: CompactFrame): string { return `- ${shortTime(frame.timestamp)} · ${frame.app} (${truncate(frame.url ? hostFromUrl(frame.url) : frame.window_title || frame.app || 'unknown', 60)})${frame.excerpt ? (frame.garbled ? ' — (OCR unreliable)' : ` — "${truncate(frame.excerpt, 220)}"`) : ''}`; }
function formatPersonFrameLine(frame: CompactFrame): string { return `- ${shortTime(frame.timestamp)} · ${frame.app} (${truncate(frame.url ? hostFromUrl(frame.url) : frame.window_title || frame.app || 'unknown', 80)})${frame.excerpt ? ` — "${truncate(frame.excerpt, 520)}"` : ''}`; }
function formatSessionList(label: string, sessions: CompactSession[]): string { return sessions.length ? `${label}:\n${sessions.map(s => `- ${shortTime(s.started_at)}–${shortTime(s.ended_at)} · ${s.active_min} min · ${displayEntity(s.primary_entity ?? s.primary_app ?? 'unknown')}`).join('\n')}` : ''; }
function formatFrameContexts(contexts: FrameContextResult[]): string { return contexts.map(ctx => `Verified context around ${ctx.anchor.app} at ${shortTime(ctx.anchor.timestamp)}:\n(Anchor is the only relevant part)\n${ctx.before.length ? `Before:\n${ctx.before.map(formatActionableFrameLine).join('\n')}\n` : ''}Anchor: ${formatActionableFrameLine(ctx.anchor)}\n${ctx.after.length ? `After:\n${ctx.after.map(formatActionableFrameLine).join('\n')}` : ''}`).join('\n\n'); }

function displayEntity(path: string): string { return path.includes('/') ? `${path.split('/')[1]} (${path.split('/')[0]?.replace(/s$/, '')})` : path; }
function shortTime(iso: string): string { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); }
function shortDate(iso: string): string { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
function formatMinutes(min: number): string { return min < 60 ? `${min} min` : `${Math.floor(min / 60)}h${min % 60 ? ` ${min % 60}m` : ''}`; }
function hostFromUrl(url: string): string { try { return new URL(url).host; } catch { return url; } }
function truncate(text: string, max: number): string { return text.length <= max ? text : `${text.slice(0, max - 1)}…`; }
