"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronDown, ShieldCheck } from "lucide-react";
import { cn } from "@evalai/shared/utils";
import { OverlayConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  evaluationApi,
  type ExperimentDecision,
  type GateResult,
  type PlatformCapabilities,
  type RunResult,
} from "@/lib/api";
import { userFacingError } from "@/lib/api-errors";
import { useUIState } from "@/components/ui-state";
import { ExportMenu } from "@/components/export-menu";
import {
  formatPercentValue,
  formatWhen,
  humanizeKey,
  isQualityGoverned,
  isReleaseGoverned,
  scoreColor,
  type QualityOutcome,
  type runEvidenceContractPresentation,
} from "./lib";

/**
 * The Release Decision affordance may be offered only when the run is
 * release-governed (a gate policy resolved in its lineage) AND the backend
 * capability endpoint granted `record_release_decision` to this caller.
 * A `null`/unresolved capability answer keeps the affordance hidden — the
 * panel must never render and then 403.
 */

/**
 * Why a metric is on this run, in the reader's terms.
 *
 * `humanizeKey` printed the resolver's own enum: "Legacy scenario primary" and
 * "Legacy cross cutting" told a reader nothing about why the metric applies,
 * and "legacy" is our migration history, not theirs.
 */
const REQUIREMENT_SOURCE_LABELS: Record<string, string> = {
  quality_contract: "Quality contract",
  explicit_selection: "Chosen for this run",
  legacy_scenario_primary: "Default for this scenario",
  legacy_cross_cutting: "Applies to every scenario",
  catalog_diagnostic_default: "Catalog diagnostic default",
};

export function shouldOfferReleaseDecision(
  run: RunResult,
  capabilities: PlatformCapabilities | null,
): boolean {
  if (!(isReleaseGoverned(run) && capabilities?.actions?.record_release_decision === true)) {
    return false;
  }
  // Fail closed: release decisions require an explicit eligible result from
  // the backend. Missing eligibility must not unlock the decision form.
  if (!run.release_eligibility) {
    return false;
  }
  return run.release_eligibility.status === "eligible";
}

/** Present backend eligibility on release-governed runs; never recompute it. */
export function releaseEligibilityPresentation(run: RunResult): {
  label: string;
  detail: string;
  tone: "positive" | "attention" | "neutral";
} | null {
  if (!isReleaseGoverned(run)) return null;
  const eligibility = run.release_eligibility;
  if (!eligibility) {
    return {
      label: "Eligibility not reported",
      detail: "This run payload does not include a backend eligibility result.",
      tone: "neutral",
    };
  }
  if (eligibility.status === "eligible") {
    return {
      label: "Release-eligible",
      detail: "Execution finished, verdict is conclusive, required evidence is complete, and the gate passed.",
      tone: "positive",
    };
  }
  return {
    label: "Not release-eligible",
    detail: eligibility.message || eligibility.code || "This run cannot be used as release evidence.",
    tone: "attention",
  };
}

export function ReleaseEligibilityBanner({ run }: { run: RunResult }) {
  const presentation = releaseEligibilityPresentation(run);
  if (!presentation) return null;
  const toneClass =
    presentation.tone === "positive"
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200"
      : presentation.tone === "attention"
        ? "border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-100"
        : "border-border bg-muted/40 text-muted-foreground";
  return (
    <div role="status" className={`rounded-xl border px-4 py-3 text-sm ${toneClass}`}>
      <p className="font-semibold tracking-tight">{presentation.label}</p>
      <p className="mt-1 text-xs leading-5 opacity-90">{presentation.detail}</p>
    </div>
  );
}

export function FullPageQualitySection({
  run,
  quality,
  caseCount,
}: {
  run: RunResult;
  quality: QualityOutcome;
  caseCount: number | null;
}) {
  const controlCount = quality.groups.length;
  // Governance is decided by an approved quality contract, not manifest
  // presence: this section only renders for a quality-governed run, and a
  // governed run may have no recorded manifest.
  const governed = isQualityGoverned(run);
  const outcomeSummary =
    quality.partial === 0 && quality.notMet === 0 && quality.unavailable === 0
      ? `${quality.met} of ${controlCount} controls met`
      : `${quality.met} met · ${quality.partial} partial · ${quality.notMet} not met · ${quality.unavailable} unavailable`;

  return (
    <section
      aria-labelledby="quality-controls-title"
      className="overflow-hidden rounded-xl border bg-card shadow-sm"
    >
      <header className="flex flex-wrap items-start justify-between gap-4 border-b px-5 py-4 sm:px-6">
        <div>
          <h2 id="quality-controls-title" className="text-base font-semibold tracking-tight">
            Quality controls
          </h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {controlCount === 0
              ? governed
                ? "No quality-control results were recorded for this run."
                : "No quality contract was evaluated for this run."
              : `${controlCount} control${controlCount === 1 ? "" : "s"} evaluated${
                  caseCount == null
                    ? "."
                    : ` across ${caseCount} case${caseCount === 1 ? "" : "s"}.`
                }`}
          </p>
        </div>
        {controlCount > 0 ? (
          <ExportMenu run={run} scope="quality" label="Export" />
        ) : null}
      </header>

      {controlCount === 0 ? (
        <div className="px-5 py-8 sm:px-6">
          <p className="text-sm font-medium">
            {governed ? "No quality controls recorded" : "No quality contract attached"}
          </p>
          <p className="mt-1 w-full max-w-2xl text-xs leading-5 text-muted-foreground">
            {governed
              ? "This run is governed by a quality contract, but no quality-control results were recorded. Review its metric results and evidence contract."
              : "Review this run through its cases and metrics, or attach a quality contract to assess release controls."}
          </p>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-end justify-between gap-3 px-5 py-4 sm:px-6">
            <div className="flex items-baseline gap-2">
              <span
                className={cn(
                  "font-mono text-2xl font-semibold",
                  quality.overall == null ? undefined : scoreColor(quality.overall * 100),
                )}
              >
                {quality.overall == null ? "—" : formatPercentValue(quality.overall * 100)}
              </span>
              <span className="text-xs text-muted-foreground">Quality score</span>
            </div>
            <p className="text-xs font-medium text-muted-foreground">{outcomeSummary}</p>
          </div>

          <div className="border-t">
            {quality.groups.map((group) => {
              const pct = group.mean === null ? null : group.mean * 100;
              const outcomeLabel =
                group.gate === "pass"
                  ? "Met"
                  : group.gate === "warn"
                    ? "Partial"
                    : group.gate === "fail"
                      ? "Not met"
                      : group.state === "not_applicable"
                        ? "Not applicable"
                        : group.state === "technical_error"
                          ? "Technical error"
                          : "Not scored";
              const resultCount = group.passes + group.warns + group.fails;
              return (
                <details
                  key={group.metricId}
                  className="group border-b last:border-b-0"
                  open={group.gate === "pass" ? undefined : true}
                >
                  <summary className="grid cursor-pointer list-none gap-3 px-5 py-3.5 outline-none transition-colors hover:bg-muted/20 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center sm:px-6">
                    <div className="min-w-0">
                      <p className="text-sm font-medium capitalize">{group.label}</p>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        {resultCount} case result{resultCount === 1 ? "" : "s"}
                      </p>
                    </div>
                    <div className="flex items-center justify-between gap-3 sm:block sm:text-right">
                      <span className="text-[10px] uppercase tracking-wide text-muted-foreground sm:hidden">
                        Score
                      </span>
                      <span className={cn("font-mono text-sm font-semibold", pct === null ? undefined : scoreColor(pct))}>
                        {pct === null ? "—" : formatPercentValue(pct)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-3 sm:justify-end">
                      <QualityOutcomeBadge gate={group.gate} label={outcomeLabel} />
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-foreground">
                        Evidence
                        <ChevronDown
                          className="size-3.5 transition-transform group-open:rotate-180"
                          aria-hidden="true"
                        />
                      </span>
                    </div>
                  </summary>
                  <div className="border-t bg-muted/10 px-5 py-4 sm:px-6">
                    {group.rationales.length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        No scorer rationale was captured for this control.
                      </p>
                    ) : (
                      <ul className="space-y-2 text-xs leading-5 text-muted-foreground">
                        {group.rationales.map((rationale, index) => (
                          <li key={`${group.metricId}-${index}`} className="flex gap-2">
                            <span className="font-mono text-[10px] text-foreground" aria-hidden="true">
                              {String(index + 1).padStart(2, "0")}
                            </span>
                            <span>{rationale}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </details>
              );
            })}
          </div>

          <p className="border-t px-5 py-3 text-[11px] text-muted-foreground sm:px-6">
            Generated {formatWhen(run.completed_at || run.started_at)}
          </p>
        </>
      )}
    </section>
  );
}

const RELEASE_DECISION_OPTIONS: Array<{
  value: ExperimentDecision["decision"];
  label: string;
}> = [
  { value: "approved", label: "Approve for release" },
  { value: "approved_with_exception", label: "Approve with exception" },
  { value: "rejected", label: "Reject" },
];

/**
 * Record a release decision for a release-governed run.
 *
 * Callers must only mount this when the run is release-governed
 * (`isReleaseGoverned`) AND the capabilities endpoint granted
 * `record_release_decision` — the affordance is hidden entirely otherwise,
 * never rendered-then-403.
 */
export function ReleaseDecisionPanel({ run }: { run: RunResult }) {
  const { fullName, identityResolved } = useUIState();
  const experimentId = run.experiment?.experiment_id;
  const [decision, setDecision] = useState<ExperimentDecision["decision"]>("approved");
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [recorded, setRecorded] = useState<ExperimentDecision | null>(null);
  const [history, setHistory] = useState<ExperimentDecision[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!experimentId) return;
    let cancelled = false;
    evaluationApi
      .listDecisions(experimentId)
      .then((rows) => {
        if (!cancelled) setHistory(rows);
      })
      .catch((cause) => {
        if (!cancelled) {
          setHistoryError(userFacingError(cause, "Decision history could not be loaded."));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [experimentId]);

  if (!experimentId) return null;

  const decisionLabel =
    RELEASE_DECISION_OPTIONS.find((option) => option.value === decision)?.label ?? decision;

  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      // Fail closed. `fullName` falls back to the literal string "User" when
      // gateway identity does not resolve, and this panel's own copy calls the
      // result an audited history — so an unresolved identity must not be able
      // to sign a release decision at all, rather than signing it as "User".
      if (!identityResolved) {
        throw new Error("Your identity could not be confirmed, so this decision was not recorded.");
      }
      const saved = await evaluationApi.createDecision(experimentId, {
        run_id: run.run_id,
        decision,
        approved_by: fullName,
        reason: reason.trim() || undefined,
      });
      setRecorded(saved);
      setHistory((rows) => [saved, ...rows]);
      setConfirming(false);
    } catch (cause) {
      setConfirming(false);
      setError(userFacingError(cause, "The release decision could not be recorded. Try again."));
    } finally {
      setPending(false);
    }
  };

  return (
    <section
      aria-labelledby="release-decision-title"
      className="overflow-hidden rounded-xl border bg-card shadow-sm"
    >
      <header className="border-b px-5 py-4 sm:px-6">
        <h2 id="release-decision-title" className="text-base font-semibold tracking-tight">
          Release decision
        </h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          This run is release-governed. Record whether it is approved as release evidence; the
          decision is audited under your name.
        </p>
        {run.release_eligibility?.status === "eligible" ? (
          <p className="mt-2 text-xs font-medium text-emerald-700 dark:text-emerald-300">
            Backend eligibility: release-eligible.
          </p>
        ) : null}
      </header>

      <div className="border-b px-5 py-4 sm:px-6">
        <h3 className="text-sm font-medium tracking-tight">Experiment decision history</h3>
        {historyError ? (
          <p className="mt-2 text-xs text-destructive" role="alert">
            {historyError}
          </p>
        ) : history.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">No release decisions recorded yet.</p>
        ) : (
          <ul className="mt-3 grid gap-2">
            {history.map((item) => (
              <li
                key={item.decision_id || `${item.decision}-${item.approved_by}-${item.created_at}`}
                className="rounded-lg border bg-muted/30 px-3 py-2 text-xs"
              >
                <p className="font-medium capitalize text-foreground">
                  {item.decision.replaceAll("_", " ")}
                </p>
                <p className="mt-1 text-muted-foreground">
                  <Link href={`/runs/${encodeURIComponent(item.run_id)}`} className="underline">Run {item.run_id}</Link>
                </p>
                <p className="mt-1 text-muted-foreground">
                  {item.approved_by}
                  {item.created_at ? ` · ${formatWhen(item.created_at)}` : ""}
                </p>
                {item.reason ? <p className="mt-1 text-muted-foreground">{item.reason}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      {recorded ? (
        <div className="px-5 py-4 sm:px-6">
          <p className="text-sm font-medium">
            Decision recorded:{" "}
            <span className="capitalize">{recorded.decision.replaceAll("_", " ")}</span>
          </p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Recorded by {recorded.approved_by}
            {recorded.reason ? <> · {recorded.reason}</> : null}
          </p>
        </div>
      ) : (
        <div className="space-y-4 px-5 py-4 sm:px-6">
          <div className="grid gap-1.5">
            <label htmlFor="release-decision-choice" className="text-xs font-medium text-foreground">
              Decision
            </label>
            <select
              id="release-decision-choice"
              value={decision}
              onChange={(event) =>
                setDecision(event.target.value as ExperimentDecision["decision"])
              }
              className="h-9 w-full max-w-xs rounded-lg border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {RELEASE_DECISION_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-1.5">
            <label htmlFor="release-decision-reason" className="text-xs font-medium text-foreground">
              Rationale
            </label>
            <textarea
              id="release-decision-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={3}
              placeholder="Why this run is (or is not) acceptable release evidence"
              className="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          {error ? (
            <p role="alert" className="text-xs leading-5 text-red-600 dark:text-red-400">
              {error}
            </p>
          ) : null}
          {identityResolved ? null : (
            <p role="alert" className="text-xs leading-5 text-state-caution">
              Your identity could not be confirmed, so a decision recorded now could not be
              attributed to you. Sign in again before recording a release decision.
            </p>
          )}
          <button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={!identityResolved}
            aria-disabled={!identityResolved}
            className="inline-flex h-9 items-center rounded-lg bg-foreground px-4 text-sm font-semibold text-background hover:bg-foreground/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Record decision
          </button>
        </div>
      )}

      {confirming ? (
        <OverlayConfirmDialog
          icon={ShieldCheck}
          tone="default"
          title="Record release decision?"
          description={
            <>
              <span className="font-medium text-foreground">{decisionLabel}</span> will be recorded
              for this run as <span className="font-medium text-foreground">{fullName}</span>, a
              confirmed identity. The decision is appended to the experiment&apos;s audited
              history.
            </>
          }
          confirmLabel="Record decision"
          pendingLabel="Recording…"
          pending={pending}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void submit()}
        />
      ) : null}
    </section>
  );
}

export function QualityCount({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: GateResult | "neutral";
}) {
  return (
    <div className="flex items-center gap-2">
      <span
        className={cn(
          "size-2 rounded-full",
          tone === "pass" && "bg-gate-pass",
          tone === "warn" && "bg-gate-warn",
          tone === "fail" && "bg-gate-fail",
          tone === "neutral" && "bg-gate-neutral",
        )}
        aria-hidden="true"
      />
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-mono font-semibold text-foreground">{value}</dd>
    </div>
  );
}

export function QualityOutcomeBadge({ gate, label }: { gate: GateResult | null; label: string }) {
  return (
    <span
      className={cn(
        "inline-flex rounded-lg border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
        gate === "pass" &&
          "border-state-positive/30 bg-state-positive-soft text-state-positive dark:border-state-positive/30 dark:bg-state-positive-soft dark:text-state-positive",
        gate === "warn" &&
          "border-state-caution/30 bg-state-caution-soft text-state-caution dark:border-state-caution/30 dark:bg-state-caution-soft dark:text-state-caution",
        gate === "fail" &&
          "border-red-300 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300",
        gate === null && "border-border bg-muted/30 text-muted-foreground",
      )}
    >
      {label}
    </span>
  );
}

export function EvidenceContractDisclosure({
  contract,
}: {
  contract: NonNullable<ReturnType<typeof runEvidenceContractPresentation>>;
}) {
  return (
    <details className="group border-y">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 py-3 text-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        <span className="min-w-0">
          <span className="block font-medium text-foreground">Evidence contract</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {contract.summary} · {contract.source}
          </span>
        </span>
        <ChevronDown
          className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180 motion-reduce:transition-none"
          aria-hidden="true"
        />
      </summary>
      <div className="border-t py-4">
        <p className="text-xs leading-5 text-muted-foreground">
          Resolved before execution. Observed capture and evaluator outcomes cannot change these
          requirements.
        </p>
        <dl className="mt-4 space-y-3 text-xs">
          <div className="grid gap-1 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-4">
            <dt className="font-medium text-muted-foreground">Required evidence</dt>
            <dd className="break-words text-foreground">
              {contract.effectiveRequirements.map(humanizeKey).join(" · ")}
            </dd>
          </div>
          {contract.configurationFingerprint ? (
            <div className="grid gap-1 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-4">
              <dt className="font-medium text-muted-foreground">Configuration fingerprint</dt>
              <dd
                className="break-all font-mono text-foreground"
                translate="no"
              >
                {contract.configurationFingerprint}
              </dd>
            </div>
          ) : null}
        </dl>

        {contract.metricRequirements.length > 0 ? (
          <div className="mt-4 border-t pt-4">
            <p className="text-xs font-medium text-foreground">Metric requirements</p>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[36rem] text-left text-xs">
                <thead className="text-muted-foreground">
                  <tr>
                    <th scope="col" className="pb-2 pr-4 font-medium">Metric</th>
                    <th scope="col" className="pb-2 pr-4 font-medium">Requirement</th>
                    <th scope="col" className="pb-2 font-medium">Resolution source</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {contract.metricRequirements.map((requirement) => (
                    <tr key={requirement.metric_id}>
                      <th scope="row" className="py-2.5 pr-4 font-mono font-medium text-foreground" translate="no">
                        {requirement.metric_id}
                      </th>
                      <td className="py-2.5 pr-4 text-foreground">
                        {humanizeKey(requirement.requirement)}
                      </td>
                      <td className="py-2.5 text-muted-foreground">
                        {REQUIREMENT_SOURCE_LABELS[requirement.source] ?? humanizeKey(requirement.source)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}

        {contract.kpiCompositions.length > 0 ? (
          <div className="mt-4 border-t pt-4">
            <p className="text-xs font-medium text-foreground">Fixed gate composition</p>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[44rem] text-left text-xs">
                <thead className="text-muted-foreground">
                  <tr>
                    <th scope="col" className="pb-2 pr-4 font-medium">KPI</th>
                    <th scope="col" className="pb-2 pr-4 font-medium">Required gate constituents</th>
                    <th scope="col" className="pb-2 font-medium">Optional diagnostics</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {contract.kpiCompositions.map((composition) => (
                    <tr key={composition.kpi_id} className="align-top">
                      <th scope="row" className="py-2.5 pr-4 font-mono font-medium text-foreground" translate="no">
                        {composition.kpi_id}
                      </th>
                      <td className="py-2.5 pr-4 text-foreground">
                        {composition.required_gate_constituents.length > 0
                          ? composition.required_gate_constituents
                              .map((metricId) => {
                                const weight = composition.fixed_gate_weights[metricId];
                                return weight === undefined
                                  ? metricId
                                  : `${metricId} · ${(weight * 100).toFixed(0)}%`;
                              })
                              .join("; ")
                          : "Diagnostic only"}
                      </td>
                      <td className="py-2.5 text-muted-foreground">
                        {composition.optional_diagnostic_constituents.length > 0
                          ? composition.optional_diagnostic_constituents.join(" · ")
                          : "None"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}

        {contract.metricDependencies.length > 0 ? (
          <div className="mt-4 border-t pt-4">
            <p className="text-xs font-medium text-foreground">Additional metric dependencies</p>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[32rem] text-left text-xs">
                <thead className="text-muted-foreground">
                  <tr>
                    <th scope="col" className="pb-2 pr-4 font-medium">Metric</th>
                    <th scope="col" className="pb-2 font-medium">Additional evidence</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {contract.metricDependencies.map(([metricId, requirements]) => (
                    <tr key={metricId}>
                      <th
                        scope="row"
                        className="py-2.5 pr-4 font-mono font-medium text-foreground"
                        translate="no"
                      >
                        {metricId}
                      </th>
                      <td className="py-2.5 text-muted-foreground">
                        {requirements.length > 0
                          ? requirements.map(humanizeKey).join(" · ")
                          : "Scope evidence only"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </div>
    </details>
  );
}
