"use client";

import type { ReactNode } from "react";

import { cn } from "@evalai/shared/utils";
import { COLUMN_HEADER } from "@/lib/page-frame";
import Link from "next/link";
import { ChevronRight } from "lucide-react";

import { ProductionBadge } from "@/components/status-badge";
import type { GroupedPrompt } from "@/lib/prompts";
import { leadVersion, productionVersion, promptPreview } from "@/lib/prompts";

/**
 * The prompt library, as an index.
 *
 * A prompt body runs to hundreds of words; a list needs one line per row. Every
 * attempt to show both here — clamping the text, setting it in monospace, hiding
 * the rest behind a dialog — was a workaround for a list trying to be a detail
 * view. The full text, the version history and the actions live on the prompt's
 * own page now, so a row only has to answer "which prompt is this, and is it
 * live?" well enough to pick one.
 */
export function PromptIndexList({
  prompts,
  toolbar,
  footer,
}: {
  prompts: GroupedPrompt[];
  toolbar?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
      {toolbar}
      <div className="overflow-x-auto"><div className="min-w-[700px]">
      {/* The rows were already a four-column grid; without a header they read as a
          list of cards and the columns looked incidental. Naming them is the whole
          difference between a list and a table. */}
      <div className={cn("grid grid-cols-[minmax(0,1fr)_10rem_6rem_1rem] gap-x-4", COLUMN_HEADER)}>
        <span>Prompt</span>
        <span>Production</span>
        <span>Versions</span>
        <span />
      </div>
      <ul className="divide-y">
      {prompts.map((prompt) => {
        const live = productionVersion(prompt);
        const lead = leadVersion(prompt);
        return (
          <li key={prompt.promptId}>
            <Link
              href={`/catalog/prompts/${encodeURIComponent(prompt.promptId)}`}
              // The whole row is the target. A link wrapped around the name only
              // leaves most of a row that looks clickable doing nothing.
              className="grid min-h-16 grid-cols-[minmax(0,1fr)_10rem_6rem_1rem] items-center gap-x-4 gap-y-1 px-5 py-3.5 transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <span className="min-w-0">
                <span className="flex min-w-0 flex-wrap items-baseline gap-x-2.5">
                  <span className="truncate font-medium">{prompt.name}</span>
                  <span className="truncate font-mono text-xs text-muted-foreground" translate="no">
                    {prompt.promptId}
                  </span>
                </span>
                {lead ? (
                  <span className="mt-1 block truncate text-sm leading-5 text-muted-foreground">
                    {promptPreview(lead.content)}
                  </span>
                ) : null}
              </span>

              <span className="row-start-1 justify-self-end sm:row-auto sm:justify-self-start">
                <ProductionBadge version={live} />
              </span>

              <span className="text-xs tabular-nums text-muted-foreground">
                {prompt.versions.length} {prompt.versions.length === 1 ? "version" : "versions"}
              </span>

              <ChevronRight
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
            </Link>
          </li>
        );
      })}
      </ul>
      </div></div>
      {footer}
    </div>
  );
}
