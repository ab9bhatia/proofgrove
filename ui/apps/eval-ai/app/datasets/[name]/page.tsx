"use client";

import { PAGE_FRAME } from "@/lib/page-frame";
import { Suspense, useCallback, useEffect, useState } from "react";
import { LONG_LIST_PER_PAGE } from "@/lib/pagination";
import { Check, X } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Button } from "@evalai/shared/ui/button";
import { OverlayConfirmDialog } from "@/components/ui/confirm-dialog";
import { nextTabIndexForKey } from "@/components/ui/tabs";
import { cn } from "@evalai/shared/utils";
import {
  api,
  fullName,
  type DatasetInfo,
  type DatasetRecord,
  type ValidationResult,
} from "@/lib/api";
import { ApiError, userFacingError } from "@/lib/api-errors";
import {
  DatasetDetailHeader,
  type DatasetDetailAction,
} from "@/components/dataset-detail-header";
import { DatasetValidationEmptyState } from "@/components/dataset-validation-empty-state";
import { DatasetRecordMetadata, MetadataJsonDialog, metadataLabel, metadataValueText } from "@/components/dataset-record-metadata";
import { EvalHubGate } from "@/components/eval-hub-gate";
import { ErrorState, LoadingState } from "@/components/page-state";
import { recordMetadata } from "@/lib/dataset-csv";
import { DatasetEvidenceGuide, SuppliedResponse, datasetPreviewRow } from "@/components/evaluation/dataset-preview-table";
import { useUIState } from "@/components/ui-state";

const ACTIONS: Record<string, DatasetDetailAction[]> = {
  DRAFT: [{ label: "Run validation", action: "validate" }],
  VALIDATED: [
    { label: "Approve", action: "approve" },
    { label: "Reject", action: "reject", variant: "destructive" },
  ],
  APPROVED: [{ label: "Publish", action: "publish" }],
  PUBLISHED: [{ label: "Deprecate", action: "deprecate" }],
  DEPRECATED: [{ label: "Retire", action: "retire" }],
  REJECTED: [
    { label: "Return to draft", action: "reopen", variant: "outline" },
    { label: "Create draft version", action: "create-version", variant: "outline" },
  ],
  RETIRED: [{ label: "Restore as editable draft", action: "restore-draft" }],
};

type Tab = "records" | "validation" | "history";

/** Page size for the server-paged records table. */
export const RECORDS_PAGE_SIZE = LONG_LIST_PER_PAGE;

/**
 * Honest failure copy for the dataset read. A 404 means the dataset id in the
 * URL does not exist in this workspace (deleted, renamed, or another
 * workspace's link) — say that clearly instead of a generic failure.
 */
export function datasetLoadAlert(
  reason: unknown,
  name: string,
): { kind: "missing" | "error"; title: string; message: string } {
  if (reason instanceof ApiError && reason.status === 404) {
    return {
      kind: "missing",
      title: "Dataset not found",
      message: `Dataset "${name}" was not found in this workspace. It may have been deleted or renamed, or the link may belong to another workspace.`,
    };
  }
  return {
    kind: "error",
    title: "Unable to load this dataset",
    message: userFacingError(reason, "The dataset service did not respond. Try again shortly."),
  };
}

export default function DatasetDetailPage() {
  return (
    <EvalHubGate>
      <Suspense fallback={<LoadingState label="Loading dataset…" className="min-h-48" />}>
        <DatasetDetail />
      </Suspense>
    </EvalHubGate>
  );
}

function DatasetDetail() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const name = typeof params.name === "string" ? decodeURIComponent(params.name) : "";
  const { fullName: actorName } = useUIState();

  const [ds, setDs] = useState<DatasetInfo | null>(null);
  const [loadAlert, setLoadAlert] = useState<ReturnType<typeof datasetLoadAlert> | null>(null);
  const [records, setRecords] = useState<DatasetRecord[]>([]);
  const [metadataRecord, setMetadataRecord] = useState<{ record: DatasetRecord; label: string; question: string } | null>(null);
  const [metadataColumns, setMetadataColumns] = useState<string[]>([]);
  const hasSuppliedResponses = records.some((record) => datasetPreviewRow(record, 0).response != null);
  const availableMetadataColumns = [...new Set(records.flatMap((record) => Object.entries(recordMetadata(record)).filter(([key, value]) => key !== "response" && value !== null && typeof value !== "object").map(([key]) => key)))].sort();
  const visibleMetadataColumns = availableMetadataColumns.filter((key) => metadataColumns.includes(key));
  const [recordsTotal, setRecordsTotal] = useState<number | null>(null);
  const [recordsError, setRecordsError] = useState<string | null>(null);
  const [recordsLoadingMore, setRecordsLoadingMore] = useState(false);
  const [history, setHistory] = useState<Record<string, unknown>[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingDecision, setPendingDecision] = useState<string | null>(null);
  const [newVersionName, setNewVersionName] = useState("");
  const [tab, setTab] = useState<Tab>(() => {
    const requested = searchParams.get("tab");
    return requested === "validation" || requested === "history" ? requested : "records";
  });

  function selectTab(next: Tab) {
    setTab(next);
    const query = new URLSearchParams(window.location.search);
    if (next === "records") query.delete("tab");
    else query.set("tab", next);
    window.history.replaceState(null, "", `${window.location.pathname}${query.size ? `?${query}` : ""}`);
  }

  const load = useCallback(() => {
    if (!name) return Promise.resolve();
    setLoadAlert(null);
    // Records and history failures are tracked per-section (never rendered as
    // a fake "no records"/"no history" empty state); only the dataset read
    // itself failing replaces the whole page.
    return Promise.all([
      api.getDataset(name),
      api
        .getRecordsPage(name, { limit: RECORDS_PAGE_SIZE })
        .then((page) => ({ page, error: null as string | null }))
        .catch((reason) => ({
          page: null,
          error: userFacingError(reason, "Dataset records could not be loaded."),
        })),
      api
        .getHistory(name)
        .then((entries) => ({ entries, error: null as string | null }))
        .catch((reason) => ({
          entries: null,
          error: userFacingError(reason, "Version history could not be loaded."),
        })),
    ])
      .then(([info, recs, hist]) => {
        setDs(info);
        setRecords(recs.page?.items ?? []);
        setRecordsTotal(recs.page ? recs.page.total : null);
        setRecordsError(recs.error);
        setHistory(hist.entries ?? []);
        setHistoryError(hist.error);
      })
      .catch((reason) => {
        setDs(null);
        setLoadAlert(datasetLoadAlert(reason, name));
      })
      .finally(() => setLoading(false));
  }, [name]);

  const loadMoreRecords = useCallback(() => {
    if (!name || recordsLoadingMore) return;
    setRecordsLoadingMore(true);
    api
      .getRecordsPage(name, { limit: RECORDS_PAGE_SIZE, offset: records.length })
      .then((page) => {
        setRecords((current) => [...current, ...page.items]);
        setRecordsTotal(page.total);
      })
      .catch((reason) => {
        setError(userFacingError(reason, "More records could not be loaded. Try again."));
      })
      .finally(() => setRecordsLoadingMore(false));
  }, [name, records.length, recordsLoadingMore]);

  useEffect(() => {
    const id = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(id);
  }, [load]);

  const runAction = async (action: string) => {
    if (action !== "validate") {
      if (action === "create-version") setNewVersionName(`${name.replace(/_v\d+$/i, "")}_v${(ds?.version_number || 1) + 1}`);
      setPendingDecision(action);
      return;
    }
    setActionLoading(action);
    setError(null);
    try { setValidation(await api.validate(name)); selectTab("validation"); await load(); }
    catch (reason) { setError(userFacingError(reason, "Validation failed")); }
    finally { setActionLoading(null); }
  };

  const confirmDecision = async () => {
    const action = pendingDecision;
    if (!action) return;
    if (action === "create-version" && !newVersionName.trim()) { setError("Enter a name for the draft version."); return; }
    setActionLoading(action);
    setError(null);
    try {
      if (action === "approve") await api.approve(name, actorName);
      else if (action === "reject") await api.reject(name, actorName);
      else if (action === "reopen") await api.reopen(name, actorName);
      else if (action === "publish") await api.publish(name);
      else if (action === "deprecate") await api.deprecate(name);
      else if (action === "retire") await api.retire(name);
      else if (action === "delete") { await api.deleteDataset(name); router.push("/datasets"); return; }
      else if (action === "restore-draft" || action === "create-version") {
        const created = action === "restore-draft"
          ? await api.restoreDataset(name, actorName)
          : await api.createVersion(name, {source_dataset_name: name, new_dataset_name: newVersionName.trim(), change_reason: "content_update", created_by: actorName});
        setPendingDecision(null);
        router.push(`/datasets/${encodeURIComponent(fullName(created))}`);
        return;
      }
      setPendingDecision(null);
      await load();
    } catch (reason) { setError(userFacingError(reason, "Dataset action failed")); }
    finally { setActionLoading(null); }
  };

  const del = () => setPendingDecision("delete");
  const decisionLabel = Object.values(ACTIONS).flat().find((item) => item.action === pendingDecision)?.label || "Delete dataset";
  const decisionExplanation: Record<string, string> = {
    publish: "Make this approved version available for evaluations. Deprecate it later to stop new use.",
    deprecate: "Stop recommending this version for new evaluations. Existing run evidence remains available.",
    retire: "Remove this version from active use. You can restore its records as a new editable draft.",
    "restore-draft": "Copy the records into a new editable draft. This retired version stays unchanged; the new draft can be deleted.",
    "create-version": "Create an empty draft version. Records are not copied. You can delete the draft if it is not needed.",
    delete: "Delete this dataset permanently. This cannot be undone.",
    approve: "Record approval of this validated dataset.",
    reject: "The dataset will need changes before it can be approved.",
    reopen: "Return this rejected dataset to an editable draft.",
  };

  const onUpload = async (file: File) => {
    setError(null);
    try {
      await api.uploadCsv(name, file);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    }
  };

  if (loading) {
    return <LoadingState label="Loading dataset…" className="min-h-72" />;
  }
  if (!ds) {
    const alert = loadAlert ?? datasetLoadAlert(null, name);
    return (
      <div className={PAGE_FRAME}>
        <div className="mb-4 text-sm">
          <Link href="/datasets" className="text-primary hover:underline">
            Datasets
          </Link>
          <span className="mx-1 text-muted-foreground">/</span>
          <span className="font-semibold">{name}</span>
        </div>
        <ErrorState
          title={alert.title}
          message={alert.message}
          onRetry={alert.kind === "missing" ? undefined : () => void load()}
          className="min-h-56"
        />
        <p className="mt-4 text-center text-sm">
          <Link href="/datasets" className="text-primary hover:underline">
            Back to the dataset library
          </Link>
        </p>
      </div>
    );
  }

  const displayStatus = ds.status;
  const actions = ACTIONS[displayStatus] ?? [];
  const canUpload = ds.status === "DRAFT";

  return (
    <div className={PAGE_FRAME}>
      <div className="mb-4 text-sm">
        <Link href="/datasets" className="text-primary hover:underline">
          Datasets
        </Link>
        <span className="mx-1 text-muted-foreground">/</span>
        <span className="font-semibold">{fullName(ds)}</span>
      </div>

      <DatasetDetailHeader
        dataset={ds}
        displayName={fullName(ds)}
        displayStatus={displayStatus}
        recordCount={recordsTotal ?? records.length}
        actions={actions}
        actionLoading={actionLoading}
        onAction={(action) => void runAction(action)}
        onDelete={ds.status === "DRAFT" ? () => void del() : undefined}
        evaluateHref={
          displayStatus === "PUBLISHED"
            ? `/evaluate?dataset=${encodeURIComponent(fullName(ds))}`
            : undefined
        }
      />

      {error && (
        <div className="mb-6 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}

      {canUpload && (
        <label className="mb-6 flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed border-foreground/30 bg-muted/40 p-6 text-center transition-colors hover:border-primary/70 hover:bg-primary/5 focus-within:border-primary/70 focus-within:ring-2 focus-within:ring-primary/25">
          <input
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onUpload(f);
            }}
          />
          <span className="text-sm text-foreground/80">
            Drop or click to upload a <span className="font-mono">.csv</span> with columns{" "}
            <span className="font-mono">Serial No, Question, Expected Output, Risk</span>
          </span>
        </label>
      )}

      <div className="mb-4 flex gap-0 border-b" role="tablist" aria-label="Dataset details">
        {(["records", "validation", "history"] as const).map((t, index, tabs) => (
          <button
            key={t}
            id={`dataset-tab-${t}`}
            type="button"
            role="tab"
            aria-selected={tab === t}
            aria-controls={`dataset-panel-${t}`}
            tabIndex={tab === t ? 0 : -1}
            onClick={() => selectTab(t)}
            onKeyDown={(event) => {
              const nextIndex = nextTabIndexForKey(event.key, index, tabs.length);
              if (nextIndex === null) return;
              event.preventDefault();
              const next = tabs[nextIndex];
              selectTab(next);
              document.getElementById(`dataset-tab-${next}`)?.focus();
            }}
            className={cn(
              "-mb-px min-h-11 border-b-2 px-4 py-2 text-sm font-medium capitalize focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              tab === t ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "records" && (
        <div id="dataset-panel-records" role="tabpanel" aria-labelledby="dataset-tab-records" className="rounded-md border bg-card">
          {records.length ? <div className="px-4 py-4"><DatasetEvidenceGuide supplied={hasSuppliedResponses} /></div> : null}
          {records.length ? <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3"><p className="text-sm text-muted-foreground">{records.length} loaded {records.length === 1 ? "record" : "records"}{recordsTotal !== null ? ` of ${recordsTotal}` : ""}</p><details className="relative" onKeyDown={(event) => { if (event.key === "Escape") { event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); } }}><summary className="flex min-h-10 cursor-pointer items-center rounded-lg border px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Columns</summary><fieldset className="absolute right-0 top-full z-20 mt-1 max-h-80 w-64 overflow-auto rounded-lg border bg-popover p-3 shadow-lg"><legend className="sr-only">Optional metadata columns</legend><p className="mb-2 text-xs text-muted-foreground">Show metadata fields as columns. Input and expected output stay visible.</p>{availableMetadataColumns.length ? availableMetadataColumns.map((key) => <label key={key} className="flex min-h-10 items-center gap-2 break-words text-sm"><input type="checkbox" checked={metadataColumns.includes(key)} onChange={() => setMetadataColumns((current) => current.includes(key) ? current.filter((value) => value !== key) : [...current, key])} />{metadataLabel(key)}</label>) : <p className="text-sm text-muted-foreground">No additional fields recorded.</p>}</fieldset></details></div> : null}
          {ds.missing_row_fields?.length ? <p role="status" className="border-b bg-state-caution-soft px-4 py-3 text-sm">Some rows are missing: {ds.missing_row_fields.join(", ")}. Review these fields before evaluation.</p> : null}
          {recordsError ? (
            <ErrorState
              title="Records unavailable"
              message={recordsError}
              onRetry={() => void load()}
              className="m-5 min-h-44"
            />
          ) : records.length === 0 ? (
            <div className="py-12 text-center text-muted-foreground">No records yet</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full table-fixed text-sm" style={{ minWidth: `${48 + visibleMetadataColumns.length * 12 + (hasSuppliedResponses ? 18 : 0)}rem` }}>
                <caption className="sr-only">Dataset records</caption>
                <colgroup><col className="w-20" /><col /><col />{hasSuppliedResponses ? <col className="w-72" /> : null}{visibleMetadataColumns.map((key) => <col key={key} className="w-48" />)}<col className="w-72" /></colgroup>
                <thead>
                  <tr className="border-b bg-muted/50 text-xs text-muted-foreground">
                    <th className="px-4 py-2 text-left font-medium">Record</th>
                    <th className="px-4 py-2 text-left font-medium">Input</th>
                    <th className="px-4 py-2 text-left font-medium">Expected output / reference</th>
                    {hasSuppliedResponses ? <th scope="col" className="px-4 py-2 text-left font-medium">Supplied response</th> : null}
                    {visibleMetadataColumns.map((key) => <th key={key} scope="col" className="px-4 py-2 text-left font-medium">{metadataLabel(key)}</th>)}
                    <th className="px-4 py-2 text-left font-medium">Metadata / tags</th>
                  </tr>
                </thead>
                <tbody>
                  {records.map((r, i) => {
                    const row = datasetPreviewRow(r, i);
                    return (
                      <tr key={i} className="border-b last:border-b-0 hover:bg-muted/50">
                        <td className="px-4 py-2 align-top font-mono text-xs text-muted-foreground">{row.serialNo}</td>
                        <td className="break-words px-4 py-2 align-top whitespace-pre-wrap">{row.question || "Question not recorded"}</td>
                        <td className="break-words px-4 py-2 align-top whitespace-pre-wrap">{row.expectedOutput || "Reference answer not recorded"}</td>
                        {hasSuppliedResponses ? <td className="break-words px-4 py-2 align-top whitespace-pre-wrap"><SuppliedResponse row={row} /></td> : null}
                        {visibleMetadataColumns.map((key) => <td key={key} className="break-words px-4 py-2 align-top">{metadataValueText(key, recordMetadata(r)[key])}</td>)}
                        <td className="max-w-xs px-4 py-2 align-top">
                          <DatasetRecordMetadata hiddenKeys={[...visibleMetadataColumns, "response"]} record={r} recordLabel={`record ${row.serialNo}`} onViewJson={() => setMetadataRecord({ record: r, label: `Record ${row.serialNo}`, question: row.question })} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {recordsTotal !== null && records.length < recordsTotal ? (
                <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3">
                  <p className="text-xs text-muted-foreground" aria-live="polite">
                    Showing {records.length} of {recordsTotal} records.
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={recordsLoadingMore}
                    onClick={loadMoreRecords}
                  >
                    {recordsLoadingMore ? "Loading more…" : "Load more records"}
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </div>
      )}

      {tab === "validation" && (
        <div id="dataset-panel-validation" role="tabpanel" aria-labelledby="dataset-tab-validation" className="rounded-md border bg-card p-6">
          {!validation ? (
            <DatasetValidationEmptyState
              apiStatus={ds.status}
              displayStatus={displayStatus}
              actionLoading={actionLoading}
              onValidate={() => void runAction("validate")}
            />
          ) : (
            <div>
              <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-4">
                  <div
                    className={cn(
                      "font-mono text-3xl font-semibold",
                      validation.passed ? "text-gate-pass" : "text-gate-fail",
                    )}
                  >
                    {(validation.dqs * 100).toFixed(0)}%
                  </div>
                  <div>
                    <p className={cn("text-sm font-semibold", validation.passed ? "text-gate-pass" : "text-gate-fail")}>
                      {validation.passed ? "Passed" : "Failed"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Target: <span className="font-mono">{validation.target_status}</span>
                    </p>
                  </div>
                </div>
                {displayStatus === "VALIDATED" ? (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      disabled={actionLoading !== null}
                      onClick={() => runAction("approve")}
                    >
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={actionLoading !== null}
                      onClick={() => runAction("reject")}
                    >
                      Reject
                    </Button>
                  </div>
                ) : null}
              </div>
              <div className="space-y-2">
                {validation.checks.map((c) => (
                  <div
                    key={c.name}
                    className={cn(
                      "flex items-center justify-between rounded-md border p-3",
                      c.passed
                        ? "border-gate-pass/30 bg-gate-pass-soft"
                        : "border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950",
                    )}
                  >
                    <div className="flex items-center gap-2">
                      {/* Icons, not the ✓/✗ dingbats: the brand draws glyphs from
                          the icon set, and a bare character renders in whatever
                          the system font offers. aria-hidden because the check's
                          name and message beside it already carry the outcome. */}
                      {c.passed ? (
                        <Check className="size-4 shrink-0 text-gate-pass" aria-hidden="true" />
                      ) : (
                        <X className="size-4 shrink-0 text-gate-fail" aria-hidden="true" />
                      )}
                      <div>
                        <p className="font-mono text-sm font-medium">{c.name}</p>
                        <p className="text-xs text-muted-foreground">{c.message}</p>
                      </div>
                    </div>
                    <span className="font-mono text-sm font-semibold">{(c.score * 100).toFixed(0)}%</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {tab === "history" && (
        <div id="dataset-panel-history" role="tabpanel" aria-labelledby="dataset-tab-history" className="overflow-hidden rounded-md border bg-card">
          {historyError ? (
            <ErrorState
              title="Version history unavailable"
              message={historyError}
              onRetry={() => void load()}
              className="m-5 min-h-44"
            />
          ) : history.length === 0 ? (
            <div className="py-12 text-center text-muted-foreground">No history entries</div>
          ) : (
            <div className="divide-y">
              {history.map((h, i) => (
                <div key={i} className="px-4 py-3 text-sm">
                  <span className="font-mono text-xs text-muted-foreground">
                    {h.timestamp ? new Date(String(h.timestamp)).toLocaleString() : `Entry ${i + 1}`}
                  </span>
                  <span className="ml-2 text-xs font-medium">{String(h.operation ?? "Dataset updated").replace("STATUS:", "Status changed to ")}</span>
                  <p className="mt-1 text-xs text-muted-foreground">By {String(h.actor || h.created_by || (h.operation === "CREATE" ? ds.created_by : null) || "Not recorded")}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {metadataRecord ? <MetadataJsonDialog record={metadataRecord.record} recordLabel={metadataRecord.label} question={metadataRecord.question} onClose={() => setMetadataRecord(null)} /> : null}

      {pendingDecision ? (
        <OverlayConfirmDialog
          tone={["reject", "delete", "retire"].includes(pendingDecision) ? "destructive" : "default"}
          title={`${decisionLabel}?`}
          description={<div className="space-y-3"><p>{decisionExplanation[pendingDecision]}</p><p>Dataset: <strong className="break-all">{name}</strong></p>{pendingDecision === "create-version" ? <label className="block">Draft name<input value={newVersionName} onChange={(event) => setNewVersionName(event.target.value)} className="mt-1 w-full rounded-lg border bg-background p-2" /></label> : null}{error ? <p role="alert" className="text-destructive">{error}</p> : null}</div>}
          confirmLabel={decisionLabel}
          pendingLabel="Saving decision…"
          pending={actionLoading === pendingDecision}
          onCancel={() => setPendingDecision(null)}
          onConfirm={() => void confirmDecision()}
        />
      ) : null}
    </div>
  );
}
