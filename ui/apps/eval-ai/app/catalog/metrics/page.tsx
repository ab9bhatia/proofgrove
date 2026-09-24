"use client";

import { ROWS_PER_PAGE } from "@/lib/pagination";
import { TablePagination } from "@/components/table-pagination";
import { PAGE_FRAME, COLUMN_HEADER } from "@/lib/page-frame";
import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@evalai/shared/ui/button";
import { EvalHubGate } from "@/components/eval-hub-gate";
import { MetricCatalogCard } from "@/components/metric-catalog-card";
import { MetricCatalogFilters } from "@/components/catalog/metric-catalog-filters";
import { PageHeader } from "@/components/page-header";
import { evaluationApi, type MetricCatalogEntry } from "@/lib/api";
import { userFacingError } from "@/lib/api-errors";
import { Chip } from "@/components/status-badge";

export default function MetricCatalogPage() {
  return (
    <EvalHubGate>
      <MetricCatalog />
    </EvalHubGate>
  );
}

function MetricCatalog() {
  const [metrics, setMetrics] = useState<MetricCatalogEntry[]>([]);
  const [page, setPage] = useState(1);
  const pageSize = ROWS_PER_PAGE;
  const [query, setQuery] = useState("");
  const [scenario, setScenario] = useState("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setMetrics(await evaluationApi.listMetrics());
    } catch (cause) {
      setError(userFacingError(cause, "Failed to load the Metric Catalog"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    evaluationApi
      .listMetrics()
      .then((items) => {
        if (!cancelled) setMetrics(items);
      })
      .catch((cause) => {
        if (!cancelled) setError(userFacingError(cause, "Failed to load the Metric Catalog"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const visibleMetrics = useMemo(() => {
    const search = query.trim().toLowerCase();
    return metrics.filter((metric) => {
      if (scenario !== "all" && metric.scenario && metric.scenario !== scenario) return false;
      if (!search) return true;
      return [metric.name, metric.metric_id, metric.description, metric.scoring_type, metric.default_adapter, ...(metric.kpi_ids ?? [])]
        .join(" ")
        .toLowerCase()
        .includes(search);
    });
  }, [metrics, query, scenario]);

  const pageCount = Math.max(1, Math.ceil(visibleMetrics.length / pageSize));
  const currentPage = Math.min(page, pageCount);

  return (
    <div className={PAGE_FRAME}>
      <PageHeader
        section="Configure"
        title="Checks"
        description="Explore the scoring metrics available for Agent, RAG, and LLM evaluations. Shared metrics remain visible across applicable evaluation types."
        actions={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void load()}
            disabled={loading}
          >
          <RefreshCw className={`mr-2 size-4 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
            {loading ? "Refreshing…" : "Refresh"}
          </Button>
        }
      />

      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Metric library</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Compare applicability and scoring requirements before configuring an evaluation.
          </p>
        </div>
        {!loading ? (
          <Chip size="md">
            {visibleMetrics.length} of {metrics.length} {metrics.length === 1 ? "metric" : "metrics"}
          </Chip>
        ) : null}
      </div>

      <section className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <MetricCatalogFilters
        metrics={metrics}
        query={query}
        scenario={scenario}
        onQueryChange={(value) => { setQuery(value); setPage(1); }}
        onScenarioChange={(value) => { setScenario(value); setPage(1); }}
      />

      {error ? <div role="alert" className="mb-5 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">{error}</div> : null}
      {loading ? (
        <div role="status" aria-label="Loading metrics" className="flex justify-center py-16"><div className="h-5 w-5 animate-spin rounded-full border-2 border-muted border-t-primary" /></div>
      ) : visibleMetrics.length === 0 ? (
        <div className="rounded-xl border border-dashed py-14 text-center text-sm text-muted-foreground">No metrics match the selected filters. <button type="button" className="ml-2 rounded px-2 py-2 font-medium text-brand-text focus-visible:ring-2 focus-visible:ring-ring" onClick={() => { setQuery(""); setScenario("all"); }}>Clear filters</button></div>
      ) : (
        <div className="overflow-x-auto">
          <div className={`grid min-w-[700px] grid-cols-[minmax(0,2fr)_8rem_9rem_5rem] gap-3 ${COLUMN_HEADER}`}><span>Metric</span><span>Evaluation type</span><span>Scoring</span><span>Details</span></div>
          {visibleMetrics.slice((currentPage - 1) * pageSize, currentPage * pageSize).map((metric) => (
            <MetricCatalogCard key={metric.metric_id} metric={metric} />
          ))}
        </div>
      )}
      {!loading && !error ? <TablePagination total={visibleMetrics.length} page={currentPage} onPageChange={setPage} label="metrics" /> : null}
      </section>
    </div>
  );
}
