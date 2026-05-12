import * as React from 'react';
import { AlertTriangle, Ban, Globe2, Loader2, LockKeyhole, Pause, Play, Plus, RefreshCcw, ShieldCheck, Trash2, X } from 'lucide-react';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/sonner';
import { PageHeader } from '@/components/PageHeader';
import { countByValue, parseLines, uniqueStrings } from '@/lib/collections';
import { formatBytes, formatNumber, localDayKey } from '@/lib/format';
import { domainFromUrl, normalizeDomainInput } from '@/lib/url';
import { cn } from '@/lib/utils';
import type { Frame, LoadedConfig, RuntimeOverview } from '@/global';

export function Privacy({ config, overview, onRefresh, onSaved, onOverview, onStart, onPause, onResume }: any) {
  const [recentFrames, setRecentFrames] = React.useState<Frame[]>([]), [loadingRecent, setLoadingRecent] = React.useState(false), [saving, setSaving] = React.useState(false), [deleting, setDeleting] = React.useState(false);
  const [appDraft, setAppDraft] = React.useState(''), [urlDraft, setUrlDraft] = React.useState(''), [keywordDraft, setKeywordDraft] = React.useState(''), [blurPasswordFields, setBlurPasswordFields] = React.useState(true), [pauseOnScreenLock, setPauseOnScreenLock] = React.useState(true), [purgeApp, setPurgeApp] = React.useState(''), [purgeDomain, setPurgeDomain] = React.useState('');

  React.useEffect(() => {
    if (!config) return;
    setAppDraft(config.config.capture.excluded_apps.join('\n')); setUrlDraft(config.config.capture.excluded_url_patterns.join('\n')); setKeywordDraft(config.config.capture.privacy.sensitive_keywords.join('\n')); setBlurPasswordFields(config.config.capture.privacy.blur_password_fields); setPauseOnScreenLock(config.config.capture.privacy.pause_on_screen_lock);
  }, [config]);

  const loadRecent = React.useCallback(async () => { setLoadingRecent(true); try { setRecentFrames(await window.beside.searchFrames({ day: localDayKey(), limit: 500 })); } catch { setRecentFrames([]); } finally { setLoadingRecent(false); } }, []);
  React.useEffect(() => { loadRecent(); }, [loadRecent]);

  if (!config) return <div className="flex flex-col gap-6 pt-6"><PageHeader title="Privacy" description="Loading…" /><Card><CardContent className="flex flex-col gap-4"><Skeleton className="h-16 w-full" /><Skeleton className="h-28 w-full" /><Skeleton className="h-28 w-full" /></CardContent></Card></div>;

  const captureLive = !!overview?.capture.running && !overview.capture.paused, capturePaused = !!overview?.capture.running && !!overview.capture.paused;
  const ignoredApps = parseLines(appDraft), ignoredUrls = parseLines(urlDraft), sensitiveKeywords = parseLines(keywordDraft);
  const recentApps = countByValue(recentFrames.map(f => f.app).filter(Boolean) as string[]).filter(i => !ignoredApps.includes(i.value)), recentDomains = countByValue(recentFrames.map(f => domainFromUrl(f.url)).filter(Boolean) as string[]).filter(i => !ignoredUrls.includes(i.value));

  const savePrivacy = async (next?: any) => {
    const apps = next?.apps ?? ignoredApps, urls = next?.urls ?? ignoredUrls, keywords = next?.keywords ?? sensitiveKeywords, blur = next?.blur ?? blurPasswordFields, pauseLock = next?.pauseLock ?? pauseOnScreenLock;
    setSaving(true);
    try {
      const wasRunning = overview?.status === 'running', wasPaused = !!overview?.capture.paused;
      onSaved(await window.beside.saveConfigPatch({ capture: { excluded_apps: apps, excluded_url_patterns: urls, privacy: { blur_password_fields: blur, pause_on_screen_lock: pauseLock, sensitive_keywords: keywords } } }));
      setAppDraft(apps.join('\n')); setUrlDraft(urls.join('\n')); setKeywordDraft(keywords.join('\n')); setBlurPasswordFields(blur); setPauseOnScreenLock(pauseLock);
      if (wasRunning) { let no = await window.beside.startRuntime(); if (wasPaused && !no.capture.paused) no = await window.beside.pauseCapture(); onOverview(no); }
      toast.success('Saved', { description: wasRunning ? 'Restarted.' : 'Applies next start.' });
    } catch (err: any) { toast.error('Save failed', { description: err.message }); } finally { setSaving(false); }
  };

  const deleteScope = async (scope: any) => {
    setDeleting(true);
    try { const r = await window.beside.deleteFrames(scope); toast.success('Deleted', { description: `Removed ${formatNumber(r.frames)} frames, ${r.assetPaths.length} assets.` }); setPurgeApp(''); setPurgeDomain(''); await Promise.all([loadRecent(), onRefresh()]); } catch (err: any) { toast.error('Delete failed', { description: err.message }); } finally { setDeleting(false); }
  };

  return (
    <div className="flex flex-col gap-6 pt-6 pb-12">
      <PageHeader title="Privacy" description="Control what Beside remembers." actions={<Button variant="ghost" size="sm" onClick={onRefresh}><RefreshCcw />Refresh</Button>} />
      <CaptureControl live={captureLive} paused={capturePaused} eventsToday={overview?.capture.eventsToday ?? 0} totalBytes={overview?.storage.totalAssetBytes ?? 0} onStart={onStart} onPause={onPause} onResume={onResume} />

      <Card><CardContent className="flex flex-col gap-5">
        <SectionTitle icon={<Ban />} title="Ignore Rules" description="Apps and sites skipped." />
        <div className="grid gap-4 md:grid-cols-2">
          <ListEditor label="Ignored apps" value={appDraft} onChange={setAppDraft} placeholder="One app per line" suggestions={recentApps} onAddSuggestion={(v: string) => savePrivacy({ apps: uniqueStrings([...ignoredApps, v]) })} />
          <ListEditor label="Ignored websites" value={urlDraft} onChange={setUrlDraft} placeholder="example.com" hint={<>One rule per line.</>} suggestions={recentDomains} onAddSuggestion={(v: string) => savePrivacy({ urls: uniqueStrings([...ignoredUrls, v]) })} />
        </div>
        <div className="flex justify-end"><Button onClick={() => savePrivacy()} disabled={saving}>{saving ? <Loader2 className="animate-spin" /> : <ShieldCheck />}Save ignore rules</Button></div>
      </CardContent></Card>

      <Card><CardContent className="flex flex-col gap-5">
        <SectionTitle icon={<LockKeyhole />} title="Sensitive Content" description="Skip obvious secrets." />
        <div className="flex flex-col gap-0 rounded-lg border"><ToggleRow title="Skip password fields" description="Avoid saving focused password inputs." checked={blurPasswordFields} onChange={(v: boolean) => { setBlurPasswordFields(v); savePrivacy({ blur: v }); }} /><Separator /><ToggleRow title="Pause on screen lock" description="Stop capture when locked." checked={pauseOnScreenLock} onChange={(v: boolean) => { setPauseOnScreenLock(v); savePrivacy({ pauseLock: v }); }} /></div>
        <div className="flex flex-col gap-2"><label className="text-sm font-medium">Sensitive words</label><Textarea value={keywordDraft} onChange={e => setKeywordDraft(e.currentTarget.value)} placeholder="password\napi_key" className="min-h-28" /><p className="text-xs text-muted-foreground">If visible text contains these, the event is skipped.</p></div>
        <div className="flex justify-end"><Button onClick={() => savePrivacy()} disabled={saving}>{saving ? <Loader2 className="animate-spin" /> : <ShieldCheck />}Save sensitive rules</Button></div>
      </CardContent></Card>

      <Card className="border-destructive/30 bg-destructive/5"><CardContent className="flex flex-col gap-5">
        <SectionTitle icon={<AlertTriangle />} title="Delete Stored Memory" description="Permanently purge captures." danger />
        <div className="grid gap-4 md:grid-cols-2">
          <PurgeBox icon={<Ban className="size-4" />} title="Delete by app" value={purgeApp} onChange={setPurgeApp} placeholder="Slack" confirmLabel="Delete app memory" disabled={deleting || !purgeApp.trim()} onConfirm={() => deleteScope({ app: purgeApp.trim() })} />
          <PurgeBox icon={<Globe2 className="size-4" />} title="Delete by website" value={purgeDomain} onChange={(v: string) => setPurgeDomain(normalizeDomainInput(v))} placeholder="notion.so" confirmLabel="Delete site memory" disabled={deleting || !purgeDomain.trim()} onConfirm={() => deleteScope({ urlDomain: purgeDomain.trim() })} />
        </div>
        {loadingRecent && <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3 animate-spin" />Reading recent…</div>}
      </CardContent></Card>
    </div>
  );
}

function CaptureControl({ live, paused, eventsToday, totalBytes, onStart, onPause, onResume }: any) {
  return (
    <Card><CardContent className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
      <div className="flex items-start gap-3">
        <div className={cn('grid size-10 place-items-center rounded-lg', live ? 'bg-success/15 text-success' : paused ? 'bg-warning/15 text-warning' : 'bg-muted text-muted-foreground')}><ShieldCheck className="size-5" /></div>
        <div><div className="flex items-center gap-2"><h2 className="font-semibold">Capture Guard</h2><Badge variant={live ? 'success' : paused ? 'warning' : 'muted'}>{live ? 'Capturing' : paused ? 'Paused' : 'Off'}</Badge></div><p className="mt-1 text-sm text-muted-foreground">{formatNumber(eventsToday)} moments today · {formatBytes(totalBytes)} stored locally</p></div>
      </div>
      <div className="flex gap-2">{!live && !paused && <Button onClick={onStart}><Play />Start</Button>}{live && <Button variant="outline" onClick={onPause}><Pause />Pause</Button>}{paused && <Button onClick={onResume}><Play />Resume</Button>}</div>
    </CardContent></Card>
  );
}

function SectionTitle({ icon, title, description, danger }: any) {
  return <div className="flex items-start gap-3"><div className={cn('grid size-9 shrink-0 place-items-center rounded-lg [&>svg]:size-4', danger ? 'bg-destructive/15 text-destructive' : 'bg-primary/10 text-primary')}>{icon}</div><div><h2 className={cn('font-semibold', danger && 'text-destructive')}>{title}</h2><p className="mt-0.5 text-sm text-muted-foreground">{description}</p></div></div>;
}

function ListEditor({ label, value, onChange, placeholder, hint, suggestions, onAddSuggestion }: any) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-between gap-2"><label className="text-sm font-medium">{label}</label><span className="text-xs text-muted-foreground">{parseLines(value).length} saved</span></div>
      <Textarea value={value} onChange={e => onChange(e.currentTarget.value)} placeholder={placeholder} className="min-h-36" />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {suggestions.length > 0 && <div className="flex flex-wrap gap-1.5">{suggestions.slice(0, 8).map((i: any) => <button key={i.value} type="button" onClick={() => onAddSuggestion(i.value)} className="inline-flex items-center gap-1 rounded-full border bg-background px-2.5 py-1 text-xs text-muted-foreground hover:border-primary/40 hover:text-foreground"><Plus className="size-3" />{i.value}<span className="text-muted-foreground/60">{i.count}</span></button>)}</div>}
    </div>
  );
}

function ToggleRow({ title, description, checked, onChange }: any) {
  return <div className="flex items-center justify-between gap-4 px-4 py-3"><div><div className="text-sm font-medium">{title}</div><div className="text-xs text-muted-foreground">{description}</div></div><Switch checked={checked} onCheckedChange={onChange} /></div>;
}

function PurgeBox({ icon, title, value, onChange, placeholder, confirmLabel, disabled, onConfirm }: any) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-background/60 p-4">
      <div className="flex items-center gap-2 text-sm font-medium">{icon}{title}</div>
      <div className="relative"><Input value={value} onChange={e => onChange(e.currentTarget.value)} placeholder={placeholder} className="pr-8" />{value && <button type="button" onClick={() => onChange('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"><X className="size-4" /></button>}</div>
      <AlertDialog><AlertDialogTrigger asChild><Button variant="destructive" disabled={disabled}><Trash2 />{confirmLabel}</Button></AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{confirmLabel}?</AlertDialogTitle><AlertDialogDescription>This removes all matching memory. No undo.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => onConfirm()}>Delete</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    </div>
  );
}
