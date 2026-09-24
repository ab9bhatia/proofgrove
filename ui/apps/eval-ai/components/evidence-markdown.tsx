import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@evalai/shared/utils";

export function EvidenceMarkdown({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "min-w-0 text-sm leading-7 text-foreground [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: (props) => <p className="my-3" {...props} />,
          h1: (props) => <h4 className="mb-3 mt-5 text-lg font-semibold" {...props} />,
          h2: (props) => <h5 className="mb-2 mt-5 text-base font-semibold" {...props} />,
          h3: (props) => <h6 className="mb-2 mt-4 text-sm font-semibold" {...props} />,
          h4: (props) => <p role="heading" aria-level={7} className="mb-2 mt-4 text-sm font-semibold" {...props} />,
          h5: (props) => <p role="heading" aria-level={8} className="mb-2 mt-4 text-sm font-semibold" {...props} />,
          h6: (props) => <p role="heading" aria-level={9} className="mb-2 mt-4 text-sm font-semibold" {...props} />,
          ul: (props) => <ul className="my-3 list-disc space-y-1 pl-6" {...props} />,
          ol: (props) => <ol className="my-3 list-decimal space-y-1 pl-6" {...props} />,
          li: (props) => <li className="pl-0.5" {...props} />,
          blockquote: (props) => (
            <blockquote
              className="my-3 border-l-2 border-primary/40 pl-4 text-muted-foreground"
              {...props}
            />
          ),
          hr: (props) => <hr className="my-5 border-border" {...props} />,
          a: (props) => (
            <a
              className="font-medium text-primary underline underline-offset-2 hover:opacity-80"
              target="_blank"
              rel="noreferrer noopener"
              {...props}
            />
          ),
          img: ({ alt }) => (
            <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
              {alt ? `[Image omitted: ${alt}]` : "[Image omitted]"}
            </span>
          ),
          code: ({ className: codeClassName, children, ...rest }) => {
            const isBlock = /language-/.test(codeClassName ?? "");
            if (isBlock) {
              return (
                <code className={cn("font-mono text-xs", codeClassName)} {...rest}>
                  {children}
                </code>
              );
            }
            return (
              <code
                className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em]"
                {...rest}
              >
                {children}
              </code>
            );
          },
          pre: (props) => (
            <pre
              className="my-3 overflow-x-auto rounded-lg border bg-muted/60 p-3 text-xs leading-5"
              {...props}
            />
          ),
          table: (props) => (
            <div className="my-4 overflow-x-auto rounded-lg border">
              <table aria-label="Evaluation evidence" className="w-full border-collapse text-left text-xs" {...props} />
            </div>
          ),
          thead: (props) => <thead className="bg-muted/60" {...props} />,
          th: (props) => (
            <th className="border-b border-r px-3 py-2 font-semibold last:border-r-0" {...props} />
          ),
          td: (props) => (
            <td className="border-b border-r px-3 py-2 align-top last:border-r-0" {...props} />
          ),
          strong: (props) => <strong className="font-semibold" {...props} />,
          em: (props) => <em className="italic" {...props} />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
