"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, LoaderCircle, Plus, Users, X } from "lucide-react";

import { Button } from "@evalai/shared/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@evalai/shared/ui/label";
import { cn } from "@evalai/shared/utils";
import type { EvaluationProject, TargetVersion } from "@/lib/api";
import type { CatalogueLoadState } from "@/components/contract-profiles-panel";
import { SearchField } from "@/components/toolbar";

const TARGETS_PER_PAGE = 6;
const AGENTS_PER_PAGE = 5;
const selectClassName =
  "h-[60px] w-full rounded-xl border-2 border-[rgba(41,41,41,0.24)] bg-background px-4 text-base font-medium text-foreground outline-none focus:border-foreground disabled:cursor-not-allowed disabled:opacity-50";

export function ContractTargetsPanel({
  project,
  targets,
  catalogAgents,
  customOpen,
  selectedTargetVersionId,
  onSelect,
  onAddAgent,
  onCustomOpenChange,
  onSubmit,
  submitting = false,
  actionsDisabled = false,
  pendingAgentId = null,
  loadState = "ready",
  catalogLoadState = "ready",
  onRetryCatalog,
}: {
  project: EvaluationProject | null;
  targets: TargetVersion[];
  catalogAgents: TargetVersion[];
  customOpen: boolean;
  selectedTargetVersionId: string;
  onSelect: (targetVersionId: string) => void;
  onAddAgent: (agent: TargetVersion) => Promise<void>;
  onCustomOpenChange: (open: boolean) => void;
  onSubmit: (form: FormData) => void;
  submitting?: boolean;
  actionsDisabled?: boolean;
  pendingAgentId?: string | null;
  loadState?: CatalogueLoadState;
  catalogLoadState?: CatalogueLoadState;
  onRetryCatalog?: () => void;
}) {
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(targets.length / TARGETS_PER_PAGE));
  const currentPage = Math.min(page, pageCount);
  const visibleTargets = targets.slice((currentPage - 1) * TARGETS_PER_PAGE, currentPage * TARGETS_PER_PAGE);

  return (
    <div>
      {project ? (
        <p className="mb-3 text-sm text-muted-foreground">
          Available for <span className="font-medium text-foreground">{project.name}</span>.
        </p>
      ) : null}
      {project ? (
        <div className="mb-4 rounded-lg border border-evalai-purple/25 border-l-4 border-l-evalai-purple bg-brand-purple-soft/30 px-3.5 py-2.5 text-sm text-foreground">
          <strong className="font-semibold">Registering a new target changes this Project permanently.</strong>{" "}
          Existing targets can be selected without changing Project configuration.
        </div>
      ) : null}

      {loadState === "loading" ? (
        <div role="status" className="rounded-lg border px-4 py-8 text-center text-sm text-muted-foreground">
          Loading targets…
        </div>
      ) : loadState === "error" ? (
        <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-4 text-sm text-destructive">
          Targets could not be loaded. Refresh to retry before registering another target.
        </div>
      ) : !project ? (
        <div className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
          Select a project before choosing a target.
        </div>
      ) : targets.length === 0 ? (
        <div className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
          No registered targets yet. Register a custom endpoint to continue.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <div className="divide-y" role="radiogroup" aria-label="Selected evaluation target">
            {visibleTargets.map((target) => {
              const selected = selectedTargetVersionId === target.target_version_id;
              const identity = [target.name, target.target_type.replace("_", " "), target.environment, target.model_version || target.version].filter(Boolean).join(", ");
              return (
                <div key={target.target_version_id} className="max-w-full">
                  <label
                    className={cn(
                      "relative grid cursor-pointer grid-cols-1 gap-3 px-4 py-3.5 text-sm transition-colors md:grid-cols-[minmax(0,1.3fr)_minmax(0,0.8fr)_minmax(0,1fr)] md:items-center md:gap-4",
                      selected ? "bg-primary/5" : "hover:bg-muted/40",
                      actionsDisabled && "cursor-not-allowed opacity-60",
                    )}
                  >
                    <span className="flex min-w-0 items-start gap-2.5">
                      <input
                        className="peer absolute inset-0 size-full cursor-pointer appearance-none opacity-0 disabled:cursor-not-allowed"
                        type="radio"
                        name="selected-target"
                        aria-label={identity}
                        value={target.target_version_id}
                        checked={selected}
                        disabled={actionsDisabled}
                        onChange={() => onSelect(target.target_version_id)}
                      />
                      <span className={cn("mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border", "peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2", selected ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40 bg-background")} aria-hidden="true">
                        {selected ? <Check className="size-3" strokeWidth={2.5} aria-hidden="true" /> : null}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{target.name}</span>
                        {/* Type and environment are separate elements, not one joined
                            string: they are the two things a user scans a target list for,
                            and each has to be independently readable. */}
                        <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                          <span className="capitalize">{target.target_type.replace("_", " ")}</span>
                          <span aria-hidden="true">·</span>
                          <span>{target.environment}</span>
                        </span>
                      </span>
                    </span>
                    <span className="text-xs text-muted-foreground">Version {target.version}</span>
                    <span className="min-w-0 truncate text-xs text-muted-foreground">{[target.model_version, target.prompt_version].filter(Boolean).join(" · ") || "Configuration not reported"}</span>
                  </label>
                  {/* Outside the label on purpose. Machine identifiers belong behind a
                      disclosure, and opening one must never mean choosing the target. */}
                  <TargetTechnicalDetails endpoint={target.endpoint} targetId={target.target_id} />
                </div>
              );
            })}
          </div>
          {targets.length > TARGETS_PER_PAGE ? (
            <Pagination
              label={`${(currentPage - 1) * TARGETS_PER_PAGE + 1}–${Math.min(currentPage * TARGETS_PER_PAGE, targets.length)} of ${targets.length} targets`}
              currentPage={currentPage}
              pageCount={pageCount}
              previousLabel="Previous targets"
              nextLabel="Next targets"
              onPrevious={() => setPage((value) => Math.max(1, value - 1))}
              onNext={() => setPage((value) => Math.min(pageCount, value + 1))}
            />
          ) : null}
        </div>
      )}

      {loadState !== "error" ? (
        <div className="mt-5 flex flex-wrap justify-end gap-3">
          <Button type="button" variant="outline" onClick={() => onCustomOpenChange(true)} disabled={!project || actionsDisabled || loadState === "loading"}>
            <Plus className="mr-2 size-4" aria-hidden="true" />Register custom endpoint
          </Button>
          <Button type="button" variant="outline" onClick={() => setCatalogOpen(true)} disabled={!project || actionsDisabled}>
            <Users className="mr-2 size-4" aria-hidden="true" />Add from Agent Catalog
          </Button>
        </div>
      ) : null}

      {customOpen && project ? (
        <CustomTargetDialog project={project} submitting={submitting} actionsDisabled={actionsDisabled} onClose={() => onCustomOpenChange(false)} onSubmit={onSubmit} />
      ) : null}
      {catalogOpen ? (
        <AgentTargetDialog
          agents={catalogAgents}
          targets={targets}
          pendingAgentId={pendingAgentId}
          actionsDisabled={actionsDisabled}
          loadState={catalogLoadState}
          onRetry={onRetryCatalog}
          onAddAgent={onAddAgent}
          onClose={() => setCatalogOpen(false)}
          projectName={project?.name ?? "this Project"}
        />
      ) : null}
    </div>
  );
}

export function CustomTargetDialog({ project, submitting, actionsDisabled, onClose, onSubmit }: {
  project: EvaluationProject;
  submitting: boolean;
  actionsDisabled: boolean;
  onClose: () => void;
  onSubmit: (form: FormData) => void;
}) {
  const nameRef = useRef<HTMLInputElement>(null);
  const pendingForm = useRef<FormData | null>(null);
  const submitRef = useRef<HTMLButtonElement>(null);
  const confirmationCancelRef = useRef<HTMLButtonElement>(null);
  const [confirming, setConfirming] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    if (confirming) confirmationCancelRef.current?.focus();
  }, [confirming]);
  const cancelConfirmation = () => {
    setConfirming(false);
    window.requestAnimationFrame(() => submitRef.current?.focus());
  };
  return (
    <Dialog
      labelledBy={confirming ? "custom-target-confirmation-title" : "custom-target-dialog-title"}
      onClose={submitting ? () => undefined : confirming ? cancelConfirmation : onClose}
      scrimLabel={confirming ? "Cancel target registration confirmation" : "Close custom endpoint dialog"}
      initialFocusRef={nameRef}
      width={confirming ? "max-w-md" : "max-w-3xl"}
    >
      {confirming ? (
        <TargetConfirmationContent
          titleId="custom-target-confirmation-title"
          title="Register target permanently?"
          description={`This target remains on ${project.name} even if you abandon this Assignment.`}
          cancelRef={confirmationCancelRef}
          cancelLabel="Cancel"
          confirmLabel="Register target"
          pendingLabel="Registering…"
          pending={submitting}
          onCancel={cancelConfirmation}
          onConfirm={() => {
            setConfirming(false);
            if (pendingForm.current) onSubmit(pendingForm.current);
            pendingForm.current = null;
          }}
        />
      ) : <>
        <div className="flex items-start justify-between gap-4 border-b px-5 py-4 sm:px-6">
        <div><h2 id="custom-target-dialog-title" className="text-lg font-semibold">Register custom endpoint</h2><p className="mt-1 text-sm text-muted-foreground">Registers permanently on {project.name}.</p></div>
        <Button type="button" variant="ghost" size="icon" aria-label="Close custom endpoint dialog" onClick={onClose} disabled={submitting}><X className="size-4" aria-hidden="true" /></Button>
        </div>
        <form
        className="grid gap-5 p-5 md:grid-cols-2 sm:p-6"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          // Native `required` blocks the submit without telling a screen reader
          // which field is at fault. Validate here so each field can carry its
          // own message and aria-invalid, matching the override-note dialog.
          const missing = REQUIRED_TARGET_FIELDS.filter(
            ([field]) => !String(data.get(field) ?? "").trim(),
          );
          setFieldErrors(Object.fromEntries(missing));
          if (missing.length > 0) {
            const [firstField] = missing[0]!;
            (event.currentTarget.elements.namedItem(firstField) as HTMLElement | null)?.focus();
            return;
          }
          pendingForm.current = data;
          setConfirming(true);
        }}
      >
        <fieldset disabled={submitting || actionsDisabled} className="contents">
          <TargetField error={fieldErrors.name} id="target-name" label="Target name"><Input ref={nameRef} id="target-name" name="name" aria-invalid={fieldErrors.name ? true : undefined} aria-describedby={fieldErrors.name ? "target-name-error" : undefined} required /></TargetField>
          <TargetField error={fieldErrors.target_id} id="target-id" label="Target ID"><Input id="target-id" name="target_id" aria-invalid={fieldErrors.target_id ? true : undefined} aria-describedby={fieldErrors.target_id ? "target-id-error" : undefined} required /></TargetField>
          <TargetField error={fieldErrors.version} id="target-version" label="Version"><Input id="target-version" name="version" aria-invalid={fieldErrors.version ? true : undefined} aria-describedby={fieldErrors.version ? "target-version-error" : undefined} defaultValue="1.0.0" required /></TargetField>
          <TargetField id="target-type" label="Target type"><select id="target-type" name="target_type" className={cn("select-chevron pr-9", selectClassName)}><option value="agent">Agent</option><option value="application">Application</option><option value="rag_system">RAG system</option><option value="endpoint">Endpoint</option></select></TargetField>
          <TargetField error={fieldErrors.endpoint} id="target-endpoint" label="Gateway or endpoint URL"><Input id="target-endpoint" name="endpoint" aria-invalid={fieldErrors.endpoint ? true : undefined} aria-describedby={fieldErrors.endpoint ? "target-endpoint-error" : undefined} type="url" required /></TargetField>
          <TargetField error={fieldErrors.environment} id="target-environment" label="Environment"><Input id="target-environment" name="environment" aria-invalid={fieldErrors.environment ? true : undefined} aria-describedby={fieldErrors.environment ? "target-environment-error" : undefined} defaultValue="dev" required /></TargetField>
          <TargetField id="target-model-version" label="Model version"><Input id="target-model-version" name="model_version" /></TargetField>
          <TargetField id="target-prompt-version" label="Prompt version"><Input id="target-prompt-version" name="prompt_version" /></TargetField>
        </fieldset>
        <div className="flex justify-end gap-3 border-t pt-5 md:col-span-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button ref={submitRef} type="submit" disabled={submitting || actionsDisabled}>{submitting ? <LoaderCircle className="mr-2 size-4 animate-spin" aria-hidden="true" /> : <Plus className="mr-2 size-4" aria-hidden="true" />}{submitting ? "Registering target…" : "Register target version"}</Button>
        </div>
        </form>
      </>}
    </Dialog>
  );
}

/**
 * Endpoints, target IDs and cluster addresses are what an operator needs when something
 * breaks and noise the other 95% of the time. Behind a disclosure, with a copy action,
 * so the row stays readable without losing the values.
 */
function TargetTechnicalDetails({ endpoint, targetId }: { endpoint: string; targetId: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <details className="max-w-full border-t border-dashed px-4 py-2 text-xs text-muted-foreground">
      <summary className="cursor-pointer rounded py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        Technical details
      </summary>
      <dl className="mt-2 grid gap-2 pb-1">
        <div className="min-w-0">
          <dt className="font-medium text-foreground">Target ID</dt>
          <dd className="truncate font-mono">{targetId}</dd>
        </div>
        <div className="min-w-0">
          <dt className="font-medium text-foreground">Endpoint</dt>
          <dd className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate font-mono">{endpoint}</span>
            <button
              type="button"
              className="shrink-0 rounded-full border px-2.5 py-1 text-xs transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => {
                void navigator.clipboard?.writeText(endpoint).then(() => setCopied(true)).catch(() => setCopied(false));
              }}
            >
              {copied ? "Copied" : "Copy endpoint"}
            </button>
            <span aria-live="polite" className="sr-only">{copied ? "Endpoint copied" : ""}</span>
          </dd>
        </div>
      </dl>
    </details>
  );
}

/** Required fields, with the message each one shows when it is left empty. */
const REQUIRED_TARGET_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ["name", "Give the target a name."],
  ["target_id", "Give the target an ID."],
  ["version", "Give the target a version."],
  ["endpoint", "Enter the gateway or endpoint URL."],
  ["environment", "Name the environment this target runs in."],
];

function TargetField({ id, label, error, children }: { id: string; label: string; error?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <Label className="text-sm font-medium" htmlFor={id}>{label}</Label>
      {children}
      {error ? <p id={`${id}-error`} role="alert" className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}

export function AgentTargetDialog({ agents, targets, pendingAgentId, actionsDisabled, loadState = "ready", onRetry, onAddAgent, onClose, projectName = "this Project" }: {
  agents: TargetVersion[];
  targets: TargetVersion[];
  pendingAgentId: string | null;
  actionsDisabled: boolean;
  loadState?: CatalogueLoadState;
  onRetry?: () => void;
  onAddAgent: (agent: TargetVersion) => Promise<void>;
  onClose: () => void;
  projectName?: string;
}) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [agentToAdd, setAgentToAdd] = useState<TargetVersion | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const originatingAddButton = useRef<HTMLButtonElement | null>(null);
  const originatingAgentId = useRef<string | null>(null);
  const confirmationCancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (agentToAdd) confirmationCancelRef.current?.focus();
  }, [agentToAdd]);
  const cancelAgentConfirmation = () => {
    setAgentToAdd(null);
    setAddError(null);
    window.requestAnimationFrame(() => originatingAddButton.current?.focus());
  };
  const filtered = useMemo(() => agents.filter((agent) => [agent.name, agent.target_id, agent.model_version, agent.environment].filter(Boolean).join(" ").toLowerCase().includes(query.trim().toLowerCase())), [agents, query]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / AGENTS_PER_PAGE));
  const currentPage = Math.min(page, pageCount);
  const visible = filtered.slice((currentPage - 1) * AGENTS_PER_PAGE, currentPage * AGENTS_PER_PAGE);
  return (
    <Dialog
      labelledBy={agentToAdd ? "agent-target-confirmation-title" : "agent-target-dialog-title"}
      onClose={pendingAgentId ? () => undefined : agentToAdd ? cancelAgentConfirmation : onClose}
      scrimLabel={agentToAdd ? "Cancel agent confirmation" : "Close Agent Catalog"}
      initialFocusRef={searchRef}
      width={agentToAdd ? "max-w-md" : "max-w-3xl"}
    >
      {agentToAdd ? (
        <TargetConfirmationContent
          titleId="agent-target-confirmation-title"
          title="Add agent permanently?"
          description={`${agentToAdd.name} remains on ${projectName} even if you abandon this Assignment.`}
          cancelRef={confirmationCancelRef}
          cancelLabel="Cancel"
          confirmLabel="Add agent"
          pendingLabel="Adding…"
          pending={actionsDisabled}
          error={addError}
          onCancel={cancelAgentConfirmation}
          onConfirm={() => {
            void onAddAgent(agentToAdd)
              .then(() => setAgentToAdd(null))
              .catch((cause) => setAddError((cause as Error).message));
          }}
        />
      ) : <>
      <div className="flex items-start justify-between gap-4 border-b px-5 py-4 sm:px-6"><div><h2 id="agent-target-dialog-title" className="text-lg font-semibold">Add target from Agent Catalog</h2><p className="mt-1 text-sm text-muted-foreground">Registers the agent permanently on this Project.</p></div><Button type="button" variant="ghost" size="icon" aria-label="Close Agent Catalog" onClick={onClose}><X className="size-4" aria-hidden="true" /></Button></div>
      <div className="border-b p-4 sm:px-6"><SearchField ref={searchRef} inputSize="default" containerClassName="block" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="Search agents" label="Search Agent Catalog" /></div>
      <div className="p-4 sm:px-6">
      {addError ? <p role="alert" className="mb-3 text-sm text-destructive">{addError}</p> : null}
      {loadState === "loading" ? (
        <p role="status" className="py-8 text-center text-sm text-muted-foreground">Loading Agent Catalog…</p>
      ) : loadState === "error" ? (
        <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-4 text-sm text-destructive">
          <p>Agent Catalog could not be loaded. Retry before adding an agent.</p>
          {onRetry ? <Button type="button" variant="outline" size="sm" className="mt-3" onClick={onRetry}>Retry Agent Catalog</Button> : null}
        </div>
      ) : visible.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">No agents match this search.</p>
      ) : <div className="divide-y">{visible.map((agent) => {
        const added = targets.some((target) => target.target_id === agent.target_id && target.endpoint === agent.endpoint);
        return <div key={agent.target_version_id} className="flex items-center justify-between gap-3 py-3"><span className="truncate text-sm font-semibold">{agent.name}</span><Button ref={(node) => { if (node && originatingAgentId.current === agent.target_version_id) originatingAddButton.current = node; }} type="button" size="sm" disabled={added || actionsDisabled} onClick={(event) => { originatingAgentId.current = agent.target_version_id; originatingAddButton.current = event.currentTarget; setAddError(null); setAgentToAdd(agent); }}>{pendingAgentId === agent.target_version_id ? "Adding…" : added ? "Added" : "Add target"}</Button></div>;
      })}</div>}
      </div>
      {loadState === "ready" ? <Pagination label={filtered.length ? `${(currentPage - 1) * AGENTS_PER_PAGE + 1}–${Math.min(currentPage * AGENTS_PER_PAGE, filtered.length)} of ${filtered.length}` : "0 agents"} currentPage={currentPage} pageCount={pageCount} previousLabel="Previous agents" nextLabel="Next agents" onPrevious={() => setPage((value) => Math.max(1, value - 1))} onNext={() => setPage((value) => Math.min(pageCount, value + 1))} /> : null}
      </>}
    </Dialog>
  );
}

function TargetConfirmationContent({
  titleId,
  title,
  description,
  cancelRef,
  cancelLabel,
  confirmLabel,
  pendingLabel,
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  titleId: string;
  title: string;
  description: string;
  cancelRef: { readonly current: HTMLButtonElement | null };
  cancelLabel: string;
  confirmLabel: string;
  pendingLabel: string;
  pending: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="grid gap-5 p-6">
      <div className="grid gap-2">
        <h2 id={titleId} className="text-base font-semibold">{title}</h2>
        <p className="text-sm text-muted-foreground">{description}</p>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      </div>
      <div className="flex gap-3">
        <Button ref={cancelRef} type="button" variant="outline" className="flex-1" onClick={onCancel} disabled={pending}>
          {cancelLabel}
        </Button>
        <Button type="button" className="flex-1" onClick={onConfirm} disabled={pending}>
          {pending ? pendingLabel : confirmLabel}
        </Button>
      </div>
    </div>
  );
}

function Pagination({ label, currentPage, pageCount, previousLabel, nextLabel, onPrevious, onNext }: {
  label: string; currentPage: number; pageCount: number; previousLabel: string; nextLabel: string; onPrevious: () => void; onNext: () => void;
}) {
  return <div className="flex items-center justify-between gap-3 border-t px-4 py-3"><p className="text-xs text-muted-foreground">{label}</p><div className="flex items-center gap-2"><Button type="button" variant="outline" size="icon" aria-label={previousLabel} disabled={currentPage === 1} onClick={onPrevious}><ChevronLeft className="size-4" aria-hidden="true" /></Button><span className="min-w-16 text-center text-xs font-medium">{currentPage} / {pageCount}</span><Button type="button" variant="outline" size="icon" aria-label={nextLabel} disabled={currentPage === pageCount} onClick={onNext}><ChevronRight className="size-4" aria-hidden="true" /></Button></div></div>;
}
