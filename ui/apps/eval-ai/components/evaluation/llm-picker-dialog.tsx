"use client";

import { useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";

import { Button } from "@evalai/shared/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@evalai/shared/utils";

import { modelSelectionId, findSelectedModel } from "@/lib/model-selection";
import type { LlmCatalogEntry } from "@/lib/api";

/** Where the model comes from, in the user's terms rather than the enum's. */
export function llmSourceLabel(source: LlmCatalogEntry["source"]): string {
  return source === "openai" ? "OpenAI" : source === "ollama" ? "Ollama · local" : source === "custom" ? "Custom endpoint" : "OpenAI-compatible gateway";
}

export function filterLlms(models: LlmCatalogEntry[], query: string): LlmCatalogEntry[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return models;
  return models.filter((model) =>
    [model.name, model.model_id, model.description ?? "", llmSourceLabel(model.source)]
      .join(" ")
      .toLocaleLowerCase()
      .includes(normalized),
  );
}

/**
 * Choosing the model from a table rather than a dropdown.
 *
 * The dropdown collapsed each model to `name · model_id · source` on one line, so the
 * description — the only thing distinguishing two similarly named models — never
 * appeared, and nothing confirmed the choice afterwards. Same reasoning as the dataset
 * picker beside it; the two now behave the same way.
 */
export function LlmPickerDialog({
  models,
  selectedId,
  onSelect,
  onClose,
}: {
  models: LlmCatalogEntry[];
  selectedId: string | null;
  onSelect: (model: LlmCatalogEntry) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const closeRef = useRef<HTMLButtonElement>(null);
  const shown = useMemo(() => filterLlms(models, query), [models, query]);

  return (
    <Dialog
      variant="modal"
      labelledBy="llm-picker-title"
      scrimLabel="Close model picker"
      onClose={onClose}
      initialFocusRef={closeRef}
      width="w-[min(56rem,calc(100vw-2rem))]"
    >
      <div className="flex items-start justify-between gap-4 border-b px-5 py-4">
        <div>
          <h2 id="llm-picker-title" className="text-base font-semibold">Select a model</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Choose an OpenAI model, an installed local Ollama model, or your own endpoint.
          </p>
        </div>
        <Button ref={closeRef} type="button" variant="outline" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>

      <div className="border-b px-5 py-3">
        <label className="relative block">
          <span className="sr-only">Search models</span>
          <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" aria-hidden="true" />
          <Input
            inputSize="sm"
            className="pl-9"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by name, id, or description…"
          />
        </label>
      </div>

      <div className="max-h-[55vh] overflow-y-auto">
        {shown.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-muted-foreground">
            No model matches “{query.trim()}”.
          </p>
        ) : (
          <ul className="divide-y">
            {shown.map((model) => {
              const selected = findSelectedModel(models, selectedId || "") === model;
              return (
                <li key={modelSelectionId(model)}>
                  <button
                    type="button"
                    onClick={() => onSelect(model)}
                    aria-current={selected ? "true" : undefined}
                    className={cn(
                      "flex w-full flex-col gap-1 px-5 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      selected ? "bg-brand/5" : "hover:bg-muted/30",
                    )}
                  >
                    <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <span className="text-sm font-medium">{model.name}</span>
                      {/* An identifier, not prose — machine translation would make it
                          stop matching the model the backend knows. */}
                      <code translate="no" className="font-mono text-xs text-muted-foreground">
                        {model.model_id}
                      </code>
                      <span className="text-xs text-muted-foreground">· {llmSourceLabel(model.source)}</span>
                    </span>
                    <span className="text-xs leading-5 text-muted-foreground">
                      {model.description?.trim() || "No description provided."}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
