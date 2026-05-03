import * as React from 'react';
import {
  Calendar,
  Clock,
  ExternalLink,
  FileText,
  ImageOff,
  Layers,
  Sparkles,
  Trash2,
} from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { toast } from '@/components/ui/sonner';
import { cacheThumbnail, thumbnailCache } from '@/lib/thumbnail-cache';
import { formatLocalTime, localDayKey, prettyDay } from '@/lib/format';
import type { Frame } from '@/global';

type DeleteHandler = (frame: Frame) => void | Promise<void>;

interface FrameSearchContext {
  query: string;
  explanation?: string;
}

interface FrameDetailContextValue {
  open: (frame: Frame, opts?: { onDeleted?: DeleteHandler; searchContext?: FrameSearchContext }) => void;
  close: () => void;
}

const FrameDetailContext = React.createContext<FrameDetailContextValue | null>(null);

export function FrameDetailProvider({ children }: { children: React.ReactNode }) {
  const [frame, setFrame] = React.useState<Frame | null>(null);
  const [searchContext, setSearchContext] = React.useState<FrameSearchContext | null>(null);
  // Per-open `onDeleted` callback so screens can refresh their lists when
  // a frame opened from them gets deleted. Stored in a ref so re-renders
  // don't reset the binding.
  const onDeletedRef = React.useRef<DeleteHandler | null>(null);

  const value = React.useMemo<FrameDetailContextValue>(
    () => ({
      open: (next, opts) => {
        onDeletedRef.current = opts?.onDeleted ?? null;
        setSearchContext(opts?.searchContext ?? null);
        setFrame(next);
      },
      close: () => {
        setFrame(null);
        setSearchContext(null);
      },
    }),
    [],
  );

  return (
    <FrameDetailContext.Provider value={value}>
      {children}
      <FrameDetailDialog
        frame={frame}
        searchContext={searchContext}
        onOpenChange={(open) => {
          if (!open) {
            setFrame(null);
            setSearchContext(null);
            onDeletedRef.current = null;
          }
        }}
        onDeleted={(deleted) => {
          const cb = onDeletedRef.current;
          onDeletedRef.current = null;
          setFrame(null);
          setSearchContext(null);
          if (cb) void cb(deleted);
        }}
      />
    </FrameDetailContext.Provider>
  );
}

export function useFrameDetail(): FrameDetailContextValue {
  const ctx = React.useContext(FrameDetailContext);
  if (!ctx) throw new Error('useFrameDetail must be used within <FrameDetailProvider>');
  return ctx;
}

function FrameDetailDialog({
  frame,
  searchContext,
  onOpenChange,
  onDeleted,
}: {
  frame: Frame | null;
  searchContext: FrameSearchContext | null;
  onOpenChange: (open: boolean) => void;
  onDeleted: (frame: Frame) => void;
}) {
  return (
    <Dialog open={frame !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl gap-0 overflow-hidden p-0">
        {frame ? (
          <FrameDetailBody
            frame={frame}
            searchContext={searchContext}
            onDeleted={() => onDeleted(frame)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function FrameDetailBody({
  frame,
  searchContext,
  onDeleted,
}: {
  frame: Frame;
  searchContext: FrameSearchContext | null;
  onDeleted: () => void;
}) {
  const [thumbUrl, setThumbUrl] = React.useState<string | null>(null);
  const [detailExplanation, setDetailExplanation] = React.useState<string | null>(
    searchContext?.explanation ?? null,
  );
  const [explanationLoading, setExplanationLoading] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!frame.asset_path) {
        setThumbUrl(null);
        return;
      }
      const cached = thumbnailCache.get(frame.asset_path);
      if (cached) {
        setThumbUrl(cached);
        return;
      }
      try {
        const bytes = await window.cofounderos.readAsset(frame.asset_path);
        if (cancelled) return;
        const type = frame.asset_path.endsWith('.png')
          ? 'image/png'
          : frame.asset_path.match(/\.jpe?g$/)
            ? 'image/jpeg'
            : 'image/webp';
        const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
        cacheThumbnail(frame.asset_path, url);
        setThumbUrl(url);
      } catch {
        setThumbUrl(null);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [frame.asset_path]);

  React.useEffect(() => {
    let cancelled = false;
    const query = searchContext?.query.trim();
    setDetailExplanation(searchContext?.explanation ?? null);
    if (!query || searchContext?.explanation || !frame.id) {
      setExplanationLoading(false);
      return () => {
        cancelled = true;
      };
    }
    setExplanationLoading(true);
    void (async () => {
      try {
        const explained = await window.cofounderos.explainSearchResults({
          text: query,
          frames: [frame],
        });
        if (!cancelled) setDetailExplanation(explained[0]?.explanation ?? null);
      } catch {
        if (!cancelled) setDetailExplanation(null);
      } finally {
        if (!cancelled) setExplanationLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [frame, searchContext?.explanation, searchContext?.query]);

  const title =
    frame.window_title ||
    frame.entity_path ||
    frame.url ||
    (frame.text ? String(frame.text).replace(/\s+/g, ' ').slice(0, 80) : 'Untitled moment');
  const time = formatLocalTime(frame.timestamp, { seconds: true });
  const day = frame.day || (frame.timestamp ? localDayKey(new Date(frame.timestamp)) : '');

  return (
    <div className="grid grid-cols-1 md:grid-cols-[1.4fr_1fr] max-h-[80vh]">
      <div className="bg-muted/40 grid place-items-center min-h-64 md:min-h-[480px] overflow-hidden">
        {thumbUrl ? (
          <img
            src={thumbUrl}
            alt=""
            className="w-full h-full object-contain max-h-[80vh]"
          />
        ) : (
          <div className="flex flex-col items-center gap-2 text-muted-foreground p-8">
            <ImageOff className="size-10" />
            <span className="text-sm">No screenshot available</span>
          </div>
        )}
      </div>

      <div className="flex flex-col border-l border-border min-w-0">
        <div className="px-6 pt-6 pb-3 border-b border-border">
          <DialogTitle className="text-base leading-snug line-clamp-3">{title}</DialogTitle>
          <DialogDescription className="mt-2 flex flex-wrap items-center gap-2">
            <Badge variant="muted">{frame.app || 'Unknown app'}</Badge>
            {frame.activity_session_id ? (
              <Badge variant="outline" className="font-mono text-[10px]">
                session {frame.activity_session_id.slice(0, 8)}
              </Badge>
            ) : null}
          </DialogDescription>
        </div>

        <ScrollArea className="flex-1">
          <div className="px-6 py-4 flex flex-col gap-4">
            <DetailRow icon={<Calendar />} label="Day" value={day ? prettyDay(day) : '—'} />
            <DetailRow icon={<Clock />} label="Time" value={time || '—'} />
            {frame.url ? (
              <DetailRow
                icon={<ExternalLink />}
                label="URL"
                value={
                  <a
                    href={frame.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline break-all"
                  >
                    {frame.url}
                  </a>
                }
              />
            ) : null}
            {frame.entity_path ? (
              <DetailRow
                icon={<Layers />}
                label="Entity"
                value={<span className="font-mono text-xs break-all">{frame.entity_path}</span>}
              />
            ) : null}
            {searchContext ? (
              <div>
                <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground mb-2">
                  <Sparkles className="size-3.5" />
                  <span>Search context</span>
                </div>
                <div className="rounded-md border bg-muted/40 p-3 text-sm leading-relaxed">
                  {detailExplanation || (explanationLoading ? 'Reading context from this result…' : 'No AI context available for this result yet.')}
                </div>
              </div>
            ) : null}
            {frame.text ? (
              <div>
                <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground mb-2">
                  <FileText className="size-3.5" />
                  <span>Captured text</span>
                </div>
                <div className="rounded-md border bg-muted/40 p-3 text-xs whitespace-pre-wrap break-words leading-relaxed max-h-64 overflow-auto font-mono">
                  {frame.text}
                </div>
              </div>
            ) : null}
            {frame.asset_path ? (
              <div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
                  Screenshot path
                </div>
                <div className="font-mono text-[11px] text-muted-foreground break-all">
                  {frame.asset_path}
                </div>
              </div>
            ) : null}
          </div>
        </ScrollArea>

        <div className="border-t border-border px-6 py-3 flex items-center justify-end">
          <DeleteFrameButton frame={frame} onDeleted={onDeleted} />
        </div>
      </div>
    </div>
  );
}

function DeleteFrameButton({
  frame,
  onDeleted,
}: {
  frame: Frame;
  onDeleted: () => void;
}) {
  const [pending, setPending] = React.useState(false);

  async function handleDelete() {
    if (!frame.id) {
      toast.error('Cannot delete this moment', { description: 'Missing frame id.' });
      return;
    }
    setPending(true);
    try {
      await window.cofounderos.deleteFrame(frame.id);
      toast.success('Moment deleted', {
        description: 'Removed from your memory and disk.',
      });
      onDeleted();
    } catch (err) {
      toast.error('Could not delete moment', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="sm" className="text-destructive hover:bg-destructive/10">
          <Trash2 />
          Delete
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this moment?</AlertDialogTitle>
          <AlertDialogDescription>
            The screenshot and any captured text for this frame will be removed
            permanently from this device. This can't be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => void handleDelete()}
            disabled={pending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {pending ? 'Deleting…' : 'Delete moment'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function DetailRow({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
        <span className="[&>svg]:size-3.5">{icon}</span>
        <span>{label}</span>
      </div>
      <div className="text-sm">{value}</div>
    </div>
  );
}
