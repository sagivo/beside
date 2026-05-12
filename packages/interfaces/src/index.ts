export type RawEventType = 'screenshot' | 'audio_transcript' | 'window_focus' | 'window_blur' | 'url_change' | 'click' | 'keystroke_summary' | 'idle_start' | 'idle_end' | 'app_launch' | 'app_quit' | 'clipboard_summary';

export interface RawEvent {
  id: string; timestamp: string; session_id: string; type: RawEventType; app: string; app_bundle_id: string; window_title: string; url: string | null; content: string | null; asset_path: string | null; duration_ms: number | null; idle_before_ms: number | null; screen_index: number; metadata: Record<string, unknown>; privacy_filtered: boolean; capture_plugin: string;
}

export interface CaptureStatus { running: boolean; paused: boolean; eventsToday: number; eventsLastHour?: number; storageBytesToday: number; cpuPercent: number; memoryMB: number; }

export interface CaptureConfig {
  pluginName: string; screenshot_diff_threshold: number; idle_threshold_sec: number; screenshot_format: 'webp' | 'jpeg'; screenshot_quality: number; screenshot_max_dim: number; content_change_min_interval_ms: number; jpeg_quality: number; excluded_apps: string[]; excluded_url_patterns: string[]; capture_audio: boolean; privacy: { blur_password_fields: boolean; pause_on_screen_lock: boolean; sensitive_keywords: string[]; }; poll_interval_ms: number; focus_settle_delay_ms: number; raw_root: string;
}

export type RawEventHandler = (event: RawEvent) => void | Promise<void>;
export interface ICapture { start(): Promise<void>; stop(): Promise<void>; pause(): Promise<void>; resume(): Promise<void>; onEvent(handler: RawEventHandler): void; getStatus(): CaptureStatus; getConfig(): CaptureConfig; }

export interface StorageQuery { ids?: string[]; from?: string; to?: string; types?: RawEventType[]; apps?: string[]; limit?: number; offset?: number; since_checkpoint?: string; unindexed_for_strategy?: string; unframed_only?: boolean; }

export interface Frame { id: string; timestamp: string; day: string; monitor: number; app: string; app_bundle_id: string; window_title: string; url: string | null; text: string | null; text_source: FrameTextSource | null; asset_path: string | null; perceptual_hash: string | null; trigger: string | null; session_id: string; duration_ms: number | null; entity_path: string | null; entity_kind: EntityKind | null; activity_session_id: string | null; meeting_id: string | null; source_event_ids: string[]; }
export type FrameTextSource = 'ocr' | 'accessibility' | 'ocr_accessibility' | 'audio' | 'none';
export interface FrameQuery { text?: string; embedding?: number[]; embeddingModel?: string; from?: string; to?: string; apps?: string[]; day?: string; entityPath?: string; entityKind?: EntityKind; activitySessionId?: string; urlDomain?: string; textSource?: FrameTextSource; limit?: number; offset?: number; }
export interface FrameDeleteQuery { app?: string; urlDomain?: string; }
export interface FrameEmbeddingTask { id: string; content_hash: string; content: string; }
export interface FrameSemanticMatch { frame: Frame; score: number; }

export type MemoryChunkKind = 'index_page' | 'entity_summary' | 'meeting_summary' | 'day_event' | 'fact' | 'procedure';
export interface MemoryChunk { id: string; kind: MemoryChunkKind; sourceId: string; title: string; body: string; entityPath: string | null; entityKind: EntityKind | null; day: string | null; timestamp: string | null; sourceRefs: string[]; contentHash: string; createdAt: string; updatedAt: string; }
export interface MemoryChunkQuery { text?: string; kind?: MemoryChunkKind; entityPath?: string; day?: string; from?: string; to?: string; limit?: number; offset?: number; }
export interface MemoryChunkEmbeddingTask { id: string; content_hash: string; content: string; }
export interface MemoryChunkSemanticMatch { chunk: MemoryChunk; score: number; }
export interface MemoryIndexStats { chunks: number; chunksByKind: Partial<Record<MemoryChunkKind, number>>; chunkEmbeddings: number; chunkEmbeddingsByModel: Record<string, number>; chunksMissingEmbedding: number; framesWithEmbeddings: number; framesMissingEmbeddings: number; }

export interface FrameOcrTask { id: string; asset_path: string; existing_text: string | null; existing_source: FrameTextSource | null; perceptual_hash?: string | null; }
export type FrameAssetTier = 'original' | 'compressed' | 'thumbnail' | 'deleted';
export interface FrameAsset { id: string; asset_path: string; timestamp: string; tier: FrameAssetTier; }

export type EntityKind = 'project' | 'repo' | 'meeting' | 'contact' | 'channel' | 'doc' | 'webpage' | 'app';
export interface EntityRef { kind: EntityKind; path: string; title: string; }
export interface EntityRecord extends EntityRef { firstSeen: string; lastSeen: string; totalFocusedMs: number; frameCount: number; }
export interface ListEntitiesQuery { kind?: EntityKind; limit?: number; sinceLastSeen?: string; }
export interface SearchEntitiesQuery { text: string; kind?: EntityKind; limit?: number; includeNoise?: boolean; }
export interface EntityCoOccurrence { path: string; kind: EntityKind; title: string; sharedSessions: number; sharedFocusedMs: number; lastSharedAt: string; }

export type TimelineGranularity = 'day' | 'hour';
export interface EntityTimelineBucket { bucket: string; frames: number; focusedMs: number; sessions: number; }
export interface EntityTimelineQuery { granularity?: TimelineGranularity; from?: string; to?: string; limit?: number; }

export interface ActivitySession { id: string; started_at: string; ended_at: string; day: string; duration_ms: number; active_ms: number; frame_count: number; primary_entity_path: string | null; primary_entity_kind: EntityKind | null; primary_app: string | null; entities: string[]; }
export interface ListSessionsQuery { day?: string; from?: string; to?: string; limit?: number; order?: 'recent' | 'chronological'; }

export type MeetingPlatform = 'zoom' | 'meet' | 'teams' | 'webex' | 'whereby' | 'around' | 'other';
export type MeetingSummaryStatus = 'pending' | 'running' | 'ready' | 'failed' | 'skipped_short';
export type MeetingTurnSource = 'whisper' | 'vtt' | 'srt' | 'import';
export interface MeetingTurn { id: number; meeting_id: string; t_start: string; t_end: string; speaker: string | null; text: string; visual_frame_id: string | null; source: MeetingTurnSource; }
export interface Meeting { id: string; entity_path: string; title: string | null; platform: MeetingPlatform; started_at: string; ended_at: string; day: string; duration_ms: number; frame_count: number; screenshot_count: number; audio_chunk_count: number; transcript_chars: number; content_hash: string; summary_status: MeetingSummaryStatus; summary_md: string | null; summary_json: MeetingSummaryJson | null; attendees: string[]; links: string[]; failure_reason: string | null; updated_at: string; }
export interface MeetingSummaryJson { title: string | null; tldr: string; agenda: string[]; decisions: Array<{ text: string; evidence_turn_ids: number[] }>; action_items: Array<{ owner: string | null; task: string; due: string | null; evidence_turn_ids: number[] }>; open_questions: Array<{ text: string; evidence_turn_ids: number[] }>; key_moments: Array<{ t: string; what: string; frame_id: string | null }>; attendees_seen: string[]; links_shared: string[]; notes: string | null; }
export interface ListMeetingsQuery { day?: string; from?: string; to?: string; platform?: MeetingPlatform; limit?: number; order?: 'recent' | 'chronological'; summaryStatus?: MeetingSummaryStatus; }
export interface MeetingSummaryUpdate { status: MeetingSummaryStatus; md?: string | null; json?: MeetingSummaryJson | null; contentHash?: string; failureReason?: string | null; title?: string | null; }

export type DayEventKind = 'meeting' | 'calendar' | 'communication' | 'task' | 'other';
export type DayEventSource = 'meeting_capture' | 'calendar_screen' | 'email_screen' | 'slack_screen' | 'task_screen' | 'other_screen';
export type DayEventStatus = 'pending' | 'ready' | 'failed';
export interface DayEvent { id: string; day: string; starts_at: string; ends_at: string | null; kind: DayEventKind; source: DayEventSource; title: string; source_app: string | null; context_md: string | null; attendees: string[]; links: string[]; meeting_id: string | null; evidence_frame_ids: string[]; content_hash: string; status: DayEventStatus; failure_reason: string | null; created_at: string; updated_at: string; }
export interface ListDayEventsQuery { day?: string; from?: string; to?: string; kind?: DayEventKind; limit?: number; order?: 'recent' | 'chronological'; }

export interface StorageStats { totalEvents: number; totalAssetBytes: number; oldestEvent: string | null; newestEvent: string | null; eventsByType: Record<string, number>; eventsByApp: Record<string, number>; }

export interface IStorage {
  init(): Promise<void>; write(event: RawEvent): Promise<void>; writeAsset(assetPath: string, data: Buffer): Promise<void>; readEvents(query: StorageQuery): Promise<RawEvent[]>; countEvents(query: StorageQuery): Promise<number>; readAsset(assetPath: string): Promise<Buffer>; listDays(): Promise<string[]>; getStats(): Promise<StorageStats>; isAvailable(): Promise<boolean>;
  markIndexed(strategy: string, eventIds: string[]): Promise<void>; clearIndexCheckpoint(strategy: string): Promise<void>; getIndexCheckpoint(strategy: string): Promise<string | null>; getRoot(): string;
  upsertFrame(frame: Frame): Promise<void>; searchFrames(query: FrameQuery): Promise<Frame[]>; getFrameContext(frameId: string, before: number, after: number): Promise<{ anchor: Frame; before: Frame[]; after: Frame[] } | null>; getJournal(day: string): Promise<Frame[]>; listFramesNeedingOcr(limit: number): Promise<FrameOcrTask[]>; setFrameText(frameId: string, text: string, source: Extract<FrameTextSource, 'ocr' | 'accessibility' | 'ocr_accessibility'>): Promise<void>; findOcrTextByPerceptualHash?(perceptualHash: string, excludeFrameId?: string): Promise<{ text: string; source: Extract<FrameTextSource, 'ocr' | 'accessibility' | 'ocr_accessibility'> } | null>; markFramed(eventIds: string[]): Promise<void>; resetFrameDerivatives(query?: { from?: string; to?: string }): Promise<void>;
  listFramesNeedingEmbedding(model: string, limit: number): Promise<FrameEmbeddingTask[]>; upsertFrameEmbedding(frameId: string, model: string, contentHash: string, vector: number[]): Promise<void>; upsertFrameEmbeddings?(embeddings: Array<{ frameId: string; model: string; contentHash: string; vector: number[] }>): Promise<void>; findExistingFrameEmbedding?(model: string, contentHash: string): Promise<{ vector: number[]; dims: number } | null>; findExistingFrameEmbeddings?(model: string, contentHashes: string[]): Promise<Map<string, { vector: number[]; dims: number }>>; searchFrameEmbeddings(vector: number[], query?: Omit<FrameQuery, 'text' | 'embedding' | 'embeddingModel'> & { model?: string }): Promise<FrameSemanticMatch[]>; clearFrameEmbeddings(model?: string): Promise<void>;
  replaceMemoryChunks(generatedKinds: MemoryChunkKind[], chunks: MemoryChunk[]): Promise<void>; upsertMemoryChunks(chunks: MemoryChunk[]): Promise<void>; searchMemoryChunks(query: MemoryChunkQuery): Promise<MemoryChunk[]>; listMemoryChunksNeedingEmbedding(model: string, limit: number): Promise<MemoryChunkEmbeddingTask[]>; upsertMemoryChunkEmbeddings(embeddings: Array<{ chunkId: string; model: string; contentHash: string; vector: number[] }>): Promise<void>; findExistingMemoryChunkEmbeddings?(model: string, contentHashes: string[]): Promise<Map<string, { vector: number[]; dims: number }>>; searchMemoryChunkEmbeddings(vector: number[], query?: Omit<MemoryChunkQuery, 'text'> & { model?: string }): Promise<MemoryChunkSemanticMatch[]>; getMemoryIndexStats?(model?: string): Promise<MemoryIndexStats>;
  listFramesNeedingResolution(limit: number): Promise<Frame[]>; resolveFrameToEntity(frameId: string, entity: EntityRef): Promise<void>; resolveFramesToEntities(items: ReadonlyArray<{ frameId: string; entity: EntityRef }>): Promise<void>; rebuildEntityCounts(): Promise<void>; getEntity(path: string): Promise<EntityRecord | null>; listEntities(query?: ListEntitiesQuery): Promise<EntityRecord[]>; searchEntities(query: SearchEntitiesQuery): Promise<EntityRecord[]>; getEntityFrames(path: string, limit?: number): Promise<Frame[]>; listEntityCoOccurrences(entityPath: string, limit?: number): Promise<EntityCoOccurrence[]>; getEntityTimeline(entityPath: string, query?: EntityTimelineQuery): Promise<EntityTimelineBucket[]>; reattributeFrames(input: { frameIds: string[]; fromAppPaths: string[]; target: EntityRef }): Promise<{ moved: number; refreshedEntities: string[] }>;
  listFramesForVacuum(currentTier: FrameAssetTier, olderThanIso: string, limit: number): Promise<FrameAsset[]>; updateFrameAsset(frameId: string, update: { assetPath?: string | null; tier: FrameAssetTier }): Promise<void>; deleteAssetIfUnreferenced(assetPath: string): Promise<void>; countFramesByTier(): Promise<Record<FrameAssetTier, number>>;
  upsertSession(session: ActivitySession): Promise<void>; getSession(id: string): Promise<ActivitySession | null>; listSessions(query?: ListSessionsQuery): Promise<ActivitySession[]>; listFramesNeedingSessionAssignment(limit: number): Promise<Frame[]>; assignFramesToSession(frameIds: string[], sessionId: string): Promise<void>; getSessionFrames(sessionId: string): Promise<Frame[]>; clearAllSessions(): Promise<void>;
  upsertMeeting(meeting: Meeting): Promise<void>; getMeeting(id: string): Promise<Meeting | null>; listMeetings(query?: ListMeetingsQuery): Promise<Meeting[]>; listFramesNeedingMeetingAssignment(limit: number): Promise<Frame[]>; assignFramesToMeeting(frameIds: string[], meetingId: string): Promise<void>; getMeetingFrames(meetingId: string): Promise<Frame[]>; listAudioFramesInRange(fromIso: string, toIso: string): Promise<Frame[]>; setMeetingTurns(meetingId: string, turns: Array<Omit<MeetingTurn, 'id' | 'meeting_id'>>): Promise<MeetingTurn[]>; getMeetingTurns(meetingId: string): Promise<MeetingTurn[]>; setMeetingSummary(meetingId: string, update: MeetingSummaryUpdate): Promise<void>; clearAllMeetings(): Promise<void>;
  upsertDayEvent(event: DayEvent): Promise<void>; getDayEvent(id: string): Promise<DayEvent | null>; listDayEvents(query?: ListDayEventsQuery): Promise<DayEvent[]>; deleteDayEventsBySourceForDay(day: string, source: DayEventSource): Promise<void>; clearAllDayEvents(): Promise<void>;
  deleteFrame(frameId: string): Promise<{ assetPath: string | null }>; deleteFrames(query: FrameDeleteQuery): Promise<{ frames: number; assetPaths: string[] }>; deleteAllMemory(): Promise<{ frames: number; events: number; assetBytes: number }>; runMaintenance(): Promise<{ vacuumed: boolean; analyzed: boolean }>; checkpointWal?(mode?: 'PASSIVE' | 'TRUNCATE'): Promise<void>; deleteOldData(retentionDays: number): Promise<{ frames: number; events: number; sessions: number; meetings: number; entities: number; assetPaths: string[] }>;
}

export interface ModelInfo { name: string; contextWindowTokens: number; isLocal: boolean; supportsVision: boolean; costPerMillionTokens: number; }
export interface CompletionOptions { maxTokens?: number; temperature?: number; responseFormat?: 'text' | 'json'; systemPrompt?: string; }
export type ModelBootstrapProgress = { kind: 'check'; message: string } | { kind: 'install_started'; tool: string; message?: string } | { kind: 'install_log'; line: string; progress?: boolean } | { kind: 'install_done'; tool: string } | { kind: 'install_failed'; tool: string; reason: string } | { kind: 'server_starting'; host: string } | { kind: 'server_ready'; host: string } | { kind: 'server_failed'; host: string; reason: string } | { kind: 'pull_started'; model: string; sizeHint?: string } | { kind: 'pull_progress'; model: string; status: string; completed: number; total: number; } | { kind: 'pull_done'; model: string } | { kind: 'pull_failed'; model: string; reason: string } | { kind: 'ready'; model: string };
export type ModelBootstrapHandler = (event: ModelBootstrapProgress) => void;

export interface IModelAdapter { complete(prompt: string, options?: CompletionOptions): Promise<string>; completeWithVision(prompt: string, images: Buffer[], options?: CompletionOptions): Promise<string>; completeStream?(prompt: string, options: CompletionOptions, onChunk: (chunk: string) => void): Promise<string>; embed?(texts: string[]): Promise<number[][]>; isAvailable(): Promise<boolean>; getModelInfo(): ModelInfo; unload?(): Promise<void>; ensureReady?(onProgress?: ModelBootstrapHandler, opts?: { force?: boolean }): Promise<void>; }

export interface IndexState { strategy: string; lastIncrementalRun: string | null; lastReorganisationRun: string | null; pageCount: number; eventsCovered: number; rootPath: string; }
export interface IndexPage { path: string; content: string; sourceEventIds: string[]; backlinks: string[]; lastUpdated: string; evidenceHash?: string; }
export interface ReorganisationSummary { merged: Array<{ from: string[]; into: string }>; split: Array<{ from: string; into: string[] }>; archived: string[]; newSummaryPages: string[]; reclassified: Array<{ page: string; newCategory: string }>; notes: string; }
export interface IndexUpdate { pagesToCreate: IndexPage[]; pagesToUpdate: IndexPage[]; pagesToDelete: string[]; newRootIndex: string; reorganisationNotes: string; }

export interface IIndexStrategy { readonly name: string; readonly description: string; init(rootPath: string): Promise<void>; getUnindexedEvents(storage: IStorage): Promise<RawEvent[]>; indexBatch(events: RawEvent[], currentIndex: IndexState, model: IModelAdapter): Promise<IndexUpdate>; reorganise(currentIndex: IndexState, model: IModelAdapter): Promise<IndexUpdate>; applyUpdate(update: IndexUpdate): Promise<IndexState>; getState(): Promise<IndexState>; readPage(pagePath: string): Promise<IndexPage | null>; readRootIndex(): Promise<string>; reset(): Promise<void>; }

export interface ExportStatus { name: string; running: boolean; lastSync: string | null; pendingUpdates: number; errorCount: number; }
export interface ExportServices { storage: IStorage; strategy: IIndexStrategy; model: IModelAdapter; embeddingModelName?: string; embeddingSearchWeight?: number; dataDir: string; triggerReindex: (full?: boolean) => Promise<void>; summarizeMeeting?: (meetingId: string, opts?: { force?: boolean }) => Promise<{ status: 'ok' | 'failed' | 'not_found' | 'deferred'; message?: string; }>; }
export interface IExport { readonly name: string; start(): Promise<void>; stop(): Promise<void>; onPageUpdate(page: IndexPage): Promise<void>; onPageDelete(pagePath: string): Promise<void>; onReorganisation(summary: ReorganisationSummary): Promise<void>; fullSync(index: IndexState, strategy: IIndexStrategy): Promise<void>; getStatus(): ExportStatus; bindServices?(services: ExportServices): void; }

export type PluginLayer = 'capture' | 'storage' | 'model' | 'index' | 'export';
export type PluginInterfaceName = 'ICapture' | 'IStorage' | 'IModelAdapter' | 'IIndexStrategy' | 'IExport';
export interface PluginManifest { name: string; version: string; layer: PluginLayer; interface: PluginInterfaceName; entrypoint: string; description?: string; config_schema?: Record<string, unknown>; }
export interface PluginHostContext { dataDir: string; logger: Logger; config: Record<string, unknown>; }
export type PluginFactory<T> = (context: PluginHostContext) => T | Promise<T>;

export interface Logger { debug(msg: string, ...rest: unknown[]): void; info(msg: string, ...rest: unknown[]): void; warn(msg: string, ...rest: unknown[]): void; error(msg: string, ...rest: unknown[]): void; child(scope: string): Logger; }

export interface JournalRenderOptions { assetUrlPrefix?: string; sessions?: ActivitySession[]; meetings?: Meeting[]; afkThresholdMs?: number; }

export function renderJournalMarkdown(day: string, frames: Frame[], optionsOrPrefix: JournalRenderOptions | string = {}): string {
  const o = typeof optionsOrPrefix === 'string' ? { assetUrlPrefix: optionsOrPrefix } : optionsOrPrefix, a = o.assetUrlPrefix ?? '', s = o.sessions ?? [], m = o.meetings ?? [], t = o.afkThresholdMs ?? 120000;
  if (!frames.length) return `# Journal — ${day}\n\n_No frames captured on this day._\n`;
  const l: string[] = [`# Journal — ${day}`, ''];
  if (m.length) { l.push(`## Meetings (${m.length})`, ''); m.sort((a, b) => a.started_at.localeCompare(b.started_at)).forEach(mtg => { if (mtg.summary_md?.trim()) l.push(mtg.summary_md.trim(), ''); else l.push(`- **${mtg.started_at.slice(11,16)}-${mtg.ended_at.slice(11,16)}** · [[${mtg.entity_path}]] · ${Math.max(1, Math.round(mtg.duration_ms/60000))} min · ${mtg.platform}`); }); l.push(''); }
  const ms = frames.reduce((a, f) => a + (f.duration_ms ?? 0), 0), mins = Math.round(ms / 60000), sp = [`${frames.length} frame(s) captured`];
  if (mins > 0) sp.push(`~${mins} min focused`);
  if (s.length) sp.push(`${s.length} session(s), ${Math.round(s.reduce((a, x) => a + x.active_ms, 0)/60000)} active min`);
  l.push(`_${sp.join(', ')}._`, '');

  if (s.length) {
    const fbs = new Map<string, Frame[]>(); frames.forEach(f => { const id = f.activity_session_id ?? '__loose__'; if (fbs.has(id)) fbs.get(id)!.push(f); else fbs.set(id, [f]); });
    l.push('## Timeline', '');
    let pe: string | null = null;
    s.sort((a, b) => a.started_at.localeCompare(b.started_at)).forEach(ss => {
      if (pe) { const g = Date.parse(ss.started_at) - Date.parse(pe); if (g >= t) l.push('---', `_…idle for ${Math.round(g/60000)}m…_`, ''); }
      const fs = fbs.get(ss.id) ?? [], st = ss.started_at.slice(11,16), et = ss.ended_at.slice(11,16), am = Math.max(1, Math.round(ss.active_ms/60000));
      l.push(`### ${st} – ${et} · ${ss.primary_entity_path ? `[[${ss.primary_entity_path}]]` : ss.primary_app || 'Focus'} · ${am} min active${fs.length ? ` · ${fs.length} frames` : ''}`);
      if (fs.length) { let la: string | null = null; fs.forEach(f => { if (f.app !== la) { l.push(`#### ${f.app || '(unknown)'}`); la = f.app; } const tm = f.timestamp.slice(11,19), d = f.duration_ms ? ` _(${Math.round(f.duration_ms/1000)}s)_` : '', tgt = [f.window_title ? `"${f.window_title}"` : null, f.url ? `<${f.url}>` : null].filter(Boolean).join(' · '), ep = f.entity_path ? ` → [[${f.entity_path}]]` : ''; l.push(`- **${tm}**${d} — ${tgt || '(no title)'}${ep}`); if (f.text && ['accessibility', 'audio'].includes(f.text_source!) && f.text.trim()) l.push(`  > ${f.text.trim().slice(0, 200)}...`); if (f.asset_path) l.push(`  ![](${a}${f.asset_path})`); }); }
      pe = ss.ended_at;
    });
    if (fbs.has('__loose__')) { l.push('---', '### Loose frames', `_${fbs.get('__loose__')!.length} frames_`, ''); let la: string | null = null; fbs.get('__loose__')!.forEach(f => { if (f.app !== la) { l.push(`#### ${f.app || '(unknown)'}`); la = f.app; } l.push(`- **${f.timestamp.slice(11,19)}** — ${f.window_title}`); }); }
  } else {
    l.push('## Timeline', ''); let la: string | null = null;
    frames.forEach(f => { if (f.app !== la) { l.push(`### ${f.app || '(unknown)'}`); la = f.app; } l.push(`- **${f.timestamp.slice(11,19)}** — ${f.window_title}`); });
  }
  return l.join('\n') + '\n';
}
