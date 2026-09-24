import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Button, buttonVariants } from "@evalai/shared/ui/button";
import { DatasetStageStepper } from "@/components/dataset-stage-stepper";
import { StatusBadge } from "@/components/status-badge";
import type { DatasetInfo } from "@/lib/api";

export type DatasetDetailAction = {
  label: string;
  action: string;
  variant?: "default" | "outline" | "destructive";
};

export function DatasetDetailHeader({
  dataset,
  displayName,
  displayStatus,
  recordCount,
  actions,
  actionLoading,
  onAction,
  onDelete,
  evaluateHref,
}: {
  dataset: DatasetInfo;
  displayName: string;
  displayStatus: string;
  recordCount: number;
  actions: DatasetDetailAction[];
  actionLoading: string | null;
  onAction: (action: string) => void;
  onDelete?: () => void;
  evaluateHref?: string;
}) {
  const summary = [
    { label: "Product", value: dataset.product_id || "—" },
    // Prefer the live records total (from the paged records read) — the
    // dataset info payload's record_count is not reliably populated.
    { label: "Records", value: String(recordCount ?? dataset.record_count ?? 0) },
    { label: "Data quality", value: dataset.dqs == null ? "Not run" : `${(dataset.dqs * 100).toFixed(0)}%` },
  ];

  return (
    <section className="mb-6 overflow-hidden rounded-xl border bg-card shadow-sm" aria-labelledby="dataset-title">
      <div className="flex flex-col gap-5 px-5 py-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            Dataset
          </p>
          <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-2.5">
            <h1 id="dataset-title" className="min-w-0 truncate text-2xl font-semibold tracking-tight" title={displayName}>
              {displayName}
            </h1>
            <StatusBadge status={displayStatus} />
            <span className="rounded-lg bg-muted px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
              v{dataset.version_number}
            </span>
          </div>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {dataset.tenant_id}
            {dataset.product_id ? ` / ${dataset.product_id}` : ""}
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap gap-2">
          {evaluateHref ? (
            <Link href={evaluateHref} className={buttonVariants({ size: "sm" })}>
              Evaluate dataset
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          ) : null}
          {actions.map(({ label, action, variant }) => (
            <Button
              key={action}
              size="sm"
              variant={variant ?? "default"}
              disabled={actionLoading !== null}
              onClick={() => onAction(action)}
            >
              {actionLoading === action ? "…" : label}
            </Button>
          ))}
          {onDelete ? (
            <Button size="sm" variant="outline" onClick={onDelete}>
              Delete
            </Button>
          ) : null}
        </div>
      </div>

      <div className="border-t bg-muted/5 px-5 py-3">
        <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Lifecycle
        </p>
        <div className="mt-2">
          <DatasetStageStepper status={displayStatus} />
        </div>
      </div>

      {!["PUBLISHED", "DEPRECATED", "RETIRED"].includes(displayStatus) ? (
        <div className="border-t border-state-caution/30 bg-state-caution-soft px-5 py-2.5 text-xs leading-5 text-state-caution dark:border-state-caution/30 dark:bg-state-caution-soft dark:text-state-caution">
          Only published datasets can be selected for an evaluation. Complete this lifecycle and
          publish the version when it is ready to test.
        </div>
      ) : null}

      {displayStatus === "RETIRED" ? (
        <div className="border-t border-state-caution/30 bg-state-caution-soft px-5 py-2.5 text-xs text-state-caution dark:border-state-caution/30 dark:bg-state-caution-soft dark:text-state-caution">
          This retired version remains read-only. Restore it as an editable draft to copy its
          records into the next version, then edit or validate there.
        </div>
      ) : null}

      <dl className="grid grid-cols-2 border-t bg-muted/10 sm:grid-cols-4">
        {summary.map((item, index) => (
          <div
            key={item.label}
            className={[
              "px-5 py-3",
              index % 2 === 0 ? "border-r" : "",
              index >= 2 ? "border-t sm:border-t-0" : "",
              index < summary.length - 1 ? "sm:border-r" : "",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            <dt className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {item.label}
            </dt>
            <dd className="mt-0.5 truncate text-sm font-medium text-foreground" title={item.value}>
              {item.value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
