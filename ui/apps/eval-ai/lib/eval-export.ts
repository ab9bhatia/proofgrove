/** Build and download evaluation result extracts (JSON, CSV, printable PDF). */

import type { MetricResult, RunResult } from "@/lib/api";
import { escapeCsvCell } from "@/lib/csv";
import { downloadTextFile } from "@/lib/dataset-csv";
import {
  formatRunScore,
  recordedResponseSource,
  runInvokesTarget,
  runLabel,
  runScenarioTypeLabel,
} from "@/lib/run-recommendation";
import { presentRunOutcome } from "@/lib/run-outcome";

export type ExportFormat = "json" | "csv" | "pdf";
export type ExportScope = "full" | "metrics" | "quality";
/** PDF report depth — Summary is outcome-only; Details is human-readable tables. */
export type PdfGranularity = "summary" | "details";

function metricDisplayName(metricId: string): string {
  const leaf = metricId.includes(".") ? metricId.split(".").pop()! : metricId;
  return leaf.replace(/_/g, " ");
}

function rowsToCsv(headers: string[], rows: string[][]): string {
  return [
    headers.map(escapeCsvCell).join(","),
    ...rows.map((row) => row.map(escapeCsvCell).join(",")),
  ].join("\n");
}

function averageMetricScores(run: RunResult): Array<{
  id: string;
  label: string;
  mean: number;
  count: number;
  passes: number;
  warns: number;
  fails: number;
}> {
  const byMetric = new Map<string, MetricResult[]>();
  for (const result of run.metric_results || []) {
    if (result.metric_id.startsWith("quality.")) continue;
    const list = byMetric.get(result.metric_id) ?? [];
    list.push(result);
    byMetric.set(result.metric_id, list);
  }
  return [...byMetric.entries()]
    .flatMap(([id, results]) => {
      const scored = results.filter(
        (row): row is MetricResult & { normalised_score: number } => row.normalised_score !== null,
      );
      if (scored.length === 0) return [];
      return [{
        id,
        label: metricDisplayName(id),
        mean: scored.reduce((sum, row) => sum + row.normalised_score, 0) / scored.length,
        count: scored.length,
        passes: scored.filter((row) => row.threshold_result === "pass").length,
        warns: scored.filter((row) => row.threshold_result === "warn").length,
        fails: scored.filter((row) => row.threshold_result === "fail").length,
      }];
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function metricAggregateOutcome(row: { passes: number; warns: number; fails: number }): "Pass" | "Warn" | "Fail" | "Not scored" {
  if (row.fails > 0) return "Fail";
  if (row.warns > 0) return "Warn";
  if (row.passes > 0) return "Pass";
  return "Not scored";
}

export function qualityContractGroups(run: RunResult) {
  const byMetric = new Map<string, MetricResult[]>();
  for (const result of run.metric_results || []) {
    if (!result.metric_id.startsWith("quality.")) continue;
    const list = byMetric.get(result.metric_id) ?? [];
    list.push(result);
    byMetric.set(result.metric_id, list);
  }

  let met = 0;
  let partial = 0;
  let notMet = 0;
  let unavailable = 0;
  const groups = [...byMetric.entries()].map(([metricId, results]) => {
    const scored = results.filter(
      (row): row is MetricResult & { normalised_score: number } => row.normalised_score !== null,
    );
    const mean = scored.length
      ? scored.reduce((sum, row) => sum + row.normalised_score, 0) / scored.length
      : null;
    const passes = results.filter((row) => row.threshold_result === "pass").length;
    const warns = results.filter((row) => row.threshold_result === "warn").length;
    const fails = results.filter((row) => row.threshold_result === "fail").length;
    const state = fails > 0
      ? "fail"
      : warns > 0
        ? "warn"
        : passes > 0
          ? "pass"
          : results.every((row) => row.metric_applicability === "not_applicable")
            ? "not_applicable"
            : results.some((row) => row.metric_status === "technical_error")
              ? "technical_error"
              : "not_scored";
    const gate = state === "pass" || state === "warn" || state === "fail" ? state : null;
    if (gate === "pass") met += 1;
    else if (gate === "warn") partial += 1;
    else if (gate === "fail") notMet += 1;
    else unavailable += 1;
    return {
      metricId,
      label: metricDisplayName(metricId),
      mean,
      passes,
      warns,
      fails,
      gate,
      state,
      rationales: results
        .map((row) => row.rationale?.trim())
        .filter((text): text is string => Boolean(text))
        .slice(0, 8),
    };
  });

  const overall =
    groups.filter((group) => group.mean !== null).length === 0
      ? null
      : groups
          .filter((group): group is typeof group & { mean: number } => group.mean !== null)
          .reduce((sum, group) => sum + group.mean, 0) /
        groups.filter((group) => group.mean !== null).length;

  return { groups, met, partial, notMet, unavailable, overall };
}

/**
 * How the answers being scored came to exist, carried in every run-scoped
 * export. Once a file leaves the UI nothing else says it — a provided run's
 * score was otherwise indistinguishable from live-target evidence, because the
 * only trace of the source was a presentation label or an empty endpoint cell.
 * `target_invoked` is null when the run recorded nothing to answer with.
 */
function provenanceFields(run: RunResult) {
  return {
    response_source: recordedResponseSource(run) || null,
    target_invoked: runInvokesTarget(run),
  };
}

/**
 * What governed this run, carried in every run-scoped export.
 *
 * `governed` alone says a profile stood behind the verdict without saying
 * which, so an exported file could not be traced back to the configuration
 * that produced it — the one question an auditor reading the file will ask.
 * The run records the manifest and the pinned versions rather than the
 * Assignment itself, so that is what is exported.
 */
function governanceFields(run: RunResult) {
  const lineage = run.lineage ?? null;
  return {
    run_manifest_id: run.run_manifest_id ?? lineage?.run_manifest_id ?? null,
    run_manifest_hash: lineage?.run_manifest_hash ?? null,
    quality_profile_id: run.quality_profile_id ?? lineage?.quality_profile_id ?? null,
    quality_profile_version: run.quality_profile_version ?? lineage?.quality_profile_version ?? null,
    gate_policy_id: lineage?.gate_policy_id ?? null,
    gate_policy_version: lineage?.gate_policy_version ?? null,
  };
}

function fullPayload(run: RunResult) {
  const metrics = averageMetricScores(run);
  const quality = qualityContractGroups(run);
  return {
    run_id: run.run_id,
    name: run.experiment?.name ?? null,
    label: runLabel(run),
    status: run.status,
    // The composed label too, not only the raw parts. A consumer had to
    // cross-reference three fields by hand to reconstruct what the UI states in
    // one string.
    outcome: presentRunOutcome(run).label,
    verdict_status: run.verdict_status ?? null,
    diagnostic_only: Boolean(run.diagnostic_only),
    governed: presentRunOutcome(run).governed,
    ...governanceFields(run),
    overall_gate: run.overall_gate,
    overall_score: formatRunScore(run),
    scenario: runScenarioTypeLabel(run),
    ...provenanceFields(run),
    judge_model: run.experiment?.judge_model ?? null,
    dataset_version: run.experiment?.dataset_version ?? null,
    target_endpoint: runInvokesTarget(run) === true ? run.experiment?.target_endpoint ?? null : null,
    started_at: run.started_at,
    completed_at: run.completed_at,
    active_metrics: run.active_metrics,
    metrics,
    quality_contracts: quality,
    metric_results: run.metric_results,
    kpi_results: run.kpi_results,
    root_cause: run.root_cause,
  };
}

function metricsPayload(run: RunResult) {
  return {
    run_id: run.run_id,
    name: run.experiment?.name ?? null,
    scope: "metrics" as const,
    ...provenanceFields(run),
    averages: averageMetricScores(run),
    metric_results: (run.metric_results || []).filter(
      (row) => !row.metric_id.startsWith("quality."),
    ),
  };
}

function qualityPayload(run: RunResult) {
  return {
    run_id: run.run_id,
    name: run.experiment?.name ?? null,
    scope: "quality" as const,
    ...provenanceFields(run),
    ...qualityContractGroups(run),
    metric_results: (run.metric_results || []).filter((row) =>
      row.metric_id.startsWith("quality."),
    ),
  };
}

function payloadFor(scope: ExportScope, run: RunResult): unknown {
  if (scope === "metrics") return metricsPayload(run);
  if (scope === "quality") return qualityPayload(run);
  return fullPayload(run);
}

function scorerProvenanceCsv(results: MetricResult[]): string {
  return rowsToCsv(
    ["metric_id", "row_id", "requested_scorer", "executed_scorer", "result_state"],
    results.map((result) => [
      result.metric_id,
      result.row_id,
      result.requested_scorer ?? "",
      result.executed_scorer ?? "",
      result.unscored_reason === "simulated"
        ? "Simulated - no real judge ran"
        : result.metric_applicability === "not_applicable"
          ? "not applicable"
          : result.metric_status ?? "not recorded",
    ]),
  );
}

export function csvFor(scope: ExportScope, run: RunResult): string {
  if (scope === "metrics") {
    const averages = averageMetricScores(run);
    const summary = rowsToCsv(
      ["metric_id", "label", "mean_score_pct", "cases", "pass", "warn", "fail"],
      averages.map((row) => [
        row.id,
        row.label,
        row.mean === null ? "" : (row.mean * 100).toFixed(2),
        String(row.count),
        String(row.passes),
        String(row.warns),
        String(row.fails),
      ]),
    );
    const results = (run.metric_results || []).filter(
      (row) => !row.metric_id.startsWith("quality."),
    );
    return `${summary}\n\n${scorerProvenanceCsv(results)}`;
  }

  if (scope === "quality") {
    const { groups } = qualityContractGroups(run);
    const summary = rowsToCsv(
      ["contract_id", "label", "mean_score_pct", "gate", "pass", "warn", "fail"],
      groups.map((row) => [
        row.metricId,
        row.label,
        row.mean === null ? "" : (row.mean * 100).toFixed(2),
        row.state,
        String(row.passes),
        String(row.warns),
        String(row.fails),
      ]),
    );
    const results = (run.metric_results || []).filter((row) =>
      row.metric_id.startsWith("quality."),
    );
    return `${summary}\n\n${scorerProvenanceCsv(results)}`;
  }

  const metrics = averageMetricScores(run);
  const quality = qualityContractGroups(run);
  // The composed outcome, not just the raw gate. `overall_gate` alone could read
  // `pass` one row above an `overall_score` of "Not scored", with nothing in the
  // file explaining the contradiction — and filtering a spreadsheet on
  // `overall_gate = pass` is the single most likely thing anyone does with this
  // export. A CSV is the artifact most likely to reach an auditor without ever
  // passing back through the UI, so it carries the same honesty the PDF path
  // already gets from `presentRunOutcome`.
  const outcome = presentRunOutcome(run);
  const summary = rowsToCsv(
    ["field", "value"],
    [
      ["run_id", run.run_id],
      ["name", run.experiment?.name || ""],
      ["label", runLabel(run) || ""],
      ["status", run.status || ""],
      ["outcome", outcome.label],
      ["verdict_status", run.verdict_status ?? ""],
      ["diagnostic_only", String(Boolean(run.diagnostic_only))],
      ["governed", String(outcome.governed)],
      ...Object.entries(governanceFields(run)).map(
        ([key, value]) => [key, value ?? ""] as [string, string],
      ),
      ["overall_gate", run.overall_gate || ""],
      ["overall_score", formatRunScore(run)],
      ["scenario", runScenarioTypeLabel(run)],
      ["response_source", recordedResponseSource(run) || ""],
      ["target_invoked", runInvokesTarget(run) === null ? "" : String(runInvokesTarget(run))],
      ["judge_model", run.experiment?.judge_model || ""],
      ["dataset_version", run.experiment?.dataset_version || ""],
      ["target_endpoint", runInvokesTarget(run) === true ? run.experiment?.target_endpoint || "" : ""],
    ],
  );
  const metricsCsv = rowsToCsv(
    ["section", "id", "label", "mean_score_pct", "pass", "warn", "fail"],
    [
      ...metrics.map((row) => [
        "metric",
        row.id,
        row.label,
        row.mean === null ? "" : (row.mean * 100).toFixed(2),
        String(row.passes),
        String(row.warns),
        String(row.fails),
      ]),
      ...quality.groups.map((row) => [
        "quality_contract",
        row.metricId,
        row.label,
        row.mean === null ? "" : (row.mean * 100).toFixed(2),
        String(row.passes),
        String(row.warns),
        String(row.fails),
      ]),
    ],
  );
  return `${summary}\n\n${metricsCsv}\n\n${scorerProvenanceCsv(run.metric_results || [])}`;
}

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function overallOutcomeBanner(run: RunResult): string {
  const outcome = presentRunOutcome(run);
  const tone =
    outcome.kind === "pass"
      ? "background:#ecfdf5;border:1px solid #a7f3d0;color:#065f46;"
      : outcome.kind === "fail"
        ? "background:#fef2f2;border:1px solid #fecaca;color:#991b1b;"
        : "background:#f8fafc;border:1px solid #cbd5e1;color:#334155;";
  return `<div style="margin:16px 0 24px;padding:14px 16px;border-radius:10px;${tone}">
  <div style="font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;">Overall Outcome</div>
  <div style="margin-top:4px;font-size:28px;font-weight:700;">${htmlEscape(outcome.label)}</div>
  <div style="margin-top:4px;font-size:12px;">Gate ${htmlEscape(String(outcome.gate || "—"))} · Gated score ${htmlEscape(outcome.scoreLabel)}${outcome.observedScoreLabel !== "—" && outcome.scoreLabel === "—" ? ` · Observed score ${htmlEscape(outcome.observedScoreLabel)} (not gated)` : ""}</div>
</div>`;
}

function pdfHtml(scope: ExportScope, run: RunResult, granularity: PdfGranularity): string {
  const title =
    scope === "metrics"
      ? "Metrics report"
      : scope === "quality"
        ? "Quality contracts report"
        : "Evaluation result";
  const depthLabel = granularity === "summary" ? "Summary" : "Details";
  const heading = htmlEscape(run.experiment?.name || run.run_id);
  const body =
    granularity === "summary" ? pdfSummaryBody(scope, run) : pdfDetailsBody(scope, run);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${htmlEscape(title)} (${depthLabel}) — ${heading}</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 32px; color: #111; }
    h1 { font-size: 22px; margin: 0 0 8px; }
    h2 { font-size: 16px; margin: 24px 0 8px; }
    p, li { font-size: 13px; line-height: 1.5; }
    .meta { color: #555; font-size: 12px; margin-bottom: 12px; }
    table { border-collapse: collapse; width: 100%; margin-top: 8px; }
    th, td { border: 1px solid #ddd; padding: 6px 8px; text-align: left; font-size: 12px; }
    th { background: #f5f5f5; }
    @media print { body { margin: 12mm; } }
  </style>
</head>
<body>
  <h1>${htmlEscape(title)} — ${depthLabel}</h1>
  <p class="meta">${heading}<br/>Run ${htmlEscape(run.run_id)}</p>
  ${overallOutcomeBanner(run)}
  ${body}
  <script>window.onload = function () { window.print(); };</script>
</body>
</html>`;
}

function pdfSummaryBody(scope: ExportScope, run: RunResult): string {
  if (scope === "metrics") {
    const metrics = averageMetricScores(run);
    const rows = metrics
      .map(
        (row) =>
          `<tr><td>${htmlEscape(row.label)}</td><td>${(row.mean * 100).toFixed(1)}%</td><td>${metricAggregateOutcome(row)}</td></tr>`,
      )
      .join("");
    return `<h2>Metric outcomes</h2><table><thead><tr><th>Metric</th><th>Average</th><th>Outcome</th></tr></thead><tbody>${rows || "<tr><td colspan='3'>No metrics</td></tr>"}</tbody></table>`;
  }
  if (scope === "quality") {
    const { groups, met, partial, notMet, unavailable } = qualityContractGroups(run);
    const rows = groups
      .map(
        (row) =>
          `<tr><td>${htmlEscape(row.label)}</td><td>${row.mean === null ? "—" : `${(row.mean * 100).toFixed(1)}%`}</td><td>${htmlEscape(row.state.replace(/_/g, " "))}</td></tr>`,
      )
      .join("");
    return `<p>${met} met · ${partial} partial · ${notMet} not met · ${unavailable} unavailable</p><h2>Quality contract outcomes</h2><table><thead><tr><th>Contract</th><th>Average</th><th>Outcome</th></tr></thead><tbody>${rows || "<tr><td colspan='3'>No quality contracts</td></tr>"}</tbody></table>`;
  }
  const metrics = averageMetricScores(run);
  const quality = qualityContractGroups(run);
  return `<h2>Summary</h2>
<p>Scored metrics: ${metrics.length}. Quality contracts: ${quality.groups.length} (${quality.met} met, ${quality.partial} partial, ${quality.notMet} not met, ${quality.unavailable} unavailable).</p>
${pdfSummaryBody("metrics", run)}
${pdfSummaryBody("quality", run)}`;
}

function pdfDetailsBody(scope: ExportScope, run: RunResult): string {
  if (scope === "metrics") {
    const rows = averageMetricScores(run)
      .map(
        (row) =>
          `<tr><td>${htmlEscape(row.label)}</td><td>${(row.mean * 100).toFixed(1)}%</td><td>${row.passes} pass · ${row.warns} warn · ${row.fails} fail</td><td>${row.count} cases</td></tr>`,
      )
      .join("");
    return `<h2>Metric averages</h2><table><thead><tr><th>Metric</th><th>Average</th><th>Pass / Warn / Fail</th><th>Cases</th></tr></thead><tbody>${rows || "<tr><td colspan='4'>No metrics</td></tr>"}</tbody></table>`;
  }
  if (scope === "quality") {
    const { groups, met, partial, notMet, unavailable } = qualityContractGroups(run);
    const rows = groups
      .map((row) => {
        const rationale = row.rationales[0]
          ? htmlEscape(row.rationales[0])
          : "No rationale captured.";
        return `<tr><td>${htmlEscape(row.label)}</td><td>${row.mean === null ? "—" : `${(row.mean * 100).toFixed(1)}%`}</td><td>${htmlEscape(row.state.replace(/_/g, " "))}</td><td>${row.passes}/${row.warns}/${row.fails}</td><td>${rationale}</td></tr>`;
      })
      .join("");
    return `<p>${met} met · ${partial} partial · ${notMet} not met · ${unavailable} unavailable</p><h2>Quality contracts</h2><table><thead><tr><th>Contract</th><th>Average</th><th>Gate</th><th>Pass / Warn / Fail</th><th>Sample rationale</th></tr></thead><tbody>${rows || "<tr><td colspan='5'>No quality contracts</td></tr>"}</tbody></table>`;
  }
  return `${pdfDetailsBody("metrics", run)}${pdfDetailsBody("quality", run)}<h2>Run configuration</h2>
<table><tbody>
<tr><th>Judge</th><td>${htmlEscape(run.experiment?.judge_model || "—")}</td></tr>
<tr><th>Dataset</th><td>${htmlEscape(run.experiment?.dataset_version || "—")}</td></tr>
<tr><th>Target</th><td>${htmlEscape(runInvokesTarget(run) === true
    ? run.experiment?.target_endpoint || "—"
    : runInvokesTarget(run) === null
      ? "Not recorded"
      : "Not invoked")}</td></tr>
<tr><th>Scenario</th><td>${htmlEscape(runScenarioTypeLabel(run))}</td></tr>
<tr><th>Active metrics</th><td>${htmlEscape((run.active_metrics || []).join(", ") || "—")}</td></tr>
<tr><th>Label</th><td>${htmlEscape(runLabel(run) || "—")}</td></tr>
</tbody></table>`;
}

function filenameBase(scope: ExportScope, runId: string, granularity?: PdfGranularity): string {
  const suffix =
    scope === "metrics" ? "metrics" : scope === "quality" ? "quality-report" : "evaluation-result";
  if (granularity) return `${runId}-${suffix}-${granularity}`;
  return `${runId}-${suffix}`;
}

/** Download or print an evaluation extract for the given scope and format. */
export function exportEvaluation(
  scope: ExportScope,
  format: ExportFormat,
  run: RunResult,
  options?: { pdfGranularity?: PdfGranularity },
): void {
  const granularity = options?.pdfGranularity ?? "details";
  const base = filenameBase(scope, run.run_id, format === "pdf" ? granularity : undefined);
  if (format === "json") {
    downloadTextFile(
      `${base}.json`,
      JSON.stringify(payloadFor(scope, run), null, 2),
      "application/json",
    );
    return;
  }
  if (format === "csv") {
    downloadTextFile(`${base}.csv`, csvFor(scope, run), "text/csv;charset=utf-8");
    return;
  }

  const html = pdfHtml(scope, run, granularity);
  const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
  window.open(url, "_blank", "noopener,noreferrer");
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);

}

export { averageMetricScores as exportMetricAverages, payloadFor as exportPayloadFor };

export type LibraryCsvRow = {
  name: string;
  runs: number;
  latestScore: string;
  latestOutcome: string;
  lastRun: string;
};

/** CSV for the filtered evaluation library group rows (view export). */
export function libraryCsv(rows: ReadonlyArray<LibraryCsvRow>): string {
  return rowsToCsv(
    ["evaluation", "runs", "latest_score", "latest_outcome", "last_run"],
    rows.map((row) => [
      row.name,
      String(row.runs),
      row.latestScore,
      row.latestOutcome,
      row.lastRun,
    ]),
  );
}

export function downloadLibraryCsv(filename: string, rows: ReadonlyArray<LibraryCsvRow>): void {
  downloadTextFile(filename, libraryCsv(rows), "text/csv;charset=utf-8");
}
