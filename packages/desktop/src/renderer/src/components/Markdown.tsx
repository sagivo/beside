import * as React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { cacheThumbnail, resolveAssetUrl, thumbnailCache } from '@/lib/thumbnail-cache';
import { cn } from '@/lib/utils';

const APP_NAME_OVERRIDES: Record<string, string> = {
  vscode: 'VS Code',
  iterm: 'iTerm',
  iterm2: 'iTerm',
  macos: 'macOS',
  ios: 'iOS',
  github: 'GitHub',
  gitlab: 'GitLab',
  notion: 'Notion',
  obsidian: 'Obsidian',
  firefox: 'Firefox',
  chrome: 'Chrome',
  safari: 'Safari',
  slack: 'Slack',
  mail: 'Mail',
  zoom: 'Zoom',
};

function titleCaseSegment(s: string): string {
  if (!s) return s;
  const lower = s.toLowerCase();
  if (APP_NAME_OVERRIDES[lower]) return APP_NAME_OVERRIDES[lower];
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function humanizeEntityPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith('apps/')) {
    return titleCaseSegment(trimmed.slice(5));
  }
  if (trimmed.startsWith('channels/')) {
    return `#${trimmed.slice(9)}`;
  }
  if (trimmed.startsWith('contacts/')) {
    return trimmed
      .slice(9)
      .split('-')
      .filter(Boolean)
      .map(titleCaseSegment)
      .join(' & ');
  }
  const last = trimmed.split('/').pop() ?? trimmed;
  return last.replace(/-/g, ' ');
}

function humanizeWikiLinks(md: string): string {
  return md.replace(/\[\[([^\]\n]+)\]\]/g, (_, target) => humanizeEntityPath(String(target)));
}

export function Markdown({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  const processed = React.useMemo(() => humanizeWikiLinks(content), [content]);
  return (
    <div className={cn('text-sm leading-relaxed text-inherit', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ node: _node, ...props }) => (
            <p {...props} className="my-2 first:mt-0 last:mb-0 leading-relaxed" />
          ),
          h1: ({ node: _node, ...props }) => (
            <h1 {...props} className="mt-4 mb-2 text-base font-semibold first:mt-0" />
          ),
          h2: ({ node: _node, ...props }) => (
            <h2 {...props} className="mt-4 mb-2 text-base font-semibold first:mt-0" />
          ),
          h3: ({ node: _node, ...props }) => (
            <h3 {...props} className="mt-3 mb-1.5 text-sm font-semibold first:mt-0" />
          ),
          h4: ({ node: _node, ...props }) => (
            <h4 {...props} className="mt-3 mb-1.5 text-sm font-semibold first:mt-0" />
          ),
          ul: ({ node: _node, ...props }) => (
            <ul {...props} className="my-2 list-disc space-y-1 pl-5 marker:text-muted-foreground" />
          ),
          ol: ({ node: _node, ...props }) => (
            <ol {...props} className="my-2 list-decimal space-y-1 pl-5 marker:text-muted-foreground" />
          ),
          li: ({ node: _node, ...props }) => (
            <li {...props} className="my-0.5 leading-relaxed" />
          ),
          blockquote: ({ node: _node, ...props }) => (
            <blockquote
              {...props}
              className="my-2 border-l-2 border-border pl-3 text-muted-foreground"
            />
          ),
          hr: ({ node: _node, ...props }) => (
            <hr {...props} className="my-3 border-border" />
          ),
          a: ({ node: _node, ...props }) => (
            <a
              {...props}
              target="_blank"
              rel="noreferrer noopener"
              className="underline underline-offset-2 hover:opacity-80"
            />
          ),
          strong: ({ node: _node, ...props }) => (
            <strong {...props} className="font-semibold" />
          ),
          table: ({ node: _node, ...props }) => (
            <div className="my-3 overflow-x-auto">
              <table
                {...props}
                className="w-full border-collapse text-xs"
              />
            </div>
          ),
          thead: ({ node: _node, ...props }) => (
            <thead {...props} className="bg-muted/40" />
          ),
          th: ({ node: _node, ...props }) => (
            <th {...props} className="border border-border px-2 py-1 text-left font-medium" />
          ),
          td: ({ node: _node, ...props }) => (
            <td {...props} className="border border-border px-2 py-1 align-top" />
          ),
          code: ({ node: _node, className: cls, children, ...props }) => {
            const text = String(children ?? '');
            const isBlock = /\blanguage-/.test(cls ?? '') || text.includes('\n');
            if (isBlock) {
              return (
                <pre className="my-2 overflow-x-auto rounded-md border border-border bg-muted/40 px-3 py-2 text-xs leading-relaxed">
                  <code className={cn('font-mono whitespace-pre', cls)} {...props}>
                    {children}
                  </code>
                </pre>
              );
            }
            return (
              <code
                className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]"
                {...props}
              >
                {children}
              </code>
            );
          },
          pre: ({ children }) => <>{children}</>,
          img: ({ node: _node, src, alt, ...props }) => (
            <AssetImage src={String(src ?? '')} alt={typeof alt === 'string' ? alt : ''} {...props} />
          ),
        }}
      >
        {processed}
      </ReactMarkdown>
    </div>
  );
}

/**
 * Renders an `<img>` from markdown. When the source looks like an
 * in-app capture asset path (relative path under the storage root,
 * e.g. `raw/2026-...`) the bytes are loaded over IPC and shown inline.
 */
function AssetImage({
  src,
  alt,
  ...rest
}: React.ImgHTMLAttributes<HTMLImageElement> & { src: string }) {
  const [resolved, setResolved] = React.useState<string | null>(null);
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => {
    let cancelled = false;
    if (!src) {
      setResolved(null);
      return () => {
        cancelled = true;
      };
    }
    if (/^(?:https?:|data:|blob:|file:)/i.test(src)) {
      setResolved(src);
      return () => {
        cancelled = true;
      };
    }
    const cleaned = src.replace(/^\.\//, '');
    const cached = thumbnailCache.get(cleaned);
    if (cached) {
      setResolved(cached);
      return () => {
        cancelled = true;
      };
    }
    void (async () => {
      try {
        const url = await resolveAssetUrl(cleaned);
        if (cancelled) return;
        cacheThumbnail(cleaned, url);
        setResolved(url);
      } catch {
        if (!cancelled) setResolved(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [src]);

  if (!resolved) {
    return (
      <span className="my-2 inline-block rounded-md border border-dashed border-border px-2 py-1 text-xs text-muted-foreground">
        {alt || 'Screenshot unavailable'}
      </span>
    );
  }
  const caption = alt || 'Screenshot';
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Open ${caption} at full size`}
        className="group relative my-2 block w-full overflow-hidden rounded-md border border-border bg-background/40 transition hover:border-primary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
      >
        <img
          {...rest}
          src={resolved}
          alt={alt}
          className="max-h-72 w-full object-contain transition-transform duration-200 group-hover:scale-[1.01]"
        />
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-end gap-2 bg-gradient-to-t from-background/85 via-background/40 to-transparent px-2 py-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-foreground/80 opacity-0 transition-opacity group-hover:opacity-100"
        >
          Click to expand
        </span>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[92vw] gap-0 overflow-hidden p-0 sm:rounded-xl">
          <DialogTitle className="sr-only">{caption}</DialogTitle>
          <div className="flex max-h-[90vh] items-center justify-center bg-black/40">
            <img
              src={resolved}
              alt={alt}
              className="max-h-[90vh] w-auto max-w-full object-contain"
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
