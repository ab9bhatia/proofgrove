"use client";

import { Bot } from "lucide-react";
import { inputClass } from "@/components/evaluation/form-primitives";
import { FormEvent, useRef } from "react";

import { Button } from "@evalai/shared/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@evalai/shared/ui/label";

export function AgentFormDialog({
  endpoint,
  testing,
  error,
  onEndpointChange,
  onSubmit,
  onClose,
}: {
  endpoint: string;
  testing: boolean;
  error: string | null;
  onEndpointChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onClose: () => void;
}) {
  const firstFieldRef = useRef<HTMLInputElement>(null);

  return (
    <Dialog
      variant="modal"
      labelledBy="new-agent-form-title"
      describedBy="new-agent-form-hint"
      scrimLabel="Close the new agent form"
      onClose={onClose}
      initialFocusRef={firstFieldRef}
      width="w-[min(36rem,calc(100vw-2rem))]"
    >
      <div className="border-b px-6 py-5">
        <Bot aria-hidden="true" className="mb-3 size-8 rounded-lg bg-brand-green-soft p-1.5 text-brand-slate" />
        <h2 id="new-agent-form-title" className="font-display text-xl font-semibold">New agent</h2>
        <p id="new-agent-form-hint" className="mt-2 text-sm leading-6 text-muted-foreground">
          Connect an A2A-compatible endpoint. Proofgrove verifies its agent card before saving it.
        </p>
      </div>

      <form onSubmit={onSubmit} className="flex min-h-0 flex-col">
        <div className="max-h-[60vh] space-y-5 overflow-y-auto px-6 py-5">
          <div className="space-y-2">
            <Label className="text-sm font-medium" htmlFor="agent-system-endpoint">
              Agent system endpoint
            </Label>
            <Input
              className={`${inputClass} h-11`}
              ref={firstFieldRef}
              id="agent-system-endpoint"
              type="url"
              required
              value={endpoint}
              onChange={(event) => onEndpointChange(event.target.value)}
              placeholder="https://agent.example.com"
              autoComplete="url"
              aria-describedby="agent-system-endpoint-help"
            />
            <p id="agent-system-endpoint-help" className="text-xs leading-5 text-muted-foreground">
              Proofgrove checks <code>/.well-known/agent.json</code> and saves the agent only after a
              successful connection test.
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

        <div className="flex flex-wrap justify-end gap-2 border-t px-6 py-4">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={testing || !endpoint.trim()}>
            {testing ? "Testing connection…" : "Test and add"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
