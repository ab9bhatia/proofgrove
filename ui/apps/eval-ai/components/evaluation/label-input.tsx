"use client";

import { useRef, useState } from "react";
import { X } from "lucide-react";

import { Input } from "@/components/ui/input";
import { cn } from "@evalai/shared/utils";

/** What the backend accepts: short, de-duplicated, and a bounded list. */
export const MAX_RUN_LABELS = 10;
export const MAX_RUN_LABEL_LENGTH = 64;

/**
 * Add one label to a list, or explain why it cannot be added.
 *
 * Returns the unchanged list plus a reason rather than silently dropping the input —
 * typing a duplicate and watching nothing happen reads as a broken control.
 */
export function addRunLabel(
  labels: string[],
  raw: string,
): { labels: string[]; error: string | null } {
  const value = raw.trim().replace(/\s+/g, " ");
  if (!value) return { labels, error: null };
  if (value.length > MAX_RUN_LABEL_LENGTH) {
    return { labels, error: `Labels are at most ${MAX_RUN_LABEL_LENGTH} characters.` };
  }
  if (labels.some((existing) => existing.toLocaleLowerCase() === value.toLocaleLowerCase())) {
    return { labels, error: `“${value}” is already added.` };
  }
  if (labels.length >= MAX_RUN_LABELS) {
    return { labels, error: `A run carries at most ${MAX_RUN_LABELS} labels.` };
  }
  return { labels: [...labels, value], error: null };
}

/**
 * Labels as chips rather than one free-text field.
 *
 * A run is tagged with several independent things — "baseline", "prompt tweak",
 * "release candidate" — which a single string can only join with punctuation nothing
 * downstream can split on again. Each chip is one label, so filtering later has
 * something real to match.
 */
export function RunLabelInput({
  labels,
  onChange,
  id = "run-labels",
  describedBy,
}: {
  labels: string[];
  onChange: (labels: string[]) => void;
  id?: string;
  describedBy?: string;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const errorId = `${id}-error`;

  function commit(raw: string) {
    const result = addRunLabel(labels, raw);
    setError(result.error);
    if (result.labels !== labels) {
      onChange(result.labels);
      setDraft("");
    } else if (!result.error) {
      setDraft("");
    }
  }

  function remove(label: string) {
    setError(null);
    onChange(labels.filter((existing) => existing !== label));
    inputRef.current?.focus();
  }

  return (
    <div>
      <div
        className={cn(
          "flex min-h-11 w-full flex-wrap items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2.5 text-sm outline-none transition focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/15",
          error && "border-destructive focus-within:border-destructive",
        )}
        onClick={() => inputRef.current?.focus()}
      >
        {labels.length ? (
          <ul className="flex flex-wrap gap-1.5">
            {labels.map((label) => (
              <li key={label}>
                <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 py-1 pl-2.5 pr-1 text-xs">
                  <span className="max-w-[16rem] truncate">{label}</span>
                  <button
                    type="button"
                    onClick={() => remove(label)}
                    aria-label={`Remove label ${label}`}
                    className="flex size-6 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <X className="size-3" aria-hidden="true" />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        ) : null}

        <Input
          ref={inputRef}
          inputSize="sm"
          id={id}
          name="run-labels"
          autoComplete="off"
          aria-label="Add a run label"
          aria-describedby={[describedBy, error ? errorId : null].filter(Boolean).join(" ") || undefined}
          aria-invalid={error ? true : undefined}
          value={draft}
          maxLength={MAX_RUN_LABEL_LENGTH + 1}
          placeholder="e.g. baseline v2"
          className="h-6 min-w-[12rem] flex-1 border-0 bg-transparent px-0 py-0 focus:border-transparent focus:ring-0 focus-visible:border-transparent focus-visible:ring-0"
          onChange={(event) => {
            setDraft(event.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === ",") {
              // Enter adds a label rather than submitting the setup form.
              event.preventDefault();
              commit(draft);
              return;
            }
            if (event.key === "Backspace" && !draft && labels.length) {
              event.preventDefault();
              remove(labels[labels.length - 1]!);
            }
          }}
          // Typing a label and clicking away should keep it, not discard it.
          onBlur={() => commit(draft)}
        />
      </div>

      {error ? (
        <p id={errorId} role="alert" className="mt-1 text-xs text-destructive">{error}</p>
      ) : null}
    </div>
  );
}
