"use client";

import { FormEvent, useRef } from "react";

import { Button } from "@evalai/shared/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@evalai/shared/ui/label";

export function LlmFormDialog({
  modelId,
  displayName,
  endpoint,
  description,
  saving,
  error,
  onModelIdChange,
  onDisplayNameChange,
  onEndpointChange,
  onDescriptionChange,
  onSubmit,
  onClose,
}: {
  modelId: string;
  displayName: string;
  endpoint: string;
  description: string;
  saving: boolean;
  error: string | null;
  onModelIdChange: (value: string) => void;
  onDisplayNameChange: (value: string) => void;
  onEndpointChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onClose: () => void;
}) {
  const firstFieldRef = useRef<HTMLInputElement>(null);

  return (
    <Dialog
      variant="modal"
      labelledBy="new-llm-form-title"
      describedBy="new-llm-form-hint"
      scrimLabel="Close the new LLM form"
      onClose={onClose}
      initialFocusRef={firstFieldRef}
      width="w-[min(44rem,calc(100vw-2rem))]"
    >
      <div className="border-b px-5 py-4">
        <h2 id="new-llm-form-title" className="text-base font-semibold">New LLM</h2>
        <p id="new-llm-form-hint" className="mt-0.5 text-xs leading-5 text-muted-foreground">
          Register an OpenAI-compatible endpoint. The model will be labelled as Custom.
        </p>
      </div>

      <form onSubmit={onSubmit} className="flex min-h-0 flex-col">
        <div className="max-h-[60vh] space-y-5 overflow-y-auto px-5 py-4">
          <div className="grid gap-x-5 gap-y-5 sm:grid-cols-2">
            <div className="space-y-2">
              <Label className="text-sm font-medium" htmlFor="llm-model-id">Model id</Label>
              <Input
                ref={firstFieldRef}
                id="llm-model-id"
                value={modelId}
                onChange={(event) => onModelIdChange(event.target.value)}
                placeholder="my-org/gpt-custom"
                autoComplete="off"
                spellCheck={false}
                required
              />
            </div>
            <div className="space-y-2">
              <Label className="text-sm font-medium" htmlFor="llm-display-name">Display name</Label>
              <Input
                id="llm-display-name"
                value={displayName}
                onChange={(event) => onDisplayNameChange(event.target.value)}
                placeholder="Optional friendly name"
                autoComplete="off"
              />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label className="text-sm font-medium" htmlFor="llm-endpoint">
                OpenAI-compatible base URL
              </Label>
              <Input
                id="llm-endpoint"
                type="url"
                value={endpoint}
                onChange={(event) => onEndpointChange(event.target.value)}
                placeholder="https://llm.example.com/v1"
                autoComplete="url"
                required
              />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label className="text-sm font-medium" htmlFor="llm-description">Description</Label>
              <Input
                id="llm-description"
                value={description}
                onChange={(event) => onDescriptionChange(event.target.value)}
                placeholder="Optional notes for evaluators"
                autoComplete="off"
              />
            </div>
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
          <Button type="submit" disabled={saving || !modelId.trim() || !endpoint.trim()}>
            {saving ? "Adding…" : "Add custom LLM"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
