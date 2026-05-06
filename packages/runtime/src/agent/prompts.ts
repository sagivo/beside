import type {
  ChatIntent,
  ChatTurnHistoryItem,
  CollectedToolResults,
  CompactFrame,
  CompactSession,
  DateAnchor,
  FrameContextResult,
} from './types.js';

/**
 * System prompt for the chat agent's tools-mode answer step. Distilled
 * from §3 (response assembly) + §6 (anti-patterns) of the harness
 * rules. Used only when the router decided this turn needs the
 * captured-data tool surface.
 */
export function buildSystemPrompt(): string {
  // Kept deliberately short: small local models tend to drop the middle
  // of long system prompts. The most important rules (GROUNDING +
  // no-fabrication + no-closer) are also restated immediately above the
  // OUTPUT FORMAT block so the model reads them last.
  return [
    'You are CofounderOS, a personal-productivity assistant on the user\'s device.',
    'You answer ONLY from the CONTEXT block in the user message. Never invent.',
    '',
    'Hard rules:',
    '- GROUNDING: every concrete fact (name, app, channel, time, quote, number) MUST appear verbatim or as a direct paraphrase in the CONTEXT. Do not mention anything that isn\'t there.',
    '- If CONTEXT has no matches / no candidates / "(No tool data was gathered.)", reply exactly: "I don\'t see that in your captures." and stop.',
    '- The OUTPUT FORMAT block shows shape only — never copy its example text into the answer.',
    '- No preambles ("Sure!", "Based on your data,"). No closers ("Let me know if…", "Hope this helps", "What else can I help with?").',
    '- No frame / session / capture stats unless the user explicitly asked about time usage.',
    '- Do not restate the user\'s question. Do not surface internal ids or entity paths — use user-visible names.',
    '',
    'Style: Markdown bullets, terse, one item per line. Times in CONTEXT are ALREADY in the user\'s local time — copy them as-is, do not convert again. Reconstruct meaning from noisy OCR; do not quote it verbatim.',
  ].join('\n');
}

/**
 * System prompt for the direct-answer path. Used when the router
 * decided the question doesn't need captured-data tools.
 */
export function buildDirectSystemPrompt(): string {
  return [
    'You are CofounderOS, a personal-productivity assistant on the user\'s device.',
    'You also act as a general-purpose assistant when the question is not about the user\'s captured device activity.',
    'For this turn the router decided captured-memory tools are NOT needed — answer directly from your own knowledge plus history.',
    '',
    'Hard constraints:',
    '- NO internet access, NO web search, NO real-time data. Do not pretend.',
    '- If a question wants current news about a topic / company / person / project ("what\'s the latest with X", "any updates on Y"), the user almost certainly meant THEIR context on X. Say so briefly and suggest a rephrase like "what have I been doing on X lately" — do NOT bail with a generic "check a news site" answer.',
    '- Do not pretend to have read their files, calendar, or messages this turn. If you don\'t know, say so.',
    '',
    'Style: Markdown bullets, inline code, and fenced code blocks (with language tag) for code.',
    '',
    'CRITICAL — apply to EVERY response you generate in this mode, no exceptions:',
    '- Lead with the answer. No preambles like "Sure!", "Of course,", "Hello!" before the substance.',
    '- Stop the moment your answer is complete. Do NOT add a closing sentence inviting more questions.',
    '- Forbidden closing phrases (do not write any of these, in any wording): "Let me know if…", "Hope this helps", "Happy to help", "Feel free to ask", "What else can I help with", "Is there anything else", "Need more details", "More details if you need".',
  ].join('\n');
}

/**
 * User-side prompt for the direct-answer path. Carries history but
 * never the captured-data context block.
 */
export function buildDirectAnswerPrompt(input: {
  message: string;
  history: ChatTurnHistoryItem[];
}): string {
  const sections: string[] = [];
  if (input.history.length > 0) {
    sections.push('Recent conversation (oldest first):');
    sections.push(input.history.map(formatHistoryItem).join('\n'));
  }
  sections.push(`User message:\n${input.message}`);
  return sections.join('\n\n');
}

/**
 * Compose the user-side prompt for the tools-mode answer step.
 *
 * Critical: the prompt is INTENT-AWARE. Different intents need
 * different output shapes (a daily briefing leads with calendar +
 * pending items; a recall query leads with the matched moment; a
 * project-status query leads with the entity rollup). Without per-
 * intent guidance, small local models default to summarizing whatever
 * is most numeric in the context — which is why "what's on my plate"
 * was returning "458 frames, top app Slack 90 min" instead of meetings
 * and follow-ups.
 *
 * Each branch follows the same structure:
 *   1. State the question.
 *   2. Show the relevant context (reordered: most actionable first).
 *   3. Give a strict OUTPUT TEMPLATE the model should follow.
 */
export function buildAnswerPrompt(input: {
  intent: ChatIntent;
  anchor: DateAnchor;
  message: string;
  history: ChatTurnHistoryItem[];
  results: CollectedToolResults;
}): string {
  const { intent, anchor, message, history, results } = input;
  const sections: string[] = [];
  sections.push(`Today is ${anchor.day} (${anchor.label}). All times in the CONTEXT below are already in the user's local timezone — use them verbatim, do not subtract or add hours.`);
  if (history.length > 0) {
    sections.push('Recent conversation (oldest first):');
    sections.push(history.map(formatHistoryItem).join('\n'));
  }
  sections.push(`User asked: ${message}`);
  sections.push(formatContextForIntent(intent, anchor, results));
  sections.push(buildGroundingReminder(intent));
  sections.push(formatOutputTemplate(intent, anchor, results));
  return sections.join('\n\n');
}

/**
 * One-line reminder repeated immediately before the OUTPUT FORMAT
 * block. Small local models weight the LAST instruction they read
 * heavily, so a tight grounding-only restate here meaningfully cuts
 * fabrication on tools-mode answers.
 */
function buildGroundingReminder(intent: ChatIntent): string {
  const allowStats = intent === 'time_audit';
  const lines = [
    'REMINDER before answering:',
    '- Use ONLY facts that appear in the CONTEXT above. If a name, app, channel, time, or quote is not in the CONTEXT, do not mention it.',
    '- If the CONTEXT contains only "no matches" / "no candidates" / "(No tool data was gathered.)", reply exactly: "I don\'t see that in your captures."',
    '- No preambles, no closers, no offers of further help. Stop right after the last bullet.',
  ];
  if (!allowStats) {
    lines.push('- Do NOT include frame counts, session counts, or capture stats.');
  }
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────
// Per-intent context formatting
// ─────────────────────────────────────────────────────────────────────

function formatContextForIntent(
  intent: ChatIntent,
  anchor: DateAnchor,
  results: CollectedToolResults,
): string {
  const parts: string[] = [
    'CONTEXT:',
    [
      'Confidence guide for this block:',
      '- HIGH: structured fields (entity titles/paths, session totals, calendar event titles drawn from clean OCR, verified frame-context blocks). Quote and cite directly.',
      '- MEDIUM: actionable frame excerpts (calendar / open-loop / search hits) with non-garbled OCR. Reconstruct meaning, do not quote verbatim.',
      '- LOW: lines tagged "(OCR unreliable; defer to verified context)" or planner notes that say "no matches" — these are NOT evidence on their own. Either ground in the matching verified context block or omit the item.',
    ].join('\n'),
  ];

  if (results.notes.length > 0) {
    parts.push(`Planner notes:\n${results.notes.map((n) => `- ${n}`).join('\n')}`);
  }

  switch (intent) {
    case 'daily_briefing':
      parts.push(...buildDailyBriefingContext(anchor, results));
      break;
    case 'calendar_check':
      parts.push(...buildCalendarContext(results));
      break;
    case 'open_loops':
      parts.push(...buildOpenLoopsContext(results));
      break;
    case 'recall_event':
    case 'recall_preference':
    case 'topic_deep_dive':
      parts.push(...buildRecallContext(results));
      parts.push(...buildIndexContext(results));
      break;
    case 'project_status':
      parts.push(...buildEntityContext(results));
      parts.push(...buildIndexContext(results));
      break;
    case 'people_context':
      parts.push(...buildPeopleContext(results));
      break;
    case 'time_audit':
      parts.push(...buildTimeAuditContext(anchor, results));
      break;
    case 'general':
    default:
      parts.push(...buildGeneralContext(results));
      break;
  }

  // Verified frame contexts: include only when they actually add
  // signal. The before/after frames in a context window are the user's
  // unrelated activity from earlier/later in the day; small models
  // happily summarize them as if they were part of the answer. So we
  // only emit the block when the anchor's own OCR is garbled (and we
  // genuinely need surrounding frames to disambiguate it). For clean
  // anchors the original search-result line already has everything.
  const usefulContexts = results.frame_contexts.filter((c) => c.anchor.garbled === true);
  if (usefulContexts.length > 0) {
    parts.push(formatFrameContexts(usefulContexts));
  }

  if (parts.length === 1) parts.push('(No tool data was gathered.)');
  return parts.join('\n\n');
}

function buildDailyBriefingContext(anchor: DateAnchor, results: CollectedToolResults): string[] {
  const d = results.daily_briefing;
  if (!d) return ['No daily briefing data was retrieved.'];
  const out: string[] = [];

  // Lead with calendar candidates — these are what "what's on my plate"
  // is really asking about. Use the extraction-style formatter so the
  // model doesn't confuse the screen-capture timestamp with a meeting
  // time.
  if (d.calendar_candidates.length > 0) {
    out.push(
      [
        `Calendar screens captured on ${anchor.day}. Extract meetings from inside the OCR excerpt; the screen-capture timestamp is NOT a meeting time:`,
        d.calendar_candidates.map(formatCalendarFrameForExtraction).join('\n'),
      ].join('\n'),
    );
  } else {
    out.push('No calendar-related frames were captured today.');
  }

  // Then open loops.
  if (d.open_loop_candidates.length > 0) {
    out.push(`Frames suggesting pending / unanswered items on ${anchor.day}:\n${d.open_loop_candidates.map(formatActionableFrameLine).join('\n')}`);
  } else {
    out.push('No open-loop signals were detected today.');
  }

  // Working context (only for grounding — explicit instruction below
  // tells the model not to dump these as stats).
  if (d.top_entities.length > 0) {
    out.push(
      `What the user worked on today (entity, minutes focused):\n${d.top_entities
        .map((e) => `- ${displayEntity(e.path)}: ${e.minutes} min`)
        .join('\n')}`,
    );
  }

  return out;
}

function buildCalendarContext(results: CollectedToolResults): string[] {
  const c = results.calendar_check ?? results.daily_briefing;
  if (!c) return ['No calendar data was retrieved.'];
  const candidates =
    'candidates' in c ? c.candidates : (c as NonNullable<typeof results.daily_briefing>).calendar_candidates;
  if (candidates.length === 0) {
    return ['No calendar-related frames were captured for the requested day. The user may not have opened their calendar app.'];
  }
  // Drop the capture timestamp — it's the time the user OPENED the
  // calendar, not a meeting time. Small models confuse the two and emit
  // a phantom meeting at the capture time. The OCR excerpt below is
  // where the actual meeting times live.
  return [
    `Calendar screens captured for the day. The OCR excerpt below contains the meetings — extract clock time + title pairs from inside the excerpt; ignore everything outside it.`,
    candidates
      .map((f) => formatCalendarFrameForExtraction(f))
      .join('\n'),
  ];
}

function formatCalendarFrameForExtraction(frame: CompactFrame): string {
  if (frame.garbled || !frame.excerpt) {
    return `- (OCR unreliable for the calendar frame from ${frame.app}; defer to verified context if present)`;
  }
  return `- Calendar OCR: "${truncate(frame.excerpt, 600)}"`;
}

function buildOpenLoopsContext(results: CollectedToolResults): string[] {
  const c = results.open_loops ?? results.daily_briefing;
  if (!c) return ['No open-loop data was retrieved.'];
  const candidates =
    'candidates' in c
      ? c.candidates
      : (c as NonNullable<typeof results.daily_briefing>).open_loop_candidates;
  if (candidates.length === 0) {
    return ['No open-loop signals were found in the captures for the requested day.'];
  }
  return [
    `Frames suggesting pending / unanswered items (Slack / GitHub / etc.):\n${candidates.map(formatActionableFrameLine).join('\n')}`,
  ];
}

function buildRecallContext(results: CollectedToolResults): string[] {
  const out: string[] = [];
  // Only surface searches that actually produced matches. Empty
  // searches are not signal — small models will copy the literal "no
  // matches" line into the answer alongside the real hit.
  const nonEmpty = results.searches.filter((s) => s.matches.length > 0);
  for (const search of nonEmpty) {
    out.push(
      `Search results for "${search.query}" (best match first):\n${search.matches
        .map(formatActionableFrameLine)
        .join('\n')}`,
    );
  }
  if (out.length === 0 && results.searches.length > 0) {
    // Only summarise the empty-search state when ALL searches were
    // empty (so the answer prompt's no-evidence short-circuit can fire).
    out.push('No search results were retrieved.');
  }
  return out;
}

function buildEntityContext(results: CollectedToolResults): string[] {
  const out: string[] = [];
  for (const lookup of results.entity_lookups) {
    if (lookup.entities.length === 0) continue; // skip empties — see buildIndexContext.
    out.push(
      `Entity matches for "${lookup.query}":\n${lookup.entities
        .map((e) => `- ${e.title} (${e.kind}, last seen ${shortDate(e.lastSeen)})`)
        .join('\n')}`,
    );
  }
  for (const es of results.entity_summaries) {
    const lines: string[] = [`Entity rollup — ${es.title} (${es.kind}):`];
    if (es.totalFocusedMin > 0) lines.push(`- Total focused time: ${formatMinutes(es.totalFocusedMin)}`);
    if (es.neighbours.length > 0) {
      lines.push(
        `- Frequently appears with: ${es.neighbours
          .slice(0, 5)
          .map((n) => `${n.title} (${n.kind})`)
          .join(', ')}`,
      );
    }
    if (es.timeline.length > 0) {
      const recent = es.timeline.slice(0, 7);
      lines.push(
        `- Recent activity (last ${recent.length} days): ${recent
          .map((b) => `${b.bucket}: ${b.minutes} min`)
          .join('; ')}`,
      );
    }
    if (es.recentFrames.length > 0) {
      lines.push(
        `- Recent screens:\n${es.recentFrames.slice(0, 5).map(formatActionableFrameLine).join('\n')}`,
      );
    }
    out.push(lines.join('\n'));
  }
  if (out.length === 0) out.push('No entity data was retrieved.');
  return out;
}

function buildPeopleContext(results: CollectedToolResults): string[] {
  const out: string[] = [];

  if (results.people_synthesis) {
    out.push(
      `LLM memory synthesis for "${results.people_synthesis.query}" (${results.people_synthesis.usedVision ? `inspected ${results.people_synthesis.imageCount} screenshot(s) plus text/index summaries` : 'text/index summaries only'}):\n${results.people_synthesis.brief}`,
    );
    return out;
  }

  for (const lookup of results.entity_lookups) {
    if (lookup.entities.length === 0) {
      out.push(`Contact lookup for "${lookup.query}" returned no candidates. This is not an answer; continue with memory search evidence.`);
    } else {
      out.push(
        `Contact lookup candidates for "${lookup.query}" (metadata only; do not treat last-seen as the person's status):\n${lookup.entities
          .map((e) => `- ${e.title} (${e.kind}, path ${e.path}, metadata last seen ${shortDate(e.lastSeen)})`)
          .join('\n')}`,
      );
    }
  }

  for (const es of results.entity_summaries) {
    const lines: string[] = [`Clean contact rollup — ${es.title}:`];
    if (es.neighbours.length > 0) {
      lines.push(
        `- Appears with: ${es.neighbours
          .slice(0, 5)
          .map((n) => `${n.title} (${n.kind})`)
          .join(', ')}`,
      );
    }
    if (es.recentFrames.length > 0) {
      lines.push(
        `- Recent contact frames:\n${es.recentFrames.slice(0, 5).map(formatActionableFrameLine).join('\n')}`,
      );
    }
    out.push(lines.join('\n'));
  }

  out.push(...buildPeopleIndexContext(results));
  out.push(...buildPeopleSearchContext(results));

  if (out.length === 0) out.push('No people-context evidence was retrieved.');
  return out;
}

function buildPeopleIndexContext(results: CollectedToolResults): string[] {
  const out: string[] = [];
  for (const search of results.index_searches) {
    if (search.matches.length === 0) {
      out.push(`Knowledge-base search for "${search.query}" returned no page matches.`);
      continue;
    }
    out.push(
      `Knowledge-base candidates for "${search.query}" (secondary evidence only; use only excerpts that describe actual messages, work, or commitments involving the person):\n${search.matches
        .map((m) => `- ${m.title} (${m.path}, updated ${shortDate(m.lastUpdated)}) — ${truncate(m.excerpt.replace(/\s+/g, ' '), 260)}`)
        .join('\n')}`,
    );
  }
  return out;
}

function buildPeopleSearchContext(results: CollectedToolResults): string[] {
  const out: string[] = [];
  for (const search of results.searches) {
    if (search.matches.length === 0) {
      out.push(`Person frame search for "${search.query}" returned no message-like matches.`);
      continue;
    }
    out.push(
      `Person-related message candidates for "${search.query}" (newest first, deduped and filtered toward communication surfaces; ignore anything that is not a real message):\n${search.matches
        .map(formatPersonFrameLine)
        .join('\n')}`,
    );
  }
  return out;
}

function buildTimeAuditContext(anchor: DateAnchor, results: CollectedToolResults): string[] {
  const d = results.daily_briefing;
  if (!d) return ['No time-audit data was retrieved.'];
  const out: string[] = [
    `Totals for ${anchor.day}: ${formatMinutes(d.totals.active_min)} active across ${d.totals.sessions} focus sessions.`,
  ];
  if (d.top_apps.length > 0) {
    out.push(
      `Top apps:\n${d.top_apps.map((a) => `- ${a.app}: ${formatMinutes(a.minutes)}`).join('\n')}`,
    );
  }
  if (d.top_entities.length > 0) {
    out.push(
      `Top entities:\n${d.top_entities
        .map((e) => `- ${displayEntity(e.path)}: ${formatMinutes(e.minutes)}`)
        .join('\n')}`,
    );
  }
  if (d.sessions.length > 0) {
    out.push(formatSessionList('Sessions (chronological)', d.sessions));
  }
  return out;
}

function buildGeneralContext(results: CollectedToolResults): string[] {
  const out: string[] = [];
  if (results.daily_briefing) {
    out.push(...buildDailyBriefingContext({ day: results.daily_briefing.day } as DateAnchor, results));
  }
  if (results.searches.length > 0) {
    out.push(...buildRecallContext(results));
  }
  if (results.entity_summaries.length > 0 || results.entity_lookups.length > 0) {
    out.push(...buildEntityContext(results));
  }
  if (results.index_searches.length > 0) {
    out.push(...buildIndexContext(results));
  }
  if (out.length === 0) out.push('No tool data was gathered.');
  return out;
}

function buildIndexContext(results: CollectedToolResults): string[] {
  const out: string[] = [];
  // Skip empty index searches in the prompt for the same reason we
  // skip empty frame searches above — the model treats their summary
  // line as content and quotes it.
  for (const search of results.index_searches) {
    if (search.matches.length === 0) continue;
    out.push(
      `Knowledge-base page matches for "${search.query}" (synthesised index pages; prefer these for high-level "latest/status" answers):\n${search.matches
        .map((m) => `- ${m.title} (${m.path}, updated ${shortDate(m.lastUpdated)}) — ${truncate(m.excerpt.replace(/\s+/g, ' '), 260)}`)
        .join('\n')}`,
    );
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// Per-intent OUTPUT TEMPLATES
//
// These are the most important part of the prompt. Without them small
// local models drift toward summarizing the most numeric thing in the
// context. With them, we steer the answer shape per intent.
// ─────────────────────────────────────────────────────────────────────

function formatOutputTemplate(
  intent: ChatIntent,
  anchor: DateAnchor,
  results: CollectedToolResults,
): string {
  switch (intent) {
    case 'daily_briefing':
      return [
        'OUTPUT FORMAT — follow exactly:',
        '1. Start with **Today\'s calendar:** followed by a bullet list of meetings/events you can identify from the calendar frames. Use clock time + title. If you can\'t identify any concrete meeting from the OCR, write "Nothing on the calendar I can pin down — check your calendar app to confirm."',
        '2. Then **Pending / open loops:** followed by a bullet list of things that look unanswered (Slack messages, PR review requests, etc.). One short line per item describing what\'s waiting and where. If none, write "No open loops detected."',
        '3. (Optional) End with **What you\'ve been on:** as a SHORT one-line note about the top 1–2 entities/apps you\'ve been focused on today. Skip this if it doesn\'t add anything.',
        '',
        'Do NOT include frame counts, session counts, or any "X frames captured" stat.',
        'Do NOT close with "What else can I help with?" — just stop after the last item.',
      ].join('\n');

    case 'calendar_check':
      return [
        'OUTPUT FORMAT — follow exactly:',
        `- List meetings/events for ${anchor.label} as a bullet list, sorted by clock time, in the format \`**HH:MM AM/PM** — Title\`.`,
        '- If the OCR is too garbled to extract a clean title, give your best reconstruction and note "(OCR uncertain)".',
        '- If no meetings can be identified from the calendar frames, write a single line: "I don\'t see any meetings I can pin down for ' +
          anchor.label +
          ". Check your calendar app to confirm.\"",
        '- Do NOT add commentary, totals, or closers.',
      ].join('\n');

    case 'open_loops':
      return [
        'OUTPUT FORMAT:',
        '',
        'If CONTEXT contains at least one pending candidate, your entire answer is a bullet list, one bullet per pending item, most recent first. Each bullet has the shape:',
        '- **<where it is>** — <what is waiting, paraphrased in your own words>',
        '',
        'If CONTEXT has zero pending candidates, your entire answer is exactly this single line, with no bullets:',
        'Nothing pending I can confirm from your captures.',
        '',
        'Never produce both forms in the same answer.',
        '',
        'Examples of <where it is>: "#channel-name (Slack)", "PR #123 (GitHub)", "Thread with Maya (Slack)".',
        'Examples of <what is waiting>: "Maya asked about alert routing — reply needed", "review requested on 3-commit merge".',
        '',
        'Rules:',
        '- Never paste raw OCR text. Do not include phrases like "3 replies", channel chrome, ISO timestamps, or quotation marks around OCR snippets. Reconstruct what is happening in plain English.',
        '- The <where it is> part must include the channel name or PR identifier when CONTEXT has one (e.g. include "#sdk-warn-alerts-prod" if that channel name appears).',
        '- If you can\'t tell what is waiting for a candidate, omit that bullet.',
        '- No closers, no stats, no closing sentence, no instruction words from this template.',
      ].join('\n');

    case 'recall_event':
    case 'recall_preference':
      return [
        'OUTPUT FORMAT:',
        '',
        'When CONTEXT contains at least one matched frame:',
        '  Step 1. Locate the BEST match line in CONTEXT. It looks like: `- HH:MM AM/PM · <app> (<surface>) — "..."`.',
        '  Step 2. Copy the time and app from that exact line into your first sentence, character-for-character. Do NOT round to the nearest half hour. Do NOT change "1:20 PM" to "2:00 PM" or similar.',
        '  Step 3. Write: "<copied time> in <copied app> — <one short paraphrased clause about what was on screen>".',
        '  Step 4. Optionally follow with 1–3 short bullets, each a paraphrased detail drawn ONLY from that same matched frame.',
        '',
        'Worked example (pretend CONTEXT has the line `- 9:47 AM · Notes (mybook.app) — "..."`):',
        '  Correct first sentence: `9:47 AM in Notes — <paraphrase of that frame here>`.',
        '  WRONG: `10:00 AM in Notes — ...` (rounded the time — never do this).',
        '  WRONG: `9:30 AM in Notes — ...` (also rounded — never do this).',
        '  WRONG: `9:47 AM in Notes — review request on a 3-commit merge.` (this example sentence is a placeholder, NOT the actual content — your one-clause summary must come from the real CONTEXT, not from this example).',
        '',
        'When CONTEXT shows "no matches", "no results", or "(No tool data was gathered.)", your ENTIRE response must be exactly: `I don\'t see that in your captures.`',
        '',
        'Rules:',
        '- Every concrete fact (time, app, name, channel, message text) must appear in the CONTEXT. If it isn\'t there, do not write it.',
        '- Do NOT quote OCR verbatim or wrap matched text in quotation marks. Paraphrase the meaning in plain English.',
        '- Do NOT add a separate "Time is X PM CDT." line — the time is already in the lead sentence.',
        '- No closers, no stats, no raw search scores, no ISO timestamps.',
      ].join('\n');

    case 'project_status':
      return [
        'OUTPUT FORMAT — follow exactly:',
        '- Lead with one sentence summarising current state of the project (e.g. "You\'ve been focused on X this week, especially Y.").',
        '- Then **Recent attention** as a bullet list of the last few days with minutes.',
        '- Then **Connected to** as a one-liner naming the top 2–3 related entities (people, channels, repos).',
        '- Do NOT include closers or stats unrelated to the project.',
      ].join('\n');

    case 'people_context':
      return [
        'OUTPUT FORMAT — follow this template literally:',
        '',
        '<one sentence: what is the latest with this person, based ONLY on the LLM memory synthesis above>',
        '',
        '**Recent messages**',
        '- <app or channel> · <local time like "11:10 AM"> · <speaker>: <paraphrased substance — one short clause, NOT a verbatim OCR quote>',
        '',
        '**Commitments / todos**',
        '- <one short bullet per commitment, or "None I can confirm.">',
        '',
        '**Open loops**',
        '- <one short bullet per unresolved item, or "None I can confirm.">',
        '',
        'Rules:',
        '- Use the LLM memory synthesis above as the source of truth. Do not invent details outside it.',
        '- Use local clock times like "11:10 AM" only. Never print raw ISO timestamps with T and Z in them.',
        '- NEVER quote OCR text verbatim. Paraphrase. ("sounds good, ping me when ready" → "user acknowledged").',
        '- Distinguish the person\'s messages from the user\'s. Do not attribute a message to the person unless the synthesis says so.',
        '- Do NOT use a metadata last-seen date as the person\'s status. If no real messages exist, say you don\'t see a useful update and stop.',
        '- No closers, no frame counts, no entity paths.',
      ].join('\n');

    case 'time_audit':
      return [
        'OUTPUT FORMAT — follow this template literally, including the bold section headers and the empty lines between sections. Replace ONLY the values in <angle brackets> with numbers from CONTEXT:',
        '',
        'You spent **<total>** active today across <N> sessions.',
        '',
        '**Top apps**',
        '- <app> — <duration>',
        '- <app> — <duration>',
        '',
        '**Top focus**',
        '- <entity> — <duration>',
        '- <entity> — <duration>',
        '',
        'Use the **Top apps:** values from CONTEXT for the apps section and the **Top entities:** values for the focus section. Never merge them. Do not add a closing sentence.',
      ].join('\n');

    case 'topic_deep_dive':
      return [
        'OUTPUT FORMAT — follow exactly:',
        '- Lead with a one-paragraph synthesis of what the captures say about the topic. Do NOT repeat the synthesis as bullets below.',
        '- Then **Notable moments** as up to 5 bullets, each citing the date/time and what was happening. Each bullet must reference a different captured frame.',
        '- Then **Related entities** as a one-liner naming any related projects/channels/contacts.',
        '',
        'Rules:',
        '- Never copy planner-note language into the answer. Do not write phrases like "No matches were found", "No tool data was gathered", or "the knowledge-base search returned no page matches" — those are internal status, not facts about the topic.',
        '- Do not pad with redundant restated bullets. If you only have one matched frame, keep "Notable moments" to one bullet.',
        '- No closers, no stats.',
      ].join('\n');

    case 'general':
    default:
      return [
        'OUTPUT FORMAT — follow exactly:',
        '- Answer directly in 1–4 sentences using whatever data is in the CONTEXT block above.',
        '- If the context is empty or doesn\'t answer the question, say "I don\'t see that in your captures." and offer one specific follow-up the user could ask.',
        '- Do NOT include closers or stats.',
      ].join('\n');
  }
}

// ─────────────────────────────────────────────────────────────────────
// Frame / session formatting helpers
// ─────────────────────────────────────────────────────────────────────

function formatHistoryItem(item: ChatTurnHistoryItem): string {
  const role = item.role === 'user' ? 'User' : 'You (assistant)';
  return `${role}: ${truncate(item.content, 600)}`;
}

/**
 * Frame line formatted for an actionable list (calendar / loops /
 * search hits). We surface the time, the app/where, and a longer
 * excerpt than the generic formatter — the model needs the OCR text
 * to extract concrete meeting titles or message snippets.
 */
function formatActionableFrameLine(frame: CompactFrame): string {
  const time = shortTime(frame.timestamp);
  const where = frame.url ? hostFromUrl(frame.url) : frame.window_title || frame.app || 'unknown';
  // For garbled OCR we DROP the verbatim excerpt — small models will
  // happily quote junk text — and tag the line so the answer prompt
  // tells the model to hedge or rely on the verified frame-context
  // block instead.
  const excerpt = frame.excerpt
    ? frame.garbled
      ? ' — (OCR unreliable; defer to verified context)'
      : ` — "${truncate(frame.excerpt, 220)}"`
    : '';
  return `- ${time} · ${frame.app} (${truncate(where, 60)})${excerpt}`;
}

function formatPersonFrameLine(frame: CompactFrame): string {
  const time = shortTime(frame.timestamp);
  const where = frame.url ? hostFromUrl(frame.url) : frame.window_title || frame.app || 'unknown';
  const excerpt = frame.excerpt ? ` — "${truncate(frame.excerpt, 520)}"` : '';
  return `- ${time} · ${frame.app} (${truncate(where, 80)})${excerpt}`;
}

function formatSessionList(label: string, sessions: CompactSession[]): string {
  if (sessions.length === 0) return '';
  const lines = sessions.map(
    (s) =>
      `- ${shortTime(s.started_at)}–${shortTime(s.ended_at)} · ${s.active_min} min · ${displayEntity(s.primary_entity ?? s.primary_app ?? 'unknown')}`,
  );
  return `${label}:\n${lines.join('\n')}`;
}

function formatFrameContexts(contexts: FrameContextResult[]): string {
  // The verified-context block exists ONLY to disambiguate the anchor
  // frame's OCR (e.g. when the anchor excerpt is garbled and we want
  // to show what was on screen just before/after it). The Before /
  // After frames are NOT additional answer material — they're
  // typically the user's other activity from earlier/later in the day
  // and are unrelated to the question. Small models will happily
  // summarize them anyway, so we label the block aggressively.
  return contexts
    .map((ctx) =>
      [
        `Verified anchor context around ${ctx.anchor.app} at ${shortTime(ctx.anchor.timestamp)}:`,
        '(The "Anchor" line below is the matched frame and is the only thing relevant to the question. The Before / After frames are unrelated activity from earlier/later in the day, included only to confirm the anchor — do not summarize them or include them in your answer.)',
        ctx.before.length > 0 ? `Before (unrelated background):\n${ctx.before.map(formatActionableFrameLine).join('\n')}` : '',
        `Anchor (the actual match): ${formatActionableFrameLine(ctx.anchor)}`,
        ctx.after.length > 0 ? `After (unrelated background):\n${ctx.after.map(formatActionableFrameLine).join('\n')}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n\n');
}

function displayEntity(path: string): string {
  if (path.includes('/')) {
    const [kind, slug] = path.split('/', 2);
    return `${slug} (${kind?.replace(/s$/, '')})`;
  }
  return path;
}

function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatMinutes(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function hostFromUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
