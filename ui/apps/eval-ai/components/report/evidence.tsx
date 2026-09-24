import { type ReactNode } from "react";
import { datasetVersionLabel } from "@/lib/dataset-lineage";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@evalai/shared/ui/button";
import { cn } from "@evalai/shared/utils";
import { type RunResult } from "@/lib/api";
import { CopyIdButton } from "@/components/copyable-id";
import { runInvokesTarget, runLabel, runScenarioTypeLabel } from "@/lib/run-recommendation";
import { RunOutcomeBadge } from "@/components/run-outcome-badge";
import {
  formatWhen,
  humanizeKey,
  runEvidenceContractPresentation,
  runEvidencePresentation,
  scoringMethodForRun,
  judgeLabelForRun,
} from "./lib";
import { EvidenceContractDisclosure } from "./governance";

export function RunEvidenceSection({
  run,
  caseCount,
  casesLoading,
  casesError,
  onInspectCases,
}: {
  run: RunResult;
  caseCount: number;
  casesLoading: boolean;
  casesError: string | null;
  onInspectCases: () => void;
}) {
  const presentation = runEvidencePresentation(run);
  const contract = runEvidenceContractPresentation(run);
  const categories = run.evidence_categories ?? [];
  const evidenceDiagnostics = [...new Set(
    categories
      .map((category) => category.diagnostic)
      .filter((value): value is string => Boolean(value)),
  )];
  // Selected-tools level: named tools this tool_interactions run was scoped to
  // (absent = the whole tool layer was evaluated).
  const evaluatedTools =
    run.lineage?.selected_tool_ids ?? run.experiment?.selected_tool_ids ?? null;
  const caseEvidenceDetail = casesLoading
    ? "Checking the saved case evidence for this run."
    : casesError
      ? "Case evidence could not be loaded. Open Case details to review the retrieval error."
      : caseCount > 0
        ? `${caseCount} evaluated case${caseCount === 1 ? " is" : "s are"} available for inspection.`
        : "No case-level evidence was recorded for this run.";

  return (
    <div className="space-y-5">
      <dl className="grid gap-4 sm:grid-cols-3 sm:gap-0 sm:divide-x">
        <EvidenceFact
          label="Evidence scope"
          value={presentation.scopeLabel}
          detail={presentation.scopeDetail}
        />
        <EvidenceFact
          label="Verdict"
          value={presentation.verdictLabel}
          detail={presentation.verdictDetail}
        />
        <EvidenceFact
          label="Overall capture"
          value={presentation.captureLabel}
          detail="Whether the evidence was captured — not whether scoring succeeded"
        />
      </dl>

      {evaluatedTools && evaluatedTools.length > 0 ? (
        <p className="rounded-lg border bg-muted/10 px-4 py-2.5 text-xs leading-5 text-muted-foreground">
          Evaluated tools:{" "}
          <span className="font-medium text-foreground">{evaluatedTools.join(", ")}</span>
          <span className="ml-1">
            — scoring was scoped to these named tools; other tool calls remain in the
            captured evidence but did not contribute to scores.
          </span>
        </p>
      ) : null}

      {evidenceDiagnostics.length > 0 ? (
        <div className="rounded-lg border border-state-caution/30 bg-state-caution-soft px-4 py-3 text-sm text-state-caution dark:border-state-caution/30 dark:bg-state-caution-soft dark:text-state-caution">
          <p className="font-medium">Completed with partial telemetry evidence</p>
          <p className="mt-1 text-xs leading-5">
            Metrics that only need the response were scored. These need the trace and were not: {evidenceDiagnostics.map(humanizeKey).join(", ")}.
            A later completion marker can create a linked enrichment run automatically.
          </p>
        </div>
      ) : null}

      {contract ? <EvidenceContractDisclosure contract={contract} /> : null}

      {categories.length === 0 ? (
        <div className="rounded-lg border border-dashed bg-muted/10 px-4 py-5">
          <p className="text-sm font-medium">Category-level evidence was not recorded</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            This historical state does not imply that evidence was absent.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <div className="border-b bg-muted/15 px-4 py-3">
            <p className="text-sm font-medium">Evidence categories</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Backend-recorded completeness and provenance for each evidence type.
            </p>
          </div>
          <div className="divide-y md:hidden">
            {categories.map((category) => (
              <dl key={category.category} className="grid grid-cols-2 gap-x-4 gap-y-3 px-4 py-4 text-xs">
                <div className="col-span-2">
                  <dt className="text-xs text-muted-foreground">Category</dt>
                  <dd className="mt-1 font-medium text-foreground">{humanizeKey(category.category)}</dd>
                </div>
                <EvidenceCategoryFact
                  label="Requirement"
                  value={category.required ? "Required" : "Not required"}
                />
                <div>
                  <dt className="text-xs text-muted-foreground">Capture</dt>
                  <dd className="mt-1"><EvidenceCaptureText status={category.status} /></dd>
                </div>
                <EvidenceCategoryFact
                  label="Records"
                  mono
                  value={
                    category.record_count === 0 &&
                    category.completeness_attested &&
                    category.status === "captured"
                      ? "0 · none observed"
                      : String(category.record_count)
                  }
                />
                <EvidenceCategoryFact
                  label="Completeness"
                  value={category.completeness_attested ? "Attested complete" : "Not attested"}
                />
                <div className="col-span-2">
                  <dt className="text-xs text-muted-foreground">Provenance</dt>
                  <dd className="mt-1 text-foreground">
                    {humanizeKey(category.provenance_status)}
                    {category.provenance_source ? (
                      <span className="ml-1 text-muted-foreground">· {category.provenance_source}</span>
                    ) : null}
                  </dd>
                </div>
              </dl>
            ))}
          </div>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-[760px] text-left text-xs">
              <thead className="border-b bg-muted/10 text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-2.5 font-medium">Category</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Requirement</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Capture</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">Records</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Completeness</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Provenance</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {categories.map((category) => (
                  <tr key={category.category} className="align-top">
                    <th scope="row" className="px-4 py-3 font-medium text-foreground">
                      {humanizeKey(category.category)}
                    </th>
                    <td className="px-3 py-3 text-muted-foreground">
                      {category.required ? "Required" : "Not required"}
                    </td>
                    <td className="px-3 py-3">
                      <EvidenceCaptureText status={category.status} />
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-foreground">
                      {category.record_count === 0 &&
                      category.completeness_attested &&
                      category.status === "captured"
                        ? "0 · none observed"
                        : category.record_count}
                    </td>
                    <td className="px-3 py-3 text-muted-foreground">
                      {category.completeness_attested ? "Attested complete" : "Not attested"}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      <span className="block text-foreground">
                        {humanizeKey(category.provenance_status)}
                      </span>
                      {category.provenance_source ? (
                        <span className="mt-0.5 block max-w-52 truncate" title={category.provenance_source}>
                          {category.provenance_source}
                        </span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-medium">Case evidence inspector</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {caseEvidenceDetail} Saved outputs, retrieval, tool activity, scorer rationale,
            and runtime references appear there. Trace-linked evidence and identifiers appear
            only when the backend marks them available.
          </p>
        </div>
        <div className="flex shrink-0 flex-col gap-2 sm:items-end">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onInspectCases}
            disabled={casesLoading || (caseCount === 0 && !casesError)}
          >
            {casesError ? "Review case evidence error" : "Inspect case evidence"}
            <ChevronRight className="ml-1.5 size-3.5" aria-hidden="true" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function EvidenceFact({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="min-w-0 sm:px-5 sm:first:pl-0 sm:last:pr-0">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-1.5 text-base font-semibold tracking-tight text-foreground">{value}</dd>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</p>
    </div>
  );
}

function EvidenceCategoryFact({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("mt-1 text-foreground", mono && "font-mono")}>{value}</dd>
    </div>
  );
}

function EvidenceCaptureText({
  status,
}: {
  status: NonNullable<RunResult["evidence_categories"]>[number]["status"];
}) {
  const label = humanizeKey(status);
  return (
    <span
      className={cn(
        "font-medium text-foreground",
        (status === "partial" || status === "not_captured") &&
          "text-state-caution",
        (status === "unknown" || status === "not_required") && "text-muted-foreground",
      )}
    >
      {label}
    </span>
  );
}

function DetailList({
  rows,
}: {
  rows: Array<{ label: string; value: ReactNode; mono?: boolean; idKind?: "run" | "trace" }>;
}) {
  return (
    <dl className="space-y-4">
      {rows.map((row) => (
        <div key={row.label}>
          <dt className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            {row.label}
          </dt>
          <dd
            className={cn(
              "mt-1 break-words text-sm",
              row.mono && "break-all font-mono text-xs",
            )}
          >
            <span className="inline-flex items-center gap-1">
              {row.value}
              {row.idKind && typeof row.value === "string" ? <CopyIdButton value={row.value} kind={row.idKind} /> : null}
            </span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function EmbeddedRunDetails({ run }: { run: RunResult }) {
  const typeLabel = runScenarioTypeLabel(run);
  const targetInvoked = runInvokesTarget(run) === true;
  const provenanceSubject = targetInvoked ? "target" : "response source";
  const annotation = runLabel(run);
  const versionLabel = run.run_number != null ? `v${run.run_number}` : "—";
  const recordedTargetVersion =
    run.lineage?.target_version_id || run.experiment?.target_version || "Not recorded";
  const recordedManifest = run.lineage?.run_manifest_id || run.experiment?.run_manifest_id;
  const identityStatus = run.lineage?.target_identity_status;
  const identityAssurance = identityStatus
    ? `${humanizeKey(identityStatus)}${
        run.lineage?.exact_runtime_identity_required ? " · Exact identity required" : ""
      }`
    : "Not recorded";

  return (
    <div className="min-w-0 space-y-4" style={{ boxSizing: "border-box", width: "100%" }}>
      <dl className="grid overflow-hidden rounded-xl border bg-background sm:grid-cols-2">
        <EmbeddedDetailCell
          label="Dataset"
          value={datasetVersionLabel(run.experiment?.dataset_version) || "Not recorded"}
          mono
        />
        <EmbeddedDetailCell
          label="Target"
          value={targetInvoked ? run.experiment?.target_endpoint || "Not recorded" : "Not invoked"}
          mono
        />
        <EmbeddedDetailCell
          label="Judge"
          value={judgeLabelForRun(run)}
        />
        <EmbeddedDetailCell
          label="Target prompt"
          value={run.lineage?.target_prompt_ref || run.lineage?.target_prompt_version || "Not recorded"}
          mono
        />
        <EmbeddedDetailCell
          label="Release result"
          value={<RunOutcomeBadge run={run} />}
        />
      </dl>

      <dl className="grid gap-x-6 gap-y-4 px-1 sm:grid-cols-2">
        <EmbeddedDetailCell label="Created" value={formatWhen(run.started_at)} unframed />
        <EmbeddedDetailCell label="Run label" value={annotation || "No label"} unframed />
      </dl>

      <details className="group overflow-hidden rounded-xl border bg-background">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium outline-none hover:bg-muted/25 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
          Technical details
          <ChevronDown
            className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
            aria-hidden="true"
          />
        </summary>
        <div className="grid grid-rows-[0fr] transition-[grid-template-rows] duration-200 ease-standard motion-reduce:transition-none group-open:grid-rows-[1fr]">
          <div className="min-h-0 overflow-hidden">
            <div className="border-t bg-muted/10 px-4 py-4">
              <DetailList
                rows={[
                  { label: "Run ID", value: run.run_id, mono: true, idKind: "run" },
                  { label: "Version", value: versionLabel },
                  {
                    label: "Type / status",
                    value: `${typeLabel} · ${run.status || "unknown"}`,
                  },
                  {
                    label: "Target version",
                    value: recordedTargetVersion,
                  },
                  {
                    label: "Target version ID",
                    value:
                      run.lineage?.target_version_id ||
                      run.experiment?.target_version_id ||
                      "Not recorded",
                    mono: Boolean(
                      run.lineage?.target_version_id || run.experiment?.target_version_id,
                    ),
                  },
                  {
                    label: "Quality contract manifest",
                    value: recordedManifest || "Not recorded",
                    mono: Boolean(recordedManifest),
                  },
                  {
                    label: "Evaluation setup snapshot",
                    value:
                      run.lineage?.experiment_version_id ||
                      run.experiment_version_id ||
                      "Not recorded",
                    mono: Boolean(
                      run.lineage?.experiment_version_id || run.experiment_version_id,
                    ),
                  },
                  {
                    label: "Provenance captured",
                    value: run.lineage?.captured_at
                      ? formatWhen(run.lineage.captured_at)
                      : "Not recorded",
                  },
                  {
                    label: "Identity assurance",
                    value: identityAssurance,
                  },
                  {
                    label: `Requested ${provenanceSubject}`,
                    value: targetProvenanceSummary(run.lineage?.requested_target_provenance),
                  },
                  {
                    label: `Resolved ${provenanceSubject}`,
                    value: targetProvenanceSummary(run.lineage?.resolved_target_provenance),
                  },
                  {
                    label: `Observed ${provenanceSubject}`,
                    value: targetProvenanceSummary(run.lineage?.observed_target_provenance),
                  },
                  { label: "Scoring mode", value: scoringMethodForRun(run).label },
                ]}
              />
            </div>
          </div>
        </div>
      </details>
    </div>
  );
}

function targetProvenanceSummary(provenance?: Record<string, unknown>): string {
  if (!provenance || Object.keys(provenance).length === 0) return "Not recorded";
  const identifier = [provenance.identifier, provenance.revision]
    .filter((value) => typeof value === "string" && value.length > 0)
    .join("@");
  const model = typeof provenance.model === "string" ? provenance.model : "";
  const targetType = typeof provenance.target_type === "string" ? provenance.target_type : "";
  const identity = identifier || model || targetType || "Identity not recorded";
  const status = typeof provenance.status === "string" ? humanizeKey(provenance.status) : "Status not recorded";
  return `${identity} · ${status}`;
}

function EmbeddedDetailCell({
  label,
  value,
  mono = false,
  unframed = false,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
  unframed?: boolean;
}) {
  return (
    <div
      className={cn(
        "min-w-0",
        !unframed &&
          "border-b px-4 py-4 last:border-b-0 sm:[&:nth-child(odd)]:border-r sm:[&:nth-last-child(-n+2)]:border-b-0",
      )}
    >
      <dt className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        {label}
      </dt>
      <dd
        className={cn(
          "mt-1.5 min-w-0 text-sm font-medium text-foreground",
          mono && "break-words font-mono text-xs font-normal",
        )}
      >
        {value}
      </dd>
    </div>
  );
}
