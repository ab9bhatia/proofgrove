"use client";

import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { evaluationApi } from "@/lib/api";
import { ApiError } from "@/lib/api-errors";
import { CopyableId } from "@/components/copyable-id";

/**
 * Workspace-safe deep link from a captured trace to its run report case.
 * Only call when the run item is readable in the current workspace.
 */
export function runReportLineageHref(runId: string, exampleId: string): string {
  return `/runs/${encodeURIComponent(runId)}?item=${encodeURIComponent(exampleId)}`;
}

export const RUN_REPORT_LINEAGE_LABEL = "Open run report";
export const RUN_UNREADABLE_EXPLANATION =
  "This run belongs to another workspace";

/** Run readability stamped with the trace it was resolved against. */
export type ResolvedTraceReadability = { traceId: string; readable: boolean } | null;

/**
 * What a failed `getRunItem` proves about run readability.
 *
 * `GET /runs/{run_id}/items/{example_id}` answers 404 for two different facts:
 * the run is not readable in this workspace, or the run IS readable and only
 * this case is absent from it. The item endpoint cannot tell them apart, so a
 * 404 is settled against the run endpoint itself: a readable run keeps its
 * link (only the case is missing), and a 404/403 there is the genuine
 * workspace boundary.
 *
 * A 403 on the item is already a boundary. Every other failure (500, 503,
 * network) — on either call — is transient and proves nothing, so readability
 * stays unresolved (`null`) rather than asserting "this run belongs to another
 * workspace" about a backend hiccup.
 */
export async function resolveRunReadability(
  reason: unknown,
  runId: string,
  tenantId: string,
): Promise<boolean | null> {
  if (!(reason instanceof ApiError)) return null;
  if (reason.status === 403) return false;
  if (reason.status !== 404) return null;
  try {
    await evaluationApi.getRun(runId, tenantId);
    return true;
  } catch (runReason) {
    if (runReason instanceof ApiError && (runReason.status === 404 || runReason.status === 403)) {
      return false;
    }
    return null;
  }
}

/**
 * Readability of `traceId`'s run, or null when it is still unresolved — a
 * result resolved for a different (previously opened) trace says nothing about
 * this one, so it must not be reused.
 */
export function readabilityForTrace(
  traceId: string,
  resolved: ResolvedTraceReadability,
): boolean | null {
  return resolved && resolved.traceId === traceId ? resolved.readable : null;
}

/**
 * Trace→run lineage affordance: link when the run item is readable, otherwise
 * a copyable Run ID with a one-line workspace explanation (no dead link).
 *
 * `readable` is tri-state: `null` means readability is not resolved for the
 * trace being shown yet, and nothing is rendered — a stale flag from a
 * previously opened trace must never link out to another workspace's run.
 */
export function RunLineageCta({
  runId,
  exampleId,
  readable,
  className,
}: {
  runId: string | null;
  exampleId: string | null;
  readable: boolean | null;
  className?: string;
}) {
  if (readable == null || !runId || !exampleId) return null;

  if (readable) {
    return (
      <Link
        className={
          className ??
          "inline-flex shrink-0 items-center gap-2 rounded-lg border px-3 py-2 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        }
        href={runReportLineageHref(runId, exampleId)}
      >
        {RUN_REPORT_LINEAGE_LABEL}{" "}
        <ExternalLink className="size-3.5" aria-hidden="true" />
      </Link>
    );
  }

  return (
    <div
      className={
        className ??
        "flex max-w-sm flex-col items-end gap-1 text-right sm:max-w-md"
      }
    >
      <div className="flex items-center gap-2">
        <CopyableId value={runId} kind="run" valueClassName="text-muted-foreground" />
      </div>
      <p className="text-xs text-muted-foreground">{RUN_UNREADABLE_EXPLANATION}</p>
    </div>
  );
}
