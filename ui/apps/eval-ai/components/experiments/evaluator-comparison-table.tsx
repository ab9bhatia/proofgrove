"use client";

import { useState } from "react";
import { SearchField } from "@/components/toolbar";
import type { RunResult } from "@/lib/api";
import { isMeasurement, metricResultIsScored, summarizeMetricScores } from "@/components/report/lib";

export function EvaluatorComparisonTable({ runs, labels = ["Baseline", "Candidate 1", "Candidate 2", "Candidate 3"] }: { runs: RunResult[]; labels?: string[] }) {
  const [query, setQuery] = useState("");
  const summaries = runs.map((run) => {
    const recordedCases = new Set((run.metric_results || []).map((result) => result.row_id)).size;
    return summarizeMetricScores(run, recordedCases).filter((metric) => !isMeasurement(metric.id));
  });
  const metrics = [...new Map(summaries.flat().map((metric) => [metric.id, metric.label])).entries()];
  metrics.sort(([a, aLabel], [b, bLabel]) => {
    const attention = (id: string) => summaries.reduce((count, rows) => {
      const metric = rows.find((row) => row.id === id);
      return count + (metric?.failingCount ?? 0) + (metric?.errorCount ?? 0);
    }, 0);
    return attention(b) - attention(a) || aLabel.localeCompare(bLabel);
  });
  if (!metrics.length) return <p role="status" className="text-sm text-muted-foreground">No evaluator results recorded. Operational measurements do not establish answer quality.</p>;
  return (
    <div className="grid gap-4">
      <SearchField value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search evaluators" label="Search evaluators" />
      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full min-w-[36rem] text-left text-sm" aria-label="Evaluator comparison">
          <thead className="border-b bg-muted/20"><tr>
            <th scope="col" className="px-4 py-3">Evaluator</th>
            {runs.map((run, index) => <th key={run.run_id} scope="col" className="px-4 py-3">{labels[index] ?? `Run ${index + 1}`}</th>)}
          </tr></thead>
          <tbody className="divide-y">{!metrics.some(([id, label]) => `${id} ${label}`.toLowerCase().includes(query.trim().toLowerCase())) ? <tr><td colSpan={runs.length + 1} className="px-4 py-6 text-muted-foreground">No evaluators match your search.</td></tr> : null}{metrics.filter(([id, label]) => `${id} ${label}`.toLowerCase().includes(query.trim().toLowerCase())).map(([id, label]) => <tr key={id}>
            <th scope="row" className="px-4 py-3 align-top font-medium capitalize">{label}</th>
            {runs.map((run, index) => {
              const metric = summaries[index].find((row) => row.id === id);
              if (!metric) return <td key={run.run_id} className="px-4 py-3 align-top text-muted-foreground">Not recorded</td>;
              const scored = metric.results.filter((result) => metricResultIsScored(result) && result.normalised_score !== null && result.metric_applicability !== "not_applicable");
              const judged = scored.filter((result) => result.threshold_result != null);
              const passed = judged.filter((result) => result.threshold_result === "pass").length;
              return <td key={run.run_id} className="space-y-1 px-4 py-3 align-top tabular-nums">
                <p className="font-medium">{metric.mean == null ? "Not scored" : `${(metric.mean * 100).toFixed(1)}% average`}</p>
                <p className="text-xs">{judged.length ? `${passed} / ${judged.length} passed` : "No verdict"}</p>
                <p className="text-xs text-muted-foreground">{scored.length} / {metric.totalCases || "—"} recorded cases scored</p>
                {metric.errorCount ? <p className="text-xs font-medium text-destructive">{metric.errorCount} scoring {metric.errorCount === 1 ? "error" : "errors"}</p> : null}
              </td>;
            })}
          </tr>)}</tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">Pass counts include only results with a verdict. Missing or errored results are not zero scores. Coverage uses cases recorded in these results, not the full dataset size.</p>
    </div>
  );
}
