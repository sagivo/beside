import * as React from 'react';
import { Copy, FolderOpen, ImageOff, Inbox, RefreshCcw, Trash2 } from 'lucide-react';
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { toast } from '@/components/ui/sonner';
import { PageHeader } from '@/components/PageHeader';
import { useFrameDetail } from '@/components/FrameDetailDialog';
import { formatLocalTime, prettyDay } from '@/lib/format';
import { listItemProps, useListKeyboardNav } from '@/lib/list-keys';
import { cacheThumbnail, thumbnailCache } from '@/lib/thumbnail-cache';
import { cn } from '@/lib/utils';
import type { ActivitySession, Frame, JournalDay } from '@/global';

export function Timeline({
  days,
  selectedDay,
  journal,
  onChooseDay,
  onRefresh,
}: {
  days: string[];
  selectedDay: string | null;
  journal: JournalDay | null;
  onChooseDay: (day: string) => void;
  onRefresh: () => void;
}) {
  const [selectedSessionId, setSelectedSessionId] = React.useState<string | null>(null);

  useListKeyboardNav();

  const sessions = journal?.sessions ?? [];
  const frames = journal?.frames ?? [];
  const sessionFrames = selectedSessionId
    ? frames.filter((f) => f.activity_session_id === selectedSessionId)
    : [];
  const visibleFrames = selectedSessionId ? sessionFrames : frames;

  async function copyDaySummary() {
    if (!journal) return;
    const summary = renderDaySummary(journal);
    await window.cofounderos.copyText(summary);
    toast.success('Day summary copied', {
      description: `${frames.length} moments · ${sessions.length} sessions`,
    });
  }

  return (
    <div className="flex flex-col gap-6 pt-6">
      <PageHeader
        title="Timeline"
        description="Browse your memories one day at a time."
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={onRefresh}>
              <RefreshCcw />
              Refresh
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void window.cofounderos.openPath('markdown')}
            >
              <FolderOpen />
              Open folder
            </Button>
          </>
        }
      />

      {days.length === 0 ? (
        <EmptyState
          icon={<Inbox className="size-10" />}
          title="No memories yet"
          description="Start capturing on the Dashboard and they'll show up here."
        />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
          <aside className="lg:sticky lg:top-6 lg:self-start">
            <div className="flex items-baseline justify-between px-1 mb-2">
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Days
              </h3>
              <span className="text-xs text-muted-foreground/70">{days.length}</span>
            </div>
            <ScrollArea className="max-h-[60vh]">
              <div className="flex flex-col gap-0.5 pr-1">
                {days
                  .slice()
                  .reverse()
                  .map((day) => (
                    <button
                      key={day}
                      type="button"
                      onClick={() => {
                        setSelectedSessionId(null);
                        onChooseDay(day);
                      }}
                      className={cn(
                        'flex items-center justify-between rounded-md px-3 py-1.5 text-sm transition-colors',
                        day === selectedDay
                          ? 'bg-accent text-accent-foreground font-medium'
                          : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                      )}
                    >
                      <span>{prettyDay(day)}</span>
                      <span className="text-xs text-muted-foreground/70 font-mono">
                        {day.slice(5)}
                      </span>
                    </button>
                  ))}
              </div>
            </ScrollArea>
          </aside>

          <div className="flex flex-col gap-6 min-w-0">
            {journal ? (
              <div className="flex flex-wrap items-baseline justify-between gap-3 border-b pb-4">
                <div>
                  <h2 className="text-xl font-semibold">{prettyDay(journal.day)}</h2>
                  <p className="text-sm text-muted-foreground">
                    {frames.length} moments · {sessions.length} work sessions
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => void copyDaySummary()}>
                    <Copy />
                    Copy summary
                  </Button>
                  <DeleteDayButton
                    day={journal.day}
                    frameCount={frames.length}
                    onDeleted={onRefresh}
                  />
                </div>
              </div>
            ) : null}

            {sessions.length > 0 && (
              <section>
                <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide mb-3">
                  Work sessions
                </h3>
                <div className="grid gap-2 sm:grid-cols-2">
                  {sessions.slice(0, 10).map((s, i) => (
                    <SessionRow
                      key={i}
                      session={s}
                      selected={selectedSessionId === s.id}
                      onClick={() =>
                        setSelectedSessionId(selectedSessionId === s.id ? null : s.id ?? null)
                      }
                    />
                  ))}
                </div>
              </section>
            )}

            <section>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
                  {selectedSessionId ? 'In this session' : 'Moments'}
                </h3>
                {selectedSessionId && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSelectedSessionId(null)}
                  >
                    Clear filter
                  </Button>
                )}
              </div>
              {visibleFrames.length === 0 ? (
                <EmptyState
                  icon={<Inbox className="size-10" />}
                  title="Nothing here yet"
                  description="Pick a day on the left to see what you worked on."
                />
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  {visibleFrames.slice(0, 60).map((frame, i) => (
                    <MomentCard key={i} frame={frame} onDeleted={onRefresh} />
                  ))}
                </div>
              )}
            </section>
          </div>
        </div>
      )}
    </div>
  );
}

function DeleteDayButton({
  day,
  frameCount,
  onDeleted,
}: {
  day: string;
  frameCount: number;
  onDeleted: () => void;
}) {
  const [pending, setPending] = React.useState(false);
  const [open, setOpen] = React.useState(false);

  async function handleDelete() {
    setPending(true);
    try {
      const result = await window.cofounderos.deleteFramesByDay(day);
      toast.success(`Deleted ${prettyDay(day)}`, {
        description: `Removed ${result.frames.toLocaleString()} moment${result.frames === 1 ? '' : 's'}.`,
      });
      setOpen(false);
      onDeleted();
    } catch (err) {
      toast.error('Could not delete day', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setPending(false);
    }
  }

  if (frameCount === 0) return null;

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:bg-destructive/10"
        >
          <Trash2 />
          Delete day
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {prettyDay(day)}?</AlertDialogTitle>
          <AlertDialogDescription>
            All {frameCount.toLocaleString()} moment{frameCount === 1 ? '' : 's'} captured on
            this day, plus their screenshots and any work-session rollups, will be removed
            permanently from this device. This can't be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              if (!pending) void handleDelete();
            }}
            disabled={pending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {pending ? 'Deleting…' : `Delete ${frameCount.toLocaleString()} moments`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function EmptyState({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center text-center py-12">
        <div className="text-muted-foreground/60 mb-3">{icon}</div>
        <h4 className="font-medium">{title}</h4>
        <p className="text-sm text-muted-foreground mt-1 max-w-sm">{description}</p>
      </CardContent>
    </Card>
  );
}

function SessionRow({
  session,
  selected,
  onClick,
}: {
  session: ActivitySession;
  selected: boolean;
  onClick: () => void;
}) {
  const start = formatLocalTime(session.started_at);
  const end = formatLocalTime(session.ended_at);
  const minutes = Math.round((session.active_ms || 0) / 60000);
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-start gap-3 rounded-lg border bg-card p-3 text-left transition-all hover:border-primary/40',
        selected && 'border-primary/60 ring-2 ring-primary/30',
      )}
    >
      <div className="font-mono text-xs text-muted-foreground shrink-0 pt-0.5">
        {start}–{end}
      </div>
      <Separator orientation="vertical" className="h-10" />
      <div className="min-w-0 flex-1">
        <h4 className="font-medium text-sm truncate">
          {session.primary_entity_path || session.primary_app || 'Mixed work'}
        </h4>
        <p className="text-xs text-muted-foreground mt-0.5">
          {minutes} active min · {session.frame_count} moments
        </p>
      </div>
    </button>
  );
}

function MomentCard({
  frame,
  onDeleted,
}: {
  frame: Frame;
  onDeleted?: () => void;
}) {
  const [thumbUrl, setThumbUrl] = React.useState<string | null>(null);
  const detail = useFrameDetail();
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

  return (
    <button
      type="button"
      onClick={() => detail.open(frame, { onDeleted: onDeleted ? () => onDeleted() : undefined })}
      {...listItemProps}
      className="group flex flex-col gap-2 rounded-lg border bg-card overflow-hidden text-left transition-all hover:border-primary/40 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
    >
      <div className="aspect-video w-full bg-muted/40 grid place-items-center overflow-hidden">
        {thumbUrl ? (
          <img
            className="w-full h-full object-cover transition-transform group-hover:scale-[1.02]"
            src={thumbUrl}
            alt=""
          />
        ) : (
          <div className="flex flex-col items-center gap-1 text-muted-foreground">
            <ImageOff className="size-6" />
            <span className="text-xs">No screenshot</span>
          </div>
        )}
      </div>
      <div className="px-3 pb-3 flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-muted-foreground">
            {formatLocalTime(frame.timestamp)}
          </span>
          <Badge variant="muted" className="truncate max-w-[140px]">
            {frame.app || 'Unknown app'}
          </Badge>
        </div>
        <div className="text-sm line-clamp-2">
          {frame.window_title ||
            frame.entity_path ||
            frame.url ||
            (frame.text
              ? String(frame.text).replace(/\s+/g, ' ').slice(0, 120)
              : 'No details')}
        </div>
      </div>
    </button>
  );
}

function renderDaySummary(journal: JournalDay): string {
  const frames = journal.frames;
  const sessions = journal.sessions;
  const apps = Array.from(
    new Set(frames.map((frame) => frame.app).filter(Boolean) as string[]),
  );
  const lines = [
    `# CofounderOS Journal — ${journal.day}`,
    '',
    `${frames.length} moment${frames.length === 1 ? '' : 's'} captured.`,
    `${sessions.length} work session${sessions.length === 1 ? '' : 's'} found.`,
  ];
  if (apps.length > 0) {
    lines.push(`Apps: ${apps.slice(0, 8).join(', ')}${apps.length > 8 ? ', …' : ''}.`);
  }
  lines.push('', '## Work sessions');
  if (sessions.length === 0) {
    lines.push('- No work sessions found yet.');
  } else {
    for (const session of sessions.slice(0, 12)) {
      const start = formatLocalTime(session.started_at);
      const end = formatLocalTime(session.ended_at);
      const label = session.primary_entity_path || session.primary_app || 'Mixed work';
      lines.push(
        `- ${start}-${end}: ${label} (${Math.round((session.active_ms || 0) / 60000)} active min, ${session.frame_count} moments)`,
      );
    }
  }
  lines.push('', '## Recent moments');
  for (const frame of frames.slice(0, 12)) {
    const time = formatLocalTime(frame.timestamp);
    const title = frame.window_title || frame.entity_path || frame.url || 'Untitled';
    lines.push(`- ${time} · ${frame.app || 'Unknown app'} · ${title}`);
  }
  return `${lines.join('\n')}\n`;
}
