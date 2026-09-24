"use client";

import type { ReactNode } from "react";

import { modelSelectionId } from "@/lib/model-selection";
import { COLUMN_HEADER } from "@/lib/page-frame";
import { BrainCircuit, ChevronDown } from "lucide-react";

import { cn } from "@evalai/shared/utils";
import type { LlmCatalogEntry, LlmSource } from "@/lib/api";

export function LlmCatalogList({
  models,
  highlightedModelId = "",
  toolbar,
  footer,
}: {
  models: LlmCatalogEntry[];
  highlightedModelId?: string;
  toolbar?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
      {toolbar}
      <div className="overflow-x-auto"><div className="min-w-[700px]">
      {/* No Endpoint column: a truncated gateway URL tells you nothing about a
          model, and the full address is in Details. */}
      <div className={cn("grid grid-cols-[minmax(0,2.2fr)_minmax(0,1.2fr)_6rem] gap-4", COLUMN_HEADER)}>
        <span>Model</span>
        <span>Provider</span>
        <span className="text-right">Details</span>
      </div>

      <div role="list" aria-label="Available LLMs" className="divide-y">
        {models.map((model) => {
          const highlighted = highlightedModelId === model.model_id;
          return (
            <article
              key={modelSelectionId(model)}
              role="listitem"
              data-llm-model-id={model.model_id}
              className={cn("scroll-mt-24", highlighted && "relative z-10 ring-2 ring-primary ring-inset")}
            >
              <details className="group">
                <summary
                  aria-label={`Model details for ${model.name}`}
                  className="grid min-h-11 cursor-pointer list-none gap-4 px-4 py-4 transition-colors hover:bg-muted/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40 sm:px-5 grid-cols-[minmax(0,2.2fr)_minmax(0,1.2fr)_6rem] items-center [&::-webkit-details-marker]:hidden"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand-text dark:bg-brand/15 dark:text-brand">
                      <BrainCircuit className="size-4" aria-hidden="true" />
                    </span>
                    <div className="min-w-0">
                      <h3 className="truncate text-sm font-semibold tracking-tight" title={model.name}>
                        {model.name}
                      </h3>
                      {model.name.trim() !== model.model_id.trim() ? (
                        <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground" translate="no">
                          {model.model_id}
                        </p>
                      ) : null}
                    </div>
                  </div>

                  <div>
                    <span className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-muted-foreground sr-only">
                      Provider
                    </span>
                    <SourceLabel source={model.source} />
                  </div>

                  <span className="flex items-center gap-1 text-sm font-medium text-primary justify-end">
                    Details
                    <ChevronDown
                      aria-hidden="true"
                      className="size-4 transition-transform group-open:rotate-180"
                    />
                  </span>
                </summary>

                <div className="border-t bg-muted/20 px-4 py-4 sm:px-5">
                  <dl className="grid gap-x-6 gap-y-4 text-sm md:grid-cols-2">
                    <div className="min-w-0">
                      <dt className="text-xs font-medium text-muted-foreground">Description</dt>
                      <dd className="mt-1 leading-5">
                        {model.description?.trim() || "No description provided."}
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-xs font-medium text-muted-foreground">Endpoint</dt>
                      <dd className="mt-1 break-all font-mono text-xs leading-5" translate="no">
                        {model.endpoint?.trim() || "Managed by the platform"}
                      </dd>
                    </div>
                  </dl>
                </div>
              </details>
            </article>
          );
        })}
      </div>
      </div></div>
      {footer}
    </div>
  );
}

function sourceDisplayName(source: LlmSource) {
  return { openai: "OpenAI", ollama: "Local Ollama", compass: "OpenAI-compatible gateway", custom: "Custom endpoint" }[source];
}

function SourceLabel({ source }: { source: LlmSource }) {
  return (
    <span
      className={cn(
        "inline-flex rounded-full px-2 py-1 text-[11px] font-semibold ring-1",
        (source === "openai" || source === "compass")
          ? "bg-sky-50 text-sky-800 ring-sky-200 dark:bg-sky-950/50 dark:text-sky-300 dark:ring-sky-900"
          : "bg-state-caution-soft text-state-caution ring-state-caution/30 dark:bg-state-caution-soft dark:text-state-caution dark:ring-state-caution/30",
      )}
    >
      {sourceDisplayName(source)}
    </span>
  );
}
