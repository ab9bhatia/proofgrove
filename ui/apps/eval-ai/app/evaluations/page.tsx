"use client";

import { PAGE_FRAME } from "@/lib/page-frame";
import { Suspense, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ProofgroveGate } from "@/components/proofgrove-gate";
import { PageHeader } from "@/components/page-header";
import { TableSkeleton } from "@/components/page-state";
import { RunsList } from "@/app/runs/page";
import { ExperimentsView } from "@/app/experiments/page";
import {
  evaluationViewForKey,
  type EvaluationsTab,
  readEvaluationsTab,
  writeEvaluationsTab,
} from "@/lib/evaluations-tab";

const TAB_ORDER: readonly EvaluationsTab[] = ["runs", "experiments"] as const;

// Re-export for existing tests that imported evaluationViewForKey from this module.
export { evaluationViewForKey } from "@/lib/evaluations-tab";

export default function EvaluationsPage() {
  return (
    <ProofgroveGate>
      <Suspense fallback={<TableSkeleton label="Loading evaluations…" rows={8} className="min-h-[60vh]" />}>
        <EvaluationsLibrary />
      </Suspense>
    </ProofgroveGate>
  );
}

function EvaluationsLibrary() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const view = readEvaluationsTab(searchParams);

  function setView(next: EvaluationsTab) {
    const params = new URLSearchParams(searchParams.toString());
    writeEvaluationsTab(params, next);
    const query = params.toString();
    router.replace(query ? `/evaluations?${query}` : "/evaluations", { scroll: false });
  }

  function onTabKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, current: EvaluationsTab) {
    const next = evaluationViewForKey(current, event.key);
    if (!next) return;
    event.preventDefault();
    setView(next);
    document.getElementById(`evaluations-tab-${next}`)?.focus();
  }

  return (
    <div className={PAGE_FRAME}>
      <PageHeader
        section="Evaluate"
        title="Experiments"
        description="Review immutable runs or group related runs into experiments to track trends and compare variants."
      />
      <div className="workspace-switcher mb-6" role="tablist" aria-label="Evaluation library view">
        {TAB_ORDER.map((option) => (
          <button
            key={option}
            id={`evaluations-tab-${option}`}
            type="button"
            role="tab"
            aria-selected={view === option}
            aria-controls="evaluations-tabpanel"
            tabIndex={view === option ? 0 : -1}
            onClick={() => setView(option)}
            onKeyDown={(event) => onTabKeyDown(event, option)}

          >

            <span className="block font-display text-sm font-semibold tracking-tight">
              {option === "runs" ? "Run history" : "Experiments"}
            </span>

          </button>
        ))}
      </div>
      <section id="evaluations-tabpanel" role="tabpanel" aria-labelledby={`evaluations-tab-${view}`}>
        {view === "runs" ? <RunsList embedded /> : <ExperimentsView embedded />}
      </section>
    </div>
  );
}
