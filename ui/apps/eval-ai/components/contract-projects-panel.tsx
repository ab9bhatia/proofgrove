"use client";

import { useState, useRef, type FormEventHandler } from "react";
import { Check, LoaderCircle, Plus, X } from "lucide-react";

import { Button } from "@evalai/shared/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@evalai/shared/ui/label";
import { cn } from "@evalai/shared/utils";
import type { EvaluationProject } from "@/lib/api";
import type { CatalogueLoadState } from "@/components/contract-profiles-panel";

export function ContractProjectsPanel({
  projects,
  selectedProjectId,
  createOpen,
  onSelect,
  onCreateOpenChange,
  onSubmit,
  submitting = false,
  actionsDisabled = false,
  loadState = "ready",
}: {
  projects: EvaluationProject[];
  selectedProjectId: string;
  createOpen: boolean;
  onSelect: (projectId: string) => void;
  onCreateOpenChange: (open: boolean) => void;
  onArchive?: (project: EvaluationProject) => Promise<void>;
  onSubmit: FormEventHandler<HTMLFormElement>;
  submitting?: boolean;
  actionsDisabled?: boolean;
  pendingArchiveId?: string | null;
  loadState?: CatalogueLoadState;
}) {
  return (
    <div>
      {loadState === "loading" ? (
        <div role="status" className="rounded-lg border px-4 py-8 text-center text-sm text-muted-foreground">
          Loading Projects…
        </div>
      ) : loadState === "error" ? (
        <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-4 text-sm text-destructive">
          Projects could not be loaded. Refresh to retry before creating anything.
        </div>
      ) : projects.length === 0 ? (
        <div className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
          No projects yet. Create one to continue.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <div
            aria-hidden="true"
            className="hidden grid-cols-[minmax(0,1.4fr)_minmax(0,0.8fr)_minmax(0,0.8fr)_auto] gap-4 border-b bg-muted/40 px-4 py-2.5 text-xs font-medium text-muted-foreground sm:grid"
          >
            <span>Project</span>
            <span>System type</span>
            <span>Owner</span>
            <span>Status</span>
          </div>
          <div className="divide-y" role="radiogroup" aria-label="Selected evaluation project">
            {projects.map((project) => {
              const selected = selectedProjectId === project.project_id;
              return (
                <label
                  key={project.project_id}
                  className={cn(
                    "relative grid cursor-pointer gap-2 px-4 py-3.5 text-sm transition-colors sm:grid-cols-[minmax(0,1.4fr)_minmax(0,0.8fr)_minmax(0,0.8fr)_auto] sm:items-center sm:gap-4",
                    selected ? "bg-primary/5" : "hover:bg-muted/40",
                    actionsDisabled && "cursor-not-allowed opacity-60",
                  )}
                >
                  <span className="flex min-w-0 items-center gap-2.5 font-medium">
                    {/* Full-row hit target, not a 1x1 `sr-only` input: the row is what
                        a user aims at, and a real element here carries the focus ring. */}
                    <input
                      className="peer absolute inset-0 size-full cursor-pointer appearance-none opacity-0 disabled:cursor-not-allowed"
                      type="radio"
                      name="selected-project"
                      aria-label={[project.name, project.system_type, project.status, project.owner ? `owned by ${project.owner}` : null].filter(Boolean).join(", ")}
                      value={project.project_id}
                      checked={selected}
                      disabled={actionsDisabled}
                      onChange={() => onSelect(project.project_id)}
                    />
                    <span
                      className={cn(
                        "flex size-5 shrink-0 items-center justify-center rounded-full border",
                        "peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2",
                        selected
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-muted-foreground/40 bg-background",
                      )}
                      aria-hidden="true"
                    >
                      {selected ? <Check className="size-3" strokeWidth={2.5} aria-hidden="true" /> : null}
                    </span>
                    <span className="truncate">{project.name}</span>
                  </span>
                  <span className="text-muted-foreground">{project.system_type}</span>
                  <span className="truncate text-muted-foreground">{project.owner}</span>
                  <span className="w-fit rounded-full border bg-background px-2.5 py-1 text-xs capitalize text-muted-foreground">
                    {project.status}
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      )}

      {loadState !== "error" ? (
        <div className="mt-5 flex justify-end">
          <Button type="button" onClick={() => onCreateOpenChange(true)} disabled={actionsDisabled || loadState === "loading"}>
            <Plus className="mr-2 size-4" aria-hidden="true" />
            New project
          </Button>
        </div>
      ) : null}

      {createOpen ? (
        <ProjectCreateDialog
          submitting={submitting}
          actionsDisabled={actionsDisabled}
          onClose={() => onCreateOpenChange(false)}
          onSubmit={onSubmit}
        />
      ) : null}
    </div>
  );
}

export function ProjectCreateDialog({
  submitting,
  actionsDisabled,
  onClose,
  onSubmit,
  description = "Create an evaluation scope for targets and quality controls.",
}: {
  submitting: boolean;
  actionsDisabled: boolean;
  onClose: () => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
  description?: string;
}) {
  const nameRef = useRef<HTMLInputElement>(null);
  // Native `required` stops the submit but says nothing a screen reader can
  // associate with the field it belongs to. The override-note dialog on the
  // governance page already pairs aria-invalid with a described-by message;
  // this is the same pattern, applied where the audit found it missing.
  const [fieldErrors, setFieldErrors] = useState<{ name?: string; owner?: string }>({});

  const handleSubmit: FormEventHandler<HTMLFormElement> = (event) => {
    const form = event.currentTarget;
    const data = new FormData(form);
    const errors: { name?: string; owner?: string } = {};
    if (!String(data.get("name") ?? "").trim()) errors.name = "Give the Project a name.";
    if (!String(data.get("owner") ?? "").trim()) errors.owner = "Name who owns this Project.";
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      event.preventDefault();
      (form.elements.namedItem(errors.name ? "name" : "owner") as HTMLInputElement | null)?.focus();
      return;
    }
    onSubmit(event);
  };

  return (
    <Dialog
      labelledBy="new-project-title"
      onClose={submitting ? () => undefined : onClose}
      scrimLabel="Close new project dialog"
      initialFocusRef={nameRef}
      width="w-[min(42rem,calc(100vw-2rem))]"
      className="flex-none"
    >
      <div className="flex items-start justify-between gap-4 border-b px-5 py-4 sm:px-6">
        <div className="min-w-0 flex-1">
          <h2 id="new-project-title" className="text-lg font-semibold">Create project</h2>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        </div>
        <Button type="button" variant="ghost" size="icon" aria-label="Close new project dialog" onClick={onClose} disabled={submitting}>
          <X className="size-4" aria-hidden="true" />
        </Button>
      </div>
      <form className="p-5 sm:p-6" noValidate onSubmit={handleSubmit}>
        <fieldset disabled={submitting || actionsDisabled} className="grid gap-5 sm:grid-cols-2">
          <div className="space-y-2 sm:col-span-2">
            <Label className="text-sm font-medium" htmlFor="project-name">Project name</Label>
            <Input
              ref={nameRef}
              id="project-name"
              name="name"
              required
              aria-invalid={fieldErrors.name ? true : undefined}
              aria-describedby={fieldErrors.name ? "project-name-error" : undefined}
              placeholder="Customer support evaluation"
              autoComplete="off"
            />
            {fieldErrors.name ? (
              <p id="project-name-error" role="alert" className="text-sm text-destructive">{fieldErrors.name}</p>
            ) : null}
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label className="text-sm font-medium" htmlFor="project-owner">Owner</Label>
            <Input
              id="project-owner"
              name="owner"
              required
              aria-invalid={fieldErrors.owner ? true : undefined}
              aria-describedby={fieldErrors.owner ? "project-owner-error" : undefined}
              placeholder="Team or person"
              autoComplete="off"
            />
            {fieldErrors.owner ? (
              <p id="project-owner-error" role="alert" className="text-sm text-destructive">{fieldErrors.owner}</p>
            ) : null}
          </div>
        </fieldset>
        <div className="mt-6 flex justify-end gap-3 border-t pt-5">
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button type="submit" disabled={submitting || actionsDisabled}>
            {submitting ? <LoaderCircle className="mr-2 size-4 animate-spin" aria-hidden="true" /> : <Plus className="mr-2 size-4" aria-hidden="true" />}
            {submitting ? "Creating…" : "Create project"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
