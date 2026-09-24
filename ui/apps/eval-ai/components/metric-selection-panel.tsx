"use client";

import { memo, useState } from "react";

import { Check, ChevronDown, Search } from "lucide-react";

import { cn } from "@evalai/shared/utils";

import type { EvaluationScope, EvidenceReadinessResult, MetricCatalogEntry } from "@/lib/api";
import type { EvaluationKind } from "@/lib/evaluation-form";
import { evaluationScopeLabel } from "@/components/evaluation/scope-selector";
import { scopeOptionsFrom } from "@/components/evaluation/helpers";

import { METRIC_GROUPS, metricMeaning, type MetricMeaning, type MetricGroupDefinition } from "@/lib/metric-groups";
export { METRIC_GROUPS, metricMeaning } from "@/lib/metric-groups";

export function metricRequiresJudge(metric: MetricCatalogEntry): boolean {
  return metric.available_in_run !== false && !["deterministic", "trace", "mock"].includes(metric.default_adapter ?? "native");
}

export function metricEvidenceScope(metric: MetricCatalogEntry): EvaluationScope {
  const categories = new Set(metric.required_evidence_categories ?? []);
  if (categories.has("trace") || categories.has("lifecycle_events") || categories.has("model_usage")) {
    return "full_execution";
  }
  if (
    metric.requires_trace ||
    categories.has("tool_calls") ||
    categories.has("tool_results") ||
    metricMeaning(metric) === "tools" ||
    metricMeaning(metric) === "retrieval"
  ) {
    return "tool_interactions";
  }
  return "final_response";
}

export function metricEvidenceLabel(metric: MetricCatalogEntry): string {
  return evaluationScopeLabel(metricEvidenceScope(metric));
}

/**
 * Agent behavior checks grade tool evidence that an LLM target never produces, so the LLM
 * path does not offer them at all — greying them out would still be an invitation to a
 * capability that branch does not have.
 *
 * Selection is a separate question: a metric the user has somehow already selected stays
 * rendered whatever the kind, so it always keeps a way to be cleared. That is the same rule
 * the checkbox below applies to unavailable and not-applicable checks.
 */
export function metricVisibleForKind(metric: MetricCatalogEntry, kind: EvaluationKind): boolean {
  return kind === "agent" || metricMeaning(metric) !== "tools";
}

/**
 * Why a check cannot run for this setup, or null when it can.
 *
 * Depth availability comes from the readiness payload's `scope_options`, never from a
 * constant: full execution used to be hardcoded as unavailable, which stopped being true
 * the moment the backend started deriving each depth from the target. A depth the backend
 * has not spoken about stays offered, and the readiness result for the requested depth
 * remains the authority on whether the run may actually start.
 */
export function metricUnavailableReason(
  metric: MetricCatalogEntry,
  readiness?: EvidenceReadinessResult | null,
): string | null {
  if (metric.available_in_run === false) return metric.availability_note || "This check is not available in inline evaluation runs.";
  const scope = metricEvidenceScope(metric);
  const option = scopeOptionsFrom(readiness).find((item) => item.scope === scope);
  if (option && !option.available) {
    return option.reason || `${evaluationScopeLabel(scope)} evidence is not available for this setup.`;
  }
  return null;
}

export function filterMetricSelection(metrics: MetricCatalogEntry[], family: string, query: string): MetricCatalogEntry[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return metrics.filter((metric) => {
    if (family !== "all" && metricMeaning(metric) !== family && !metric.metric_id.startsWith(`${family}.`)) return false;
    if (!normalizedQuery) return true;
    return [metric.metric_id, metric.name, metric.description].join(" ").toLocaleLowerCase().includes(normalizedQuery);
  });
}

/**
 * The backend-resolved requirement for a metric, from the readiness payload's
 * `metric_requirements`. This is the ONLY source of truth for "required" — the
 * resolver's precedence rules can keep template-referenced metrics optional, so
 * a UI-side inference from contract templates must never claim a metric is
 * required. Returns null when the backend has not resolved a requirement.
 */
export function backendRequirementForMetric(
  metric: MetricCatalogEntry,
  readiness?: EvidenceReadinessResult | null,
): "required" | "optional" | null {
  const entry = readiness?.metric_requirements?.find((item) => item.metric_id === metric.metric_id);
  return entry?.requirement ?? null;
}

/**
 * Requirement sources that pin a metric immutably (the approved quality
 * contract / run manifest). Only these lock the checkbox on. Every other
 * source — most importantly "explicit_selection", which merely records that
 * the user picked the metric — stays user-clearable, even when the metric is
 * unavailable or not applicable, so the user can always recover the draft by
 * clearing it.
 */
const LOCKED_REQUIREMENT_SOURCES = new Set(["quality_contract"]);

/**
 * True only when the backend-resolved requirement is "required" AND its source
 * is the immutable quality contract. A metric that is required because the
 * user explicitly selected it is never locked — "required" there just mirrors
 * the user's own choice back, and the user must always be able to clear it.
 */
export function metricLockedByContract(
  metric: MetricCatalogEntry,
  readiness?: EvidenceReadinessResult | null,
): boolean {
  const entry = readiness?.metric_requirements?.find((item) => item.metric_id === metric.metric_id);
  return entry?.requirement === "required" && LOCKED_REQUIREMENT_SOURCES.has(entry.source);
}

/**
 * The checks in a group a user could have selected: everything except checks
 * that are unavailable in this run or known-not-applicable to the dataset.
 * Backend-required (locked) checks ARE selectable — they count toward the
 * group's tri-state and header count — they just cannot be toggled.
 */
function groupSelectableMetrics(
  groupMetrics: MetricCatalogEntry[],
  readiness?: EvidenceReadinessResult | null,
): MetricCatalogEntry[] {
  return groupMetrics.filter(
    (metric) => !metricUnavailableReason(metric, readiness) && !notApplicableReasonForMetric(metric, readiness),
  );
}

/** Tri-state selection for a group's checkbox, computed over selectable checks only. */
export function groupSelectionState(
  groupMetrics: MetricCatalogEntry[],
  selectedMetricIds: string[],
  readiness?: EvidenceReadinessResult | null,
): "none" | "some" | "all" {
  const selected = new Set(selectedMetricIds);
  const selectable = groupSelectableMetrics(groupMetrics, readiness);
  const selectedCount = selectable.filter((metric) => selected.has(metric.metric_id)).length;
  if (!selectable.length || selectedCount === 0) return "none";
  return selectedCount === selectable.length ? "all" : "some";
}

/**
 * The metric ids a group-level toggle flips. Locked (contract-required),
 * unavailable, and not-applicable checks are never touched: when every
 * togglable check is selected the toggle deselects them all, otherwise it
 * selects the remaining unselected ones.
 */
export function groupToggleTargets(
  groupMetrics: MetricCatalogEntry[],
  selectedMetricIds: string[],
  readiness?: EvidenceReadinessResult | null,
): string[] {
  const selected = new Set(selectedMetricIds);
  const togglable = groupSelectableMetrics(groupMetrics, readiness).filter(
    (metric) => !metricLockedByContract(metric, readiness),
  );
  const allSelected = togglable.length > 0 && togglable.every((metric) => selected.has(metric.metric_id));
  const targets = allSelected
    ? togglable.filter((metric) => selected.has(metric.metric_id))
    : togglable.filter((metric) => !selected.has(metric.metric_id));
  return targets.map((metric) => metric.metric_id);
}

/**
 * Memoised: the workbench holds ~80 pieces of state, so every keystroke in a field
 * as unrelated as the evaluation name re-renders it. Without this, that reconciles
 * every check row on the page. Every prop below is already a stable reference from
 * the workbench (memoised lists, a `useCallback` toggle), so the guard actually hits.
 */
export const MetricSelectionPanel = memo(function MetricSelectionPanel({
  kind,
  metrics,
  selectedMetricIds,
  recommendedMetricIds,
  readiness,
  onToggle,
}: {
  kind: EvaluationKind;
  metrics: MetricCatalogEntry[];
  selectedMetricIds: string[];
  recommendedMetricIds: string[];
  /**
   * @deprecated UI-side inference of contract-required metrics. No longer used
   * for the "Required" label — that comes exclusively from the backend-resolved
   * `readiness.metric_requirements`. Accepted so existing callers keep compiling.
   */
  contractRequiredIds?: string[];
  readiness?: EvidenceReadinessResult | null;
  onToggle: (metricId: string) => void;
}) {
  // Operations metrics (latency, tokens, cost) are captured automatically and never offered here.
  // Unavailable and not-applicable checks stay inside their semantic group,
  // rendered disabled with their reason — there is no separate section.
  const selected = new Set(selectedMetricIds);
  const offered = metrics.filter(
    (metric) =>
      metricMeaning(metric) !== "performance" &&
      (metricVisibleForKind(metric, kind) || selected.has(metric.metric_id)),
  );
  const [query, setQuery] = useState("");
  const [openGroups, setOpenGroups] = useState<Set<MetricMeaning>>(() => new Set());
  const normalizedQuery = query.trim().toLocaleLowerCase();

  return (
    <section aria-labelledby="metric-selection-title" className="min-h-0">
      <div className="sticky top-0 z-10 border-b bg-card px-5 py-4">
        <h3 id="metric-selection-title" className="sr-only">Check catalog</h3>
        <label className="relative block">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(event) => {
              const value = event.target.value;
              setQuery(value);
              setOpenGroups(new Set(
                value.trim()
                  ? filterMetricSelection(offered, "all", value).map(metricMeaning)
                  : [],
              ));
            }}
            placeholder={`Search ${offered.length} checks…`}
            aria-label="Search checks"
            className="h-11 w-full rounded-lg border border-border bg-background pl-10 pr-3 text-sm outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/15"
          />
        </label>
        {recommendedMetricIds.length > 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            The checks already ticked are a recommended starting point, not a requirement.
            Add or remove any of them.
          </p>
        ) : null}
      </div>
      <div className="divide-y">
        {METRIC_GROUPS.map((group) => {
          const groupMetrics = offered.filter((metric) => metricMeaning(metric) === group.id);
          if (!groupMetrics.length) return null;
          const visibleMetrics = normalizedQuery
            ? groupMetrics.filter((metric) =>
                [metric.metric_id, metric.name, metric.description]
                  .join(" ")
                  .toLocaleLowerCase()
                  .includes(normalizedQuery),
              )
            : groupMetrics;
          if (!visibleMetrics.length) return null;
          return (
            <MetricGroup
              key={group.id}
              group={group}
              groupMetrics={groupMetrics}
              visibleMetrics={visibleMetrics}
              open={openGroups.has(group.id)}
              onOpenChange={() => {
                setOpenGroups((current) => {
                  const next = new Set(current);
                  if (next.has(group.id)) next.delete(group.id);
                  else next.add(group.id);
                  return next;
                });
              }}
              kind={kind}
              selectedMetricIds={selectedMetricIds}
              recommendedMetricIds={recommendedMetricIds}
              readiness={readiness}
              onToggle={onToggle}
            />
          );
        })}
        {normalizedQuery && !offered.some((metric) =>
          [metric.metric_id, metric.name, metric.description].join(" ").toLocaleLowerCase().includes(normalizedQuery),
        ) ? (
          <p className="px-5 py-8 text-center text-sm text-muted-foreground">No checks match “{query.trim()}”.</p>
        ) : null}
      </div>
    </section>
  );
});

function MetricGroup({
  group,
  groupMetrics,
  visibleMetrics,
  open,
  onOpenChange,
  kind,
  selectedMetricIds,
  recommendedMetricIds,
  readiness,
  onToggle,
}: {
  group: MetricGroupDefinition;
  groupMetrics: MetricCatalogEntry[];
  visibleMetrics: MetricCatalogEntry[];
  open: boolean;
  onOpenChange: () => void;
  kind: EvaluationKind;
  selectedMetricIds: string[];
  recommendedMetricIds: string[];
  readiness?: EvidenceReadinessResult | null;
  onToggle: (metricId: string) => void;
}) {
  const selected = new Set(selectedMetricIds);
  const recommended = new Set(recommendedMetricIds);
  const selectable = groupSelectableMetrics(groupMetrics, readiness);
  const selectedCount = selectable.filter((metric) => selected.has(metric.metric_id)).length;
  const state = groupSelectionState(groupMetrics, selectedMetricIds, readiness);
  const toggleTargets = groupToggleTargets(groupMetrics, selectedMetricIds, readiness);
  const panelId = `metric-group-${group.id}`;

  return (
    <div>
      <div className={cn("flex items-center gap-3 px-5", selectedCount > 0 && "bg-brand/5")}>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={onOpenChange}
          className="flex min-h-12 min-w-0 flex-1 cursor-pointer items-center gap-3 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <ChevronDown className={cn("size-4 shrink-0 transition-transform motion-reduce:transition-none", open && "rotate-180")} aria-hidden="true" />
          <span className="flex min-w-0 flex-1 items-baseline gap-3">
            <span className="shrink-0 text-sm font-medium">{group.label}</span>
            <span className="truncate text-xs text-muted-foreground">{group.description}</span>
          </span>
          <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-xs", selectedCount > 0 ? "bg-brand/20 text-brand-text" : "bg-muted text-muted-foreground")}>
            {selectedCount} of {groupMetrics.length}
          </span>
        </button>
        {open && toggleTargets.length ? (
          <button
            type="button"
            onClick={() => toggleTargets.forEach(onToggle)}
            className="shrink-0 text-xs font-medium text-brand-text underline-offset-4 hover:underline"
          >
            {state === "all" ? "Clear all" : "Select all"}
          </button>
        ) : null}
      </div>
      <div id={panelId} hidden={!open} className="divide-y border-t">
        {visibleMetrics.map((metric) => {
          const notApplicable = readiness ? notApplicableReasonForMetric(metric, readiness) : null;
          // Backend truth only: a metric is "required" solely when the resolved
          // requirement says so, never because a template references it. Only a
          // quality-contract requirement LOCKS the checkbox — a requirement whose
          // source is the user's own explicit selection stays clearable, so an
          // unavailable selected check can always be cleared to recover the draft.
          const required = backendRequirementForMetric(metric, readiness) === "required";
          const locked = metricLockedByContract(metric, readiness);
          return (
            <MetricCheckbox
              key={metric.metric_id}
              metric={metric}
              selected={selected.has(metric.metric_id)}
              recommended={recommended.has(metric.metric_id)}
              status={resolvedMetricStatus(metric, readiness)}
              blockingReason={blockingReasonForMetric(metric, readiness)}
              notApplicableReason={notApplicable}
              unavailableReason={metricUnavailableReason(metric, readiness)}
              caution={
                kind === "agent" && group.id === "retrieval" && readiness?.agent_tools?.length === 0
                  ? "May not apply — no retrieval tool detected on this agent; runs will be unscored if no retrieval evidence is captured."
                  : null
              }
              contractRequired={locked}
              requiredLabel={required ? (locked ? "Required by rubric" : "Required") : null}
              onToggle={() => onToggle(metric.metric_id)}
            />
          );
        })}
      </div>
    </div>
  );
}

function MetricCheckbox({
  metric,
  selected,
  recommended,
  status,
  blockingReason,
  notApplicableReason,
  unavailableReason,
  caution,
  contractRequired,
  requiredLabel = null,
  onToggle,
}: {
  metric: MetricCatalogEntry;
  selected: boolean;
  recommended: boolean;
  status: string | null;
  blockingReason: string | null;
  notApplicableReason: string | null;
  /** Set when the check cannot run in this flow at all; renders disabled + greyed with the reason. */
  unavailableReason: string | null;
  caution: string | null;
  /** True only when the immutable quality contract requires this metric (locks the checkbox on). */
  contractRequired: boolean;
  /** Requirement chip text; null when the backend did not resolve the metric as required. */
  requiredLabel?: string | null;
  onToggle: () => void;
}) {
  // Not-applicable and unavailable checks are auto-deselected and cannot be re-SELECTED,
  // but a selected one always keeps a working clear affordance (disabled-for-selection is
  // not locked-from-clearing). Only a contract-required check is locked on, so its unmet
  // applicability keeps blocking Run.
  const disabled =
    ((Boolean(notApplicableReason) || Boolean(unavailableReason)) && !selected) || contractRequired;
  const greyed = Boolean(notApplicableReason) || Boolean(unavailableReason);
  const contractBlocked = contractRequired && Boolean(notApplicableReason);
  // Stable id so the checkbox's accessible description points at the metric's explanatory text.
  const describedById = `metric-desc-${metric.metric_id}`;
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={selected}
      aria-disabled={disabled}
      aria-describedby={describedById}
      onClick={() => { if (!disabled) onToggle(); }}
      className={cn(
      "flex w-full items-center gap-4 px-5 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
      selected && "bg-brand/5",
      !disabled && "hover:bg-muted/15",
      disabled && "cursor-not-allowed",
      blockingReason && selected && "bg-state-caution-soft",
      contractBlocked && "bg-red-50/60 dark:bg-red-950/15",
    )}>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={cn("font-mono text-sm", greyed && "text-muted-foreground")}>{metric.metric_id}</span>
            {metricEvidenceScope(metric) === "tool_interactions" ? <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">Tool layer</span> : null}
            {metricEvidenceScope(metric) === "full_execution" ? <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">Full trace</span> : null}
            {requiredLabel ? <span className="text-xs font-medium text-foreground">{requiredLabel}</span> : null}
            {recommended && !requiredLabel && !greyed ? <span className="text-xs text-muted-foreground">Recommended</span> : null}
            {status && !notApplicableReason && !unavailableReason ? <span className="text-xs font-medium text-muted-foreground">{status}</span> : null}
          </span>
          <span id={describedById}>
            <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{metric.description}</span>
            {unavailableReason ? (
              <span className="mt-1 block text-xs font-medium text-muted-foreground">Unavailable in this run: {unavailableReason}</span>
            ) : null}
            {notApplicableReason && !contractRequired ? (
              <span className="mt-1 block text-xs font-medium text-muted-foreground">Not applicable: {notApplicableReason}</span>
            ) : null}
            {caution ? (
              <span className="mt-1 block text-xs font-medium text-state-caution">{caution}</span>
            ) : null}
            {contractBlocked ? (
              <span className="mt-1 block text-xs font-medium text-destructive">Required by a rubric but not applicable to this dataset: {notApplicableReason} Remove the rubric to continue.</span>
            ) : null}
            {blockingReason && selected && !notApplicableReason ? (
              contractRequired ? (
                <span className="mt-1 block text-xs font-medium text-destructive">Required by a rubric but unavailable: {blockingReason} Remove the rubric to continue.</span>
              ) : (
                <span className="mt-1 block text-xs font-medium text-state-caution">Unavailable: {blockingReason} Clear this checkbox to continue.</span>
              )
            ) : null}
          </span>
        </span>
        <span className={cn("flex min-w-16 shrink-0 items-center justify-center gap-1 rounded-full border px-3 py-1 text-xs font-medium", selected ? "border-brand-text/40 bg-brand/15 text-brand-text" : "border-border bg-background", disabled && "opacity-60")}>
          {selected ? <Check className="size-3.5" aria-hidden="true" /> : null}
          {contractRequired ? "Required" : selected ? "Added" : "Add"}
        </span>
    </button>
  );
}

export function notApplicableReasonForMetric(metric: MetricCatalogEntry, readiness?: EvidenceReadinessResult | null): string | null {
  const entry = readiness?.metric_applicability.find((item) => item.metric_id === metric.metric_id);
  if (!entry || entry.applicability !== "known_not_applicable") return null;
  return entry.reason ?? "This check does not apply to the evidence in this dataset.";
}

export function resolvedMetricStatus(metric: MetricCatalogEntry, readiness?: EvidenceReadinessResult | null): string | null {
  const applicability = readiness?.metric_applicability.find((item) => item.metric_id === metric.metric_id);
  if (applicability?.applicability === "known_not_applicable") return "Not applicable";
  if (blockingReasonForMetric(metric, readiness)) return "Unavailable";
  const requirement = readiness?.metric_requirements?.find((item) => item.metric_id === metric.metric_id);
  if (!requirement) return null;
  return requirement.requirement === "optional" ? "For insight only" : "Affects verdict";
}

export function blockingReasonForMetric(metric: MetricCatalogEntry, readiness?: EvidenceReadinessResult | null): string | null {
  if (!readiness || readiness.status === "ready") return null;
  const categories = new Set(metric.required_evidence_categories ?? []);
  if (metric.requires_trace && categories.size === 0) {
    categories.add("tool_calls");
    categories.add("tool_results");
  }
  const detail = readiness.details.find((item) => item.evidence_category && categories.has(item.evidence_category));
  return detail?.message ?? null;
}
