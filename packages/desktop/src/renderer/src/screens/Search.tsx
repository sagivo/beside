import * as React from 'react';
import { CalendarDays, Clock, ExternalLink, Globe2, ImageOff, Layers3, Mic, Search as SearchIcon, Sparkles, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PageHeader } from '@/components/PageHeader';
import { useFrameDetail } from '@/components/FrameDetailDialog';
import { formatLocalDateTime, prettyDay } from '@/lib/format';
import { listItemProps, useListKeyboardNav } from '@/lib/list-keys';
import { buildFrameSearchContext } from '@/lib/search-context';
import { cacheThumbnail, resolveAssetUrl, thumbnailCache } from '@/lib/thumbnail-cache';
import { domainFromUrl, isHttpUrl } from '@/lib/url';
import { cn } from '@/lib/utils';
import type { Frame } from '@/global';

const RECENT_KEY = 'cofounderos:recent-searches', RECENT_LIMIT = 6, EXPLANATION_LIMIT = 8, EXPLANATION_CONCURRENCY = 1, KNOWN_APPS_SAMPLE_LIMIT = 500, KNOWN_APPS_DAY_SAMPLE = 7;
const SUGGESTIONS = ['design doc', 'github pull request', 'slack message', 'meeting notes', 'pricing', 'roadmap'];

function readRecent(): string[] { try { const r = localStorage.getItem(RECENT_KEY); return r ? (JSON.parse(r) as string[]).filter(v => typeof v === 'string').slice(0, RECENT_LIMIT) : []; } catch { return []; } }
function writeRecent(items: string[]) { try { localStorage.setItem(RECENT_KEY, JSON.stringify(items.slice(0, RECENT_LIMIT))); } catch {} }

export function Search({ days, searchRequest }: { days: string[]; searchRequest?: { id: number; query: string } | null; }) {
  const [q, setQ] = React.useState(''), [appF, setAppF] = React.useState('__all__'), [dayF, setDayF] = React.useState('__all__'), [domF, setDomF] = React.useState('__all__'), [txtF, setTxtF] = React.useState('__all__');
  const [results, setResults] = React.useState<Frame[] | null>(null), [activeQ, setActiveQ] = React.useState(''), [exps, setExps] = React.useState<Record<string, string>>({}), [loading, setLoading] = React.useState(false), [searched, setSearched] = React.useState(false);
  const [knownApps, setKnownApps] = React.useState<string[]>([]), [knownDoms, setKnownDoms] = React.useState<string[]>([]), [recent, setRecent] = React.useState(() => readRecent());
  const reqRef = React.useRef<number | null>(null), runRef = React.useRef(0), fKeyRef = React.useRef('');

  useListKeyboardNav();

  React.useEffect(() => {
    let c = false;
    (async () => {
      try {
        const sDays = days.slice(-KNOWN_APPS_DAY_SAMPLE).reverse(); if (!sDays.length) return;
        const lim = Math.max(80, Math.ceil(KNOWN_APPS_SAMPLE_LIMIT / sDays.length));
        const fs = (await Promise.all(sDays.map(d => window.cofounderos.searchFrames({ day: d, limit: lim }).catch(() => [])))).flat().slice(0, KNOWN_APPS_SAMPLE_LIMIT);
        if (!c) { setKnownApps([...new Set(fs.map(f => f.app).filter(Boolean) as string[])].sort()); setKnownDoms([...new Set(fs.map(f => domainFromUrl(f.url)).filter(Boolean) as string[])].sort()); }
      } catch {}
    })();
    return () => { c = true; };
  }, [days]);

  const fKey = React.useMemo(() => JSON.stringify([dayF, appF, domF, txtF]), [appF, dayF, domF, txtF]);

  const runSearch = React.useCallback(async (txt?: string, sync = txt !== undefined) => {
    const text = txt ?? q; if (!text.trim()) { runRef.current++; fKeyRef.current = ''; setResults(null); setActiveQ(''); setExps({}); setSearched(false); return; }
    const rid = ++runRef.current; if (txt !== undefined && sync) setQ(text);
    setLoading(true); setExps({}); setActiveQ(text); setSearched(true); fKeyRef.current = fKey;
    try {
      const res = await window.cofounderos.searchFrames({ text, day: dayF !== '__all__' ? dayF : undefined, apps: appF !== '__all__' ? [appF] : undefined, urlDomain: domF !== '__all__' ? domF : undefined, textSource: txtF !== '__all__' ? txtF as any : undefined, limit: 80 });
      if (runRef.current !== rid) return; setResults(res);
      const fEx = res.slice(0, EXPLANATION_LIMIT);
      if (fEx.length) {
        (async () => {
          let i = 0; const n = async () => {
            while (runRef.current === rid && i < fEx.length) {
              const f = fEx[i++]; try { const r = (await window.cofounderos.explainSearchResults({ text, frames: [f] }))[0]; if (runRef.current === rid && r) setExps(p => ({ ...p, [r.frameId]: r.explanation })); } catch {}
            }
          };
          try { await Promise.all(Array.from({ length: Math.min(EXPLANATION_CONCURRENCY, fEx.length) }, n)); } catch { if (runRef.current === rid) setExps({}); }
        })();
      }
      setRecent(p => { const next = [text, ...p.filter(r => r.toLowerCase() !== text.toLowerCase())].slice(0, RECENT_LIMIT); writeRecent(next); return next; });
    } catch { if (runRef.current === rid) setResults([]); } finally { if (runRef.current === rid) setLoading(false); }
  }, [appF, fKey, dayF, domF, q, txtF]);

  React.useEffect(() => { if (searchRequest && reqRef.current !== searchRequest.id) { reqRef.current = searchRequest.id; runSearch(searchRequest.query); } }, [runSearch, searchRequest]);
  React.useEffect(() => { if (searched && activeQ && fKeyRef.current !== fKey) runSearch(activeQ, false); }, [activeQ, fKey, runSearch, searched]);

  const clr = () => { setRecent([]); writeRecent([]); };
  const rGrps = React.useMemo(() => results ? groupResultsByDay(results) : [], [results]);
  const aFils = [dayF !== '__all__' ? dayF : null, appF !== '__all__' ? appF : null, domF !== '__all__' ? domF : null, txtF !== '__all__' ? textSourceLabel(txtF) : null].filter(Boolean);

  return (
    <div className="flex flex-col gap-6 pt-6"><PageHeader title="Search" description="Find anything you've worked on." />
      <Card><CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[280px]"><SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" /><Input autoFocus placeholder="What were you working on…" value={q} onChange={e => setQ(e.currentTarget.value)} onKeyDown={e => e.key === 'Enter' && runSearch()} className="pl-9" /></div>
          <Button onClick={() => runSearch()} disabled={loading || !q.trim()}><SearchIcon />{loading ? 'Searching…' : 'Search'}</Button>
          {(results || q || aFils.length > 0) && <Button variant="ghost" onClick={() => { runRef.current++; fKeyRef.current = ''; setQ(''); setResults(null); setActiveQ(''); setExps({}); setSearched(false); setAppF('__all__'); setDayF('__all__'); setDomF('__all__'); setTxtF('__all__'); }}>Clear</Button>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={dayF} onValueChange={setDayF}><SelectTrigger className="w-[160px]"><SelectValue placeholder="Any day" /></SelectTrigger><SelectContent><SelectItem value="__all__">Any day</SelectItem>{days.slice().reverse().slice(0, 30).map(d => <SelectItem key={d} value={d}>{d}</SelectItem>)}</SelectContent></Select>
          {knownApps.length > 0 && <Select value={appF} onValueChange={setAppF}><SelectTrigger className="w-[160px]"><SelectValue placeholder="Any app" /></SelectTrigger><SelectContent><SelectItem value="__all__">Any app</SelectItem>{knownApps.map(a => <SelectItem key={a} value={a}>{a}</SelectItem>)}</SelectContent></Select>}
          {knownDoms.length > 0 && <Select value={domF} onValueChange={setDomF}><SelectTrigger className="w-[180px]"><SelectValue placeholder="Any website" /></SelectTrigger><SelectContent><SelectItem value="__all__">Any website</SelectItem>{knownDoms.map(d => <SelectItem key={d} value={d}>{d}</SelectItem>)}</SelectContent></Select>}
          <Select value={txtF} onValueChange={setTxtF}><SelectTrigger className="w-[150px]"><SelectValue placeholder="Any source" /></SelectTrigger><SelectContent><SelectItem value="__all__">Any source</SelectItem><SelectItem value="ocr">Screen text</SelectItem><SelectItem value="accessibility">App text</SelectItem><SelectItem value="ocr_accessibility">Screen + app</SelectItem><SelectItem value="audio">Audio</SelectItem></SelectContent></Select>
          {aFils.length > 0 && <div className="flex flex-wrap gap-1.5">{aFils.map(f => <Badge key={f} variant="muted">{f}</Badge>)}</div>}
        </div>
      </CardContent></Card>
      
      {searched && <section>{results?.length ? <><div className="mb-3 flex justify-between"><h3 className="text-sm font-medium text-muted-foreground uppercase">{results.length} result{results.length === 1 ? '' : 's'}</h3><span className="text-xs text-muted-foreground">Grouped by day</span></div><div className="flex flex-col gap-5">{rGrps.map(g => <section key={g.day} className="flex flex-col gap-2"><div className="flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground"><CalendarDays className="size-3.5" /><span>{g.label}</span><span className="font-normal normal-case">{g.frames.length} result{g.frames.length === 1 ? '' : 's'}</span></div><div className="grid gap-3 sm:grid-cols-2">{g.frames.map(f => <ResultCard key={f.id ?? `${f.timestamp}-${f.app}-${f.url}`} frame={f} searchQuery={activeQ} explanation={f.id ? exps[f.id] : undefined} onDeleted={(d: any) => setResults(p => p?.filter(x => x.id !== d.id) ?? p)} />)}</div></section>)}</div></> : <Card><CardContent className="flex flex-col items-center py-12"><Sparkles className="size-8 text-muted-foreground/60 mb-3" /><h4 className="font-medium">No matches</h4><p className="text-sm text-muted-foreground mt-1">Try a different word or broaden filters.</p></CardContent></Card>}</section>}
      
      {!searched && <Card><CardContent className="flex flex-col gap-6 py-10"><div className="flex flex-col items-center text-center gap-2"><SearchIcon className="size-8 text-muted-foreground/60" /><h4 className="font-medium">Ask your memory anything</h4><p className="text-sm text-muted-foreground max-w-md">Type a keyword, app name, or anything you saw on screen.</p></div>{recent.length > 0 && <ChipSection icon={<Clock className="size-3.5" />} label="Recent" items={recent} onPick={runSearch} onClear={clr} clearLabel="Clear history" />}<ChipSection icon={<Sparkles className="size-3.5" />} label="Try" items={SUGGESTIONS} onPick={runSearch} /></CardContent></Card>}
    </div>
  );
}

function ChipSection({ icon, label, items, onPick, onClear, clearLabel }: any) {
  if (!items.length) return null;
  return <div className="flex flex-col gap-2"><div className="flex justify-between"><div className="flex items-center gap-1.5 text-xs uppercase text-muted-foreground">{icon}<span>{label}</span></div>{onClear && <button type="button" onClick={onClear} className="flex items-center gap-1 text-xs text-muted-foreground/70 hover:text-foreground"><X className="size-3" />{clearLabel}</button>}</div><div className="flex flex-wrap gap-1.5">{items.map((i: string) => <button key={i} type="button" onClick={() => onPick(i)} className="rounded-full border bg-background px-3 py-1 text-xs font-medium hover:bg-accent">{i}</button>)}</div></div>;
}

function ResultCard({ frame, searchQuery, explanation, onDeleted }: any) {
  const [thumb, setThumb] = React.useState<string | null>(null), d = useFrameDetail(), ctx = explanation ?? buildFrameSearchContext(searchQuery, frame), dom = domainFromUrl(frame.url), src = textSourceLabel(frame.text_source);
  const open = React.useCallback(() => d.open(frame, { onDeleted, searchContext: searchQuery ? { query: searchQuery, explanation } : undefined }), [d, explanation, frame, onDeleted, searchQuery]);
  React.useEffect(() => { let c = false; const load = async () => { if (!frame.asset_path) return; const ch = thumbnailCache.get(frame.asset_path); if (ch) return setThumb(ch); try { const u = await resolveAssetUrl(frame.asset_path); if (c) return; cacheThumbnail(frame.asset_path, u); setThumb(u); } catch {} }; load(); return () => { c = true; }; }, [frame.asset_path]);

  return (
    <div className="group rounded-xl border bg-card overflow-hidden hover:border-primary/40 hover:shadow-sm">
      <div className="aspect-video w-full bg-muted/40 grid place-items-center overflow-hidden">{thumb ? <img className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform" src={thumb} alt="" /> : <div className="flex flex-col items-center gap-1 text-muted-foreground"><ImageOff className="size-6" /><span className="text-xs">No screenshot</span></div>}</div>
      <div className="p-3 flex flex-col gap-1">
        <div className="flex items-center gap-2"><span className="font-mono text-xs text-muted-foreground">{formatLocalDateTime(frame.timestamp)}</span><Badge variant="muted">{frame.app || 'Unknown app'}</Badge>{src && <Badge variant="outline">{src}</Badge>}</div>
        <div className="text-sm line-clamp-2">{frame.window_title || frame.url || (frame.text ? String(frame.text).replace(/\s+/g, ' ').slice(0, 140) : '—')}</div>
        {ctx && <div className="mt-1 flex items-start gap-1.5 rounded-lg bg-muted/50 px-2 py-1.5 text-xs text-muted-foreground"><Sparkles className="mt-0.5 size-3 shrink-0" /><span className="line-clamp-3">{ctx}</span></div>}
        <div className="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground">{dom && <span className="inline-flex items-center gap-1"><Globe2 className="size-3" /><span className="truncate">{dom}</span></span>}{frame.entity_path && <span className="inline-flex items-center gap-1"><Layers3 className="size-3" /><span className="truncate">{frame.entity_path}</span></span>}{frame.text_source === 'audio' && <span className="inline-flex items-center gap-1"><Mic className="size-3" />transcript</span>}</div>
        <div className="mt-2 flex gap-3"><button type="button" onClick={open} {...listItemProps} className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"><SearchIcon className="size-3" />Open memory</button>{isHttpUrl(frame.url) && <button type="button" onClick={() => window.cofounderos.openExternalUrl(frame.url!)} className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-primary hover:underline"><ExternalLink className="size-3" />Open source</button>}</div>
      </div>
    </div>
  );
}

function groupResultsByDay(frames: Frame[]) { const g = new Map<string, Frame[]>(); frames.forEach(f => { const d = f.day || f.timestamp?.slice(0, 10) || 'unknown'; g.set(d, [...(g.get(d) ?? []), f]); }); return Array.from(g.entries()).sort(([a], [b]) => b.localeCompare(a)).map(([d, fs]) => ({ day: d, label: d === 'unknown' ? 'Unknown day' : prettyDay(d), frames: fs })); }
function textSourceLabel(s?: string | null) { return s === 'ocr' ? 'Screen text' : s === 'accessibility' ? 'App text' : s === 'ocr_accessibility' ? 'Screen + app' : s === 'audio' ? 'Audio' : null; }
