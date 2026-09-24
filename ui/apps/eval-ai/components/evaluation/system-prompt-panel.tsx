"use client";

import { useState } from "react";
import { FilePlus2, Library } from "lucide-react";

import { Button } from "@evalai/shared/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@evalai/shared/utils";

import { Field, inputClass } from "@/components/evaluation/form-primitives";
import { SegmentedChoice, type SegmentedOption } from "@/components/segmented-choice";
import type { PromptVersion } from "@/lib/api";
import { promptRef } from "@/lib/prompts";

/** Which way the prompt is being supplied. One at a time. */
export type SystemPromptMode = "saved" | "custom";

const MODES: ReadonlyArray<SegmentedOption<SystemPromptMode>> = [
  { value: "saved", label: "Use a saved prompt", hint: "Pick a version from the library.", icon: Library },
  { value: "custom", label: "Write my own", hint: "Type a prompt for this run.", icon: FilePlus2 },
];

/**
 * The system-prompt step of the evaluation form.
 *
 * Presentational: every piece of load-bearing state lives in the workbench,
 * matching how `contracts/page.tsx` splits its panels. Extracted because the
 * workbench had grown past 2900 lines and this section is self-contained.
 *
 * The reference is the load-bearing prop. Starting from a saved prompt sets it
 * so the run records which version it used; editing the text clears it, so an
 * edited prompt honestly reports no reference instead of a stale one.
 *
 * Supplying the prompt is a choice between two ways, so the two ways are not
 * both on screen. A picker and a textarea shown together read as two competing
 * inputs for one value — you cannot tell which one the run will use, and the
 * pair can visibly disagree (a picker naming one prompt above a textarea holding
 * different text). The mode is asked first, and only its control renders.
 */
export function SystemPromptPanel({
  value,
  reference,
  savedPrompts,
  saving,
  canSave,
  saveError,
  onChange,
  onStartFrom,
  onSave,
  required = false,
}: {
  required?: boolean;
  value: string;
  reference: string | null;
  savedPrompts: PromptVersion[];
  saving: boolean;
  /** Whether the caller holds the role the save endpoint requires. */
  canSave: boolean;
  /** Why the last save failed, shown next to the button that failed. */
  saveError: string | null;
  onChange: (value: string) => void;
  onStartFrom: (prompt: PromptVersion) => void;
  onSave: () => void;
}) {
  // With nothing in the library there is no choice to offer, so the question is
  // not asked and writing is the only mode.
  const offerLibrary = savedPrompts.length > 0;
  const [mode, setMode] = useState<SystemPromptMode>(reference ? "saved" : "custom");
  const activeMode: SystemPromptMode = offerLibrary ? mode : "custom";
  const chosen = savedPrompts.find((prompt) => promptRef(prompt) === reference) ?? null;

  return (
    <div className="eval-setup-inset mt-4 space-y-4">
      {offerLibrary ? (
        <SegmentedChoice
          options={MODES}
          value={activeMode}
          onChange={setMode}
          label="How to supply the system prompt"
          disabled={saving}
        />
      ) : null}

      {activeMode === "saved" ? (
        <>
          <Field
            label="Saved prompt"
            hint="The run records the version it used."
            id="evaluation-saved-prompt"
            hintId="evaluation-saved-prompt-hint"
          >
            <Select
              disabled={saving}
              value={reference ?? ""}
              onValueChange={(next) => {
                const picked = savedPrompts.find((prompt) => promptRef(prompt) === next);
                if (picked) onStartFrom(picked);
              }}
            >
              <SelectTrigger
                size="sm"
                id="evaluation-saved-prompt"
                aria-describedby="evaluation-saved-prompt-hint"
              >
                <SelectValue placeholder="Choose a prompt version" />
              </SelectTrigger>
              <SelectContent>
                {savedPrompts.map((prompt) => (
                  <SelectItem
                    key={promptRef(prompt)}
                    value={promptRef(prompt)}
                    className="h-auto min-h-10 items-start whitespace-normal py-2 text-sm leading-5"
                  >
                    {prompt.name} · v{prompt.version}
                    {prompt.labels.includes("production") ? " · production" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          {/* Choosing by name alone is choosing blind — the text is the thing
              being sent, so it is shown, read-only because this mode does not
              author it. */}
          {chosen ? (
            <div>
              <p className="mb-1.5 text-xs font-medium text-muted-foreground">
                Sent before each row&apos;s question
              </p>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/20 px-3 py-2.5 font-mono text-xs leading-6">
                {chosen.content}
              </pre>
            </div>
          ) : null}
        </>
      ) : (
        <>
          <Field
            label="System prompt"
            hint={required ? "Required for this replay. Sent before the question." : "Optional. Sent before each row's question."}
            id="evaluation-system-prompt"
            hintId="evaluation-system-prompt-hint"
          >
            <textarea
              required={required}
              id="evaluation-system-prompt"
              className={cn(inputClass, "min-h-24 resize-y")}
              rows={4}
              // Locked while saving: the reference returned by the save would
              // otherwise name a version that does not contain the edited text.
              disabled={saving}
              value={value}
              placeholder="You are a concise support agent…"
              aria-describedby="evaluation-system-prompt-hint"
              onChange={(event) => onChange(event.target.value)}
            />
          </Field>

          {reference ? (
            <p className="text-xs text-muted-foreground">
              Runs will record this as{" "}
              <span className="font-medium">{reference}</span>. Editing the text
              clears that.
            </p>
          ) : null}

          {/* Saving belongs here, at the moment of intent: a catalog-only
              affordance would need a copy-paste round trip nobody makes. */}
          {canSave && value.trim() && !reference ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={saving}
                onClick={onSave}
              >
                {saving ? "Saving…" : "Save to library"}
              </Button>
              <span className="text-xs text-muted-foreground">
                Keeps this prompt so runs can name the version they used.
              </span>
            </div>
          ) : null}
        </>
      )}

      {/* Reported here rather than only in the form-wide banner, which sits far
          enough above this button to be off-screen when it is clicked. */}
      {saveError ? (
        <p role="alert" className="text-xs font-medium text-destructive">
          {saveError}
        </p>
      ) : null}
    </div>
  );
}
