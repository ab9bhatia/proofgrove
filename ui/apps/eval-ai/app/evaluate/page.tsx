import type { Metadata } from "next";
import { Suspense } from "react";
import { redirect } from "next/navigation";

import { ProofgroveGate } from "@/components/proofgrove-gate";
import { EvaluationLauncher } from "@/components/evaluation/launcher";
import { LoadingState } from "@/components/page-state";
import { runDetailsHref } from "@/lib/run-recommendation";

export const metadata: Metadata = { title: "Evaluate" };

export default async function EvaluatePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const runId = Array.isArray(params.run) ? params.run[0] : params.run;
  if (runId) redirect(runDetailsHref(runId));

  return (
    <ProofgroveGate>
      <Suspense fallback={<LoadingState label="Loading evaluation setup…" className="min-h-[60vh] border-0" />}>
        <EvaluationLauncher />
      </Suspense>
    </ProofgroveGate>
  );
}
