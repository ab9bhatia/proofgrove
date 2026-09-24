"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { EvaluationKindChooser } from "@/components/evaluation/kind-chooser";
import { EvaluationWorkbench } from "@/components/evaluation/workbench";
import { ErrorState, LoadingState } from "@/components/page-state";
import { api, evaluationApi } from "@/lib/api";
import { type EvaluationKind } from "@/lib/evaluation-form";

type RestoredEvaluationKind = EvaluationKind | "baseline";

function requestedKind(value: string | null): RestoredEvaluationKind | null {
  return value === "agent" || value === "llm" || value === "provided" || value === "baseline"
    ? value
    : null;
}

export function evaluationKindForResponseSource(
  responseSource: string | null | undefined,
): RestoredEvaluationKind | null {
  if (responseSource === "agent") return "agent";
  if (responseSource === "llm") return "llm";
  if (responseSource === "provided") return "provided";
  if (responseSource === "baseline") return "baseline";
  return null;
}

export function evaluationKindForLaunch(
  explicitKind: RestoredEvaluationKind | null,
  restoredKind: RestoredEvaluationKind | null,
): RestoredEvaluationKind | null {
  return restoredKind || explicitKind;
}

export function EvaluationLauncher() {
  const searchParams = useSearchParams();
  const explicitKind = requestedKind(searchParams.get("type"));
  const requestedDataset = searchParams.get("dataset");
  const rerunSourceRunId =
    searchParams.get("rerun") === "1"
      ? searchParams.get("fromRun") || searchParams.get("run") || ""
      : "";
  const [restoredKind, setRestoredKind] = useState<{
    sourceRunId: string;
    kind: RestoredEvaluationKind | null;
  } | null>(null);

  useEffect(() => {
    if (!rerunSourceRunId || explicitKind === "baseline") return;
    let cancelled = false;
    void Promise.resolve().then(async () => {
      try {
        const tenant = await api.tenant();
        const configuration = await evaluationApi.getRunConfiguration(
          rerunSourceRunId,
          tenant.tenant_id,
        );
        if (!cancelled) {
          setRestoredKind({
            sourceRunId: rerunSourceRunId,
            kind: evaluationKindForResponseSource(configuration.response_source),
          });
        }
      } catch {
        // Legacy runs may predate durable launch configuration. In that case,
        // retain the URL's target/scenario-based fallback rather than blocking.
        if (!cancelled) setRestoredKind({ sourceRunId: rerunSourceRunId, kind: null });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [explicitKind, rerunSourceRunId]);

  const rerunKindPending = Boolean(
    rerunSourceRunId &&
      explicitKind !== "baseline" &&
      restoredKind?.sourceRunId !== rerunSourceRunId,
  );
  const effectiveKind = evaluationKindForLaunch(
    explicitKind,
    restoredKind?.sourceRunId === rerunSourceRunId ? restoredKind.kind : null,
  );

  if (rerunKindPending) {
    return <LoadingState label="Restoring evaluation configuration…" />;
  }

  if (effectiveKind === "baseline") {
    return (
      <ErrorState message="Baseline runs are internal pipeline checks and cannot be rerun from Evaluate." />
    );
  }

  // `kind` only seeds the workbench's own choice, so a client-side `?type=` change has to
  // remount it — otherwise the seed would be ignored on the second visit.
  if (effectiveKind) {
    return <EvaluationWorkbench key={`${effectiveKind}:${rerunSourceRunId}`} kind={effectiveKind} />;
  }

  // No kind yet: ask it, and carry any incoming dataset through untouched. The dataset
  // list that used to live here was a second picker — step 1 already has a paged one —
  // and it asked for evidence before the question that shapes the whole form.
  return (
    <EvaluationKindChooser
      datasetName={requestedDataset}
      searchParams={new URLSearchParams(searchParams.toString())}
    />
  );
}
