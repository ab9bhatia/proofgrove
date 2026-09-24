"use client";

import { Loader2 } from "lucide-react";

import { Button } from "@evalai/shared/ui/button";

import type { EvidenceReadinessResult } from "@/lib/api";

/**
 * The launch control, with the facts the decision rests on.
 *
 * Sticky on narrow screens because it is the one control the whole form leads
 * to: scrolling back to find it is the difference between a run being launched
 * and a form being abandoned.
 *
 * Every blocking reason shares the one `run-action-help` id the button points
 * at, so the button always describes itself with whatever is actually stopping
 * it — and describes nothing when nothing is.
 */
export function RunBar({
  checkCount,
  runCount = 1,
  depthLabel,
  caseCount,
  durationEstimate,
  readiness,
  readinessLoading,
  readinessError,
  helpText,
  governanceLevel,
  busy,
  disabled,
  label,
  onRun,
}: {
  checkCount: number;
  runCount?: number;
  depthLabel: string;
  caseCount: number | null;
  durationEstimate: string | null;
  readiness: EvidenceReadinessResult | null;
  readinessLoading: boolean;
  readinessError: string | null;
  /** Why the run cannot start yet, when readiness itself is fine. */
  helpText: string | null;
  /** Diagnostic / Standardized evaluation / Release-governed at commit time. */
  governanceLevel?: string | null;
  busy: boolean;
  disabled: boolean;
  label: string;
  onRun: () => void;
}) {
  const evidenceUnavailable = Boolean(readiness && readiness.status !== "ready");
  const describedBy =
    readinessLoading || readinessError || evidenceUnavailable || helpText
      ? "run-action-help"
      : undefined;

  return (
    <footer className="sticky bottom-0 z-20 flex flex-col gap-4 border-t bg-card px-5 py-4 sm:flex-row sm:items-center sm:justify-between xl:static xl:col-span-2 xl:col-start-1 xl:row-start-3">
      <div className="min-w-0">
        <dl className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
          {runCount > 1 ? (
            <div className="flex items-baseline gap-2">
              <dt className="text-muted-foreground">Runs</dt>
              <dd className="font-medium">{runCount}</dd>
            </div>
          ) : null}
          <div className="flex items-baseline gap-2">
            <dt className="text-muted-foreground">Checks</dt>
            <dd className="font-medium">{checkCount}</dd>
          </div>
          <div className="flex items-baseline gap-2">
            <dt className="text-muted-foreground">Depth</dt>
            <dd className="font-medium">{depthLabel}</dd>
          </div>
          <div className="flex items-baseline gap-2">
            <dt className="text-muted-foreground">{runCount > 1 ? "Cases per run" : "Cases"}</dt>
            <dd className="font-medium">{caseCount ?? "—"}</dd>
          </div>
          <div className="flex items-baseline gap-2">
            <dt className="text-muted-foreground">{runCount > 1 ? "Estimated per run" : "Estimated"}</dt>
            <dd className="font-medium">{durationEstimate ?? "—"}</dd>
          </div>
          {governanceLevel ? (
            <div className="flex items-baseline gap-2">
              <dt className="text-muted-foreground">Governance</dt>
              <dd className="font-medium">{governanceLevel}</dd>
            </div>
          ) : null}
        </dl>
        {readinessLoading ? (
          <p
            id="run-action-help"
            className="mt-2 flex items-center gap-2 text-xs text-muted-foreground"
            aria-live="polite"
          >
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            Checking required evidence…
          </p>
        ) : readinessError ? (
          <p id="run-action-help" className="mt-2 text-xs text-destructive" role="alert">
            Availability check failed: {readinessError}
          </p>
        ) : evidenceUnavailable ? (
          <p id="run-action-help" className="mt-2 text-xs text-destructive" role="alert">
            {readiness?.details[0]?.message ??
              "The required evidence is not available for this setup."}
          </p>
        ) : helpText ? (
          <p id="run-action-help" className="mt-2 text-xs text-muted-foreground">
            {helpText}
          </p>
        ) : null}
      </div>
      <Button
        className="min-h-11 shrink-0"
        onClick={onRun}
        disabled={disabled}
        aria-describedby={describedBy}
      >
        {busy || readinessLoading ? (
          <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />
        ) : null}
        {label}
      </Button>
    </footer>
  );
}
