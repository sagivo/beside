import * as React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cacheThumbnail, resolveAssetUrl, thumbnailCache } from '@/lib/thumbnail-cache';
import { cn } from '@/lib/utils';

export function Markdown({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
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
        {content}
      </ReactMarkdown>
    </div>
  );
}

/**
 * Renders an `<img>` from a chat-bubble markdown body. When the source
 * looks like an in-app capture asset path (relative path under the
 * storage root, e.g. `raw/2026-...`) the bytes are loaded over IPC and
 * shown inline so the local AI agent can effectively "open" a
 * screenshot in its answer the way Claude Desktop renders MCP images.
 */
function AssetImage({
  src,
  alt,
  ...rest
}: React.ImgHTMLAttributes<HTMLImageElement> & { src: string }) {
  const [resolved, setResolved] = React.useState<string | null>(null);
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
  return (
    <img
      {...rest}
      src={resolved}
      alt={alt}
      className="my-2 max-h-72 w-full rounded-md border border-border object-contain"
    />
  );
}
