"use client";

import { FormEvent, useRef } from "react";

import { Button } from "@evalai/shared/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@evalai/shared/ui/label";
import { cn } from "@evalai/shared/utils";

import { inputClass } from "@/components/evaluation/form-primitives";

/**
 * Saving a prompt version.
 *
 * This was an accordion that expanded in place and pushed the catalog down the page,
 * behind a button whose label flipped between "New prompt" and "Close form". Writing a
 * prompt is a task you start, finish, and return from — not a region of the browsing
 * page — so it belongs in a dialog, where focus is trapped and the list you were
 * reading stays where you left it.
 */
export function PromptFormDialog({
  promptId,
  promptIdLocked = false,
  basedOnVersion,
  note,
  name,
  content,
  saving,
  error,
  onPromptIdChange,
  onNoteChange,
  onNameChange,
  onContentChange,
  onSubmit,
  onClose,
}: {
  promptId: string;
  /**
   * Opened from a prompt's own page, where the id is settled. Editing it there
   * would quietly write a different prompt than the one on screen, so the field
   * shows what is being added to and refuses input.
   */
  promptIdLocked?: boolean;
  /**
   * The version this text was loaded from, when the form was opened by editing.
   * Named in the hint because a version is never overwritten — editing produces
   * the next version, and a run citing the old one keeps resolving it.
   */
  basedOnVersion?: number;
  /** One line on what changed, stored with the version and shown in its history. */
  note: string;
  name: string;
  content: string;
  saving: boolean;
  error: string | null;
  onPromptIdChange: (value: string) => void;
  onNoteChange: (value: string) => void;
  onNameChange: (value: string) => void;
  onContentChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onClose: () => void;
}) {
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLTextAreaElement>(null);

  return (
    <Dialog
      variant="modal"
      labelledBy="new-prompt-form-title"
      describedBy="new-prompt-form-hint"
      scrimLabel="Close the new prompt form"
      onClose={onClose}
      // With the id settled there is nothing to type in the first field, so the
      // caret starts where the writing happens.
      initialFocusRef={promptIdLocked ? contentRef : firstFieldRef}
      width="w-[min(44rem,calc(100vw-2rem))]"
    >
      <div className="border-b px-5 py-4">
        <h2 id="new-prompt-form-title" className="text-base font-semibold">
          {basedOnVersion === undefined ? "New prompt version" : `Edit from version ${basedOnVersion}`}
        </h2>
        <p id="new-prompt-form-hint" className="mt-0.5 text-xs leading-5 text-muted-foreground">
          {basedOnVersion !== undefined
            ? `Saves as the next version. Version ${basedOnVersion} is left as it is, so runs that cite it still resolve it.`
            : promptIdLocked
              ? "This is added as the newest version. Nothing already saved is replaced."
              : "Saving an existing prompt id adds a version to it rather than replacing what is there."}
        </p>
      </div>

      <form onSubmit={onSubmit} className="flex min-h-0 flex-col">
        <div className="max-h-[60vh] space-y-5 overflow-y-auto px-5 py-4">
          <div className="grid gap-x-5 gap-y-5 sm:grid-cols-2">
            <div className="space-y-2">
              <Label className="text-sm font-medium" htmlFor="prompt-id">Prompt id</Label>
              <Input
                ref={firstFieldRef}
                id="prompt-id"
                value={promptId}
                onChange={(event) => onPromptIdChange(event.target.value)}
                placeholder="support-tone"
                aria-describedby="prompt-id-hint"
                // An identifier, not prose.
                spellCheck={false}
                translate="no"
                autoComplete="off"
                readOnly={promptIdLocked}
                className={promptIdLocked ? "font-mono text-xs text-muted-foreground" : undefined}
                required
              />
              <p id="prompt-id-hint" className="text-xs text-muted-foreground">
                {promptIdLocked
                  ? "The prompt this version is added to."
                  : "Letters, numbers, dots, dashes or underscores — no spaces. Saving an id that already exists adds a version to it."}
              </p>
            </div>
            <div className="space-y-2">
              <Label className="text-sm font-medium" htmlFor="prompt-name">Display name</Label>
              <Input
                id="prompt-name"
                value={name}
                onChange={(event) => onNameChange(event.target.value)}
                placeholder="Optional friendly name"
                autoComplete="off"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label className="text-sm font-medium" htmlFor="prompt-content">Prompt</Label>
            <textarea
              ref={contentRef}
              id="prompt-content"
              className={cn(inputClass, "min-h-48 resize-y font-mono text-xs leading-6")}
              value={content}
              onChange={(event) => onContentChange(event.target.value)}
              placeholder="You are a concise support agent…"
              required
            />
          </div>

          <div className="space-y-2">
            <Label className="text-sm font-medium" htmlFor="prompt-note">What changed</Label>
            <Input
              id="prompt-note"
              value={note}
              onChange={(event) => onNoteChange(event.target.value)}
              placeholder="Ask for citations"
              aria-describedby="prompt-note-hint"
              autoComplete="off"
            />
            <p id="prompt-note-hint" className="text-xs text-muted-foreground">
              Optional, but it is what the version history shows next to this version.
            </p>
          </div>

          {error ? (
            <p
              role="alert"
              className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive"
            >
              {error}
            </p>
          ) : null}
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t px-5 py-4">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={saving || !promptId.trim() || !content.trim()}>
            {saving ? "Saving…" : "Save version"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
