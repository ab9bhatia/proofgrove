"use client";

import { PAGE_FRAME } from "@/lib/page-frame";
import { Suspense, useCallback, useEffect, useState } from "react";
import { Plus, RefreshCw } from "lucide-react";
import { Button } from "@evalai/shared/ui/button";
import { cn } from "@evalai/shared/utils";
import { api, type DatasetInfo } from "@/lib/api";
import { userFacingError } from "@/lib/api-errors";
import { EvalHubGate } from "@/components/eval-hub-gate";
import { DatasetActions } from "@/components/dataset-actions";
import { DatasetLibrary } from "@/components/dataset-library";
import { PageHeader } from "@/components/page-header";

export default function DatasetsPage() {
  return (
    <Suspense>
      <EvalHubGate>
        <DatasetsList />
      </EvalHubGate>
    </Suspense>
  );
}

export function DatasetsList() {
  const [datasets, setDatasets] = useState<DatasetInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addDatasetOpen, setAddDatasetOpen] = useState(false);

  // The library is small enough (117 datasets today) to load whole and filter,
  // sort and page on the client — the same shape as ExperimentsLibrary/runs,
  // rather than a second server-paged scheme with its own edge cases.
  const load = useCallback((opts?: { manual?: boolean }) => {
    if (opts?.manual) setRefreshing(true);
    else setLoading(true);
    setError(null);
    api
      .tenant()
      .then(({ tenant_id }) => api.listDatasets({ tenant_id }))
      .then(setDatasets)
      .catch((reason) => {
        setDatasets([]);
        setError(userFacingError(reason, "The dataset service did not respond."));
      })
      .finally(() => {
        setLoading(false);
        setRefreshing(false);
      });
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => load(), 0);
    return () => window.clearTimeout(id);
  }, [load]);

  return (
    <div className={PAGE_FRAME}>
      <PageHeader
        section="Workspace"
        title="Golden dataset"
        description="Generate, import, or reuse evaluation datasets and move them through review."
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label="Refresh datasets"
              onClick={() => load({ manual: true })}
              disabled={refreshing || loading}
            >
              <RefreshCw className={cn("size-4", refreshing && "animate-spin")} aria-hidden="true" />
            </Button>
            <Button type="button" size="sm" onClick={() => setAddDatasetOpen(true)}>
              <Plus className="size-4" aria-hidden="true" />
              Add dataset
            </Button>
          </>
        }
      />

      <DatasetActions open={addDatasetOpen} onOpenChange={setAddDatasetOpen} onCreated={load} />
      <div className="mb-5 flex flex-wrap gap-4 rounded-lg border border-border bg-card p-4 text-sm"><a href="/samples/nova-refunds-golden.csv" download className="font-semibold text-brand-text underline">Download refund sample CSV</a><a href="/samples/generate-refund-dataset.txt" download className="text-brand-text underline">Download dataset-generation prompt</a><span className="text-muted-foreground">8 synthetic cases. Add dataset → Import CSV, then validate, review and publish.</span></div>

      <DatasetLibrary datasets={datasets} loading={loading} error={error} onChanged={load} />
    </div>
  );
}
